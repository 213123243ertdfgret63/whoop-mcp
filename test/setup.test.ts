import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readStoredCredentials, saveCredentials } from "../src/auth/credentials.ts";
import type { PromptIO } from "../src/cli/terminal.ts";
import { type ClientCredentials, WHOOP } from "../src/config.ts";
import { DASHBOARD_URL, runSetup, type SetupOptions, type VerifyResult, verifyCredentials } from "../src/setup.ts";

const ENV_KEYS = ["WHOOP_MCP_HOME", "WHOOP_MCP_CREDENTIAL_STORE"] as const;
let home: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "whoop-setup-test-"));
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.WHOOP_MCP_HOME = home;
  // The file store keeps these tests off the real OS keychain.
  process.env.WHOOP_MCP_CREDENTIAL_STORE = "file";
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await rm(home, { recursive: true, force: true });
});

/** Scripted prompt IO: answers are consumed in order; secrets and plain answers are tracked separately. */
function scriptedIO(answers: string[]) {
  const queue = [...answers];
  const log = { printed: [] as string[], asked: [] as string[], secretAsked: [] as string[], opened: [] as string[] };
  const next = (q: string) => {
    const a = queue.shift();
    if (a === undefined) throw new Error(`no scripted answer for: ${q}`);
    return Promise.resolve(a);
  };
  const io: PromptIO = {
    print: (t) => log.printed.push(t),
    ask: (q) => {
      log.asked.push(q);
      return next(q);
    },
    askSecret: (q) => {
      log.secretAsked.push(q);
      return next(q);
    },
    openUrl: (u) => log.opened.push(u),
  };
  return { io, log, remaining: () => queue.length };
}

function options(overrides: Partial<SetupOptions> = {}) {
  const logins: ClientCredentials[] = [];
  const opts: SetupOptions = {
    openBrowser: false,
    verify: true,
    login: true,
    verifyCredentials: async () => ({ ok: true }) as VerifyResult,
    runLogin: async (c) => {
      logins.push(c);
    },
    ...overrides,
  };
  return { opts, logins };
}

describe("runSetup", () => {
  test("saves verified credentials, then logs in with them", async () => {
    const { io, log } = scriptedIO(["my-id", "my-secret"]);
    const { opts, logins } = options();
    const result = await runSetup(io, opts);
    expect(result).toEqual({ saved: "file", loggedIn: true });
    const stored = await readStoredCredentials();
    expect(stored?.creds).toMatchObject({ clientId: "my-id", clientSecret: "my-secret" });
    expect(logins).toEqual([stored!.creds]);
    expect(log.printed.join("\n")).toContain("Redirect URLs:  http://localhost:8787/callback");
  });

  test("asks for the secret through the hidden prompt, never the echoing one", async () => {
    const { io, log } = scriptedIO(["my-id", "my-secret"]);
    await runSetup(io, options().opts);
    expect(log.secretAsked).toHaveLength(1);
    expect(log.asked.some((q) => /secret/i.test(q))).toBe(false);
  });

  test("never prints the secret", async () => {
    const { io, log } = scriptedIO(["my-id", "super-secret-value"]);
    await runSetup(io, options().opts);
    expect(log.printed.join("\n")).not.toContain("super-secret-value");
  });

  test("opens the developer dashboard only when the browser is allowed", async () => {
    const withBrowser = scriptedIO(["id", "secret"]);
    await runSetup(withBrowser.io, options({ openBrowser: true }).opts);
    expect(withBrowser.log.opened).toEqual([DASHBOARD_URL]);

    await rm(home, { recursive: true, force: true });
    const without = scriptedIO(["id", "secret"]);
    await runSetup(without.io, options().opts);
    expect(without.log.opened).toEqual([]);
  });

  test("re-prompts after WHOOP rejects the credentials and saves the corrected ones", async () => {
    const { io, log } = scriptedIO(["bad-id", "bad-secret", "good-id", "good-secret"]);
    const { opts } = options({
      verifyCredentials: async (c) =>
        c.clientId === "good-id" ? { ok: true } : { ok: false, reason: "WHOOP rejected the client ID or secret." },
    });
    await runSetup(io, opts);
    expect((await readStoredCredentials())?.creds.clientId).toBe("good-id");
    expect(log.printed.join("\n")).toContain("WHOOP rejected the client ID or secret.");
  });

  test("gives up after three rejected attempts without saving or logging in", async () => {
    const { io } = scriptedIO(["a", "1", "b", "2", "c", "3"]);
    const { opts, logins } = options({ verifyCredentials: async () => ({ ok: false, reason: "nope" }) });
    await expect(runSetup(io, opts)).rejects.toThrow(/nothing was saved/);
    expect(await readStoredCredentials()).toBeNull();
    expect(logins).toEqual([]);
  });

  test("treats blank answers as a failed attempt", async () => {
    const { io, log } = scriptedIO(["", "", "id", "secret"]);
    await runSetup(io, options().opts);
    expect(log.printed.join("\n")).toContain("required");
    expect((await readStoredCredentials())?.creds.clientId).toBe("id");
  });

  test("saves anyway when WHOOP can't be reached to verify", async () => {
    const { io, log } = scriptedIO(["id", "secret"]);
    await runSetup(io, options({ verifyCredentials: async () => ({ ok: "unknown", reason: "offline" }) }).opts);
    expect(await readStoredCredentials()).not.toBeNull();
    expect(log.printed.join("\n")).toContain("Could not verify credentials: offline");
  });

  test("skips verification when asked", async () => {
    let verified = false;
    const { io } = scriptedIO(["id", "secret"]);
    await runSetup(
      io,
      options({
        verify: false,
        verifyCredentials: async () => {
          verified = true;
          return { ok: true };
        },
      }).opts,
    );
    expect(verified).toBe(false);
  });

  test("with login disabled, saves credentials and does not open the login flow", async () => {
    const { io } = scriptedIO(["id", "secret"]);
    const { opts, logins } = options({ login: false });
    expect(await runSetup(io, opts)).toEqual({ saved: "file", loggedIn: false });
    expect(logins).toEqual([]);
  });

  test("keeps existing credentials when the user declines to replace them, and still logs in", async () => {
    await saveCredentials({
      clientId: "existing-1234",
      clientSecret: "s",
      redirectUri: "http://localhost:8787/callback",
    });
    const { io, log, remaining } = scriptedIO(["n"]);
    const { opts, logins } = options();
    const result = await runSetup(io, opts);
    expect(result).toEqual({ saved: null, loggedIn: true });
    expect(log.asked[0]).toContain("…1234");
    expect(logins[0]?.clientId).toBe("existing-1234");
    expect(remaining()).toBe(0);
  });

  test("replaces existing credentials when the user says yes", async () => {
    await saveCredentials({ clientId: "old", clientSecret: "s", redirectUri: "http://localhost:8787/callback" });
    const { io } = scriptedIO(["y", "new-id", "new-secret"]);
    await runSetup(io, options().opts);
    expect((await readStoredCredentials())?.creds.clientId).toBe("new-id");
  });

  test("uses a custom redirect URI for instructions and saved credentials", async () => {
    const { io, log } = scriptedIO(["id", "secret"]);
    await runSetup(io, options({ redirectUri: "http://127.0.0.1:9000/cb" }).opts);
    expect(log.printed.join("\n")).toContain("http://127.0.0.1:9000/cb");
    expect((await readStoredCredentials())?.creds.redirectUri).toBe("http://127.0.0.1:9000/cb");
  });
});

describe("verifyCredentials", () => {
  const creds = { clientId: "id", clientSecret: "secret", redirectUri: "http://localhost:8787/callback" };
  const originalFetch = globalThis.fetch;
  let requests: { url: string; body: URLSearchParams }[];

  function respond(make: () => Response | Promise<Response>) {
    requests = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), body: new URLSearchParams(String(init?.body ?? "")) });
      return make();
    }) as typeof fetch;
  }
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("invalid_client means the id or secret is wrong", async () => {
    respond(() => json(401, { error: "invalid_client" }));
    expect((await verifyCredentials(creds)).ok).toBe(false);
  });

  test("a grant error means the client authenticated", async () => {
    respond(() => json(400, { error: "invalid_grant" }));
    expect(await verifyCredentials(creds)).toEqual({ ok: true });
  });

  test("probes the token endpoint with a dummy refresh token and the client credentials", async () => {
    respond(() => json(400, { error: "invalid_grant" }));
    await verifyCredentials(creds);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(WHOOP.tokenUrl);
    expect(requests[0]?.body.get("grant_type")).toBe("refresh_token");
    expect(requests[0]?.body.get("client_id")).toBe("id");
    expect(requests[0]?.body.get("client_secret")).toBe("secret");
  });

  test("a server error or network failure is reported as unknown, not as bad credentials", async () => {
    respond(() => json(503, {}));
    expect((await verifyCredentials(creds)).ok).toBe("unknown");
    respond(() => Promise.reject(new Error("ECONNREFUSED")));
    const result = await verifyCredentials(creds);
    expect(result.ok).toBe("unknown");
    expect((result as { reason: string }).reason).toContain("ECONNREFUSED");
  });

  test("a non-JSON error body does not crash verification", async () => {
    respond(() => new Response("<html>bad gateway</html>", { status: 400 }));
    expect((await verifyCredentials(creds)).ok).toBe(true);
  });
});
