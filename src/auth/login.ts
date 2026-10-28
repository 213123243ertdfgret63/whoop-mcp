import { openUrl } from "../cli/terminal.ts";
import { type ClientCredentials, missingScopes } from "../config.ts";
import { log } from "../log.ts";
import {
  buildAuthorizeUrl,
  exchangeCode,
  MissingScopesError,
  randomState,
  revokeAccess,
  type TokenResponse,
} from "./oauth.ts";
import { cspFor, htmlPage, newNonce } from "./page-style.ts";

export interface LoginOptions {
  openBrowser?: boolean;
  /** Injectable for tests: revokes a token WHOOP issued with too few permissions. */
  revoke?: (accessToken: string) => Promise<unknown>;
  timeoutMs?: number;
  /** Called once the callback server is listening, with the URL the user must open. */
  onAuthorizeUrl?: (url: string) => void;
  /** Cancels the login and frees the port. */
  signal?: AbortSignal;
}

export interface LoginResult {
  tokens: TokenResponse;
}

/** Headers for every page the local server returns: never cached, never framed, no referrer leaks. */
export const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  // Not "no-referrer": under that policy browsers send `Origin: null` even on same-origin form posts, which the
  // setup page's CSRF check must refuse. "same-origin" still keeps the token-bearing URL from other sites.
  "Referrer-Policy": "same-origin",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
} as const;

/** A simple styled message page. `body` can carry attacker-controlled query params (error_description), so
 * everything is escaped. */
export function page(title: string, body: string, status = 200, tone: "ok" | "err" | "info" = "info"): Response {
  const esc = Bun.escapeHTML;
  const nonce = newNonce();
  const cls = tone === "info" ? "" : ` class="${tone}"`;
  const mark = tone === "ok" ? "✓ " : "";
  return new Response(
    htmlPage({ title: esc(title), nonce, body: `<h1${cls}>${mark}${esc(title)}</h1><p>${esc(body)}</p>` }),
    { status, headers: { ...PAGE_HEADERS, "Content-Security-Policy": cspFor(nonce) } },
  );
}

/** One plain-language line for an OAuth error WHOOP sent back, with what to do about it. */
export function explainOAuthError(error: string, description = ""): string {
  const text = `${error} ${description}`.toLowerCase();
  if (text.includes("redirect")) {
    return "WHOOP refused the redirect URL. In your WHOOP app, Redirect URLs must contain exactly http://localhost:8787/callback (no trailing slash).";
  }
  if (error === "invalid_client" || text.includes("client")) {
    return "WHOOP didn't recognise the app. Check the Client ID and Secret, or create the app again.";
  }
  if (error === "access_denied") return "Access wasn't approved on WHOOP's page.";
  if (error === "invalid_scope" || text.includes("scope")) {
    return "WHOOP refused the permissions. In your WHOOP app, tick every box under Scopes.";
  }
  return `WHOOP returned an error: ${error}${description ? ` (${description.slice(0, 200)})` : ""}.`;
}

export type CallbackOutcome =
  | { kind: "wrong-state" }
  | { kind: "error"; error: string; description?: string }
  | { kind: "no-code" }
  | { kind: "code"; code: string };

/** What WHOOP's redirect to the callback says, checking `state` first. */
export function parseCallback(url: URL, state: string): CallbackOutcome {
  const params = Object.fromEntries(url.searchParams);
  // State first: a request without this login's state didn't come from WHOOP for this login (any web page can
  // navigate here), so it must neither end the login nor get its text into our status.
  if (params.state !== state) return { kind: "wrong-state" };
  if (params.error) return { kind: "error", error: params.error, description: params.error_description };
  if (!params.code) return { kind: "no-code" };
  return { kind: "code", code: params.code };
}

export const wrongStatePage = () =>
  page(
    "Not this login",
    "This link doesn't belong to the WHOOP login in progress. Use the page Claude opened, or start the login again.",
    400,
    "err",
  );

/** Validates a localhost redirect URI and returns where to listen. */
export function parseRedirect(redirectUri: string): URL {
  const redirect = new URL(redirectUri);
  if (redirect.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname)) {
    throw new Error(`Redirect URI must be http on localhost/127.0.0.1 for local login (got ${redirectUri}).`);
  }
  return redirect;
}

export class PortInUseError extends Error {
  override name = "PortInUseError";
}

/** Whether this machine has an IPv6 loopback at all (if not, "localhost" can only mean 127.0.0.1). */
function hasIpv6Loopback(): boolean {
  try {
    Bun.serve({ hostname: "::1", port: 0, fetch: () => new Response() }).stop(true);
    return true;
  } catch {
    return false;
  }
}

/**
 * Binds a server on the redirect URI's loopback address(es). For "localhost" it must get both 127.0.0.1 and
 * ::1 (when IPv6 exists): the browser may resolve either, and a half-bound port would let whatever program
 * holds the other address receive the setup link or the OAuth callback.
 */
export function listenLocal(
  redirect: URL,
  fetch: (req: Request) => Response | Promise<Response>,
  opts: { maxRequestBodySize?: number } = {},
) {
  const port = Number(redirect.port || 80);
  const hosts =
    redirect.hostname === "localhost"
      ? ["127.0.0.1", ...(hasIpv6Loopback() ? ["::1"] : [])]
      : [redirect.hostname.replace(/^\[|\]$/g, "")];
  const servers: ReturnType<typeof Bun.serve>[] = [];
  for (const hostname of hosts) {
    try {
      servers.push(Bun.serve({ hostname, port, fetch, maxRequestBodySize: opts.maxRequestBodySize }));
    } catch (err) {
      for (const s of servers) s.stop(true);
      log.warn("could not listen for the login callback", { host: hostname, port, error: (err as Error).message });
      throw new PortInUseError(
        `Port ${port} is already in use${hosts.length > 1 ? ` (on ${hostname})` : ""}, so WHOOP can't redirect back here. ` +
          "Another WHOOP login (e.g. in a second Claude window) or another program is using it; finish or close that and try again.",
      );
    }
  }
  return {
    port,
    // Graceful stop, so the response for the request that settled the flow still gets flushed.
    stop: () => {
      for (const s of servers) void s.stop();
    },
  };
}

/**
 * The OAuth redirect handler for one consent-only login. `result` settles on the first callback that carries
 * a code or an error; a wrong `state` is refused without ending the login (possible CSRF).
 */
export function oauthCallback(state: string) {
  const deferred = Promise.withResolvers<{ code: string }>();
  // Settle on the next tick so the callback page is written before the caller can exit the process.
  const resolve = (value: { code: string }) => setTimeout(() => deferred.resolve(value), 50);
  const reject = (err: Error) => setTimeout(() => deferred.reject(err), 50);

  const handle = (url: URL): Response => {
    const outcome = parseCallback(url, state);
    switch (outcome.kind) {
      case "wrong-state":
        return wrongStatePage();
      case "error": {
        const detail = `${outcome.error}${outcome.description ? ` — ${outcome.description}` : ""}`;
        reject(new Error(`Authorization failed: ${detail}`));
        return page("WHOOP didn't connect", explainOAuthError(outcome.error, outcome.description), 200, "err");
      }
      case "no-code":
        reject(new Error("Callback had no authorization code."));
        return page("WHOOP didn't connect", "No authorization code was returned.", 200, "err");
      case "code":
        resolve({ code: outcome.code });
        // The token exchange happens after this page is sent, so don't claim success yet.
        return page(
          "Approved",
          "Claude is finishing the connection; you can close this tab and go back to Claude.",
          200,
          "ok",
        );
    }
  };

  return { handle, result: deferred.promise, reject: (err: Error) => deferred.reject(err) };
}

/** Runs the authorization-code flow with a one-shot localhost callback server. */
export async function login(creds: ClientCredentials, opts: LoginOptions = {}): Promise<LoginResult> {
  const redirect = parseRedirect(creds.redirectUri);
  const state = randomState();
  const authorizeUrl = buildAuthorizeUrl({ creds, state });
  const revoke = opts.revoke ?? revokeAccess;

  const callback = oauthCallback(state);
  const server = listenLocal(redirect, (req) => {
    const url = new URL(req.url);
    return url.pathname === redirect.pathname ? callback.handle(url) : new Response("Not found", { status: 404 });
  });

  const timeout = setTimeout(
    () => callback.reject(new Error("Timed out waiting for the WHOOP login callback.")),
    opts.timeoutMs ?? 5 * 60_000,
  );
  const onAbort = () => callback.reject(new Error("WHOOP login was cancelled."));
  if (opts.signal?.aborted) onAbort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  log.info("open this URL to authorize WHOOP access", { url: authorizeUrl });
  opts.onAuthorizeUrl?.(authorizeUrl);
  if (opts.openBrowser ?? true) openUrl(authorizeUrl);

  try {
    const { code } = await callback.result;
    const tokens = await exchangeCode(creds, code);
    // All permissions or no connection: a partial grant would leave tools failing one by one later.
    const missing = missingScopes(tokens.scope);
    if (missing.length) {
      log.warn("WHOOP granted only some permissions; not connecting", { missing });
      await revoke(tokens.access_token);
      throw new MissingScopesError(missing);
    }
    return { tokens };
  } finally {
    clearTimeout(timeout);
    opts.signal?.removeEventListener("abort", onAbort);
    server.stop();
  }
}
