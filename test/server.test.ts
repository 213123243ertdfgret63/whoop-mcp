import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { SCOPES, VERSION } from "../src/config.ts";
import { createServer } from "../src/server.ts";
import { NotLoggedInError, WhoopApiError, type WhoopClient } from "../src/whoop/client.ts";

type Responses = Record<string, unknown>;

/** Minimal WhoopClient stand-in: get(path) resolves the value keyed by path, or rejects when it is an Error. */
function stubClient(responses: Responses) {
  const calls: string[] = [];
  const stub = {
    calls,
    async get(path: string) {
      calls.push(path);
      if (!(path in responses)) throw new Error(`unexpected path ${path}`);
      const value = responses[path];
      if (value instanceof Error) throw value;
      return value;
    },
  };
  return stub;
}

const PROFILE = { user_id: 1, email: "member@example.com", first_name: "Ada", last_name: "Lovelace" };
const BODY = { height_meter: 1.8, weight_kilogram: 72.456, max_heart_rate: 195 };
const OK_RESPONSES: Responses = { "/v2/user/profile/basic": PROFILE, "/v2/user/measurement/body": BODY };

const savedEnv = { ...process.env };
const originalFetch = globalThis.fetch;
let home: string;
let client: Client | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "whoop-mcp-server-test-"));
  process.env.WHOOP_MCP_HOME = home;
  process.env.XDG_CACHE_HOME = home;
  // Any accidental network call is a test bug.
  globalThis.fetch = (async () => {
    throw new Error("network access is not allowed in tests");
  }) as unknown as typeof fetch;
});

afterEach(async () => {
  await client?.close();
  client = undefined;
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  await rm(home, { recursive: true, force: true });
});

async function connect(responses: Responses = OK_RESPONSES) {
  const stub = stubClient(responses);
  const server = createServer(stub as unknown as WhoopClient);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "server-test", version: "0.0.0" });
  await client.connect(clientTransport);
  return { client, stub };
}

const text = (result: { content?: unknown }) =>
  ((result.content as { type: string; text?: string }[] | undefined) ?? []).map((c) => c.text ?? "").join("\n");

async function writeTokenFile(tokens: Record<string, unknown>) {
  await writeFile(join(home, "tokens.json"), JSON.stringify(tokens));
}

describe("tools/list", () => {
  test("exposes exactly whoop_status and whoop_profile as read-only, idempotent tools", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["whoop_profile", "whoop_status"]);
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.annotations?.idempotentHint).toBe(true);
    }
  });

  test("whoop_status is marked as not touching the outside world, whoop_profile is", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === "whoop_status")?.annotations?.openWorldHint).toBe(false);
    expect(tools.find((t) => t.name === "whoop_profile")?.annotations?.openWorldHint).toBe(true);
  });
});

describe("whoop_status", () => {
  test("without a token file reports logged out, every scope missing and no expiry", async () => {
    const { client, stub } = await connect();
    const result = await client.callTool({ name: "whoop_status", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      logged_in: false,
      token_file: join(home, "tokens.json"),
      scopes: [],
      missing_scopes: [...SCOPES],
      access_token_expires_in_s: null,
      has_refresh_token: false,
      server_version: VERSION,
    });
    expect(text(result)).toContain("whoop-mcp login");
    expect(stub.calls).toEqual([]);
  });

  test("with a token file lists granted scopes and reports the rest as missing", async () => {
    await writeTokenFile({
      access_token: "a",
      refresh_token: "r",
      token_type: "bearer",
      scope: "offline  read:profile read:sleep",
      expires_at: Date.now() + 3600_000,
      obtained_at: Date.now(),
    });
    const { client } = await connect();
    const result = await client.callTool({ name: "whoop_status", arguments: {} });
    const data = result.structuredContent as {
      logged_in: boolean;
      scopes: string[];
      missing_scopes: string[];
      access_token_expires_in_s: number;
      has_refresh_token: boolean;
    };
    expect(data.logged_in).toBe(true);
    expect(data.scopes).toEqual(["offline", "read:profile", "read:sleep"]);
    expect(data.missing_scopes).toEqual(["read:body_measurement", "read:cycles", "read:recovery", "read:workout"]);
    expect(data.has_refresh_token).toBe(true);
    expect(data.access_token_expires_in_s).toBeGreaterThan(3590);
    expect(data.access_token_expires_in_s).toBeLessThanOrEqual(3600);
    expect(text(result)).toContain("WHOOP is connected.");
  });

  test("reports has_refresh_token false when the stored tokens lack one", async () => {
    await writeTokenFile({
      access_token: "a",
      token_type: "bearer",
      scope: "read:profile",
      expires_at: Date.now() - 1000,
      obtained_at: Date.now(),
    });
    const { client } = await connect();
    const result = await client.callTool({ name: "whoop_status", arguments: {} });
    const data = result.structuredContent as { has_refresh_token: boolean; access_token_expires_in_s: number };
    expect(data.has_refresh_token).toBe(false);
    expect(data.access_token_expires_in_s).toBeLessThanOrEqual(0);
  });

  test("never puts the access or refresh token into the result", async () => {
    await writeTokenFile({
      access_token: "secret-access-token",
      refresh_token: "secret-refresh-token",
      token_type: "bearer",
      scope: "offline",
      expires_at: Date.now() + 3600_000,
      obtained_at: Date.now(),
    });
    const { client } = await connect();
    const result = await client.callTool({ name: "whoop_status", arguments: {} });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("secret-access-token");
    expect(serialized).not.toContain("secret-refresh-token");
  });
});

describe("whoop_profile", () => {
  test("converts units, omits the email by default and carries the not-medical-advice note", async () => {
    const { client, stub } = await connect();
    const result = await client.callTool({ name: "whoop_profile", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      name: "Ada Lovelace",
      height_cm: 180,
      weight_kg: 72.5,
      max_heart_rate_bpm: 195,
      note: "Not medical advice.",
    });
    expect(text(result)).toStartWith("Profile for Ada Lovelace.");
    expect(text(result)).not.toContain("member@example.com");
    expect(stub.calls.sort()).toEqual(["/v2/user/measurement/body", "/v2/user/profile/basic"]);
  });

  test("text block mirrors the structured content as JSON", async () => {
    const { client } = await connect();
    const result = await client.callTool({ name: "whoop_profile", arguments: {} });
    const content = result.content as { type: string; text: string }[];
    expect(content).toHaveLength(1);
    expect(content[0]?.type).toBe("text");
    const json = content[0]?.text.slice(content[0].text.indexOf("{")) ?? "";
    expect(JSON.parse(json)).toEqual(result.structuredContent);
  });

  test("includes the email only when include_email is true", async () => {
    const { client } = await connect();
    const result = await client.callTool({ name: "whoop_profile", arguments: { include_email: true } });
    expect((result.structuredContent as { email?: string }).email).toBe("member@example.com");
  });

  test("rounds height to the nearest millimetre (one decimal in cm) and weight to one decimal", async () => {
    const { client } = await connect({
      ...OK_RESPONSES,
      "/v2/user/measurement/body": { height_meter: 1.7349, weight_kilogram: 80.04, max_heart_rate: 180 },
    });
    const result = await client.callTool({ name: "whoop_profile", arguments: {} });
    const data = result.structuredContent as { height_cm: number; weight_kg: number };
    expect(data.height_cm).toBe(173.5);
    expect(data.weight_kg).toBe(80);
  });

  test("trims the name when a part is empty", async () => {
    const { client } = await connect({ ...OK_RESPONSES, "/v2/user/profile/basic": { ...PROFILE, last_name: "" } });
    const result = await client.callTool({ name: "whoop_profile", arguments: {} });
    expect((result.structuredContent as { name: string }).name).toBe("Ada");
  });

  test("turns NotLoggedInError into an error result telling the user to log in", async () => {
    const { client } = await connect({ ...OK_RESPONSES, "/v2/user/profile/basic": new NotLoggedInError() });
    const result = await client.callTool({ name: "whoop_profile", arguments: {} });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(new NotLoggedInError().message);
    expect(text(result)).toContain("whoop-mcp login");
  });

  test("turns WhoopApiError into an error result with status, path and trace id", async () => {
    const err = new WhoopApiError(429, "/v2/user/measurement/body", "rate limited", "trace-123");
    const { client } = await connect({ ...OK_RESPONSES, "/v2/user/measurement/body": err });
    const result = await client.callTool({ name: "whoop_profile", arguments: {} });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(err.message);
    expect(text(result)).toContain("429");
    expect(text(result)).toContain("trace-123");
    expect(result.structuredContent).toBeUndefined();
  });

  test("rejects a non-boolean include_email with an error result and keeps serving", async () => {
    const { client, stub } = await connect();
    const result = await client.callTool({ name: "whoop_profile", arguments: { include_email: "yes" } });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Input validation error");
    expect(text(result)).toContain("include_email");
    expect(stub.calls).toEqual([]);

    const ok = await client.callTool({ name: "whoop_profile", arguments: {} });
    expect(ok.isError).toBeFalsy();
  });
});
