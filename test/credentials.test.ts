import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  credentialFilePath,
  deleteStoredCredentials,
  readStoredCredentials,
  resolveClientCredentials,
  saveCredentials,
} from "../src/auth/credentials.ts";
import { keychain as realKeychain } from "../src/auth/keychain.ts";
import { ConfigError, DEFAULT_REDIRECT_URI } from "../src/config.ts";

const creds = { clientId: "id-1234", clientSecret: "secret value", redirectUri: "http://localhost:8787/callback" };
const ENV_KEYS = ["WHOOP_MCP_HOME", "WHOOP_MCP_CREDENTIAL_STORE"] as const;

let home: string;
let savedEnv: Record<string, string | undefined>;
/** In-memory stand-in for the OS keychain; tests must never touch the real one. */
let keychain: Map<string, string>;
let spies: { mockRestore(): void }[];

function keyOf(item: { service: string; account: string }) {
  return `${item.service}/${item.account}`;
}

// The keychain path only runs on macOS; elsewhere the credentials always use the file store.
const onMac = process.platform === "darwin";

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "whoop-creds-test-"));
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.WHOOP_MCP_HOME = home;
  delete process.env.WHOOP_MCP_CREDENTIAL_STORE;
  keychain = new Map();
  spies = [
    spyOn(realKeychain, "get").mockImplementation(async (item) => keychain.get(keyOf(item)) ?? null),
    spyOn(realKeychain, "set").mockImplementation(async (item, value) => {
      keychain.set(keyOf(item), value);
    }),
    spyOn(realKeychain, "delete").mockImplementation(async (item) => keychain.delete(keyOf(item))),
  ];
});

afterEach(async () => {
  for (const s of spies) s.mockRestore();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await rm(home, { recursive: true, force: true });
});

const fail = (message: string) => async () => {
  throw new Error(message);
};
const breakKeychain = () => {
  for (const method of ["get", "set", "delete"] as const) {
    (realKeychain[method] as unknown as { mockImplementation(f: () => Promise<never>): void }).mockImplementation(
      fail("keychain locked"),
    );
  }
};
const fileExists = () => Bun.file(credentialFilePath()).exists();

describe.if(onMac)("keychain store (macOS)", () => {
  test("saves to the keychain and reads back from it, leaving no plaintext file", async () => {
    expect(await saveCredentials(creds)).toBe("keychain");
    // Proves the spy intercepted the write (the real keychain must stay untouched).
    expect(JSON.parse(keychain.get("whoop-mcp/client-credentials") ?? "{}")).toEqual(creds);
    expect(await fileExists()).toBe(false);
    expect(await readStoredCredentials()).toEqual({ creds, source: "keychain" });
  });

  test("saving to the keychain removes an older plaintext copy", async () => {
    process.env.WHOOP_MCP_CREDENTIAL_STORE = "file";
    await saveCredentials({ ...creds, clientId: "old" });
    delete process.env.WHOOP_MCP_CREDENTIAL_STORE;
    await saveCredentials(creds);
    expect(await fileExists()).toBe(false);
  });

  test("falls back to the 0600 file when the keychain is unavailable", async () => {
    breakKeychain();
    expect(await saveCredentials(creds)).toBe("file");
    expect((await stat(credentialFilePath())).mode & 0o777).toBe(0o600);
    expect(await readStoredCredentials()).toEqual({ creds, source: "file" });
  });

  test("a failed keychain write removes the old keychain entry, so the new file credentials win", async () => {
    await saveCredentials({ ...creds, clientId: "old-app" });
    (realKeychain.set as unknown as { mockImplementation(f: () => Promise<never>): void }).mockImplementation(
      fail("denied"),
    );
    expect(await saveCredentials({ ...creds, clientId: "new-app" })).toBe("file");
    expect((await readStoredCredentials())?.creds.clientId).toBe("new-app");
  });

  test("an unreadable credentials file counts as not set up", async () => {
    process.env.WHOOP_MCP_CREDENTIAL_STORE = "file";
    await writeFile(credentialFilePath(), "{oops", { mode: 0o600 });
    expect(await readStoredCredentials()).toBeNull();
  });

  test("the keychain wins over a file when both exist", async () => {
    process.env.WHOOP_MCP_CREDENTIAL_STORE = "file";
    await saveCredentials({ ...creds, clientId: "from-file" });
    delete process.env.WHOOP_MCP_CREDENTIAL_STORE;
    keychain.set("whoop-mcp/client-credentials", JSON.stringify(creds));
    expect((await readStoredCredentials())?.creds.clientId).toBe("id-1234");
  });
});

describe("file store (WHOOP_MCP_CREDENTIAL_STORE=file)", () => {
  beforeEach(() => {
    process.env.WHOOP_MCP_CREDENTIAL_STORE = "file";
  });

  test("never touches the keychain", async () => {
    await saveCredentials(creds);
    await readStoredCredentials();
    await deleteStoredCredentials();
    expect(realKeychain.get).not.toHaveBeenCalled();
    expect(realKeychain.set).not.toHaveBeenCalled();
    expect(realKeychain.delete).not.toHaveBeenCalled();
  });

  test("saves an owner-only file and reads it back", async () => {
    expect(await saveCredentials(creds)).toBe("file");
    expect((await stat(credentialFilePath())).mode & 0o777).toBe(0o600);
    expect(await readStoredCredentials()).toEqual({ creds, source: "file" });
  });

  test("returns null when nothing is stored", async () => {
    expect(await readStoredCredentials()).toBeNull();
  });

  test("ignores a stored entry that lacks the secret", async () => {
    await writeFile(credentialFilePath(), JSON.stringify({ clientId: "x" }));
    expect(await readStoredCredentials()).toBeNull();
  });

  test("fills in the default redirect URI for older entries without one", async () => {
    await writeFile(credentialFilePath(), JSON.stringify({ clientId: "x", clientSecret: "y" }));
    expect((await readStoredCredentials())?.creds.redirectUri).toBe(DEFAULT_REDIRECT_URI);
  });
});

describe.if(onMac)("deleteStoredCredentials (macOS)", () => {
  test("reports failed when the keychain holds the credentials but won't delete them", async () => {
    await saveCredentials(creds);
    (realKeychain.delete as unknown as { mockImplementation(f: () => Promise<never>): void }).mockImplementation(
      fail("user denied"),
    );
    expect(await deleteStoredCredentials()).toBe("failed");
  });

  test("deletes without reading first, so an older build's item never shows macOS's access prompt", async () => {
    keychain.set("whoop-mcp/client-credentials", JSON.stringify(creds));
    expect(await deleteStoredCredentials()).toBe("deleted");
    expect(realKeychain.get).not.toHaveBeenCalled();
    expect(keychain.size).toBe(0);
    expect(await deleteStoredCredentials()).toBe("none");
  });

  test("removes credentials from both stores and reports it", async () => {
    keychain.set("whoop-mcp/client-credentials", JSON.stringify(creds));
    await writeFile(credentialFilePath(), JSON.stringify(creds));
    expect(await deleteStoredCredentials()).toBe("deleted");
    expect(keychain.size).toBe(0);
    expect(await fileExists()).toBe(false);
    expect(await readStoredCredentials()).toBeNull();
  });

  test("reports none when nothing was stored", async () => {
    expect(await deleteStoredCredentials()).toBe("none");
  });
});

describe("deleteStoredCredentials (file store)", () => {
  test("deletes the file and reports it, never touching the keychain", async () => {
    process.env.WHOOP_MCP_CREDENTIAL_STORE = "file";
    await saveCredentials(creds);
    expect(await deleteStoredCredentials()).toBe("deleted");
    expect(await fileExists()).toBe(false);
    expect(await deleteStoredCredentials()).toBe("none");
    expect(realKeychain.delete).not.toHaveBeenCalled();
  });
});

describe("resolveClientCredentials", () => {
  test("environment variables win over stored credentials", async () => {
    await saveCredentials(creds);
    const resolved = await resolveClientCredentials({ WHOOP_CLIENT_ID: "env-id", WHOOP_CLIENT_SECRET: "env-secret" });
    expect(resolved.source).toBe("env");
    expect(resolved.creds.clientId).toBe("env-id");
  });

  test("a lone WHOOP_CLIENT_ID does not shadow stored credentials", async () => {
    await saveCredentials(creds);
    const resolved = await resolveClientCredentials({ WHOOP_CLIENT_ID: "env-id" });
    expect(resolved).toEqual({ creds, source: onMac ? "keychain" : "file" });
  });

  test("uses stored credentials, honouring a WHOOP_REDIRECT_URI override", async () => {
    await saveCredentials(creds);
    const resolved = await resolveClientCredentials({ WHOOP_REDIRECT_URI: " http://127.0.0.1:9999/cb " });
    expect(resolved.creds.redirectUri).toBe("http://127.0.0.1:9999/cb");
    expect(resolved.creds.clientSecret).toBe(creds.clientSecret);
  });

  test("throws a ConfigError pointing at whoop_login when nothing is configured", async () => {
    const err = await resolveClientCredentials({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toContain("whoop_login");
  });
});
