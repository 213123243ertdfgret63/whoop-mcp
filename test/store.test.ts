import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteTokens, readTokens, type StoredTokens, tokenPath, writeTokens } from "../src/auth/store.ts";

const ENV_KEYS = ["WHOOP_MCP_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"] as const;
let savedEnv: Record<string, string | undefined>;
let root: string;
let home: string;

const sample: StoredTokens = {
  access_token: "access-1",
  refresh_token: "refresh-1",
  token_type: "bearer",
  scope: "offline read:profile",
  expires_at: 1_700_000_360_000,
  obtained_at: 1_700_000_000_000,
};

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  root = await mkdtemp(join(tmpdir(), "whoop-mcp-store-"));
  // A not-yet-existing nested dir, so writeTokens has to create it.
  home = join(root, "config", "whoop-mcp");
  process.env.WHOOP_MCP_HOME = home;
  process.env.XDG_CONFIG_HOME = join(root, "xdg-config");
  process.env.XDG_CACHE_HOME = join(root, "xdg-cache");
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(root, { recursive: true, force: true });
});

describe("token store", () => {
  test("stores tokens at tokens.json inside WHOOP_MCP_HOME", () => {
    expect(tokenPath()).toBe(join(home, "tokens.json"));
  });

  test("readTokens returns null when no token file exists", async () => {
    expect(await readTokens()).toBeNull();
  });

  test("written tokens read back identically", async () => {
    await writeTokens(sample);
    expect(await readTokens()).toEqual(sample);
  });

  test("the token file is readable only by the owner (0600)", async () => {
    await writeTokens(sample);
    expect((await stat(tokenPath())).mode & 0o777).toBe(0o600);
  });

  test("the config directory is created private to the owner (0700)", async () => {
    await writeTokens(sample);
    expect((await stat(home)).mode & 0o777).toBe(0o700);
  });

  test("the token file stays 0600 when overwriting a pre-existing world-readable file", async () => {
    await writeTokens(sample);
    // writeFile's mode only applies on creation, so chmod explicitly to make the precondition real.
    await chmod(tokenPath(), 0o644);
    expect((await stat(tokenPath())).mode & 0o777).toBe(0o644);
    await writeTokens(sample);
    expect((await stat(tokenPath())).mode & 0o777).toBe(0o600);
  });

  test("writes leave no temporary files behind", async () => {
    await writeTokens(sample);
    await writeTokens({ ...sample, access_token: "access-2" });
    expect(await readdir(home)).toEqual(["tokens.json"]);
  });

  test("overwriting replaces the previous tokens entirely", async () => {
    await writeTokens(sample);
    const next: StoredTokens = { access_token: "access-2", token_type: "bearer", expires_at: 2, obtained_at: 1 };
    await writeTokens(next);
    expect(await readTokens()).toEqual(next);
    expect(await readFile(tokenPath(), "utf8")).not.toContain("refresh-1");
  });

  test("deleteTokens removes the file and is safe to call when nothing is stored", async () => {
    await writeTokens(sample);
    await deleteTokens();
    expect(await readTokens()).toBeNull();
    await deleteTokens();
    expect(await readTokens()).toBeNull();
  });

  test("deleteTokens succeeds even when the config directory does not exist", async () => {
    await deleteTokens();
    expect(await readTokens()).toBeNull();
  });

  test("a corrupt token file makes readTokens throw rather than silently log the user out", async () => {
    await writeTokens(sample);
    await writeFile(tokenPath(), "{not json", { mode: 0o600 });
    await expect(readTokens()).rejects.toThrow(SyntaxError);
  });
});
