import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configDir } from "../config.ts";

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

// M0: plain 0600 file. M1 moves to Bun.secrets with this as the fallback
// (ToU §2.4 wants data encrypted at rest, so the file store will need encryption too).
export function tokenPath(): string {
  return join(configDir(), "tokens.json");
}

/** Reads a JSON file from the config dir; `null` when it doesn't exist. */
export async function readPrivateJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Atomic, owner-only (0600 in a 0700 dir) write: a crash mid-write must never leave a half-written file. */
export async function writePrivateJson(path: string, data: unknown): Promise<void> {
  await mkdir(configDir(), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

export function readTokens(): Promise<StoredTokens | null> {
  return readPrivateJson<StoredTokens>(tokenPath());
}

/** A lost write here means a lost (single-use) refresh token, hence the atomic write. */
export function writeTokens(tokens: StoredTokens): Promise<void> {
  return writePrivateJson(tokenPath(), tokens);
}

export async function deleteTokens(): Promise<void> {
  await rm(tokenPath(), { force: true });
}
