import { timingSafeEqual } from "node:crypto";
import { openUrl } from "../cli/terminal.ts";
import { type ClientCredentials, SCOPES } from "../config.ts";
import { log } from "../log.ts";
import { DASHBOARD_URL, PRIVACY_URL, type VerifyResult, verifyCredentials } from "../setup.ts";
import { type CredentialSource, saveCredentials } from "./credentials.ts";
import { listenLocal, oauthCallback, PAGE_HEADERS, page, parseRedirect } from "./login.ts";
import { buildAuthorizeUrl, exchangeCode, randomState, randomToken, type TokenResponse } from "./oauth.ts";

/**
 * First-run setup entirely in the browser, so connecting WHOOP never needs a terminal (e.g. from the Claude
 * desktop app): a local page collects the WHOOP app's client ID and
 * secret, checks them with WHOOP, saves them (keychain, else a 0600 file), and continues straight into
 * WHOOP's consent screen. The OAuth callback lands on the same local server.
 *
 * The page is only reachable on loopback, behind a one-time random link, and only accepts same-origin
 * POSTs to the expected Host, so other websites (or DNS-rebinding tricks) can't submit or read it.
 */
export const SETUP_PATH = "/setup";
const MAX_BODY_BYTES = 8 * 1024;
const CREATE_URL = `${DASHBOARD_URL}/apps/create`;

export interface BrowserSetupOptions {
  redirectUri: string;
  openBrowser?: boolean;
  /** Whole flow, from opening the page to the WHOOP callback. */
  timeoutMs?: number;
  /** Cancels the flow (closes the local server; the setup link stops working). */
  signal?: AbortSignal;
  /** Called once the server is listening, with the one-time setup URL to open. */
  onSetupUrl?: (url: string) => void;
  /** Injectable for tests. */
  verify?: (creds: ClientCredentials) => Promise<VerifyResult>;
  save?: (creds: ClientCredentials) => Promise<CredentialSource>;
  exchange?: (creds: ClientCredentials, code: string) => Promise<TokenResponse>;
}

export interface BrowserSetupResult {
  creds: ClientCredentials;
  saved: CredentialSource;
  tokens: TokenResponse;
}

type Phase = "form" | "verifying" | "authorizing";

const CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  // No form-action: Chrome applies it to every redirect after the POST, and WHOOP's consent flow redirects
  // across its own pages. The form's target is fixed in the HTML, so the directive would add little.
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join("; ");

function sameSecret(a: string | null, b: string): boolean {
  if (a === null) return false;
  const [x, y] = [Buffer.from(a), Buffer.from(b)];
  return x.length === y.length && timingSafeEqual(x, y);
}

function formPage(opts: { token: string; redirectUri: string; clientId?: string; error?: string }): Response {
  const esc = Bun.escapeHTML;
  const scopes = SCOPES.filter((s) => s !== "offline")
    .map((s) => `<code>${esc(s)}</code>`)
    .join(", ");
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect WHOOP</title>
<style>
  :root { color-scheme: light dark; --fg: #111; --muted: #555; --bg: #fff; --card: #f5f5f4; --accent: #0a7; --err: #b00020; }
  @media (prefers-color-scheme: dark) { :root { --fg: #eee; --muted: #aaa; --bg: #111; --card: #1c1c1c; --accent: #3c9; --err: #ff6b6b; } }
  body { font: 16px/1.5 system-ui, sans-serif; color: var(--fg); background: var(--bg); max-width: 34rem; margin: 3rem auto; padding: 0 1rem; }
  h1 { font-size: 1.5rem; margin-bottom: .25rem; } p.lead { color: var(--muted); margin-top: 0; }
  ol { padding-left: 1.25rem; } li { margin: .35rem 0; }
  code { background: var(--card); padding: .1rem .35rem; border-radius: 4px; font-size: .9em; white-space: nowrap; }
  code.uri { white-space: normal; overflow-wrap: anywhere; }
  form { background: var(--card); padding: 1.25rem; border-radius: 10px; margin-top: 1rem; }
  label { display: block; font-weight: 600; margin: .75rem 0 .25rem; }
  input { width: 100%; box-sizing: border-box; font: inherit; padding: .55rem .65rem; border: 1px solid #8884; border-radius: 6px; background: var(--bg); color: var(--fg); }
  button { margin-top: 1.25rem; font: inherit; font-weight: 600; padding: .6rem 1.1rem; border: 0; border-radius: 6px; background: var(--accent); color: #fff; cursor: pointer; }
  .error { color: var(--err); font-weight: 600; } .note { color: var(--muted); font-size: .9rem; }
  h2 { font-size: 1.1rem; margin: 1.75rem 0 .5rem; }
  dl { background: var(--card); border-radius: 10px; padding: .5rem 1.25rem 1rem; }
  dt { font-weight: 600; margin-top: .75rem; } dd { margin: .15rem 0 0; }
  dl code { background: var(--bg); }
  code.copy { user-select: all; -webkit-user-select: all; cursor: pointer; white-space: normal; overflow-wrap: anywhere; }
</style></head>
<body>
<h1>Connect WHOOP</h1>
<p class="lead">whoop-mcp reads your WHOOP data through your own free WHOOP developer app. Creating one takes
about two minutes.</p>
<h2>1. Create the app</h2>
<p>Open the <a href="${esc(CREATE_URL)}" target="_blank" rel="noopener noreferrer">WHOOP developer dashboard</a>,
sign in with your WHOOP account and click <b>Create App</b>. Fill in the form like this (click a value to select
it, then copy it):</p>
<dl>
  <dt>Name</dt>
  <dd>Anything you like, for example <code class="copy">whoop-mcp</code>. WHOOP shows it when you approve access.</dd>
  <dt>Logo</dt>
  <dd>Leave it empty.</dd>
  <dt>Contacts</dt>
  <dd>Your own email address. WHOOP only uses it for notices about the app.</dd>
  <dt>Privacy policy</dt>
  <dd><code class="copy">${esc(PRIVACY_URL)}</code><br><span class="note">whoop-mcp keeps your data on this
  computer; that page says so.</span></dd>
  <dt>Redirect URLs</dt>
  <dd><code class="copy">${esc(opts.redirectUri)}</code><br><span class="note">Exactly this, or WHOOP refuses to
  log you in.</span></dd>
  <dt>Scopes</dt>
  <dd>Tick all six: ${scopes}.</dd>
  <dt>Webhooks</dt>
  <dd>Leave it empty.</dd>
</dl>
<p>Then click <b>Create App</b> at the bottom of the form.</p>
<h2>2. Paste the app's credentials</h2>
<p>WHOOP shows the new app's <b>Client ID</b> and <b>Client Secret</b>. Copy both into the form below.</p>
<form method="post" action="${SETUP_PATH}" autocomplete="off">
  ${opts.error ? `<p class="error" role="alert">${esc(opts.error)}</p>` : ""}
  <input type="hidden" name="token" value="${esc(opts.token)}">
  <label for="client_id">Client ID</label>
  <input id="client_id" name="client_id" required spellcheck="false" value="${esc(opts.clientId ?? "")}">
  <label for="client_secret">Client Secret</label>
  <input id="client_secret" name="client_secret" type="password" required spellcheck="false">
  <button type="submit">Save and continue to WHOOP</button>
  <p class="note">The secret is checked with WHOOP and saved to your system keychain on this computer. Nothing is sent anywhere else.</p>
</form>
</body></html>`;
  return new Response(html, {
    status: opts.error ? 400 : 200,
    headers: { ...PAGE_HEADERS, "Content-Security-Policy": CSP },
  });
}

/** Shown when the setup link is reopened after submitting: continue to WHOOP, or start over. */
function almostDonePage(opts: { token: string; authorizeUrl: string }): Response {
  const esc = Bun.escapeHTML;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Almost done</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 34rem; margin: 3rem auto; padding: 0 1rem; }
  a.button, button { display: inline-block; font: inherit; font-weight: 600; padding: .6rem 1.1rem; border-radius: 6px; border: 0; cursor: pointer; }
  a.button { background: #0a7; color: #fff; text-decoration: none; }
  button { background: transparent; color: inherit; border: 1px solid #8886; margin-top: 1rem; }
</style></head>
<body>
<h1>Almost done</h1>
<p>Your WHOOP app credentials are saved. Approve access in WHOOP to finish.</p>
<p><a class="button" href="${esc(opts.authorizeUrl)}">Continue to WHOOP</a></p>
<p>If WHOOP showed an error instead (for example about the redirect URI or an unknown client), fix the app in the
WHOOP dashboard, or enter different credentials:</p>
<form method="post" action="${SETUP_PATH}">
  <input type="hidden" name="token" value="${esc(opts.token)}">
  <input type="hidden" name="action" value="reset">
  <button type="submit">Use different credentials</button>
</form>
</body></html>`;
  return new Response(html, { headers: { ...PAGE_HEADERS, "Content-Security-Policy": CSP } });
}

export async function browserSetup(opts: BrowserSetupOptions): Promise<BrowserSetupResult> {
  const redirect = parseRedirect(opts.redirectUri);
  const verify = opts.verify ?? verifyCredentials;
  const save = opts.save ?? saveCredentials;
  const exchange = opts.exchange ?? ((creds, code) => exchangeCode(creds, code));

  const port = Number(redirect.port || 80);
  // Browsers omit the default port from Host/Origin, so a portless redirect URI means bare hostnames.
  const hostForms = ["localhost", "127.0.0.1", "[::1]"];
  const allowedHosts = new Set(redirect.port ? hostForms.map((h) => `${h}:${port}`) : hostForms);
  const allowedOrigins = new Set([...allowedHosts].map((h) => `http://${h}`));
  const token = randomToken(32);

  let phase: Phase = "form";
  let submitted: { creds: ClientCredentials; saved: CredentialSource } | null = null;
  let callback: ReturnType<typeof oauthCallback> | null = null;
  let authorizeUrl = "";
  // Settles with WHOOP's authorization code once the form was submitted and the user approved,
  // or rejects on a failed callback or the timeout.
  const authorized = Promise.withResolvers<{ code: string }>();

  const handle = async (req: Request): Promise<Response> => {
    // DNS rebinding: a hostile domain resolving to 127.0.0.1 would arrive with its own Host header.
    if (!allowedHosts.has(req.headers.get("host") ?? "")) return new Response("Misdirected request", { status: 421 });
    const url = new URL(req.url);

    if (url.pathname === redirect.pathname) {
      if (!callback) return page("Not ready", "Submit the setup form first.", 409);
      return callback.handle(url);
    }
    if (url.pathname !== SETUP_PATH) return new Response("Not found", { status: 404 });

    if (req.method === "GET") {
      if (!sameSecret(url.searchParams.get("t"), token)) {
        return page("Link expired", "This setup link isn't valid. Ask Claude to run whoop_login again.", 403);
      }
      if (phase === "authorizing") return almostDonePage({ token, authorizeUrl });
      return formPage({ token, redirectUri: opts.redirectUri });
    }
    if (req.method !== "POST")
      return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST" } });

    // CSRF: browsers always send Origin on form POSTs; other sites' (or opaque "null") origins are refused.
    const origin = req.headers.get("origin");
    if (!origin || !allowedOrigins.has(origin)) return page("Forbidden", "Cross-site request refused.", 403);
    if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
      return page("Too large", "Request too large.", 413);
    }
    const body = await req.text();
    if (body.length > MAX_BODY_BYTES) return page("Too large", "Request too large.", 413);
    const form = new URLSearchParams(body);
    if (!sameSecret(form.get("token"), token)) {
      return page("Link expired", "This setup link isn't valid. Ask Claude to run whoop_login again.", 403);
    }
    // "Use different credentials" from the almost-done page: e.g. WHOOP showed an error (wrong redirect URI,
    // rejected app) and never came back here. Drops the pending authorization; its state is no longer accepted.
    if (form.get("action") === "reset" && phase === "authorizing") {
      phase = "form";
      callback = null;
      return formPage({ token, redirectUri: opts.redirectUri, clientId: submitted?.creds.clientId });
    }
    if (phase !== "form") return page("Already submitted", "Setup is already in progress in another tab.", 409);

    const clientId = form.get("client_id")?.trim() ?? "";
    const clientSecret = form.get("client_secret")?.trim() ?? "";
    if (!clientId || !clientSecret) {
      return formPage({
        token,
        redirectUri: opts.redirectUri,
        clientId,
        error: "Enter both the Client ID and the Client Secret.",
      });
    }
    const creds = { clientId, clientSecret, redirectUri: opts.redirectUri };

    phase = "verifying";
    const result = await verify(creds);
    if (result.ok === false) {
      phase = "form";
      return formPage({
        token,
        redirectUri: opts.redirectUri,
        clientId,
        error: `${result.reason} Check both values and try again.`,
      });
    }
    if (result.ok === "unknown")
      log.warn("could not verify the WHOOP app credentials; continuing", { reason: result.reason });

    let saved: CredentialSource;
    try {
      saved = await save(creds);
    } catch (err) {
      phase = "form";
      return formPage({
        token,
        redirectUri: opts.redirectUri,
        clientId,
        error: `Couldn't save the credentials: ${(err as Error).message}`,
      });
    }
    submitted = { creds, saved };
    phase = "authorizing";
    const state = randomState(32);
    callback = oauthCallback(state, "You're all set. Close this tab and go back to Claude.");
    callback.result.then(authorized.resolve, authorized.reject);
    authorizeUrl = buildAuthorizeUrl({ creds, state });
    return Response.redirect(authorizeUrl, 303);
  };

  const server = listenLocal(
    redirect,
    (req) =>
      handle(req).catch((err: unknown) => {
        const message = (err as Error).message;
        if (/maxRequestBodySize/.test(message)) return page("Too large", "Request too large.", 413);
        log.error("setup page error", { error: message });
        return page("Something went wrong", "Unexpected error; check the MCP server log.", 500);
      }),
    { maxRequestBodySize: MAX_BODY_BYTES },
  );
  const timeout = setTimeout(
    () => authorized.reject(new Error("Timed out waiting for WHOOP setup to finish in the browser.")),
    opts.timeoutMs ?? 15 * 60_000,
  );

  const onAbort = () => authorized.reject(new Error("WHOOP setup was cancelled."));
  if (opts.signal?.aborted) onAbort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  const setupUrl = `http://${redirect.host}${SETUP_PATH}?t=${token}`;
  opts.onSetupUrl?.(setupUrl);
  if (opts.openBrowser ?? true) openUrl(setupUrl);

  try {
    const { code } = await authorized.promise;
    if (!submitted) throw new Error("WHOOP setup finished without credentials.");
    const { creds, saved } = submitted;
    return { creds, saved, tokens: await exchange(creds, code) };
  } finally {
    clearTimeout(timeout);
    opts.signal?.removeEventListener("abort", onAbort);
    server.stop();
  }
}
