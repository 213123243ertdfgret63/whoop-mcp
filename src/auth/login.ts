import { openUrl } from "../cli/terminal.ts";
import type { ClientCredentials } from "../config.ts";
import { log } from "../log.ts";
import { buildAuthorizeUrl, exchangeCode, randomState, type TokenResponse } from "./oauth.ts";

export interface LoginOptions {
  openBrowser?: boolean;
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

// `body` can carry attacker-controlled query params (error_description), so everything is escaped.
export const page = (title: string, body: string, status = 200) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><title>${Bun.escapeHTML(title)}</title>` +
      `<body style="font:16px system-ui;max-width:32rem;margin:4rem auto"><h1>${Bun.escapeHTML(title)}</h1><p>${Bun.escapeHTML(body)}</p></body>`,
    { status, headers: PAGE_HEADERS },
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
 * The OAuth redirect handler for one login attempt. `result` settles on the first callback that carries a
 * code or an error; a wrong `state` aborts (possible CSRF).
 */
export function oauthCallback(state: string, successMessage: string) {
  const deferred = Promise.withResolvers<{ code: string; params: Record<string, string> }>();
  // Settle on the next tick so the callback page is written before the caller can exit the process.
  const resolve = (value: { code: string; params: Record<string, string> }) =>
    setTimeout(() => deferred.resolve(value), 50);
  const reject = (err: Error) => setTimeout(() => deferred.reject(err), 50);

  const handle = (url: URL): Response => {
    const params = Object.fromEntries(url.searchParams);
    // State first: a request without this login's state didn't come from WHOOP for this login (any web page can
    // navigate here), so it must neither end the login nor get its text into our status.
    if (params.state !== state) {
      return page(
        "Not this login",
        "This link doesn't belong to the WHOOP login in progress. Use the page Claude opened, or start the login again.",
        400,
      );
    }
    if (params.error) {
      reject(
        new Error(
          `Authorization failed: ${params.error}${params.error_description ? ` — ${params.error_description}` : ""}`,
        ),
      );
      return page("Authorization failed", `${params.error}: ${params.error_description ?? ""}`);
    }
    if (!params.code) {
      reject(new Error("Callback had no authorization code."));
      return page("Login failed", "No authorization code was returned.");
    }
    const { code, ...rest } = params;
    resolve({ code, params: rest });
    return page("WHOOP connected", successMessage);
  };

  return { handle, result: deferred.promise, reject: (err: Error) => deferred.reject(err) };
}

/** Runs the authorization-code flow with a one-shot localhost callback server. */
export async function login(creds: ClientCredentials, opts: LoginOptions = {}): Promise<LoginResult> {
  const redirect = parseRedirect(creds.redirectUri);
  const state = randomState();
  const authorizeUrl = buildAuthorizeUrl({ creds, state });

  const callback = oauthCallback(state, "You can close this tab and return to Claude or your terminal.");
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
    return { tokens: await exchangeCode(creds, code) };
  } finally {
    clearTimeout(timeout);
    opts.signal?.removeEventListener("abort", onAbort);
    server.stop();
  }
}
