import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type ClientCredentials,
  ConfigError,
  configDir,
  DEFAULT_REDIRECT_URI,
  envValue,
  loadClientCredentials,
} from "../config.ts";
import { errorFields, log } from "../log.ts";
import { keychain } from "./keychain.ts";
import { readPrivateText, writePrivateJson } from "./store.ts";

/**
 * Where the user's WHOOP developer-app credentials (client id + secret) live after setup: the macOS keychain
 * (keychain.ts), or a 0600 file in the config dir where there is no keychain (other platforms, tests). Env vars
 * still override both.
 */
export type CredentialSource = "env" | "keychain" | "file";

const ITEM = { service: "whoop-mcp", account: "client-credentials" } as const;

export function credentialFilePath(): string {
  return join(configDir(), "client.json");
}

/** Only macOS has the keychain; `WHOOP_MCP_CREDENTIAL_STORE=file` forces the file store there too (tests). */
function keychainEnabled(env = process.env): boolean {
  return process.platform === "darwin" && env.WHOOP_MCP_CREDENTIAL_STORE !== "file";
}

function parse(raw: string | null): ClientCredentials | null {
  if (!raw) return null;
  let c: Partial<ClientCredentials>;
  try {
    c = JSON.parse(raw) as Partial<ClientCredentials>;
  } catch {
    // Unreadable (hand-edited, truncated): treat as absent so whoop_login falls back to the setup page.
    log.warn("ignoring unreadable stored WHOOP app credentials");
    return null;
  }
  if (!c?.clientId || !c.clientSecret) return null;
  return { clientId: c.clientId, clientSecret: c.clientSecret, redirectUri: c.redirectUri || DEFAULT_REDIRECT_URI };
}

export async function readStoredCredentials(): Promise<{ creds: ClientCredentials; source: CredentialSource } | null> {
  if (keychainEnabled()) {
    try {
      const creds = parse(await keychain.get(ITEM));
      if (creds) return { creds, source: "keychain" };
    } catch (err) {
      // Locked, or the user clicked Deny on the access prompt; fall through to the file store.
      log.warn("couldn't read the WHOOP app credentials from the keychain", errorFields(err));
    }
  }
  const creds = parse(await readPrivateText(credentialFilePath()));
  return creds ? { creds, source: "file" } : null;
}

/** Saves to the keychain when possible, otherwise to the 0600 file. Returns where it went. */
export async function saveCredentials(creds: ClientCredentials): Promise<CredentialSource> {
  if (keychainEnabled()) {
    try {
      await keychain.set(ITEM, JSON.stringify(creds));
      // Don't leave an older plaintext copy behind once the keychain holds the credentials.
      await rm(credentialFilePath(), { force: true });
      return "keychain";
    } catch (err) {
      log.warn("couldn't save the WHOOP app credentials to the keychain; using a private file", errorFields(err));
      // An older keychain entry would win over the file on the next read, so remove it (best effort) rather
      // than silently keep using the old app.
      await keychain.delete(ITEM).catch(() => {});
    }
  }
  await writePrivateJson(credentialFilePath(), creds);
  return "file";
}

/**
 * Removes stored credentials from both stores. "failed" means the keychain holds them but refused to delete
 * them (locked, or the user clicked Deny), so the caller must not claim they're gone.
 */
export async function deleteStoredCredentials(): Promise<"deleted" | "none" | "failed"> {
  let result: "deleted" | "none" | "failed" = "none";
  if (keychainEnabled()) {
    // Delete without reading first: a read of an item an older build saved shows macOS's access prompt, and
    // a failed read (locked, denied) may hide a saved item anyway.
    try {
      if (await keychain.delete(ITEM)) result = "deleted";
    } catch (err) {
      log.warn("could not delete the WHOOP app credentials from the keychain", errorFields(err));
      result = "failed";
    }
  }
  if (existsSync(credentialFilePath())) {
    await rm(credentialFilePath(), { force: true });
    if (result === "none") result = "deleted";
  }
  return result;
}

/** Env vars win (handy for development), then whatever setup stored. */
export async function resolveClientCredentials(
  env = process.env,
): Promise<{ creds: ClientCredentials; source: CredentialSource }> {
  const fromEnv = loadClientCredentials(env);
  if (fromEnv) return { creds: fromEnv, source: "env" };
  const stored = await readStoredCredentials();
  if (stored) {
    // A redirect override still applies to stored credentials.
    const redirectUri = envValue(env.WHOOP_REDIRECT_URI);
    return redirectUri ? { ...stored, creds: { ...stored.creds, redirectUri } } : stored;
  }
  throw new ConfigError(
    "No WHOOP app credentials found. Use the whoop_login tool: it opens a setup page in the browser.",
  );
}
