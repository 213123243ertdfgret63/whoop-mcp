import { type ClientCredentials, ConfigError, DEFAULT_REDIRECT_URI, envValue } from "../config.ts";
import { errorFields, log } from "../log.ts";
import { type BrowserSetupOptions, type BrowserSetupResult, browserSetup, type SetupPhase } from "./browser-setup.ts";
import { resolveClientCredentials } from "./credentials.ts";
import { type LoginOptions, type LoginResult, login } from "./login.ts";
import { toStored } from "./oauth.ts";
import { withTokenLock, writeTokens } from "./store.ts";

export type LoginStatus =
  | { state: "idle" }
  /**
   * `setup`: the browser page that collects the app credentials first; `login`: straight to WHOOP's consent.
   * `progress` is the setup page's step, and `problem` what the page is showing the user (e.g. a WHOOP error).
   */
  | {
      state: "pending";
      kind: "setup" | "login";
      authorizeUrl: string;
      startedAt: number;
      progress?: SetupPhase;
      problem?: string;
      /** Counts problems reported so far, so whoop_login can tell a new one from one it already passed on. */
      problemSeq?: number;
    }
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
  /** Consent-only login (app credentials already saved). */
  timeoutMs: number;
  /** Setup page: closes after this long unused, and after the hard limit regardless. */
  setupIdleMs: number;
  setupMaxMs: number;
}

const defaults: BackgroundLoginDeps = {
  resolveCreds: async () => (await resolveClientCredentials()).creds,
  login,
  save: ({ tokens }) => withTokenLock(() => writeTokens(toStored(tokens))),
  setup: browserSetup,
  redirectUri: () => envValue(process.env.WHOOP_REDIRECT_URI) ?? DEFAULT_REDIRECT_URI,
  // WHOOP_MCP_NO_BROWSER=1 (tests, headless runs from source): pages are announced but not opened.
  openBrowser: process.env.WHOOP_MCP_NO_BROWSER !== "1",
  timeoutMs: 10 * 60_000,
  setupIdleMs: 20 * 60_000,
  setupMaxMs: 60 * 60_000,
};

/** After a failed login, data tools don't reopen the browser on their own for this long (no reopen loops). */
const AUTO_START_COOLDOWN_MS = 60_000;

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
  private readonly listeners = new Set<() => void>();
  /** Pre-fills the setup page after a failed or replaced attempt. Never the secret. */
  private lastClientId: string | undefined;

  constructor(deps: Partial<BackgroundLoginDeps> = {}) {
    this.deps = { ...defaults, ...deps };
  }

  get status(): LoginStatus {
    return this.current;
  }

  private set(status: LoginStatus): void {
    this.current = status;
    for (const notify of [...this.listeners]) notify();
  }

  /**
   * Waits until the pending flow ends (or reports a new problem), at most `ms`, or until `signal` aborts.
   * Returns the status at that point. Resolves at once when nothing is pending.
   */
  waitForChange(ms: number, signal?: AbortSignal): Promise<LoginStatus> {
    if (this.current.state !== "pending" || ms <= 0 || signal?.aborted) return Promise.resolve(this.current);
    const before = this.current;
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.listeners.delete(onChange);
        signal?.removeEventListener("abort", done);
        resolve(this.current);
      };
      const onChange = () => {
        const now = this.current;
        const seqBefore = before.state === "pending" ? (before.problemSeq ?? 0) : 0;
        if (now.state !== "pending" || (now.problemSeq ?? 0) > seqBefore) done();
      };
      const timer = setTimeout(done, ms);
      this.listeners.add(onChange);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  /**
   * For data tools that found no login: starts one (never reconfiguring) unless one is already pending, or the
   * last attempt failed less than a minute ago. Returns the pending status, or null when it didn't start one.
   */
  async startIfIdle(): Promise<LoginStatus | null> {
    const now = this.current;
    if (now.state === "pending") return now;
    if (now.state === "failed" && Date.now() - now.at < AUTO_START_COOLDOWN_MS) return null;
    await this.start();
    return this.current.state === "pending" ? this.current : null;
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

  /** Forgets the Client ID remembered for pre-filling the setup page, after the app credentials were deleted. */
  forgetApp(): void {
    this.lastClientId = undefined;
  }

  /**
   * Cancels the pending flow, if any, and waits until its port is free. Also closes a finished setup page that
   * is still answering status requests (its grace period), so a new login can take the port.
   */
  async cancel(): Promise<void> {
    const pending = this.inFlight;
    this.generation++; // the aborted flow must not report "failed"
    this.controller?.abort();
    this.controller = null;
    this.inFlight = null;
    if (this.current.state === "pending") this.set({ state: "idle" });
    await pending?.catch(() => {});
  }

  private async begin(forceSetup: boolean): Promise<StartResult> {
    const gen = ++this.generation;
    // A finished flow may still hold the port for its grace period; the new one needs it.
    this.controller?.abort();
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
    // Cancelled or replaced while reading the credentials: don't start a second flow on the same port.
    if (!isCurrent()) {
      const now = this.current;
      if (now.state === "pending") return { authorizeUrl: now.authorizeUrl, alreadyPending: true, kind: now.kind };
      throw new Error("The WHOOP login was cancelled.");
    }
    const kind = creds ? "login" : "setup";
    log.info("login started", { kind, reconfigure: forceSetup || undefined });
    const urlReady = Promise.withResolvers<string>();
    const announce = (authorizeUrl: string) => {
      if (isCurrent()) this.set({ state: "pending", kind, authorizeUrl, startedAt: Date.now() });
      urlReady.resolve(authorizeUrl);
    };
    const onPhase = (progress: SetupPhase, problem?: string) => {
      const now = this.current;
      // The end of the flow (done, failed) is reported by the flow's own outcome below, not as a problem.
      if (!isCurrent() || now.state !== "pending" || progress === "done" || progress === "failed") return;
      const isNew = Boolean(problem) && problem !== now.problem;
      this.set({ ...now, progress, problem, problemSeq: (now.problemSeq ?? 0) + (isNew ? 1 : 0) });
    };
    // The setup page saves the tokens itself (persist) before it tells the user they're connected.
    let savedBySetup = false;
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
            idleTimeoutMs: this.deps.setupIdleMs,
            timeoutMs: this.deps.setupMaxMs,
            clientId: this.lastClientId,
            onSetupUrl: announce,
            onPhase,
            persist: async (tokens) => {
              await this.deps.save({ tokens });
              savedBySetup = true;
            },
            signal: controller.signal,
          })
          .then(({ creds, tokens }) => {
            this.lastClientId = creds.clientId;
            return { tokens };
          });

    const inFlight = flow
      .then(async (result) => {
        if (!savedBySetup) await this.deps.save(result);
        log.info("login succeeded", { kind, scope: result.tokens.scope });
        if (isCurrent()) this.set({ state: "succeeded", at: Date.now(), scope: result.tokens.scope });
      })
      .catch((err: unknown) => {
        log.write(isCurrent() ? "warn" : "info", isCurrent() ? "login failed" : "login cancelled", {
          kind,
          ...errorFields(err),
        });
        if (isCurrent()) {
          this.set({ state: "failed", at: Date.now(), error: err instanceof Error ? err.message : String(err) });
        }
        urlReady.reject(err); // no-op if the URL was already handed out
      })
      .finally(() => {
        if (this.inFlight === inFlight) this.inFlight = null;
        // The controller stays: aborting it later closes the finished setup page's grace period.
      });
    this.inFlight = inFlight;

    return { authorizeUrl: await urlReady.promise, alreadyPending: false, kind };
  }

  /** Resolves when the in-flight login (if any) has settled. */
  async settled(): Promise<void> {
    await this.inFlight;
  }
}
