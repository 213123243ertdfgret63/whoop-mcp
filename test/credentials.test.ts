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
import { ConfigError, DEFAULT_REDIRECT_URI } from "../src/config.ts";

/** A literal, unexpanded `${user_config.<key>}` string, as an MCP server would see it if nothing filled it in. */
const placeholder = (key: string) => `$\{user_config.${key}}`;

const creds = { clientId: "id-1234", clientSecret: "secret value", redirectUri: "http://localhost:8787/callback" };
const ENV_KEYS = ["WHOOP_MCP_HOME", "WHOOP_MCP_CREDENTIAL_STORE"] as const;

let home: string;
let savedEnv: Record<string, string | undefined>;
/** In-memory stand-in for the OS keychain; tests must never touch the real one. */
let keychain: Map<string, string>;
let spies: { mockRestore(): void }[];

function keyOf(opts: { service: string; name: string }) {
  return `${opts.service}/${opts.name}`;
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "whoop-creds-test-"));
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.WHOOP_MCP_HOME = home;
  delete process.env.WHOOP_MCP_CREDENTIAL_STORE;
  keychain = new Map();
  spies = [
    spyOn(Bun.secrets, "get").mockImplementation(
      (async (opts: { service: string; name: string }) => keychain.get(keyOf(opts)) ?? null) as typeof Bun.secrets.get,
    ),
    spyOn(Bun.secrets, "set").mockImplementation((async (opts: { service: string; name: string; value: string }) => {
      keychain.set(keyOf(opts), opts.value);
    }) as typeof Bun.secrets.set),
    spyOn(Bun.secrets, "delete").mockImplementation((async (opts: { service: string; name: string }) =>
      keychain.delete(keyOf(opts))) as typeof Bun.secrets.delete),
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

const breakKeychain = () => {
  for (const method of ["get", "set", "delete"] as const) {
    (Bun.secrets[method] as unknown as { mockImplementation(f: () => never): void }).mockImplementation(() => {
      throw new Error("no secret service");
    });
  }
};

describe("keychain store", () => {
  test("saves to the keychain and reads back from it, leaving no plaintext file", async () => {
    expect(await saveCredentials(creds)).toBe("keychain");
    // Proves the spy intercepted the write (the real keychain must stay untouched).
    expect(JSON.parse(keychain.get("whoop-mcp/client-credentials") ?? "{}")).toEqual(creds);
    expect(await Bun.file(credentialFilePath()).exists()).toBe(false);
    expect(await readStoredCredentials()).toEqual({ creds, source: "keychain" });
  });

  test("saving to the keychain removes an older plaintext copy", async () => {
    process.env.WHOOP_MCP_CREDENTIAL_STORE = "file";
    await saveCredentials({ ...creds, clientId: "old" });
    delete process.env.WHOOP_MCP_CREDENTIAL_STORE;
    await saveCredentials(creds);
    expect(await Bun.file(credentialFilePath()).exists()).toBe(false);
  });

  test("falls back to the 0600 file when the keychain is unavailable", async () => {
    breakKeychain();
    expect(await saveCredentials(creds)).toBe("file");
    expect((await stat(credentialFilePath())).mode & 0o777).toBe(0o600);
    expect(await readStoredCredentials()).toEqual({ creds, source: "file" });
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
    expect(Bun.secrets.get).not.toHaveBeenCalled();
    expect(Bun.secrets.set).not.toHaveBeenCalled();
    expect(Bun.secrets.delete).not.toHaveBeenCalled();
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

describe("deleteStoredCredentials", () => {
  test("removes credentials from both stores and reports it", async () => {
    keychain.set("whoop-mcp/client-credentials", JSON.stringify(creds));
    await writeFile(credentialFilePath(), JSON.stringify(creds));
    expect(await deleteStoredCredentials()).toBe(true);
    expect(keychain.size).toBe(0);
    expect(await Bun.file(credentialFilePath()).exists()).toBe(false);
    expect(await readStoredCredentials()).toBeNull();
  });

  test("reports false when nothing was stored", async () => {
    expect(await deleteStoredCredentials()).toBe(false);
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
    expect(resolved).toEqual({ creds, source: "keychain" });
  });

  test("uses stored credentials, honouring a WHOOP_REDIRECT_URI override", async () => {
    await saveCredentials(creds);
    const resolved = await resolveClientCredentials({ WHOOP_REDIRECT_URI: " http://127.0.0.1:9999/cb " });
    expect(resolved.creds.redirectUri).toBe("http://127.0.0.1:9999/cb");
    expect(resolved.creds.clientSecret).toBe(creds.clientSecret);
  });

  test("ignores unexpanded placeholders (an unfilled plugin user_config) and uses stored credentials", async () => {
    await saveCredentials(creds);
    const resolved = await resolveClientCredentials({
      WHOOP_CLIENT_ID: placeholder("client_id"),
      WHOOP_CLIENT_SECRET: placeholder("client_secret"),
      WHOOP_REDIRECT_URI: placeholder("redirect_uri"),
    });
    expect(resolved).toEqual({ creds, source: "keychain" });
  });

  test("placeholders alone count as not configured", async () => {
    const err = await resolveClientCredentials({
      WHOOP_CLIENT_ID: placeholder("client_id"),
      WHOOP_CLIENT_SECRET: placeholder("client_secret"),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
  });

  test("throws a ConfigError pointing at `whoop-mcp setup` when nothing is configured", async () => {
    const err = await resolveClientCredentials({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toContain("whoop-mcp setup");
  });
});
