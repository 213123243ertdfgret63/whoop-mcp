import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { BackgroundLogin } from "../src/auth/background-login.ts";
import { ConfigError, SCOPES, VERSION } from "../src/config.ts";
import { createServer } from "../src/server.ts";
import { NotLoggedInError, WhoopApiError, type WhoopClient } from "../src/whoop/client.ts";
import { addDays, cycleDate, todayLocal } from "../src/whoop/data.ts";
import { cycle, recovery, sleep, workout } from "./fixtures.ts";

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

/**
 * A login flow that announces a setup page but never opens a browser or binds a port, for tests that don't
 * drive the login themselves (data tools start one when nothing is logged in).
 */
function pageOnlyFlow(url = "http://localhost:8787/setup?t=test") {
  return new BackgroundLogin({
    openBrowser: false,
    resolveCreds: async () => {
      throw new ConfigError("no credentials in tests");
    },
    setup: (opts) =>
      new Promise((_resolve, reject) => {
        queueMicrotask(() => opts.onSetupUrl?.(url));
        opts.signal?.addEventListener("abort", () => reject(new Error("cancelled")));
      }),
  });
}

async function connect(
  responses: Responses = OK_RESPONSES,
  loginFlow?: BackgroundLogin,
  extra: Record<string, unknown> = {},
) {
  const stub = Object.assign(stubClient(responses), extra);
  const server = createServer(stub as unknown as WhoopClient, loginFlow ?? pageOnlyFlow());
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
  test("everything is read-only except whoop_login (a write) and whoop_disconnect (destructive)", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "whoop_baselines",
      "whoop_compare_periods",
      "whoop_correlate",
      "whoop_daily_summaries",
      "whoop_disconnect",
      "whoop_get_record",
      "whoop_login",
      "whoop_profile",
      "whoop_sleep",
      "whoop_status",
      "whoop_today",
      "whoop_training_load",
      "whoop_trends",
      "whoop_workouts",
    ]);
    const writes = new Set(["whoop_login", "whoop_disconnect"]);
    for (const t of tools.filter((t) => !writes.has(t.name))) expect(t.annotations?.readOnlyHint).toBe(true);
    for (const t of tools) expect(t.annotations?.idempotentHint).toBe(true);
    const byName = (n: string) => tools.find((t) => t.name === n)?.annotations;
    expect(byName("whoop_status")?.readOnlyHint).toBe(true);
    expect(byName("whoop_profile")?.readOnlyHint).toBe(true);
    // whoop_login writes tokens, so clients should not treat it as read-only; it never deletes anything.
    expect(byName("whoop_login")?.readOnlyHint).toBe(false);
    expect(byName("whoop_login")?.destructiveHint).toBe(false);
    expect(byName("whoop_disconnect")?.destructiveHint).toBe(true);
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
      session_expired: false,
      last_error: null,
      app_credentials: "missing",
      login: { state: "idle" },
      token_file: join(home, "tokens.json"),
      log_file: null,
      scopes: [],
      missing_scopes: [...SCOPES],
      access_token_expires_in_s: null,
      has_refresh_token: false,
      server_version: VERSION,
    });
    expect(text(result)).toContain("No WHOOP app credentials");
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
    process.env.WHOOP_CLIENT_ID = "id";
    process.env.WHOOP_CLIENT_SECRET = "secret";
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
    expect(text(result)).toContain("Connected, but without read:body_measurement");
    expect(text(result)).not.toContain("WHOOP is connected.");
  });

  test("warns when logged in but the app credentials are gone (the next refresh would fail)", async () => {
    await writeTokenFile({
      access_token: "a",
      refresh_token: "r",
      token_type: "bearer",
      expires_at: Date.now() + 3600_000,
      obtained_at: Date.now(),
    });
    const { client } = await connect();
    const result = await client.callTool({ name: "whoop_status", arguments: {} });
    expect(result.structuredContent).toMatchObject({ logged_in: true, app_credentials: "missing" });
    expect(text(result)).toContain("reconfigure: true");
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

  test("when not logged in, starts the connection itself and tells Claude to wait with whoop_login", async () => {
    const flow = pageOnlyFlow();
    const { client } = await connect({ ...OK_RESPONSES, "/v2/user/profile/basic": new NotLoggedInError() }, flow);
    const result = await client.callTool({ name: "whoop_profile", arguments: {} });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("open in the user's browser");
    expect(text(result)).toContain("whoop_login with wait_seconds");
    expect(flow.status).toMatchObject({ state: "pending", kind: "setup" });
  });

  test("doesn't reopen the page when a login failed a moment ago", async () => {
    const flow = new BackgroundLogin({
      openBrowser: false,
      resolveCreds: async () => {
        throw new ConfigError("none");
      },
      setup: async () => {
        throw new Error("port busy");
      },
    });
    await flow.start().catch(() => {});
    expect(flow.status.state).toBe("failed");
    const { client } = await connect({ ...OK_RESPONSES, "/v2/user/profile/basic": new NotLoggedInError() }, flow);
    const result = await client.callTool({ name: "whoop_profile", arguments: {} });
    expect(text(result)).toBe(new NotLoggedInError().message);
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

describe("whoop_login", () => {
  const AUTH_URL = "https://api.prod.whoop.com/oauth/oauth2/auth?state=xyz";

  /** A login flow whose browser step the test completes by hand; tokens are really written to the temp home. */
  function fakeFlow() {
    let approve = () => {};
    const flow = new BackgroundLogin({
      resolveCreds: async () => ({ clientId: "id", clientSecret: "s", redirectUri: "http://localhost:8787/callback" }),
      openBrowser: false,
      login: (_c, opts) =>
        new Promise((resolve) => {
          queueMicrotask(() => opts.onAuthorizeUrl?.(AUTH_URL));
          approve = () =>
            resolve({
              tokens: {
                access_token: "a",
                refresh_token: "r",
                expires_in: 3600,
                token_type: "bearer",
                scope: "offline",
              },
            });
        }),
    });
    return { flow, approve: () => approve() };
  }

  test("opens the consent page and, with wait_seconds 0, returns at once with a script for Claude", async () => {
    const { flow } = fakeFlow();
    const { client } = await connect(OK_RESPONSES, flow);
    const result = await client.callTool({ name: "whoop_login", arguments: { wait_seconds: 0 } });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain(AUTH_URL);
    expect(text(result)).toContain("Tell the user in one sentence");
    expect(text(result)).toContain("call whoop_login again");
    expect(result.structuredContent).toMatchObject({ state: "pending", kind: "login" });

    const status = await client.callTool({ name: "whoop_status", arguments: {} });
    expect(status.structuredContent).toMatchObject({
      logged_in: false,
      login: { state: "pending", authorize_url: AUTH_URL },
    });
    expect(text(status)).toContain("Waiting for the user to approve");
  });

  test("a later call keeps waiting quietly instead of reopening the page", async () => {
    const { flow } = fakeFlow();
    const { client } = await connect(OK_RESPONSES, flow);
    await client.callTool({ name: "whoop_login", arguments: { wait_seconds: 0 } });
    const again = await client.callTool({ name: "whoop_login", arguments: { wait_seconds: 0 } });
    expect(text(again)).toContain("Still waiting");
    expect(text(again)).not.toContain("Tell the user in one sentence");
  });

  test("returns connected as soon as the user approves during the wait", async () => {
    const { flow, approve } = fakeFlow();
    const { client } = await connect(OK_RESPONSES, flow);
    const call = client.callTool({ name: "whoop_login", arguments: { wait_seconds: 10 } });
    await Bun.sleep(30);
    approve();
    const result = await call;
    expect(result.structuredContent).toMatchObject({ state: "connected" });
    expect(text(result)).toContain("Carry on with the user's original request");
    const status = await client.callTool({ name: "whoop_status", arguments: {} });
    expect(status.structuredContent).toMatchObject({ logged_in: true, login: { state: "succeeded" } });
  });

  test("when already connected it returns at once without starting a login", async () => {
    await writeTokenFile({
      access_token: "a",
      refresh_token: "r",
      token_type: "bearer",
      scope: SCOPES.join(" "),
      expires_at: Date.now() + 3600_000,
      obtained_at: Date.now(),
    });
    process.env.WHOOP_CLIENT_ID = "id";
    process.env.WHOOP_CLIENT_SECRET = "secret";
    const { flow } = fakeFlow();
    const { client } = await connect(OK_RESPONSES, flow);
    const result = await client.callTool({ name: "whoop_login", arguments: {} });
    expect(result.structuredContent).toEqual({ state: "connected" });
    expect(flow.status.state).toBe("idle");
  });

  test("tokens without the app credentials a refresh needs don't count as connected", async () => {
    await writeTokenFile({
      access_token: "a",
      refresh_token: "r",
      token_type: "bearer",
      scope: SCOPES.join(" "),
      expires_at: Date.now() + 3600_000,
      obtained_at: Date.now(),
    });
    const flow = pageOnlyFlow();
    const { client } = await connect(OK_RESPONSES, flow);
    const result = await client.callTool({ name: "whoop_login", arguments: { wait_seconds: 0 } });
    expect(result.structuredContent).toMatchObject({ state: "pending", kind: "setup" });
  });

  test("a problem is passed on once, then later calls wait quietly", async () => {
    let report: ((problem: string) => void) | undefined;
    const flow = new BackgroundLogin({
      openBrowser: false,
      resolveCreds: async () => {
        throw new ConfigError("none");
      },
      setup: (opts) =>
        new Promise(() => {
          queueMicrotask(() => opts.onSetupUrl?.("http://localhost:8787/setup?t=x"));
          report = (problem) => opts.onPhase?.("authorizing", problem);
        }),
    });
    const { client } = await connect(OK_RESPONSES, flow);
    await client.callTool({ name: "whoop_login", arguments: { wait_seconds: 0 } });
    const first = client.callTool({ name: "whoop_login", arguments: { wait_seconds: 5 } });
    await Bun.sleep(30);
    report?.("WHOOP refused the redirect URL.");
    expect(text(await first)).toContain("showing a problem");
    const second = await client.callTool({ name: "whoop_login", arguments: { wait_seconds: 0 } });
    expect(text(second)).toContain("Still waiting");
    expect(text(second)).not.toContain("showing a problem");
  });

  test("a problem shown on the setup page ends the wait so Claude can mention it", async () => {
    let report: ((p: "authorizing", problem: string) => void) | undefined;
    const flow = new BackgroundLogin({
      openBrowser: false,
      resolveCreds: async () => {
        throw new ConfigError("none");
      },
      setup: (opts) =>
        new Promise(() => {
          queueMicrotask(() => opts.onSetupUrl?.("http://localhost:8787/setup?t=x"));
          report = (p, problem) => opts.onPhase?.(p, problem);
        }),
    });
    const { client } = await connect(OK_RESPONSES, flow);
    await client.callTool({ name: "whoop_login", arguments: { wait_seconds: 0 } });
    const call = client.callTool({ name: "whoop_login", arguments: { wait_seconds: 10 } });
    await Bun.sleep(30);
    report?.("authorizing", "WHOOP refused the redirect URL.");
    const result = await call;
    expect(result.structuredContent).toMatchObject({ state: "pending", problem: "WHOOP refused the redirect URL." });
    expect(text(result)).toContain("showing a problem");
  });

  test("without app credentials opens the browser setup page", async () => {
    const SETUP_URL = "http://localhost:8787/setup?t=tok";
    const { client } = await connect(OK_RESPONSES, pageOnlyFlow(SETUP_URL));
    const result = await client.callTool({ name: "whoop_login", arguments: { wait_seconds: 0 } });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain(SETUP_URL);
    expect(text(result)).toContain("about 5 minutes");
    const status = await client.callTool({ name: "whoop_status", arguments: {} });
    expect(status.structuredContent).toMatchObject({ login: { state: "pending", authorize_url: SETUP_URL } });
  });
});

describe("data tools", () => {
  const today = todayLocal();
  const yesterday = addDays(today, -1);
  const data: Responses = {
    "/v2/cycle": {
      records: [
        cycle(1, `${addDays(today, -2)}T23:30:00Z`, `${today}T00:00:00Z`),
        cycle(2, `${today}T00:00:00Z`, undefined),
      ],
    },
    "/v2/recovery": { records: [recovery(1, "s1", 70), recovery(2, "s2", 25)] },
    "/v2/activity/sleep": {
      records: [
        sleep("s1", 1, `${addDays(today, -2)}T23:30:00Z`, `${yesterday}T07:30:00Z`),
        sleep("s2", 2, `${today}T00:00:00Z`, `${today}T00:01:00Z`),
      ],
    },
    "/v2/activity/workout": {
      records: [workout("w1", `${yesterday}T18:00:00Z`, `${yesterday}T19:00:00Z`)],
    },
  };

  test("whoop_today joins recovery, sleep, the open day and workouts", async () => {
    const { client } = await connect(data);
    const result = await client.callTool({ name: "whoop_today", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      date: today,
      recovery: { recovery_pct: 25, zone: "red" },
      day: { in_progress: true, strain: 10 },
      disclaimer: "Not medical advice.",
    });
  });

  test("whoop_today reports how many days its comparison rests on", async () => {
    const { client } = await connect(data);
    const result = await client.callTool({ name: "whoop_today", arguments: {} });
    const vs = (result.structuredContent as { vs_last_30_days: Record<string, unknown>[] }).vs_last_30_days;
    expect(vs.find((v) => v.metric === "recovery")).toMatchObject({ baseline_days: 1, baseline_avg: null });
    expect(result.structuredContent).toMatchObject({ baseline_window: { days_with_data: 1 } });
  });

  test("whoop_today text is compact JSON", async () => {
    const { client } = await connect(data);
    const result = await client.callTool({ name: "whoop_today", arguments: {} });
    expect(text(result)).not.toContain('\n  "');
  });

  test("whoop_daily_summaries returns a row per day", async () => {
    const { client } = await connect(data);
    const result = await client.callTool({ name: "whoop_daily_summaries", arguments: { days: 2 } });
    expect(result.structuredContent).toMatchObject({
      days: [{ date: yesterday, recovery_pct: 70, workouts: 1, workout_min: 60 }, { date: today }],
    });
  });

  test("rejects a reversed date range with an actionable error", async () => {
    const { client, stub } = await connect(data);
    const result = await client.callTool({
      name: "whoop_daily_summaries",
      arguments: { start_date: today, end_date: yesterday },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("must be on or before end_date");
    expect(stub.calls).toEqual([]);
  });

  test("whoop_workouts filters by sport and totals per sport", async () => {
    const { client } = await connect(data);
    const hit = await client.callTool({ name: "whoop_workouts", arguments: { days: 3, sport: "walk" } });
    expect(hit.structuredContent).toMatchObject({ totals_by_sport: { walking: { count: 1, minutes: 60 } } });
    const miss = await client.callTool({ name: "whoop_workouts", arguments: { days: 3, sport: "rowing" } });
    expect(miss.structuredContent).toMatchObject({ workouts: [] });
  });

  test("raw output is limited to short ranges", async () => {
    const { client, stub } = await connect(data);
    for (const name of ["whoop_daily_summaries", "whoop_sleep", "whoop_workouts"]) {
      const over = await client.callTool({ name, arguments: { days: 8, raw: true } });
      expect(over.isError).toBe(true);
      expect(text(over)).toContain("raw is limited to 7 days");
    }
    expect(stub.calls).toEqual([]);
    for (const name of ["whoop_daily_summaries", "whoop_sleep", "whoop_workouts"]) {
      const ok = await client.callTool({ name, arguments: { days: 7, raw: true } });
      expect(ok.isError).toBeFalsy();
      expect(ok.structuredContent).toHaveProperty("raw");
    }
  });

  test("workout and training-load descriptions define zones by heart-rate reserve", async () => {
    const { client } = await connect(data);
    const { tools } = await client.listTools();
    for (const name of ["whoop_workouts", "whoop_training_load"]) {
      expect(tools.find((t) => t.name === name)?.description).toContain("heart-rate reserve");
    }
  });

  test("whoop_get_record fetches one record by type and id", async () => {
    const { client, stub } = await connect({ "/v2/cycle/2/recovery": recovery(2, "s2", 25) });
    const result = await client.callTool({
      name: "whoop_get_record",
      arguments: { type: "recovery_for_cycle", id: "2" },
    });
    expect(result.structuredContent).toMatchObject({ shaped: { recovery_pct: 25 } });
    expect(stub.calls).toEqual(["/v2/cycle/2/recovery"]);
  });
});

describe("whoop_today honesty", () => {
  const today = todayLocal();
  const yesterday = addDays(today, -1);

  test("after a night without the strap it shows the WHOOP day still running and its workouts", async () => {
    // Started 40 h ago and never ended: always labelled before today, always past the 30 h no-sleep threshold.
    const openStart = new Date(Date.now() - 40 * 3_600_000).toISOString();
    const walkStart = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const { client } = await connect({
      "/v2/cycle": { records: [cycle(1, openStart, undefined)] },
      "/v2/recovery": { records: [] },
      "/v2/activity/sleep": { records: [] },
      "/v2/activity/workout": { records: [workout("w1", walkStart, new Date(Date.now() - 3_600_000).toISOString())] },
    });
    const result = await client.callTool({ name: "whoop_today", arguments: {} });
    expect(result.structuredContent).toMatchObject({
      date: today,
      current_cycle_date: cycleDate({ start: openStart, timezone_offset: "Z" }),
    });
    expect((result.structuredContent as { workouts: unknown[] }).workouts).toHaveLength(1);
    expect(result.structuredContent).toHaveProperty("no_sleep_since");
    expect(text(result)).toContain("still running");
    expect(text(result)).toContain("no recovery recorded");
    expect(text(result)).toContain("strap may have been off");
  });

  const oneDay = (rec: ReturnType<typeof recovery>) => ({
    "/v2/cycle": { records: [cycle(1, `${yesterday}T23:00:00Z`, undefined)] },
    "/v2/recovery": { records: [rec] },
    "/v2/activity/sleep": { records: [sleep("s1", 1, `${yesterday}T23:00:00Z`, `${today}T07:00:00Z`)] },
    "/v2/activity/workout": { records: [] },
  });

  test("an unscorable recovery is not reported as still to come", async () => {
    const { client } = await connect(oneDay({ ...recovery(1, "s1"), score_state: "UNSCORABLE", score: undefined }));
    const result = await client.callTool({ name: "whoop_today", arguments: {} });
    expect(text(result)).toContain("could not score recovery");
    expect(text(result)).not.toContain("not scored yet");
  });

  test("a calibrating red recovery carries a provisional caveat", async () => {
    const rec = recovery(1, "s1", 20);
    const { client } = await connect(oneDay({ ...rec, score: { ...rec.score!, user_calibrating: true } }));
    const result = await client.callTool({ name: "whoop_today", arguments: {} });
    expect(result.structuredContent).toMatchObject({ recovery: { zone: "red", calibrating: true } });
    expect((result.structuredContent as { recovery: { zone_note?: string } }).recovery.zone_note).toContain(
      "provisional",
    );
    expect(text(result)).toContain("provisional because WHOOP is still calibrating");
  });
});

describe("whoop_status session state", () => {
  const stored = {
    access_token: "a",
    refresh_token: "r",
    token_type: "bearer",
    scope: SCOPES.join(" "),
    expires_at: Date.now() + 3600_000,
    obtained_at: Date.now(),
  };
  beforeEach(() => {
    process.env.WHOOP_CLIENT_ID = "id";
    process.env.WHOOP_CLIENT_SECRET = "secret";
  });

  test("an expired session is reported as logged out with a re-login hint", async () => {
    await writeTokenFile(stored);
    const { client } = await connect(OK_RESPONSES, undefined, {
      authProblem: () => ({ session_expired: true, last_error: "The WHOOP session has expired or was revoked." }),
    });
    const result = await client.callTool({ name: "whoop_status", arguments: {} });
    expect(result.structuredContent).toMatchObject({ logged_in: false, session_expired: true });
    expect(text(result)).toContain("expired or was revoked");
    expect(text(result)).not.toContain("WHOOP is connected.");
  });

  test("a failed refresh on a live session is surfaced, not hidden behind 'connected'", async () => {
    await writeTokenFile(stored);
    const { client } = await connect(OK_RESPONSES, undefined, {
      authProblem: () => ({ session_expired: false, last_error: "WHOOP token endpoint returned 500: boom" }),
    });
    const result = await client.callTool({ name: "whoop_status", arguments: {} });
    expect(result.structuredContent).toMatchObject({ logged_in: true, last_error: expect.stringContaining("500") });
    expect(text(result)).toContain("the last token refresh failed");
  });

  test("all scopes and valid tokens read as connected", async () => {
    await writeTokenFile(stored);
    const { client } = await connect();
    const result = await client.callTool({ name: "whoop_status", arguments: {} });
    expect(text(result)).toContain("WHOOP is connected.");
  });
});

describe("whoop_baselines", () => {
  test("uses the WHOOP day still running and keeps today's partial strain out of the comparison", async () => {
    const today = todayLocal();
    const openStart = new Date(Date.now() - 36 * 3_600_000).toISOString();
    const cycles = Array.from({ length: 10 }, (_, i) => {
      const d = addDays(today, -12 + i);
      return cycle(i + 1, `${d}T00:00:00Z`, `${addDays(d, 1)}T00:00:00Z`);
    });
    cycles.push(cycle(99, openStart, undefined));
    const { client } = await connect({
      "/v2/cycle": { records: cycles },
      "/v2/recovery": { records: [] },
      "/v2/activity/sleep": { records: [] },
      "/v2/activity/workout": { records: [] },
    });
    const result = await client.callTool({ name: "whoop_baselines", arguments: { metrics: ["strain"] } });
    const data = result.structuredContent as {
      current_cycle_date?: string;
      in_progress: boolean;
      baselines: Record<string, unknown>[];
    };
    expect(data.current_cycle_date).toBe(cycleDate({ start: openStart, timezone_offset: "Z" }));
    expect(data.in_progress).toBe(true);
    expect(data.baselines[0]).toMatchObject({ metric: "strain", today: null, today_so_far: 10, z_score: null });
  });
});

describe("tool-call logging", () => {
  test("logs the final outcome, including calls the SDK rejects before the tool runs", async () => {
    const lines: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    try {
      const { client } = await connect();
      await client.callTool({ name: "whoop_profile", arguments: {} });
      await client.callTool({ name: "whoop_daily_summaries", arguments: { start_date: "yesterday" } });
    } finally {
      spy.mockRestore();
    }
    expect(lines.some((l) => /INFO {2}tool whoop_profile ok ms=\d+/.test(l))).toBe(true);
    expect(lines.some((l) => /WARN {2}tool whoop_daily_summaries error .*start_date/.test(l))).toBe(true);
    // Results are WHOOP data and never logged.
    expect(lines.join("\n")).not.toContain("Lovelace");
  });
});

describe("dates and windows", () => {
  test("future dates are refused instead of silently showing today", async () => {
    const { client, stub } = await connect({});
    const tomorrow = addDays(todayLocal(), 1);
    for (const [name, args] of [
      ["whoop_today", { date: tomorrow }],
      ["whoop_daily_summaries", { end_date: tomorrow }],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("in the future");
    }
    expect(stub.calls).toEqual([]);
  });

  test("training load counts full 7- and 28-day windows while yesterday's WHOOP day is still running", async () => {
    const today = todayLocal();
    const closed = Array.from({ length: 40 }, (_, i) => {
      const d = addDays(today, -41 + i);
      return cycle(i + 1, `${d}T00:00:00Z`, `${addDays(d, 1)}T00:00:00Z`);
    });
    const open = cycle(99, `${addDays(today, -1)}T00:00:00Z`, undefined);
    const { client } = await connect({
      "/v2/cycle": { records: [...closed, open] },
      "/v2/recovery": { records: [] },
      "/v2/activity/sleep": { records: [] },
      "/v2/activity/workout": { records: [] },
    });
    const result = await client.callTool({ name: "whoop_training_load", arguments: {} });
    expect(result.structuredContent).toMatchObject({ days_with_strain: { acute: 7, chronic: 28 } });
    const daily = (result.structuredContent as { daily: { date: string }[] }).daily;
    expect(daily.at(-1)?.date).toBe(addDays(today, -1));
  });
});

describe("whoop_disconnect", () => {
  const stored = {
    access_token: "a",
    refresh_token: "r",
    token_type: "bearer",
    scope: SCOPES.join(" "),
    expires_at: Date.now() + 3600_000,
    obtained_at: Date.now(),
  };

  test("revokes access at WHOOP and deletes the saved login", async () => {
    await writeTokenFile(stored);
    let revoked = 0;
    const { client } = await connect(OK_RESPONSES, undefined, {
      revokeAccess: async () => {
        revoked++;
        return "revoked";
      },
    });
    const result = await client.callTool({ name: "whoop_disconnect", arguments: {} });
    expect(result.structuredContent).toMatchObject({ disconnected: true, revoked_at_whoop: true });
    expect(revoked).toBe(1);
    expect(await Bun.file(join(home, "tokens.json")).exists()).toBe(false);
    const status = await client.callTool({ name: "whoop_status", arguments: {} });
    expect(status.structuredContent).toMatchObject({ logged_in: false });
  });

  test("still deletes the login when WHOOP can't be reached, and says so", async () => {
    await writeTokenFile(stored);
    const { client } = await connect(OK_RESPONSES, undefined, { revokeAccess: async () => "failed" });
    const result = await client.callTool({ name: "whoop_disconnect", arguments: {} });
    expect(result.structuredContent).toMatchObject({ disconnected: true, revoked_at_whoop: false });
    expect(text(result)).toContain("couldn't revoke");
    expect(await Bun.file(join(home, "tokens.json")).exists()).toBe(false);
  });

  test("forget_app also deletes the saved app credentials", async () => {
    await writeTokenFile(stored);
    process.env.WHOOP_MCP_CREDENTIAL_STORE = "file";
    await writeFile(join(home, "client.json"), JSON.stringify({ clientId: "id", clientSecret: "s" }));
    const { client } = await connect(OK_RESPONSES, undefined, { revokeAccess: async () => "revoked" });
    const result = await client.callTool({ name: "whoop_disconnect", arguments: { forget_app: true } });
    expect(result.structuredContent).toMatchObject({ app_credentials_deleted: true });
    expect(await Bun.file(join(home, "client.json")).exists()).toBe(false);
  });

  test("with nothing connected it says so and calls nothing", async () => {
    let revoked = 0;
    const { client } = await connect(OK_RESPONSES, undefined, {
      revokeAccess: async () => {
        revoked++;
        return "revoked";
      },
    });
    const result = await client.callTool({ name: "whoop_disconnect", arguments: {} });
    expect(text(result)).toContain("wasn't connected");
    expect(revoked).toBe(0);
  });

  test("cancels a connection page that is still open", async () => {
    const flow = pageOnlyFlow();
    const { client } = await connect(OK_RESPONSES, flow);
    await client.callTool({ name: "whoop_login", arguments: { wait_seconds: 0 } });
    expect(flow.status.state).toBe("pending");
    await client.callTool({ name: "whoop_disconnect", arguments: {} });
    expect(flow.status.state).toBe("idle");
  });
});
