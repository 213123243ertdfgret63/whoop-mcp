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
import { readPrivateJson, writePrivateJson } from "./store.ts";

/**
 * Where the user's WHOOP developer-app credentials (client id + secret) live after `whoop-mcp setup`.
 * The OS keychain is preferred; Bun.secrets is experimental and needs a secret service on Linux,
 * so a 0600 file in the config dir is the fallback. Env vars still override both.
 */
export type CredentialSource = "env" | "keychain" | "file";

const KEYCHAIN = { service: "whoop-mcp", name: "client-credentials" } as const;

export function credentialFilePath(): string {
  return join(configDir(), "client.json");
}

/** `WHOOP_MCP_CREDENTIAL_STORE=file` forces the file store (tests, headless Linux without a keyring). */
function keychainEnabled(env = process.env): boolean {
  return env.WHOOP_MCP_CREDENTIAL_STORE !== "file";
}

function parse(raw: string | null): ClientCredentials | null {
  if (!raw) return null;
  const c = JSON.parse(raw) as Partial<ClientCredentials>;
  if (!c.clientId || !c.clientSecret) return null;
  return { clientId: c.clientId, clientSecret: c.clientSecret, redirectUri: c.redirectUri || DEFAULT_REDIRECT_URI };
}

export async function readStoredCredentials(): Promise<{ creds: ClientCredentials; source: CredentialSource } | null> {
  if (keychainEnabled()) {
    try {
      const creds = parse(await Bun.secrets.get(KEYCHAIN));
      if (creds) return { creds, source: "keychain" };
    } catch {
      // No usable keychain (e.g. no secret service daemon); fall through to the file store.
    }
  }
  const fromFile = await readPrivateJson<ClientCredentials>(credentialFilePath());
  const creds = parse(fromFile && JSON.stringify(fromFile));
  return creds ? { creds, source: "file" } : null;
}

/** Saves to the keychain when possible, otherwise to the 0600 file. Returns where it went. */
export async function saveCredentials(creds: ClientCredentials): Promise<CredentialSource> {
  if (keychainEnabled()) {
    try {
      await Bun.secrets.set({ ...KEYCHAIN, value: JSON.stringify(creds) });
      // Don't leave an older plaintext copy behind once the keychain holds the credentials.
      await rm(credentialFilePath(), { force: true });
      return "keychain";
    } catch {
      // Fall back to the file store below.
    }
  }
  await writePrivateJson(credentialFilePath(), creds);
  return "file";
}

/** Removes stored credentials from both stores. Returns whether anything was removed. */
export async function deleteStoredCredentials(): Promise<boolean> {
  let removed = false;
  if (keychainEnabled()) {
    try {
      removed = await Bun.secrets.delete(KEYCHAIN);
    } catch {
      // Nothing to remove from an unavailable keychain.
    }
  }
  const file = Bun.file(credentialFilePath());
  if (await file.exists()) {
    await rm(credentialFilePath(), { force: true });
    removed = true;
  }
  return removed;
}

/** Env vars win (handy for CI and one-off overrides), then whatever `whoop-mcp setup` stored. */
export async function resolveClientCredentials(
  env = process.env,
): Promise<{ creds: ClientCredentials; source: CredentialSource }> {
  if (envValue(env.WHOOP_CLIENT_ID) && envValue(env.WHOOP_CLIENT_SECRET)) {
    return { creds: loadClientCredentials(env), source: "env" };
  }
  const stored = await readStoredCredentials();
  if (stored) {
    // A redirect override still applies to stored credentials.
    const redirectUri = envValue(env.WHOOP_REDIRECT_URI);
    return redirectUri ? { ...stored, creds: { ...stored.creds, redirectUri } } : stored;
  }
  throw new ConfigError("No WHOOP app credentials found. Run `whoop-mcp setup` in a terminal.");
}
