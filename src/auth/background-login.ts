import type { ClientCredentials } from "../config.ts";
import { resolveClientCredentials } from "./credentials.ts";
import { type LoginOptions, type LoginResult, login } from "./login.ts";
import { toStored } from "./oauth.ts";
import { writeTokens } from "./store.ts";

export type LoginStatus =
  | { state: "idle" }
  | { state: "pending"; authorizeUrl: string; startedAt: number }
  | { state: "succeeded"; at: number; scope?: string }
  | { state: "failed"; at: number; error: string };

export interface BackgroundLoginDeps {
  resolveCreds: () => Promise<ClientCredentials>;
  login: (creds: ClientCredentials, opts: LoginOptions) => Promise<LoginResult>;
  save: (result: LoginResult) => Promise<void>;
  openBrowser: boolean;
  timeoutMs: number;
}

const defaults: BackgroundLoginDeps = {
  resolveCreds: async () => (await resolveClientCredentials()).creds,
  login,
  save: ({ tokens }) => writeTokens(toStored(tokens)),
  openBrowser: true,
  timeoutMs: 5 * 60_000,
};

/**
 * Browser login driven from inside the MCP server (the `whoop_login` tool), for clients like a Claude Code
 * plugin where the user never touches a terminal. `start()` returns as soon as the authorize URL exists, so the
 * tool can show it; the callback is awaited in the background and its outcome surfaces through `status`.
 */
export class BackgroundLogin {
  private current: LoginStatus = { state: "idle" };
  private inFlight: Promise<void> | null = null;
  private readonly deps: BackgroundLoginDeps;

  constructor(deps: Partial<BackgroundLoginDeps> = {}) {
    this.deps = { ...defaults, ...deps };
  }

  get status(): LoginStatus {
    return this.current;
  }

  /** Starts a login, or returns the one already waiting for the browser. Throws if it can't start at all. */
  async start(): Promise<{ authorizeUrl: string; alreadyPending: boolean }> {
    if (this.current.state === "pending") return { authorizeUrl: this.current.authorizeUrl, alreadyPending: true };

    const creds = await this.deps.resolveCreds();
    const urlReady = Promise.withResolvers<string>();
    this.inFlight = this.deps
      .login(creds, {
        openBrowser: this.deps.openBrowser,
        timeoutMs: this.deps.timeoutMs,
        onAuthorizeUrl: (authorizeUrl) => {
          this.current = { state: "pending", authorizeUrl, startedAt: Date.now() };
          urlReady.resolve(authorizeUrl);
        },
      })
      .then(async (result) => {
        await this.deps.save(result);
        this.current = { state: "succeeded", at: Date.now(), scope: result.tokens.scope };
      })
      .catch((err: unknown) => {
        this.current = { state: "failed", at: Date.now(), error: err instanceof Error ? err.message : String(err) };
        urlReady.reject(err); // no-op if the URL was already handed out
      })
      .finally(() => {
        this.inFlight = null;
      });

    return { authorizeUrl: await urlReady.promise, alreadyPending: false };
  }

  /** Resolves when the in-flight login (if any) has settled. */
  async settled(): Promise<void> {
    await this.inFlight;
  }
}
