import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OAuthHttpError } from "../src/auth/oauth.ts";
import { deleteTokens, readTokens, type StoredTokens, writeTokens } from "../src/auth/store.ts";
import { type ClientCredentials, WHOOP } from "../src/config.ts";
import {
  CredentialsRejectedError,
  NotLoggedInError,
  retryDelayMs,
  SessionExpiredError,
  WhoopApiError,
  WhoopClient,
} from "../src/whoop/client.ts";

const CREDS: ClientCredentials = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  redirectUri: "http://localhost:8787/callback",
};

interface TokenCall {
  body: URLSearchParams;
}
interface ApiCall {
  url: URL;
  authorization: string | null;
}
type TokenHandler = (call: TokenCall) => Response | Promise<Response>;
type ApiHandler = (call: ApiCall) => Response | Promise<Response>;

const originalFetch = globalThis.fetch;
const savedEnv = { ...process.env };
let home: string;
let tokenCalls: TokenCall[];
let apiCalls: ApiCall[];
let onToken: TokenHandler;
let onApi: ApiHandler;
let consoleSpy: ReturnType<typeof spyOn>;

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" }, ...init });

function tokens(overrides: Partial<StoredTokens> = {}): StoredTokens {
  const now = Date.now();
  return {
    access_token: "access-1",
    refresh_token: "refresh-1",
    token_type: "bearer",
    scope: "offline read:profile",
    expires_at: now + 3_600_000,
    obtained_at: now,
    ...overrides,
  };
}

const client = () => new WhoopClient(() => CREDS);

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "whoop-client-test-"));
  process.env.WHOOP_MCP_HOME = home;
  process.env.XDG_CACHE_HOME = home;
  tokenCalls = [];
  apiCalls = [];
  onToken = () => {
    throw new Error("unexpected token request");
  };
  onApi = () => json({ ok: true });
  consoleSpy = spyOn(console, "error").mockImplementation(() => {});
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.href === WHOOP.tokenUrl) {
      const call: TokenCall = { body: new URLSearchParams(String(init?.body ?? "")) };
      tokenCalls.push(call);
      return onToken(call);
    }
    if (url.href.startsWith(`${WHOOP.apiBase}/`)) {
      const call: ApiCall = { url, authorization: new Headers(init?.headers).get("Authorization") };
      apiCalls.push(call);
      return onApi(call);
    }
    throw new Error(`unexpected fetch to ${url.href}`);
  }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  consoleSpy.mockRestore();
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  await rm(home, { recursive: true, force: true });
});

describe("WhoopClient.get", () => {
  test("throws NotLoggedInError without touching the network when no tokens are stored", async () => {
    const err = await client()
      .get("/v2/user/profile/basic")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotLoggedInError);
    expect((err as Error).message).toContain("whoop_login");
    expect(apiCalls).toHaveLength(0);
    expect(tokenCalls).toHaveLength(0);
  });

  test("sends the stored access token as a Bearer header and returns the parsed body", async () => {
    await writeTokens(tokens());
    onApi = () => json({ user_id: 42 });
    const result = await client().get<{ user_id: number }>("/v2/user/profile/basic");
    expect(result).toEqual({ user_id: 42 });
    expect(apiCalls).toHaveLength(1);
    expect(apiCalls[0]?.authorization).toBe("Bearer access-1");
    expect(apiCalls[0]?.url.pathname).toBe("/developer/v2/user/profile/basic");
  });

  test("builds query params from defined values and skips undefined ones", async () => {
    await writeTokens(tokens());
    await client().get("/v2/cycle", { limit: 10, start: "2026-01-01T00:00:00Z", nextToken: undefined });
    const params = apiCalls[0]?.url.searchParams;
    expect(params?.get("limit")).toBe("10");
    expect(params?.get("start")).toBe("2026-01-01T00:00:00Z");
    expect(params?.has("nextToken")).toBe(false);
  });

  test("does not refresh when the access token is valid for more than 60 seconds", async () => {
    await writeTokens(tokens({ expires_at: Date.now() + 120_000 }));
    await client().get("/v2/user/profile/basic");
    expect(tokenCalls).toHaveLength(0);
  });

  test("refreshes before the request when the token expires within 60s and persists new tokens first", async () => {
    await writeTokens(tokens({ expires_at: Date.now() + 30_000 }));
    onToken = () =>
      json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600, token_type: "bearer" });
    let storedDuringApiCall: StoredTokens | null = null;
    onApi = async () => {
      storedDuringApiCall = await readTokens();
      return json({});
    };

    await client().get("/v2/user/profile/basic");

    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]?.body.get("grant_type")).toBe("refresh_token");
    expect(tokenCalls[0]?.body.get("refresh_token")).toBe("refresh-1");
    expect(tokenCalls[0]?.body.get("client_id")).toBe(CREDS.clientId);
    expect(apiCalls[0]?.authorization).toBe("Bearer access-2");
    const stored = storedDuringApiCall as StoredTokens | null;
    expect(stored?.access_token).toBe("access-2");
    expect(stored?.refresh_token).toBe("refresh-2");
  });

  test("keeps the old refresh token when the token response omits one", async () => {
    await writeTokens(tokens({ expires_at: Date.now() - 1000 }));
    onToken = () => json({ access_token: "access-2", expires_in: 3600, token_type: "bearer" });
    await client().get("/v2/user/profile/basic");
    const stored = await readTokens();
    expect(stored?.access_token).toBe("access-2");
    expect(stored?.refresh_token).toBe("refresh-1");
    expect(stored?.scope).toBe("offline read:profile");
  });

  test("a server error on refresh surfaces as an error and leaves the stored tokens untouched", async () => {
    const original = tokens({ expires_at: Date.now() - 1000 });
    await writeTokens(original);
    onToken = () => new Response("boom", { status: 500 });

    const err = await client()
      .get("/v2/user/profile/basic")
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(OAuthHttpError);
    expect((err as OAuthHttpError).status).toBe(500);
    expect(apiCalls).toHaveLength(0);
    expect(await readTokens()).toEqual(original);
  });

  test("invalid_grant reports an expired session, leaves the file alone and stops posting the dead token", async () => {
    const original = tokens({ expires_at: Date.now() - 1000 });
    await writeTokens(original);
    onToken = () => new Response('{"error":"invalid_grant"}', { status: 400 });
    const c = client();

    const err = await c.get("/v2/user/profile/basic").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionExpiredError);
    expect(err).toBeInstanceOf(NotLoggedInError);
    expect((err as Error).message).toContain("whoop_login");
    // Writing a marker could clobber tokens another process is saving, so the file is untouched.
    expect(await readTokens()).toEqual(original);
    expect(c.authProblem(original)).toEqual({ session_expired: true, last_error: (err as Error).message });

    // The same process fails fast without another token request.
    await expect(c.get("/v2/user/profile/basic")).rejects.toBeInstanceOf(SessionExpiredError);
    expect(tokenCalls).toHaveLength(1);
    expect(apiCalls).toHaveLength(0);
  });

  test("a new login (a different refresh token) clears the expired state", async () => {
    await writeTokens(tokens({ expires_at: Date.now() - 1000 }));
    onToken = () => new Response('{"error":"invalid_grant"}', { status: 400 });
    const c = client();
    await expect(c.get("/v2/user/profile/basic")).rejects.toBeInstanceOf(SessionExpiredError);

    const fresh = tokens({ access_token: "access-new", refresh_token: "refresh-new" });
    await writeTokens(fresh);
    expect(c.authProblem(fresh)).toEqual({ session_expired: false, last_error: null });
    await c.get("/v2/user/profile/basic");
    expect(apiCalls.at(-1)?.authorization).toBe("Bearer access-new");
  });

  test("a failed refresh is reported until a later refresh succeeds", async () => {
    const stale = tokens({ expires_at: Date.now() - 1000 });
    await writeTokens(stale);
    let fail = true;
    onToken = () =>
      fail
        ? new Response("boom", { status: 500 })
        : json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600, token_type: "bearer" });
    const c = client();
    await expect(c.get("/v2/user/profile/basic")).rejects.toBeInstanceOf(OAuthHttpError);
    expect(c.authProblem(stale)).toMatchObject({ session_expired: false, last_error: expect.stringContaining("500") });
    fail = false;
    await c.get("/v2/user/profile/basic");
    expect(c.authProblem(await readTokens())).toEqual({ session_expired: false, last_error: null });
  });

  test("invalid_grant after another process already rotated the token uses the stored tokens", async () => {
    await writeTokens(tokens({ expires_at: Date.now() - 1000 }));
    onToken = async () => {
      // The other process won the race and wrote its new tokens before our request was rejected.
      await writeTokens(tokens({ access_token: "access-other", refresh_token: "refresh-other" }));
      return new Response('{"error":"invalid_grant"}', { status: 400 });
    };
    await client().get("/v2/user/profile/basic");
    expect(apiCalls.at(-1)?.authorization).toBe("Bearer access-other");
  });

  for (const code of ["invalid_client", "unauthorized_client"]) {
    test(`${code} points to reconfiguring the app credentials and keeps the tokens`, async () => {
      const original = tokens({ expires_at: Date.now() - 1000 });
      await writeTokens(original);
      onToken = () => new Response(JSON.stringify({ error: code }), { status: 401 });
      const err = await client()
        .get("/v2/user/profile/basic")
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CredentialsRejectedError);
      expect((err as Error).message).toContain("reconfigure: true");
      expect(await readTokens()).toEqual(original);
    });
  }

  test("a logout while the refresh is in flight is not undone by writing the new tokens", async () => {
    await writeTokens(tokens({ expires_at: Date.now() - 1000 }));
    onToken = async () => {
      await deleteTokens();
      return json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600, token_type: "bearer" });
    };
    await expect(client().get("/v2/user/profile/basic")).rejects.toBeInstanceOf(NotLoggedInError);
    expect(await readTokens()).toBeNull();
    expect(apiCalls).toHaveLength(0);
  });

  test("a re-login while the refresh is in flight wins over the refreshed tokens", async () => {
    await writeTokens(tokens({ expires_at: Date.now() - 1000 }));
    onToken = async () => {
      await writeTokens(tokens({ access_token: "access-login", refresh_token: "refresh-login" }));
      return json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600, token_type: "bearer" });
    };
    await client().get("/v2/user/profile/basic");
    expect(apiCalls.at(-1)?.authorization).toBe("Bearer access-login");
    expect((await readTokens())?.refresh_token).toBe("refresh-login");
  });

  test("throws NotLoggedInError when a refresh is needed but no refresh token is stored", async () => {
    await writeTokens(tokens({ expires_at: Date.now() - 1000, refresh_token: undefined }));
    const err = await client()
      .get("/v2/user/profile/basic")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotLoggedInError);
    expect(tokenCalls).toHaveLength(0);
    expect(apiCalls).toHaveLength(0);
  });

  test("allows a new refresh after a failed one instead of caching the rejection", async () => {
    await writeTokens(tokens({ expires_at: Date.now() - 1000 }));
    let fail = true;
    onToken = () =>
      fail
        ? new Response("boom", { status: 500 })
        : json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600, token_type: "bearer" });
    const c = client();
    await expect(c.get("/v2/user/profile/basic")).rejects.toBeInstanceOf(OAuthHttpError);
    fail = false;
    await c.get("/v2/user/profile/basic");
    expect(tokenCalls).toHaveLength(2);
    expect(apiCalls.at(-1)?.authorization).toBe("Bearer access-2");
  });

  test("drain() waits until an in-flight refresh has saved its tokens", async () => {
    await writeTokens(tokens({ expires_at: Date.now() - 1000 }));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    onToken = async () => {
      await gate;
      return json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600, token_type: "bearer" });
    };
    const c = client();
    const call = c.get("/v2/user/profile/basic");
    await Bun.sleep(5);
    let drained = false;
    const draining = c.drain().then(() => {
      drained = true;
    });
    await Bun.sleep(5);
    expect(drained).toBe(false);
    release();
    await draining;
    expect((await readTokens())?.refresh_token).toBe("refresh-2");
    await call;
  });

  test("concurrent requests that both need a refresh share exactly one token request", async () => {
    await writeTokens(tokens({ expires_at: Date.now() - 1000 }));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    onToken = async () => {
      await gate;
      return json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600, token_type: "bearer" });
    };
    const c = client();
    const a = c.get("/v2/user/profile/basic");
    const b = c.get("/v2/cycle");
    // Let both calls read the store and reach the refresh before the token response arrives.
    while (tokenCalls.length === 0) await new Promise((r) => setTimeout(r, 1));
    await new Promise((r) => setTimeout(r, 5));
    release();
    await Promise.all([a, b]);

    expect(tokenCalls).toHaveLength(1);
    expect(apiCalls.map((c) => c.authorization)).toEqual(["Bearer access-2", "Bearer access-2"]);
  });
});

describe("WhoopClient 401 handling", () => {
  test("retries with the on-disk token when another process already rotated it, without refreshing", async () => {
    await writeTokens(tokens());
    onApi = async ({ authorization }) => {
      if (authorization === "Bearer access-1") {
        // Simulate another process rotating the tokens while our request was in flight.
        await writeTokens(tokens({ access_token: "access-other", refresh_token: "refresh-other" }));
        return new Response("unauthorized", { status: 401 });
      }
      return json({ ok: true });
    };

    const result = await client().get("/v2/user/profile/basic");

    expect(result).toEqual({ ok: true });
    expect(tokenCalls).toHaveLength(0);
    expect(apiCalls.map((c) => c.authorization)).toEqual(["Bearer access-1", "Bearer access-other"]);
  });

  test("refreshes exactly once and retries when the store still holds the rejected token", async () => {
    await writeTokens(tokens());
    onToken = () =>
      json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600, token_type: "bearer" });
    onApi = ({ authorization }) =>
      authorization === "Bearer access-1" ? new Response("unauthorized", { status: 401 }) : json({ ok: true });

    const result = await client().get("/v2/user/profile/basic");

    expect(result).toEqual({ ok: true });
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]?.body.get("refresh_token")).toBe("refresh-1");
    expect(apiCalls.map((c) => c.authorization)).toEqual(["Bearer access-1", "Bearer access-2"]);
    expect((await readTokens())?.refresh_token).toBe("refresh-2");
  });

  // Bug: when the token file was deleted (e.g. logout from another process) while a request was in
  // flight, get() refreshes with the in-memory tokens and writes them back, silently logging the user in again.
  test("a 401 after the token file was deleted throws NotLoggedInError instead of reviving the login", async () => {
    await writeTokens(tokens());
    onToken = () =>
      json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600, token_type: "bearer" });
    onApi = async ({ authorization }) => {
      if (authorization === "Bearer access-1") {
        await rm(join(home, "tokens.json"), { force: true });
        return new Response("unauthorized", { status: 401 });
      }
      return json({ ok: true });
    };

    const err = await client()
      .get("/v2/user/profile/basic")
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NotLoggedInError);
    expect(tokenCalls).toHaveLength(0);
    expect(await readTokens()).toBeNull();
  });

  test("a second 401 after the retry becomes a WhoopApiError instead of looping", async () => {
    await writeTokens(tokens());
    onToken = () =>
      json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600, token_type: "bearer" });
    onApi = () => new Response("still unauthorized", { status: 401, headers: { "x-whoop-trace-id": "trace-401" } });

    const err = await client()
      .get("/v2/user/profile/basic")
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(WhoopApiError);
    expect((err as WhoopApiError).status).toBe(401);
    expect(apiCalls).toHaveLength(2);
    expect(tokenCalls).toHaveLength(1);
  });
});

describe("WhoopClient errors and metadata", () => {
  test("WhoopApiError carries status, path, body and the x-whoop-trace-id", async () => {
    await writeTokens(tokens());
    onApi = () => new Response('{"message":"nope"}', { status: 404, headers: { "x-whoop-trace-id": "trace-abc" } });

    const err = await client()
      .get("/v2/recovery", { limit: 1 })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(WhoopApiError);
    const apiErr = err as WhoopApiError;
    expect(apiErr.status).toBe(404);
    expect(apiErr.path).toBe("/v2/recovery");
    expect(apiErr.body).toBe('{"message":"nope"}');
    expect(apiErr.traceId).toBe("trace-abc");
    expect(apiErr.message).toBe('WHOOP API 404 on /v2/recovery (trace trace-abc): {"message":"nope"}');
  });

  test("WhoopApiError message truncates long bodies to 300 characters", async () => {
    await writeTokens(tokens());
    onApi = () => new Response("x".repeat(1000), { status: 500 });
    const err = (await client()
      .get("/v2/cycle")
      .catch((e: unknown) => e)) as WhoopApiError;
    expect(err.traceId).toBeUndefined();
    expect(err.message).toBe(`WHOOP API 500 on /v2/cycle: ${"x".repeat(300)}`);
  });

  test("lastMeta captures the trace id and x-ratelimit-* headers with lowercased names", async () => {
    await writeTokens(tokens());
    onApi = () =>
      json(
        {},
        {
          headers: {
            "X-RateLimit-Limit": "100, 100;window=60",
            "X-RateLimit-Remaining": "99",
            "X-RateLimit-Reset": "42",
            "X-Whoop-Trace-Id": "trace-meta",
            "Content-Type": "application/json",
          },
        },
      );
    const c = client();
    await c.get("/v2/user/profile/basic");
    expect(c.lastMeta).toEqual({
      traceId: "trace-meta",
      rateLimit: {
        "x-ratelimit-limit": "100, 100;window=60",
        "x-ratelimit-remaining": "99",
        "x-ratelimit-reset": "42",
      },
    });
  });

  test("lastMeta is reset on each response rather than accumulating stale headers", async () => {
    await writeTokens(tokens());
    let first = true;
    onApi = () => {
      const headers: Record<string, string> = first ? { "X-RateLimit-Remaining": "5", "X-Whoop-Trace-Id": "t1" } : {};
      first = false;
      return json({}, { headers });
    };
    const c = client();
    await c.get("/v2/user/profile/basic");
    await c.get("/v2/user/profile/basic");
    expect(c.lastMeta).toEqual({ traceId: undefined, rateLimit: {} });
  });
});

describe("WhoopClient 429 handling", () => {
  test("waits for Retry-After and retries a rate-limited request", async () => {
    await writeTokens(tokens());
    let calls = 0;
    onApi = () => (++calls === 1 ? json({}, { status: 429, headers: { "Retry-After": "0.01" } }) : json({ ok: 1 }));
    expect(await client().get<{ ok: number }>("/v2/cycle")).toEqual({ ok: 1 });
    expect(calls).toBe(2);
  });

  test("gives up after two retries with a WhoopApiError", async () => {
    await writeTokens(tokens());
    onApi = () => json({}, { status: 429, headers: { "X-RateLimit-Reset": "0.01" } });
    await expect(client().get("/v2/cycle")).rejects.toBeInstanceOf(WhoopApiError);
    expect(apiCalls).toHaveLength(3);
  });
});

describe("retryDelayMs", () => {
  test("uses Retry-After, then X-RateLimit-Reset, capped at 30s, else 2s", () => {
    expect(retryDelayMs(new Response(null, { headers: { "Retry-After": "5" } }))).toBe(5000);
    expect(retryDelayMs(new Response(null, { headers: { "X-RateLimit-Reset": "12" } }))).toBe(12_000);
    expect(retryDelayMs(new Response(null, { headers: { "Retry-After": "600" } }))).toBe(30_000);
    expect(retryDelayMs(new Response(null))).toBe(2000);
  });
});
