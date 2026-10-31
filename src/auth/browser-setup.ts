import { timingSafeEqual } from "node:crypto";
import { openUrl } from "../cli/terminal.ts";
import { type ClientCredentials, missingScopes, missingScopesMessage, SCOPES } from "../config.ts";
import { log } from "../log.ts";
import { DASHBOARD_URL, PRIVACY_URL, type VerifyResult, verifyCredentials } from "../setup.ts";
import { type CredentialSource, saveCredentials } from "./credentials.ts";
import {
  explainOAuthError,
  listenLocal,
  PAGE_HEADERS,
  page,
  parseCallback,
  parseRedirect,
  wrongStatePage,
} from "./login.ts";
import {
  buildAuthorizeUrl,
  exchangeCode,
  randomState,
  randomToken,
  revokeAccess,
  type TokenResponse,
} from "./oauth.ts";
import { cspFor, escapeHtml, htmlPage, newNonce } from "./page-style.ts";

/**
 * First-run setup entirely in the browser, so connecting WHOOP never needs a terminal: a local page explains
 * how to create the WHOOP developer app, takes its Client ID and Secret (pasting anywhere on the page fills the
 * right box), checks them with WHOOP, saves them (keychain, else a 0600 file), and continues straight into
 * WHOOP's consent screen. The OAuth callback lands on the same local server, and the page follows the flow
 * through to "connected", so the user never has to report back to Claude.
 *
 * The page is only reachable on loopback, behind a one-time random token, and only accepts requests carrying
 * the expected Host and a same-origin Origin, so other websites (or DNS-rebinding tricks) can't use it. The
 * JSON endpoints also require the token in a header and a JSON content type, which other sites can't send
 * without a CORS preflight this server never answers.
 */
export const SETUP_PATH = "/setup";
const MAX_BODY_BYTES = 8 * 1024;
const CREATE_URL = `${DASHBOARD_URL}/apps/create`;
const VERIFY_LIMIT_PER_MINUTE = 10;

export type SetupPhase = "form" | "verifying" | "authorizing" | "exchanging" | "done" | "failed";

export interface BrowserSetupOptions {
  redirectUri: string;
  openBrowser?: boolean;
  /** Ends the flow when nobody has used the page for this long. */
  idleTimeoutMs?: number;
  /** Hard limit for the whole flow. */
  timeoutMs?: number;
  /** How long the page keeps answering after the flow ends, so the browser tab can show how it ended. */
  graceMs?: number;
  /** Cancels the flow and closes the local server at once (also during the grace period). */
  signal?: AbortSignal;
  /** Called once the server is listening, with the one-time setup URL to open. */
  onSetupUrl?: (url: string) => void;
  /** Progress for whoop_login: the step the user is on, and a problem the page is showing, if any. */
  onPhase?: (phase: SetupPhase, problem?: string) => void;
  /** Pre-fills the Client ID, e.g. from an earlier attempt. */
  clientId?: string;
  /** Saves the tokens; runs before the page says "connected", so a failed save is never shown as success. */
  persist?: (tokens: TokenResponse) => Promise<void>;
  /** Injectable for tests: revokes a token WHOOP issued with too few permissions. */
  revoke?: (accessToken: string) => Promise<unknown>;
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

type Field = "client_id" | "client_secret" | "both";
type SubmitOutcome =
  | { ok: true; authorizeUrl: string; warning?: string }
  | { ok: false; field: Field | null; message: string; status: number };

function sameSecret(a: string | null | undefined, b: string): boolean {
  if (a == null) return false;
  const [x, y] = [Buffer.from(a), Buffer.from(b)];
  return x.length === y.length && timingSafeEqual(x, y);
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });

function htmlResponse(html: string, nonce: string, status = 200): Response {
  return new Response(html, { status, headers: { ...PAGE_HEADERS, "Content-Security-Policy": cspFor(nonce) } });
}

/** A `<script>`-safe JSON literal. */
const scriptJson = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");

// ---------- pages ----------

const SETUP_CSS = `
main { max-width: 30rem; margin-top: 1.5rem; }
.steps { display: flex; gap: .5rem; list-style: none; padding: 0; margin: 1rem 0 1.25rem; font-size: .85rem; }
.steps li { flex: 1; padding: .35rem .5rem; border-radius: 6px; background: var(--card); color: var(--muted); text-align: center; }
.steps li[aria-current="step"] { background: var(--accent); color: var(--on-accent); font-weight: 600; }
.steps li.done { color: var(--ok); }
section { background: var(--card); border-radius: 12px; padding: 1rem 1.1rem; margin: 0 0 1rem; }
section[aria-disabled="true"] { opacity: .55; }
.callout { border-left: 3px solid var(--accent); padding-left: .65rem; margin: .75rem 0; }
.fields { width: 100%; border-collapse: collapse; margin: .5rem 0; }
.fields th, .fields td { text-align: left; vertical-align: top; padding: .45rem .5rem .45rem 0; border-top: 1px solid var(--line); }
.fields thead th { border-top: 0; font-size: .85rem; color: var(--muted); font-weight: 600; }
.fields tbody th { width: 8rem; font-weight: 600; } .fields td { overflow-wrap: anywhere; }
.fields tr.copied th::after { content: " ✓"; color: var(--ok); }
button.copy { padding: .2rem .55rem; font-size: .85rem; margin-left: .35rem; vertical-align: baseline; }
label { display: block; font-weight: 600; margin: .75rem 0 .25rem; }
input { width: 100%; font: inherit; padding: .55rem .65rem; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--fg); }
input[aria-invalid="true"] { border-color: var(--err); }
.secret { display: flex; gap: .4rem; } .secret input { flex: 1; }
.field-msg { min-height: 1.2em; margin: .2rem 0 0; font-size: .9rem; }
#status { min-height: 1.5em; margin: .75rem 0; }
.hint { background: var(--bg); border: 1px dashed var(--line); border-radius: 8px; padding: .5rem .7rem; }
.actions { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; margin-top: .75rem; }
`;

/** The setup wizard: create the app, paste the two codes, approve. Works without JavaScript as a plain form. */
function setupPage(opts: {
  token: string;
  redirectUri: string;
  phase: SetupPhase;
  clientId?: string;
  error?: { field: Field | null; message: string };
  keptSecretTail?: string;
  problem?: string;
}): Response {
  const esc = escapeHtml;
  const nonce = newNonce();
  const scopes = SCOPES.filter((s) => s !== "offline");
  const copyRow = (label: string, value: string, note = "") =>
    `<tr><th scope="row">${esc(label)}</th><td><code>${esc(value)}</code><button type="button" class="copy quiet" draggable="true" data-value="${esc(value)}" aria-label="Copy ${esc(label.toLowerCase())}">Copy</button>${note ? `<br><span class="small muted">${note}</span>` : ""}</td></tr>`;
  const textRow = (label: string, html: string) => `<tr><th scope="row">${esc(label)}</th><td>${html}</td></tr>`;
  const fieldMsg = (field: "client_id" | "client_secret") =>
    opts.error && (opts.error.field === field || opts.error.field === "both")
      ? `<p id="${field}_msg" class="field-msg err">${esc(opts.error.message)}</p>`
      : `<p id="${field}_msg" class="field-msg"></p>`;
  const invalid = (field: "client_id" | "client_secret") =>
    opts.error && (opts.error.field === field || opts.error.field === "both") ? ' aria-invalid="true"' : "";

  const body = `
<h1>Connect WHOOP to Claude</h1>
<p class="muted">About 5 minutes the first time: create a free WHOOP app, paste two codes, approve. WHOOP's terms
don't let open-source tools share one app, so you make your own; only you use it.</p>
<ol class="steps" aria-label="Progress">
  <li id="step1" aria-current="step">1 · Create app</li><li id="step2">2 · Paste codes</li><li id="step3">3 · Approve</li>
</ol>

<section id="s1" aria-labelledby="s1h">
  <h2 id="s1h">1. Create the app</h2>
  <p><a id="open-whoop" class="button" href="${esc(CREATE_URL)}" target="_blank" rel="noopener">Open WHOOP in a new tab</a></p>
  <p class="small muted">Sign in with your WHOOP account. Already have an app? Open it instead, add the Redirect URL
  below, and skip to step 2.</p>
  <p class="callout small">First time? WHOOP asks you to create a <b>Team</b>: name it anything, e.g. <i>personal</i>.</p>
  <p>Click <b>Create App</b> and fill in:</p>
  <table class="fields">
    <thead><tr><th scope="col">Field</th><th scope="col">What to enter</th></tr></thead>
    <tbody>
    ${copyRow("Name", "whoop-mcp")}
    ${textRow("Logo", '<span class="muted">leave empty</span>')}
    ${textRow("Contacts", "your email address")}
    ${copyRow("Privacy Policy", PRIVACY_URL)}
    ${copyRow("Redirect URLs", opts.redirectUri, "exactly this")}
    ${textRow("Scopes", `tick every box (${scopes.length}): <span class="small">${scopes.map((s) => esc(s)).join(", ")}</span>`)}
    ${textRow("Webhooks", '<span class="muted">leave empty</span>')}
    </tbody>
  </table>
  <p>Then click <b>Create App</b> at the bottom of WHOOP's form.</p>
</section>

<section id="s2" aria-labelledby="s2h">
  <h2 id="s2h">2. Paste the Client ID and Secret</h2>
  <p>WHOOP shows them on your app's page. Copy one, come back here and press
  <kbd class="paste-key">Ctrl+V</kbd> anywhere: it goes into the right box. Then the other. They're checked
  automatically.</p>
  <p id="paste-hint" class="hint small" hidden>Copied it? Press <kbd class="paste-key">Ctrl+V</kbd> anywhere on this page.</p>
  <form id="creds" method="post" action="${SETUP_PATH}" autocomplete="off" novalidate>
    <input type="hidden" name="token" value="${esc(opts.token)}">
    <label for="client_id">Client ID</label>
    <input id="client_id" name="client_id" spellcheck="false" autocapitalize="off" value="${esc(opts.clientId ?? "")}" aria-describedby="client_id_msg"${invalid("client_id")}>
    ${fieldMsg("client_id")}
    <label for="client_secret">Client Secret</label>
    <div class="secret">
      <input id="client_secret" name="client_secret" type="password" spellcheck="false" autocapitalize="off" aria-describedby="client_secret_msg"${invalid("client_secret")}${opts.keptSecretTail ? ` placeholder="Kept (ends …${esc(opts.keptSecretTail)}); leave empty to reuse"` : ""}>
      <button type="button" id="show-secret" class="quiet" aria-pressed="false" hidden>Show</button>
    </div>
    ${fieldMsg("client_secret")}
    <p id="status" role="status" aria-live="polite">${opts.error && opts.error.field === null ? `<span class="err">${esc(opts.error.message)}</span>` : ""}</p>
    <div class="actions">
      <button type="submit" id="save">Save and continue</button>
      <button type="button" id="cancel" class="quiet" hidden>Cancel</button>
    </div>
    <p class="small muted">Checked with WHOOP, then stored in your system keychain on this computer. Nothing is sent anywhere else.</p>
  </form>
</section>

<section id="s3" aria-labelledby="s3h">
  <h2 id="s3h">3. Approve access</h2>
  <p id="s3text">WHOOP asks you to approve access. After that you're done: Claude continues in the chat.</p>
  <div id="s3help"${opts.problem ? "" : " hidden"}>
    <p id="problem" class="err">${opts.problem ? esc(opts.problem) : "Did WHOOP show an error? Usually the Redirect URL isn't exactly the one above, or not every Scope is ticked."}</p>
    <div class="actions">
      <a class="button" href="${SETUP_PATH}/authorize?t=${esc(opts.token)}" id="retry">Try again</a>
      <form method="post" action="${SETUP_PATH}"><input type="hidden" name="token" value="${esc(opts.token)}"><input type="hidden" name="action" value="reset"><button type="submit" class="quiet">Use different credentials</button></form>
    </div>
  </div>
</section>`;

  const script = `
"use strict";
const C = ${scriptJson({ token: opts.token, phase: opts.phase, problem: opts.problem ?? null, keptSecret: Boolean(opts.keptSecretTail) })};
const $ = (id) => document.getElementById(id);
const id = $("client_id"), secret = $("client_secret"), statusEl = $("status");
const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
for (const k of document.querySelectorAll(".paste-key")) k.textContent = mac ? "⌘V" : "Ctrl+V";
let authorizeUrl = null, verifiedFor = null, goTimer = null, verifyTimer = null, verifying = false, polling = false;
const values = () => id.value.trim() + "\\n" + secret.value.trim();

function setStep(n) {
  for (const i of [1, 2, 3]) {
    const li = $("step" + i);
    if (i === n) li.setAttribute("aria-current", "step"); else li.removeAttribute("aria-current");
    li.classList.toggle("done", i < n);
  }
}
function say(text, cls) {
  statusEl.textContent = "";
  const span = document.createElement("span");
  if (cls) span.className = cls;
  span.textContent = text;
  statusEl.append(span);
}
function fieldError(field, message) {
  for (const [el, name] of [[id, "client_id"], [secret, "client_secret"]]) {
    const bad = field === name || field === "both";
    el.setAttribute("aria-invalid", bad ? "true" : "false");
    const msg = $(name + "_msg");
    msg.textContent = bad ? message : "";
    msg.className = "field-msg" + (bad ? " err" : "");
  }
}

const copyButtons = [...document.querySelectorAll("button.copy")];
copyButtons.forEach((b, i) => {
  b.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(b.dataset.value); }
    catch { const r = document.createRange(); r.selectNodeContents(b.previousElementSibling); getSelection().removeAllRanges(); getSelection().addRange(r); }
    b.textContent = "Copied ✓";
    b.closest("tr").classList.add("copied");
    setTimeout(() => { b.textContent = "Copy"; }, 2000);
    copyButtons[i + 1]?.focus({ preventScroll: true });
  });
  b.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/plain", b.dataset.value));
});

// Step 2: paste anywhere. Two values at once fill both boxes; a single value goes by its shape (WHOOP's IDs
// are UUIDs, secrets long strings), else into the box being pasted into, else the empty box.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function distribute(text, target) {
  const t = text.trim();
  if (!t) return;
  const labelled = /client\\s*id\\W*(\\S+)[\\s\\S]*?client\\s*secret\\W*(\\S+)/i.exec(t);
  const parts = t.split(/\\s+/);
  if (labelled) { id.value = labelled[1]; secret.value = labelled[2]; }
  else if (parts.length === 2) {
    const [a, b] = UUID.test(parts[1]) && !UUID.test(parts[0]) ? [parts[1], parts[0]] : parts;
    id.value = a; secret.value = b;
  }
  else if (UUID.test(t)) id.value = t;
  else if (t.length >= 40) secret.value = t;
  else if (target === id || target === secret) target.value = t;
  else if (!id.value) id.value = t;
  else secret.value = t;
  setStep(2);
  $("paste-hint").hidden = true;
  changed();
  scheduleVerify(300);
}
document.addEventListener("paste", (e) => {
  const text = e.clipboardData && e.clipboardData.getData("text");
  if (!text) return;
  e.preventDefault();
  distribute(text, e.target);
});
// WebKit only offers paste on non-editable content when this is cancelled.
document.addEventListener("beforepaste", (e) => e.preventDefault());
// After a check succeeded, editing either box means the new values need checking.
function changed() {
  if (verifiedFor !== null && values() !== verifiedFor) {
    authorizeUrl = null; verifiedFor = null;
    clearTimeout(goTimer);
    $("cancel").hidden = true;
  }
}
for (const el of [id, secret]) el.addEventListener("input", () => { changed(); scheduleVerify(600); });
// Coming back from WHOOP's window with a box still empty: remind where to paste.
let away = false;
window.addEventListener("blur", () => { away = true; });
window.addEventListener("focus", () => {
  if (away) $("paste-hint").hidden = !!(id.value && secret.value) || !!authorizeUrl;
});

const show = $("show-secret");
show.hidden = false;
show.addEventListener("click", () => {
  const visible = secret.type === "text";
  secret.type = visible ? "password" : "text";
  show.textContent = visible ? "Show" : "Hide";
  show.setAttribute("aria-pressed", String(!visible));
});

const secretOk = () => secret.value.trim() || C.keptSecret;
function scheduleVerify(ms) {
  clearTimeout(verifyTimer);
  if (id.value.trim() && secret.value.trim()) verifyTimer = setTimeout(() => verify(false), ms);
}
async function verify(explicit) {
  if (authorizeUrl) return;
  if (verifying) { scheduleVerify(400); return; } // checked again once the current check returns
  verifying = true;
  const sent = values();
  fieldError(null, "");
  say("Checking with WHOOP…");
  try {
    const res = await fetch(${scriptJson(`${SETUP_PATH}/verify`)}, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Setup-Token": C.token },
      body: JSON.stringify({ client_id: id.value.trim(), client_secret: secret.value.trim() }),
    });
    const data = await res.json();
    if (values() !== sent) return scheduleVerify(300); // the boxes changed meanwhile: check the new values
    if (!data.ok) {
      fieldError(data.field, data.message);
      say(data.message, "err");
      // Only on an explicit Save: moving focus during automatic checks would capture the next paste.
      if (explicit) { const el = data.field === "client_id" ? id : secret; el.focus(); el.select(); }
      return;
    }
    authorizeUrl = data.authorize_url;
    verifiedFor = sent;
    $("paste-hint").hidden = true;
    say((data.warning ? data.warning + " " : "") + "Saved. Opening WHOOP to approve access…", "ok");
    $("cancel").hidden = false;
    goTimer = setTimeout(go, 1500);
  } catch {
    say("Couldn't reach this page's server. Is Claude still open?", "err");
  } finally {
    verifying = false;
  }
}
$("cancel").addEventListener("click", () => {
  clearTimeout(goTimer);
  $("cancel").hidden = true;
  say("Paused. Press Save and continue when you're ready.");
});
$("creds").addEventListener("submit", (e) => {
  e.preventDefault();
  if (authorizeUrl) return go();
  if (!id.value.trim() || !secretOk()) {
    fieldError(!id.value.trim() ? "client_id" : "client_secret", "Paste this one from your WHOOP app.");
    return;
  }
  verify(true);
});

// Step 3: approve in WHOOP. WHOOP then returns to this server, whose page follows the flow to the end.
function go() {
  clearTimeout(goTimer);
  $("cancel").hidden = true;
  setStep(3);
  location.href = authorizeUrl;
}
async function poll() {
  if (polling) return;
  polling = true;
  const started = Date.now();
  // Polling isn't activity, so the server's idle timeout still ends an abandoned setup; stop after 30 min.
  while (Date.now() - started < 30 * 60000) {
    await new Promise((r) => setTimeout(r, 2000));
    let s;
    try {
      const res = await fetch(${scriptJson(`${SETUP_PATH}/status`)}, { headers: { "X-Setup-Token": C.token } });
      s = await res.json();
    } catch {
      // The server closes a minute after finishing.
      $("s3text").textContent = "This page's server has closed. Check the chat in Claude.";
      return;
    }
    if (s.phase === "done") {
      $("s3text").textContent = "✓ WHOOP is connected. Claude is continuing in the chat; you can close this tab.";
      $("s3text").className = "ok";
      $("s3help").hidden = true;
      return;
    }
    if (s.phase === "failed") {
      $("s3text").textContent = s.problem || "The connection failed. Ask Claude to try again.";
      $("s3text").className = "err";
      return;
    }
    if (s.problem) { $("problem").textContent = s.problem; $("s3help").hidden = false; }
    else if (Date.now() - started > 90000) $("s3help").hidden = false;
  }
}
// Back from WHOOP via the Back button: the browser may restore this page as it was, with an approval link the
// server has since replaced. Load it fresh instead.
window.addEventListener("pageshow", (e) => { if (e.persisted) location.reload(); });
if (C.phase === "authorizing" || C.phase === "exchanging") { setStep(3); poll(); }
else if (id.value) setStep(2);
`;
  return htmlResponse(
    htmlPage({ title: "Connect WHOOP", nonce, css: SETUP_CSS, body, script }),
    nonce,
    opts.error ? 400 : 200,
  );
}

/** Where WHOOP sends the browser after approval: follows the token exchange instead of claiming success early. */
function finishingPage(token: string): Response {
  const nonce = newNonce();
  const esc = escapeHtml;
  const body = `<h1 id="title">Finishing…</h1>
<p id="text">WHOOP approved access. Connecting…</p>
<div id="retry" class="actions" hidden><a class="button" href="${SETUP_PATH}/authorize?t=${esc(token)}">Try again</a>
<a class="button quiet" href="${SETUP_PATH}?t=${esc(token)}">Back to setup</a></div>
<noscript><p><a href="${SETUP_PATH}/done?t=${escapeHtml(token)}">Check whether it worked</a></p></noscript>`;
  const script = `
"use strict";
const token = ${scriptJson(token)};
(async () => {
  for (let i = 0; i < 30; i++) {
    let s;
    try {
      s = await (await fetch(${scriptJson(`${SETUP_PATH}/status`)}, { headers: { "X-Setup-Token": token } })).json();
    } catch { break; }
    if (s.phase === "done") {
      document.getElementById("title").textContent = "✓ WHOOP connected";
      document.getElementById("text").textContent = "Claude is continuing in the chat. You can close this tab.";
      // Closes only a window a script opened; a normal tab just stays.
      if (window.opener) setTimeout(() => window.close(), 1500);
      return;
    }
    if (s.phase === "failed") {
      document.getElementById("title").textContent = "WHOOP didn't connect";
      document.getElementById("text").textContent = s.problem || "Ask Claude to try again.";
      return;
    }
    // Back to approving with a problem, e.g. not every permission granted: fix it and try again from here.
    if (s.phase === "authorizing" && s.problem) {
      document.getElementById("title").textContent = "WHOOP didn't connect";
      document.getElementById("text").textContent = s.problem;
      document.getElementById("retry").hidden = false;
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  document.getElementById("text").textContent = "Check the chat in Claude to see whether it worked.";
})();`;
  return htmlResponse(htmlPage({ title: "Connecting WHOOP", nonce, body, script, css: SETUP_CSS }), nonce);
}

/** The callback after WHOOP refused (bad redirect URL, unknown client, denied): fix and retry from here. */
function callbackProblemPage(token: string, problem: string): Response {
  const esc = escapeHtml;
  const nonce = newNonce();
  const body = `<h1 class="err">WHOOP didn't connect</h1>
<p>${esc(problem)}</p>
<p class="small muted">Fix it in the WHOOP developer dashboard if needed, then:</p>
<div class="actions"><a class="button" href="${SETUP_PATH}/authorize?t=${esc(token)}">Try again</a>
<a class="button quiet" href="${SETUP_PATH}?t=${esc(token)}">Back to setup</a></div>`;
  return htmlResponse(htmlPage({ title: "WHOOP didn't connect", nonce, body, css: SETUP_CSS }), nonce);
}

// ---------- the flow ----------

export async function browserSetup(opts: BrowserSetupOptions): Promise<BrowserSetupResult> {
  const redirect = parseRedirect(opts.redirectUri);
  const verifyCreds = opts.verify ?? verifyCredentials;
  const save = opts.save ?? saveCredentials;
  const exchange = opts.exchange ?? ((creds, code) => exchangeCode(creds, code));
  const revoke = opts.revoke ?? revokeAccess;
  const idleMs = opts.idleTimeoutMs ?? 20 * 60_000;
  const graceMs = opts.graceMs ?? 60_000;

  const port = Number(redirect.port || 80);
  // Browsers omit the default port from Host/Origin, so a portless redirect URI means bare hostnames.
  const hostForms = ["localhost", "127.0.0.1", "[::1]"];
  const allowedHosts = new Set(redirect.port ? hostForms.map((h) => `${h}:${port}`) : hostForms);
  const allowedOrigins = new Set([...allowedHosts].map((h) => `http://${h}`));
  const token = randomToken(32);

  let phase: SetupPhase = "form";
  let problem: string | undefined;
  let submitted: { creds: ClientCredentials; saved: CredentialSource } | null = null;
  let authorization: { state: string; url: string } | null = null;
  let inFlight: { clientId: string; secret: string; outcome: Promise<SubmitOutcome> } | null = null;
  // The last secret that failed a check, kept (in memory only) so the no-JavaScript form needn't ask again.
  let keptSecret: string | null = null;
  let lastClientId = opts.clientId;
  const verifyTimes: number[] = [];
  // Settles with WHOOP's authorization code once the user approved, or rejects on cancel or a timeout.
  const authorized = Promise.withResolvers<{ tokens: TokenResponse }>();
  // Set once the flow is over (cancelled or timed out): a code exchange still running must then not save.
  let ended = false;
  const end = (err: Error) => {
    ended = true;
    authorized.reject(err);
  };
  let finishing: Promise<void> | null = null;

  const setPhase = (next: SetupPhase, nextProblem?: string) => {
    phase = next;
    problem = nextProblem;
    if (next === "authorizing") clearTimeout(idleTimer); // see touch()
    opts.onPhase?.(phase, problem);
  };

  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const touch = () => {
    clearTimeout(idleTimer);
    // While approving, the user is on WHOOP's pages (sign-in, two-factor), which this server can't see; the
    // overall timeout still ends an abandoned approval.
    if (phase === "done" || phase === "failed" || phase === "authorizing") return;
    idleTimer = setTimeout(() => end(new Error("The WHOOP setup page wasn't used for a while, so it closed.")), idleMs);
  };

  const authorize = (creds: ClientCredentials) => {
    const state = randomState();
    authorization = { state, url: buildAuthorizeUrl({ creds, state }) };
    setPhase("authorizing");
    return authorization.url;
  };

  /** Checks, saves and starts authorizing. Idempotent for the same credentials (double clicks, two tabs). */
  const submit = async (clientId: string, clientSecret: string): Promise<SubmitOutcome> => {
    if (ended)
      return {
        ok: false,
        field: null,
        message: "This page has closed. Ask Claude to connect WHOOP again.",
        status: 410,
      };
    if (inFlight) {
      if (inFlight.clientId === clientId && sameSecret(inFlight.secret, clientSecret)) return inFlight.outcome;
      return {
        ok: false,
        field: null,
        message: "Still checking the previous values; try again in a moment.",
        status: 409,
      };
    }
    if (phase === "exchanging" || phase === "done") {
      return { ok: false, field: null, message: "WHOOP is already connecting; check Claude.", status: 409 };
    }
    if (
      phase === "authorizing" &&
      authorization &&
      submitted?.creds.clientId === clientId &&
      sameSecret(submitted.creds.clientSecret, clientSecret)
    ) {
      return { ok: true, authorizeUrl: authorization.url };
    }
    if (!clientId || !clientSecret) {
      const field: Field = !clientId && !clientSecret ? "both" : !clientId ? "client_id" : "client_secret";
      return { ok: false, field, message: "Paste both the Client ID and the Client Secret.", status: 400 };
    }
    // One limit for every path that asks WHOOP to check credentials (the page's script and the plain form).
    const now = Date.now();
    while (verifyTimes.length && now - verifyTimes[0]! > 60_000) verifyTimes.shift();
    if (verifyTimes.length >= VERIFY_LIMIT_PER_MINUTE) {
      return { ok: false, field: null, message: "Too many tries; wait a minute.", status: 429 };
    }
    verifyTimes.push(now);
    const outcome = (async (): Promise<SubmitOutcome> => {
      const creds = { clientId, clientSecret, redirectUri: opts.redirectUri };
      lastClientId = clientId;
      // New credentials replace any approval in progress: a late callback for it must not be accepted.
      authorization = null;
      setPhase("verifying");
      const result = await verifyCreds(creds);
      // Cancelled (e.g. the user disconnected) while WHOOP was checking them: save nothing, change nothing.
      if (ended)
        return {
          ok: false,
          field: null,
          message: "This page has closed. Ask Claude to connect WHOOP again.",
          status: 410,
        };
      if (result.ok === false) {
        keptSecret = clientSecret;
        setPhase("form");
        return {
          ok: false,
          field: "both",
          message: "WHOOP didn't accept this Client ID and Secret. Copy both again from your app's page.",
          status: 400,
        };
      }
      let warning: string | undefined;
      if (result.ok === "unknown") {
        log.warn("could not verify the WHOOP app credentials; continuing", { reason: result.reason });
        warning = "Couldn't check them with WHOOP right now; continuing anyway.";
      }
      try {
        const saved = await save(creds);
        // Cancelled during the save: whoever cancelled waits for this submit, then deals with what was saved.
        if (ended)
          return {
            ok: false,
            field: null,
            message: "This page has closed. Ask Claude to connect WHOOP again.",
            status: 410,
          };
        submitted = { creds, saved };
      } catch (err) {
        keptSecret = clientSecret;
        setPhase("form");
        return { ok: false, field: null, message: `Couldn't save them: ${(err as Error).message}`, status: 500 };
      }
      keptSecret = null;
      return { ok: true, authorizeUrl: authorize(creds), ...(warning ? { warning } : {}) };
    })();
    inFlight = { clientId, secret: clientSecret, outcome };
    try {
      return await outcome;
    } finally {
      inFlight = null;
    }
  };

  /**
   * After WHOOP approved: exchange the code, insist on every permission, save, and only then report "done".
   * A partial grant is revoked and leaves the flow open, so the user can approve again from the page.
   */
  const finish = async (code: string) => {
    if (!submitted) return authorized.reject(new Error("WHOOP setup finished without credentials."));
    let tokens: TokenResponse;
    try {
      tokens = await exchange(submitted.creds, code);
      if (ended) {
        // Cancelled (e.g. the user disconnected) while WHOOP was answering: undo the grant, save nothing.
        await revoke(tokens.access_token);
        return;
      }
    } catch (err) {
      setPhase("failed", "WHOOP approved access, but finishing the connection failed. Ask Claude to try again.");
      return authorized.reject(err);
    }
    const missing = missingScopes(tokens.scope);
    if (missing.length) {
      log.warn("WHOOP granted only some permissions; not connecting", { missing });
      await revoke(tokens.access_token);
      // That approval is used up; Try again starts a new one, and a reload of this callback does nothing.
      authorization = null;
      touch();
      return setPhase("authorizing", missingScopesMessage(missing));
    }
    try {
      await opts.persist?.(tokens);
    } catch (err) {
      setPhase("failed", "WHOOP approved access, but saving the login failed. Ask Claude to try again.");
      return authorized.reject(err);
    }
    setPhase("done");
    authorized.resolve({ tokens });
  };

  const tokenOk = (req: Request, url: URL) =>
    sameSecret(req.headers.get("x-setup-token") ?? url.searchParams.get("t"), token);
  const expired = () =>
    page("Link expired", "This setup link isn't valid any more. Ask Claude to connect WHOOP again.", 403, "err");
  const pageNow = (extra: { error?: { field: Field | null; message: string } } = {}) =>
    setupPage({
      token,
      redirectUri: opts.redirectUri,
      phase,
      clientId: lastClientId,
      keptSecretTail: keptSecret ? keptSecret.slice(-4) : undefined,
      problem,
      ...extra,
    });

  let closing = false; // after the flow ended: answer only status, done and the callback
  const handle = async (req: Request): Promise<Response> => {
    // DNS rebinding: a hostile domain resolving to 127.0.0.1 would arrive with its own Host header.
    if (!allowedHosts.has(req.headers.get("host") ?? "")) return new Response("Misdirected request", { status: 421 });
    const url = new URL(req.url);

    if (url.pathname === redirect.pathname) {
      if (!authorization) {
        // No token-bearing links here: without a pending approval this request's state can't be checked.
        return problem
          ? page(
              "Already handled",
              "This WHOOP approval was already handled. Use the setup tab to try again.",
              409,
              "err",
            )
          : page("Not ready", "Finish the setup page first.", 409, "err");
      }
      const outcome = parseCallback(url, authorization.state);
      // Changes nothing: any web page can send a browser here.
      if (outcome.kind === "wrong-state") return wrongStatePage(url);
      if (closing) return finishingPage(token);
      touch();
      if (outcome.kind === "code") {
        // A reload or second request of the same callback must not exchange the (single-use) code again.
        if (phase === "exchanging" || phase === "done") return finishingPage(token);
        setPhase("exchanging");
        finishing = finish(outcome.code);
        return finishingPage(token);
      }
      // WHOOP refused (wrong redirect URL, unknown client, access denied): keep the flow alive so the user can
      // fix it and retry from the page, instead of starting over.
      const why =
        outcome.kind === "error"
          ? explainOAuthError(outcome.error, outcome.description)
          : "WHOOP sent no authorization code.";
      log.warn("WHOOP refused the authorization", { error: outcome.kind === "error" ? outcome.error : "no code" });
      setPhase("authorizing", why);
      return callbackProblemPage(token, why);
    }

    if (url.pathname === `${SETUP_PATH}/status` && req.method === "GET") {
      if (!tokenOk(req, url)) return json({ error: "forbidden" }, 403);
      // Not activity: an open tab polling must not keep an abandoned setup alive past the idle timeout.
      // Never the secret, the tokens or the OAuth state.
      return json({ phase, ...(problem ? { problem } : {}), client_id_saved: submitted !== null });
    }
    if (url.pathname === `${SETUP_PATH}/done` && req.method === "GET") {
      if (!tokenOk(req, url)) return expired();
      if (phase === "done")
        return page("WHOOP connected", "Claude is continuing in the chat. You can close this tab.", 200, "ok");
      if (phase === "failed") return page("WHOOP didn't connect", problem ?? "Ask Claude to try again.", 200, "err");
      if (phase === "authorizing" && problem) return callbackProblemPage(token, problem);
      return finishingPage(token);
    }
    if (closing) return page("Finished", "This setup has finished. Check the chat in Claude.", 410);

    if (url.pathname === `${SETUP_PATH}/authorize` && req.method === "GET") {
      if (!tokenOk(req, url)) return expired();
      if (!submitted) return Response.redirect(`${SETUP_PATH}?t=${token}`, 303);
      if (phase === "exchanging" || phase === "done") return finishingPage(token);
      touch();
      // A new approval (new state) only after WHOOP refused one; otherwise reuse the pending one, so an
      // approval the user is still completing in another window stays valid.
      if (phase === "authorizing" && authorization && !problem) return Response.redirect(authorization.url, 303);
      return Response.redirect(authorize(submitted.creds), 303);
    }

    if (url.pathname === `${SETUP_PATH}/verify`) {
      if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
      const origin = req.headers.get("origin");
      if (!origin || !allowedOrigins.has(origin)) return json({ error: "cross-site request refused" }, 403);
      if (!(req.headers.get("content-type") ?? "").startsWith("application/json")) {
        return json({ error: "JSON only" }, 415);
      }
      if (!tokenOk(req, url)) return json({ error: "forbidden" }, 403);
      touch();
      const text = await req.text();
      if (text.length > MAX_BODY_BYTES) return json({ error: "too large" }, 413);
      let body: { client_id?: unknown; client_secret?: unknown };
      try {
        body = JSON.parse(text);
      } catch {
        return json({ error: "bad JSON" }, 400);
      }
      // An empty secret reuses the one kept from a failed attempt (the page says so).
      const outcome = await submit(
        String(body.client_id ?? "").trim(),
        String(body.client_secret ?? "").trim() || keptSecret || "",
      );
      if (outcome.ok) {
        return json({
          ok: true,
          authorize_url: outcome.authorizeUrl,
          ...(outcome.warning ? { warning: outcome.warning } : {}),
        });
      }
      return json({ ok: false, field: outcome.field, message: outcome.message }, outcome.status);
    }

    if (url.pathname !== SETUP_PATH) return new Response("Not found", { status: 404 });

    if (req.method === "GET") {
      if (!tokenOk(req, url)) return expired();
      touch();
      return pageNow();
    }
    if (req.method !== "POST")
      return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST" } });

    // CSRF: browsers always send Origin on form POSTs; other sites' (or opaque "null") origins are refused.
    const origin = req.headers.get("origin");
    if (!origin || !allowedOrigins.has(origin)) return page("Forbidden", "Cross-site request refused.", 403, "err");
    if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES)
      return page("Too large", "Request too large.", 413);
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) return page("Too large", "Request too large.", 413);
    const form = new URLSearchParams(text);
    if (!sameSecret(form.get("token"), token)) return expired();
    touch();
    // "Use different credentials": e.g. WHOOP showed an error and the app needs replacing. Drops the pending
    // authorization; its state is no longer accepted.
    if (form.get("action") === "reset") {
      if (phase === "authorizing") {
        authorization = null;
        setPhase("form");
      }
      return pageNow();
    }
    const clientId = form.get("client_id")?.trim() ?? "";
    // An empty secret box reuses the one kept from a failed attempt (the page says so).
    const clientSecret = form.get("client_secret")?.trim() || keptSecret || "";
    const outcome = await submit(clientId, clientSecret);
    if (outcome.ok) return Response.redirect(outcome.authorizeUrl, 303);
    if (clientId) lastClientId = clientId;
    if (outcome.status === 409) return page("Already in progress", outcome.message, 409, "err");
    if (outcome.status === 410) return page("This page has closed", outcome.message, 410, "err");
    if (outcome.status === 429) return page("Too many tries", outcome.message, 429, "err");
    return pageNow({ error: { field: outcome.field, message: outcome.message } });
  };

  const server = await listenLocal(
    redirect,
    (req) =>
      handle(req).catch((err: unknown) => {
        const message = (err as Error).message;
        if (/maxRequestBodySize/.test(message)) return page("Too large", "Request too large.", 413);
        log.error("setup page error", { error: message });
        return page("Something went wrong", "Unexpected error; check the whoop-mcp log.", 500, "err");
      }),
    { maxRequestBodySize: MAX_BODY_BYTES },
  );
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    server.stop();
  };

  const hardTimeout = setTimeout(
    () => end(new Error("Timed out waiting for WHOOP setup to finish in the browser.")),
    opts.timeoutMs ?? 60 * 60_000,
  );
  const onAbort = () => {
    end(new Error("WHOOP setup was cancelled."));
    stop(); // also ends the grace period, so the port is free for the next login at once
  };
  if (opts.signal?.aborted) onAbort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  touch();

  const setupUrl = `http://${redirect.host}${SETUP_PATH}?t=${token}`;
  opts.onSetupUrl?.(setupUrl);
  if (opts.openBrowser ?? true) openUrl(setupUrl);

  try {
    const { tokens } = await authorized.promise;
    if (!submitted) throw new Error("WHOOP setup finished without credentials.");
    const { creds, saved } = submitted;
    return { creds, saved, tokens };
  } catch (err) {
    // (phase changes inside the request handlers, which TypeScript's narrowing can't see)
    const ended = phase as SetupPhase;
    if (ended !== "failed" && ended !== "done") setPhase("failed", (err as Error).message);
    throw err;
  } finally {
    clearTimeout(hardTimeout);
    clearTimeout(idleTimer);
    // A cancel waits for a form submit or an exchange in flight (which then save nothing, or revoke), so
    // whoever cancelled, e.g. whoop_disconnect, can be sure no credentials or login appear afterwards.
    await (inFlight as { outcome: Promise<SubmitOutcome> } | null)?.outcome.catch(() => {});
    await (finishing as Promise<void> | null)?.catch(() => {});
    // Keep answering status for a while, so the browser tab can show how it ended; cancel stops it early.
    closing = true;
    if (opts.signal?.aborted) stop();
    else setTimeout(stop, graceMs).unref();
  }
}
