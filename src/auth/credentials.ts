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
import { readPrivateText, writePrivateJson } from "./store.ts";

/**
 * Where the user's WHOOP developer-app credentials (client id + secret) live after setup.
 * The OS keychain is preferred; Bun.secrets is experimental and needs a secret service on Linux,
 * so a 0600 file in the config dir is the fallback. Env vars still override both.
 */
export type CredentialSource = "env" | "keychain" | "file";

const KEYCHAIN = { service: "whoop-mcp", name: "client-credentials" } as const;

export function credentialFilePath(): string {
  return join(configDir(), "client.json");
}

/** Exit status of Apple's `security` tool when there is no such item (errSecItemNotFound). */
const SECURITY_NOT_FOUND = 44;

/** errSecInvalidOwnerEdit: the item belongs to another program. Bun puts the OSStatus in the message. */
const isOwnerError = (err: unknown) => /-25244\b/.test(String((err as Error)?.message));

/**
 * Deletes the keychain item: true if it was there, false if not; throws if it couldn't be deleted.
 *
 * On macOS only the program that saved an item may change or delete it, and every whoop-mcp build is a
 * different (ad-hoc signed) program, so after an upgrade Bun.secrets fails with errSecInvalidOwnerEdit. Apple's
 * own `security` tool may still delete the user's item, so it is the fallback there.
 */
async function deleteKeychainItem(): Promise<boolean> {
  try {
    return await Bun.secrets.delete(KEYCHAIN);
  } catch (err) {
    // Only for an item another build owns: a locked keychain or a click on Deny stays a failure.
    if (process.platform !== "darwin" || !isOwnerError(err)) throw err;
    const proc = Bun.spawn(
      ["/usr/bin/security", "delete-generic-password", "-s", KEYCHAIN.service, "-a", KEYCHAIN.name],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore", timeout: 10_000 },
    );
    const code = await proc.exited;
    if (code === 0) return true;
    if (code === SECURITY_NOT_FOUND) return false;
    log.warn("could not delete the WHOOP app credentials from the keychain", {
      ...errorFields(err),
      security_exit: code,
    });
    throw err;
  }
}

/** `WHOOP_MCP_CREDENTIAL_STORE=file` forces the file store (tests, headless Linux without a keyring). */
function keychainEnabled(env = process.env): boolean {
  return env.WHOOP_MCP_CREDENTIAL_STORE !== "file";
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
      const creds = parse(await Bun.secrets.get(KEYCHAIN));
      if (creds) return { creds, source: "keychain" };
    } catch {
      // No usable keychain (e.g. no secret service daemon); fall through to the file store.
    }
  }
  const creds = parse(await readPrivateText(credentialFilePath()));
  return creds ? { creds, source: "file" } : null;
}

/** Saves to the keychain when possible, otherwise to the 0600 file. Returns where it went. */
export async function saveCredentials(creds: ClientCredentials): Promise<CredentialSource> {
  if (keychainEnabled()) {
    const save = async () => {
      await Bun.secrets.set({ ...KEYCHAIN, value: JSON.stringify(creds) });
      // Don't leave an older plaintext copy behind once the keychain holds the credentials.
      await rm(credentialFilePath(), { force: true });
      return "keychain" as const;
    };
    try {
      return await save();
    } catch {
      // An older keychain entry would win over the file on the next read, so remove it (best effort) rather
      // than silently keep using the old app. Usually that is an item an earlier build saved and this one
      // can't overwrite; once it's gone, saving again makes one this build owns.
      let removed = false;
      try {
        removed = await deleteKeychainItem();
      } catch {
        // No usable keychain, so nothing there to win over the file either.
      }
      if (removed) {
        try {
          return await save();
        } catch {
          // Fall back to the file store below.
        }
      }
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
    // "unknown" when the read failed: macOS and Windows always have a keychain, so a failed read (denied,
    // locked) may hide a saved item and the delete is tried anyway. Elsewhere it usually means there is no
    // keychain service, so nothing is stored there.
    let present: boolean | "unknown" = false;
    try {
      present = (await Bun.secrets.get(KEYCHAIN)) !== null;
    } catch {
      present = process.platform === "darwin" || process.platform === "win32" ? "unknown" : false;
    }
    if (present) {
      try {
        const deleted = await deleteKeychainItem();
        result = deleted ? "deleted" : present === "unknown" ? "none" : "failed";
      } catch {
        result = "failed";
      }
    }
  }
  const file = Bun.file(credentialFilePath());
  if (await file.exists()) {
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
