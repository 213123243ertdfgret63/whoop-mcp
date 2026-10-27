import type { ClientCredentials } from "../config.ts";
import { log } from "../log.ts";
import {
  buildAuthorizeUrl,
  type ClientAuthMethod,
  exchangeCode,
  pkcePair,
  randomState,
  type TokenResponse,
} from "./oauth.ts";

export interface LoginOptions {
  pkce?: boolean;
  stateLength?: number;
  auth?: ClientAuthMethod;
  openBrowser?: boolean;
  timeoutMs?: number;
}

export interface LoginResult {
  tokens: TokenResponse;
  /** Query params WHOOP sent to the callback (minus `code`), for M0 probing. */
  callbackParams: Record<string, string>;
}

// `body` can carry attacker-controlled query params (error_description), so everything is escaped.
const page = (title: string, body: string) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><title>${Bun.escapeHTML(title)}</title>` +
      `<body style="font:16px system-ui;max-width:32rem;margin:4rem auto"><h1>${Bun.escapeHTML(title)}</h1><p>${Bun.escapeHTML(body)}</p></body>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );

/** Runs the authorization-code flow with a one-shot localhost callback server. */
export async function login(creds: ClientCredentials, opts: LoginOptions = {}): Promise<LoginResult> {
  const redirect = new URL(creds.redirectUri);
  if (redirect.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname)) {
    throw new Error(`Redirect URI must be http on localhost/127.0.0.1 for local login (got ${creds.redirectUri}).`);
  }
  const port = Number(redirect.port || 80);
  const state = randomState(opts.stateLength ?? 32);
  const pkce = opts.pkce ? await pkcePair() : undefined;
  const authorizeUrl = buildAuthorizeUrl({ creds, state, codeChallenge: pkce?.challenge });

  const deferred = Promise.withResolvers<{ code: string; params: Record<string, string> }>();
  // Settle on the next tick so the callback page is written before the caller can exit the process.
  const resolve = (value: { code: string; params: Record<string, string> }) =>
    setTimeout(() => deferred.resolve(value), 50);
  const reject = (err: Error) => setTimeout(() => deferred.reject(err), 50);

  const fetchHandler = (req: Request): Response => {
    const url = new URL(req.url);
    if (url.pathname !== redirect.pathname) return new Response("Not found", { status: 404 });
    const params = Object.fromEntries(url.searchParams);
    if (params.error) {
      reject(
        new Error(
          `Authorization failed: ${params.error}${params.error_description ? ` — ${params.error_description}` : ""}`,
        ),
      );
      return page("Authorization failed", `${params.error}: ${params.error_description ?? ""}`);
    }
    if (params.state !== state) {
      reject(new Error("State mismatch on OAuth callback (possible CSRF); aborting."));
      return page("Login failed", "State mismatch. Close this tab and run login again.");
    }
    if (!params.code) {
      reject(new Error("Callback had no authorization code."));
      return page("Login failed", "No authorization code was returned.");
    }
    const { code, ...rest } = params;
    resolve({ code, params: rest });
    return page("WHOOP connected", "You can close this tab and return to the terminal.");
  };

  // "localhost" may resolve to ::1 or 127.0.0.1 in the browser, so listen on both when we can.
  const hosts = redirect.hostname === "localhost" ? ["127.0.0.1", "::1"] : [redirect.hostname.replace(/^\[|\]$/g, "")];
  const servers = hosts.flatMap((hostname) => {
    try {
      return [Bun.serve({ hostname, port, fetch: fetchHandler })];
    } catch (err) {
      log(`could not listen on ${hostname}:${port}: ${(err as Error).message}`);
      return [];
    }
  });
  if (servers.length === 0) throw new Error(`Could not start the callback server on port ${port}.`);

  const timeout = setTimeout(
    () => deferred.reject(new Error("Timed out waiting for the WHOOP login callback.")),
    opts.timeoutMs ?? 5 * 60_000,
  );

  log(`Open this URL to authorize WHOOP access:\n\n  ${authorizeUrl}\n`);
  if (opts.openBrowser ?? true) {
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
    try {
      Bun.spawn([opener, authorizeUrl], { stdout: "ignore", stderr: "ignore" });
    } catch {
      // The URL is printed above; opening a browser is best-effort.
    }
  }

  try {
    const { code, params } = await deferred.promise;
    const tokens = await exchangeCode(creds, code, { codeVerifier: pkce?.verifier, auth: opts.auth });
    return { tokens, callbackParams: params };
  } finally {
    clearTimeout(timeout);
    // Graceful stop, so the response for the request that settled the promise still gets flushed.
    for (const s of servers) void s.stop();
  }
}
