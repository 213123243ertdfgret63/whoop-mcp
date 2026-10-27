import { type ClientCredentials, ConfigError, DEFAULT_REDIRECT_URI, envValue } from "../config.ts";
import { type BrowserSetupOptions, type BrowserSetupResult, browserSetup } from "./browser-setup.ts";
import { resolveClientCredentials } from "./credentials.ts";
import { type LoginOptions, type LoginResult, login } from "./login.ts";
import { toStored } from "./oauth.ts";
import { writeTokens } from "./store.ts";

export type LoginStatus =
  | { state: "idle" }
  /** `setup`: the browser page that collects the app credentials first; `login`: straight to WHOOP's consent. */
  | { state: "pending"; kind: "setup" | "login"; authorizeUrl: string; startedAt: number }
  | { state: "succeeded"; at: number; scope?: string }
  | { state: "failed"; at: number; error: string };

export interface BackgroundLoginDeps {
  resolveCreds: () => Promise<ClientCredentials>;
  login: (creds: ClientCredentials, opts: LoginOptions) => Promise<LoginResult>;
  save: (result: LoginResult) => Promise<void>;
  /** Browser setup for when no app credentials exist yet; it saves the credentials itself. */
  setup: (opts: BrowserSetupOptions) => Promise<BrowserSetupResult>;
  redirectUri: () => string;
  openBrowser: boolean;
  timeoutMs: number;
}

const defaults: BackgroundLoginDeps = {
  resolveCreds: async () => (await resolveClientCredentials()).creds,
  login,
  save: ({ tokens }) => writeTokens(toStored(tokens)),
  setup: browserSetup,
  redirectUri: () => envValue(process.env.WHOOP_REDIRECT_URI) ?? DEFAULT_REDIRECT_URI,
  // For headless use and tests: print the URL (whoop_login returns it) without opening a browser.
  openBrowser: process.env.WHOOP_MCP_NO_BROWSER !== "1",
  timeoutMs: 5 * 60_000,
};

export interface StartResult {
  authorizeUrl: string;
  alreadyPending: boolean;
  kind: "setup" | "login";
}

/**
 * Browser login driven from inside the MCP server (the `whoop_login` tool), so users of clients like the
 * Claude desktop app never need a terminal. `start()` returns as soon as the authorize URL exists, so the
 * tool can show it; the callback is awaited in the background and its outcome surfaces through `status`.
 *
 * Only one flow runs at a time (they share the callback port): concurrent `start()` calls share it, and
 * `cancel()` / `start({ reconfigure: true })` abort it first. A generation counter keeps a superseded flow
 * from overwriting the status of the current one.
 */
export class BackgroundLogin {
  private current: LoginStatus = { state: "idle" };
  private inFlight: Promise<void> | null = null;
  private starting: Promise<StartResult> | null = null;
  private controller: AbortController | null = null;
  private generation = 0;
  private readonly deps: BackgroundLoginDeps;

  constructor(deps: Partial<BackgroundLoginDeps> = {}) {
    this.deps = { ...defaults, ...deps };
  }

  get status(): LoginStatus {
    return this.current;
  }

  /**
   * Starts a login, or returns the one already waiting for the browser. Without app credentials it starts the
   * browser setup page instead (`kind: "setup"`); `reconfigure` cancels any pending flow and opens the setup
   * page even when credentials exist (to replace wrong ones). Throws if it can't start at all.
   */
  async start(opts: { reconfigure?: boolean } = {}): Promise<StartResult> {
    if (opts.reconfigure) {
      await this.cancel();
    } else {
      if (this.current.state === "pending") {
        return { authorizeUrl: this.current.authorizeUrl, alreadyPending: true, kind: this.current.kind };
      }
      if (this.starting) return { ...(await this.starting), alreadyPending: true };
    }
    const starting = this.begin(Boolean(opts.reconfigure));
    this.starting = starting;
    try {
      return await starting;
    } finally {
      if (this.starting === starting) this.starting = null;
    }
  }

  /** Cancels the pending flow, if any, and waits until its port is free. */
  async cancel(): Promise<void> {
    const pending = this.inFlight;
    this.generation++; // the aborted flow must not report "failed"
    this.controller?.abort();
    this.controller = null;
    this.inFlight = null;
    if (this.current.state === "pending") this.current = { state: "idle" };
    await pending?.catch(() => {});
  }

  private async begin(forceSetup: boolean): Promise<StartResult> {
    const gen = ++this.generation;
    const controller = new AbortController();
    this.controller = controller;
    const isCurrent = () => gen === this.generation;

    let creds: ClientCredentials | null = null;
    if (!forceSetup) {
      try {
        creds = await this.deps.resolveCreds();
      } catch (err) {
        if (!(err instanceof ConfigError)) throw err; // no app credentials yet: collect them in the browser
      }
    }
    const kind = creds ? "login" : "setup";
    const urlReady = Promise.withResolvers<string>();
    const announce = (authorizeUrl: string) => {
      if (isCurrent()) this.current = { state: "pending", kind, authorizeUrl, startedAt: Date.now() };
      urlReady.resolve(authorizeUrl);
    };
    const flow: Promise<LoginResult> = creds
      ? this.deps.login(creds, {
          openBrowser: this.deps.openBrowser,
          timeoutMs: this.deps.timeoutMs,
          onAuthorizeUrl: announce,
          signal: controller.signal,
        })
      : this.deps
          .setup({
            redirectUri: this.deps.redirectUri(),
            openBrowser: this.deps.openBrowser,
            timeoutMs: this.deps.timeoutMs * 3, // creating the WHOOP app takes longer than approving access
            onSetupUrl: announce,
            signal: controller.signal,
          })
          .then(({ tokens }) => ({ tokens, callbackParams: {} }));

    const inFlight = flow
      .then(async (result) => {
        await this.deps.save(result);
        if (isCurrent()) this.current = { state: "succeeded", at: Date.now(), scope: result.tokens.scope };
      })
      .catch((err: unknown) => {
        if (isCurrent()) {
          this.current = { state: "failed", at: Date.now(), error: err instanceof Error ? err.message : String(err) };
        }
        urlReady.reject(err); // no-op if the URL was already handed out
      })
      .finally(() => {
        if (this.inFlight === inFlight) this.inFlight = null;
        if (this.controller === controller) this.controller = null;
      });
    this.inFlight = inFlight;

    return { authorizeUrl: await urlReady.promise, alreadyPending: false, kind };
  }

  /** Resolves when the in-flight login (if any) has settled. */
  async settled(): Promise<void> {
    await this.inFlight;
  }
}
