import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configDir } from "../config.ts";
import { log } from "../log.ts";

export interface StoredTokens {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  scope?: string;
  /** Epoch ms. */
  expires_at: number;
  /** Epoch ms. */
  obtained_at: number;
}

// Tokens live in a 0600 file in a 0700 directory (the app credentials go to the keychain instead). Encrypting
// this file at rest is still open (ToU §2.4).
export function tokenPath(): string {
  return join(configDir(), "tokens.json");
}

/** Reads a file from the config dir; `null` when it doesn't exist. */
export async function readPrivateText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Atomic, owner-only (0600 in a 0700 dir) write: a crash mid-write must never leave a half-written file. */
export async function writePrivateJson(path: string, data: unknown): Promise<void> {
  await mkdir(configDir(), { recursive: true, mode: 0o700 });
  // Unique per write: two writes of one file in this process must not share (and interleave in) a temp file.
  const tmp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

/** The saved tokens, or null when logged out. An unreadable file counts as logged out, so whoop_login fixes it. */
export async function readTokens(): Promise<StoredTokens | null> {
  const text = await readPrivateText(tokenPath());
  if (text === null) return null;
  try {
    const tokens = JSON.parse(text) as StoredTokens;
    if (tokens && typeof tokens.access_token === "string") return tokens;
  } catch {
    // fall through
  }
  log.warn("ignoring an unreadable token file; a new login replaces it", { file: tokenPath() });
  return null;
}

/** A lost write here means a lost (single-use) refresh token, hence the atomic write. */
export function writeTokens(tokens: StoredTokens): Promise<void> {
  return writePrivateJson(tokenPath(), tokens);
}

let tokenLock: Promise<unknown> = Promise.resolve();

/**
 * Runs `fn` alone among this process's token-file updates (a login saving while a refresh decides whether to
 * write), so neither overwrites the other with stale tokens. Other processes are not covered.
 */
export function withTokenLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = tokenLock.then(fn, fn);
  tokenLock = run.catch(() => {});
  return run;
}

export async function deleteTokens(): Promise<void> {
  await rm(tokenPath(), { force: true });
}
