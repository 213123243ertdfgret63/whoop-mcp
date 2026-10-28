import { type CredentialSource, readStoredCredentials, saveCredentials } from "./auth/credentials.ts";
import { login } from "./auth/login.ts";
import { toStored } from "./auth/oauth.ts";
import { tokenPath, writeTokens } from "./auth/store.ts";
import type { PromptIO } from "./cli/terminal.ts";
import { type ClientCredentials, DEFAULT_REDIRECT_URI, SCOPES, WHOOP } from "./config.ts";

export const DASHBOARD_URL = "https://developer-dashboard.whoop.com";
// WHOOP's app form requires a privacy policy URL; the README explains that data stays on this computer.
export const PRIVACY_URL = "https://github.com/213123243ertdfgret63/whoop-mcp#connect-your-whoop-account";
const MAX_ATTEMPTS = 3;

export type VerifyResult = { ok: true } | { ok: false; reason: string } | { ok: "unknown"; reason: string };

/**
 * Checks a client id/secret pair without a browser: a refresh with a dummy token fails either as
 * `invalid_client` (bad id or secret) or with a grant error (the client authenticated fine).
 */
export async function verifyCredentials(creds: ClientCredentials): Promise<VerifyResult> {
  let res: Response;
  try {
    res = await fetch(WHOOP.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: "whoop-mcp-setup-check",
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return { ok: "unknown", reason: `could not reach WHOOP (${(err as Error).message})` };
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string; error_description?: string };
  if (body.error === "invalid_client") return { ok: false, reason: "WHOOP rejected the client ID or secret." };
  // The fake refresh token must be refused as a bad grant; only that proves the client itself was accepted.
  // A firewall 403, a 429 or an HTML error page says nothing about the credentials.
  if (body.error === "invalid_grant" || body.error === "unsupported_grant_type" || body.error === "invalid_request")
    return { ok: true };
  return { ok: "unknown", reason: `WHOOP returned ${res.status}${body.error ? ` (${body.error})` : ""}` };
}

/** Browser login with the given app credentials; saves the tokens and reports missing scopes. */
export async function loginAndSave(
  creds: ClientCredentials,
  print: (text: string) => void,
  opts: { openBrowser?: boolean } = {},
): Promise<void> {
  const { tokens } = await login(creds, { openBrowser: opts.openBrowser ?? true });
  await writeTokens(toStored(tokens));
  print(`Logged in. Tokens saved to ${tokenPath()}.`);
  const granted = tokens.scope?.split(/\s+/) ?? [];
  const missing = SCOPES.filter((s) => !granted.includes(s));
  if (missing.length) print(`Warning: these scopes were not granted: ${missing.join(", ")}`);
}

export interface SetupOptions {
  openBrowser: boolean;
  verify: boolean;
  login: boolean;
  redirectUri?: string;
  /** Injectable for tests. */
  verifyCredentials?: (creds: ClientCredentials) => Promise<VerifyResult>;
  runLogin?: (creds: ClientCredentials) => Promise<void>;
}

export interface SetupResult {
  saved: CredentialSource | null;
  loggedIn: boolean;
}

const yes = (answer: string) => /^y(es)?$/i.test(answer);

export async function runSetup(io: PromptIO, opts: SetupOptions): Promise<SetupResult> {
  const redirectUri = opts.redirectUri ?? DEFAULT_REDIRECT_URI;
  const verify = opts.verifyCredentials ?? verifyCredentials;
  const runLogin = opts.runLogin ?? ((creds) => loginAndSave(creds, io.print, { openBrowser: opts.openBrowser }));

  let creds: ClientCredentials | null = null;
  let saved: CredentialSource | null = null;

  const existing = await readStoredCredentials();
  if (existing) {
    const hint = existing.creds.clientId.slice(-4);
    const answer = await io.ask(
      `WHOOP app credentials are already saved (${existing.source}, client ID …${hint}). Replace them? [y/N] `,
    );
    if (!yes(answer)) creds = { ...existing.creds, redirectUri };
  }

  if (!creds) {
    io.print(
      [
        "whoop-mcp connects to WHOOP through your own (free) WHOOP developer app.",
        "",
        `1. Open ${DASHBOARD_URL} and sign in. If asked to create a Team, name it anything.`,
        "   Click Create App and fill in the form:",
        "   Name:           anything, for example whoop-mcp",
        "   Logo:           leave empty",
        "   Contacts:       your own email address",
        `   Privacy policy: ${PRIVACY_URL}`,
        `   Redirect URLs:  ${redirectUri}   (exactly this)`,
        `   Scopes:         tick every box (${SCOPES.filter((s) => s !== "offline").join(", ")})`,
        "   Webhooks:       leave empty",
        "   Then click Create App.",
        "2. Copy the app's Client ID and Client Secret below.",
        "",
      ].join("\n"),
    );
    if (opts.openBrowser) io.openUrl(DASHBOARD_URL);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !creds; attempt++) {
      const clientId = await io.ask("Client ID: ");
      const clientSecret = await io.askSecret("Client Secret (hidden): ");
      if (!clientId || !clientSecret) {
        io.print("Both the Client ID and Client Secret are required.");
        continue;
      }
      const candidate = { clientId, clientSecret, redirectUri };
      if (opts.verify) {
        const result = await verify(candidate);
        if (result.ok === false) {
          io.print(`${result.reason} Check for extra characters and try again.`);
          continue;
        }
        io.print(
          result.ok === true
            ? "Credentials verified with WHOOP."
            : `Could not verify credentials: ${result.reason}. Saving anyway.`,
        );
      }
      creds = candidate;
    }
    if (!creds) throw new Error(`Gave up after ${MAX_ATTEMPTS} attempts; nothing was saved.`);

    saved = await saveCredentials(creds);
    io.print(
      saved === "keychain"
        ? "Saved to your system keychain (service: whoop-mcp)."
        : "Saved to a private file in your config folder (keychain unavailable or disabled).",
    );
  }

  if (!opts.login) {
    io.print("Skipping login. Run `whoop-mcp login` when you're ready.");
    return { saved, loggedIn: false };
  }
  io.print(
    `\nOpening WHOOP to authorize access. If WHOOP shows a redirect_uri error, make sure the app's redirect URI is exactly ${redirectUri}.`,
  );
  await runLogin(creds);
  return { saved, loggedIn: true };
}
