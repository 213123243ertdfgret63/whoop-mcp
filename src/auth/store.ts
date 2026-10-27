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

export async function readTokens(): Promise<StoredTokens | null> {
  try {
    return JSON.parse(await readFile(tokenPath(), "utf8")) as StoredTokens;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Atomic write: a crash mid-write must never leave a half-written (i.e. lost) refresh token. */
export async function writeTokens(tokens: StoredTokens): Promise<void> {
  const dir = configDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = tokenPath();
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

export async function deleteTokens(): Promise<void> {
  await rm(tokenPath(), { force: true });
}
