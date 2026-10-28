import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  buildAuthorizeUrl,
  exchangeCode,
  OAuthHttpError,
  randomState,
  refreshTokens,
  type TokenResponse,
  toStored,
} from "../src/auth/oauth.ts";
import type { StoredTokens } from "../src/auth/store.ts";
import { type ClientCredentials, SCOPES, WHOOP } from "../src/config.ts";

const creds: ClientCredentials = {
  clientId: "client id&1",
  clientSecret: "s3cr:et/+=",
  redirectUri: "http://localhost:8787/callback",
};

interface Captured {
  url: string;
  method: string | undefined;
  headers: Headers;
  body: URLSearchParams;
}

const originalFetch = globalThis.fetch;
let calls: Captured[];
let nextResponse: () => Response;

beforeEach(() => {
  calls = [];
  nextResponse = () =>
    new Response(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600, token_type: "bearer" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = init?.body;
    calls.push({
      url: String(input),
      method: init?.method,
      headers: new Headers(init?.headers),
      body: body instanceof URLSearchParams ? body : new URLSearchParams(String(body ?? "")),
    });
    return nextResponse();
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function onlyCall(): Captured {
  expect(calls).toHaveLength(1);
  return calls[0]!;
}

describe("buildAuthorizeUrl", () => {
  test("targets the WHOOP authorize endpoint with every required OAuth parameter", () => {
    const url = new URL(buildAuthorizeUrl({ creds, state: "state123" }));
    expect(`${url.origin}${url.pathname}`).toBe(WHOOP.authorizeUrl);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(creds.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(creds.redirectUri);
    expect(url.searchParams.get("state")).toBe("state123");
  });

  test("requests the default scopes space-joined, including offline for a refresh token", () => {
    const url = new URL(buildAuthorizeUrl({ creds, state: "s" }));
    expect(url.searchParams.get("scope")).toBe(SCOPES.join(" "));
    expect(url.searchParams.get("scope")?.split(" ")).toContain("offline");
  });

  test("uses custom scopes when given", () => {
    const url = new URL(buildAuthorizeUrl({ creds, state: "s", scopes: ["read:profile", "read:sleep"] }));
    expect(url.searchParams.get("scope")).toBe("read:profile read:sleep");
  });

  test("never leaks the client secret into the authorize URL", () => {
    const raw = buildAuthorizeUrl({ creds, state: "s" });
    expect(raw).not.toContain(encodeURIComponent(creds.clientSecret));
    expect(decodeURIComponent(raw)).not.toContain(creds.clientSecret);
    expect(new URL(raw).searchParams.has("client_secret")).toBe(false);
  });
});

describe("randomState", () => {
  test("defaults to 32 URL-safe characters", () => {
    const s = randomState();
    expect(s).toHaveLength(32);
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("honours the requested length", () => {
    for (const n of [8, 16, 64]) expect(randomState(n)).toHaveLength(n);
  });

  test("is not repeated across calls", () => {
    expect(randomState()).not.toBe(randomState());
  });
});

describe("exchangeCode", () => {
  test("POSTs a form-urlencoded authorization_code grant to the token URL", async () => {
    const resp = await exchangeCode(creds, "the-code");
    const call = onlyCall();
    expect(call.url).toBe(WHOOP.tokenUrl);
    expect(call.method).toBe("POST");
    expect(call.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(call.headers.get("accept")).toBe("application/json");
    expect(call.body.get("grant_type")).toBe("authorization_code");
    expect(call.body.get("code")).toBe("the-code");
    expect(call.body.get("redirect_uri")).toBe(creds.redirectUri);
    expect(resp.access_token).toBe("at");
  });

  test("sends client credentials in the body and no Authorization header", async () => {
    await exchangeCode(creds, "c");
    const call = onlyCall();
    expect(call.body.get("client_id")).toBe(creds.clientId);
    expect(call.body.get("client_secret")).toBe(creds.clientSecret);
    expect(call.headers.has("authorization")).toBe(false);
  });
});

describe("refreshTokens", () => {
  test("POSTs a refresh_token grant with scope=offline", async () => {
    await refreshTokens(creds, "old-rt");
    const call = onlyCall();
    expect(call.url).toBe(WHOOP.tokenUrl);
    expect(call.method).toBe("POST");
    expect(call.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(call.body.get("grant_type")).toBe("refresh_token");
    expect(call.body.get("refresh_token")).toBe("old-rt");
    expect(call.body.get("scope")).toBe("offline");
    expect(call.body.get("client_id")).toBe(creds.clientId);
    expect(call.body.get("client_secret")).toBe(creds.clientSecret);
  });
});

describe("token endpoint errors", () => {
  test("a non-2xx response throws OAuthHttpError carrying status and body", async () => {
    nextResponse = () => new Response('{"error":"invalid_grant"}', { status: 400 });
    const err = await refreshTokens(creds, "rt").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthHttpError);
    const httpErr = err as OAuthHttpError;
    expect(httpErr.name).toBe("OAuthHttpError");
    expect(httpErr.status).toBe(400);
    expect(httpErr.body).toBe('{"error":"invalid_grant"}');
    expect(httpErr.message).toContain("400");
    expect(httpErr.message).toContain("invalid_grant");
  });

  test("the error message truncates very long bodies but keeps the full body on the error", async () => {
    const long = "x".repeat(5000);
    nextResponse = () => new Response(long, { status: 500 });
    const err = (await exchangeCode(creds, "c").catch((e: unknown) => e)) as OAuthHttpError;
    expect(err.body).toBe(long);
    expect(err.message.length).toBeLessThan(400);
  });
});

describe("toStored", () => {
  const now = 1_700_000_000_000;
  const previous: StoredTokens = {
    access_token: "old-at",
    refresh_token: "old-rt",
    token_type: "bearer",
    scope: "offline read:profile",
    expires_at: now - 1000,
    obtained_at: now - 3_600_000,
  };

  test("computes expires_at and obtained_at from the injected clock", () => {
    const stored = toStored({ access_token: "at", expires_in: 3600, token_type: "bearer" }, null, now);
    expect(stored.obtained_at).toBe(now);
    expect(stored.expires_at).toBe(now + 3_600_000);
  });

  test("keeps the previous refresh token and scope when the response omits them", () => {
    const stored = toStored({ access_token: "new-at", expires_in: 60, token_type: "bearer" }, previous, now);
    expect(stored.access_token).toBe("new-at");
    expect(stored.refresh_token).toBe("old-rt");
    expect(stored.scope).toBe("offline read:profile");
  });

  test("uses the new refresh token and scope when the response includes them", () => {
    const resp: TokenResponse = {
      access_token: "new-at",
      refresh_token: "new-rt",
      expires_in: 60,
      token_type: "bearer",
      scope: "offline",
    };
    const stored = toStored(resp, previous, now);
    expect(stored.refresh_token).toBe("new-rt");
    expect(stored.scope).toBe("offline");
  });

  test("leaves refresh token undefined when neither response nor previous has one", () => {
    const stored = toStored({ access_token: "at", expires_in: 60, token_type: "bearer" }, undefined, now);
    expect(stored.refresh_token).toBeUndefined();
    expect(stored.scope).toBeUndefined();
  });
});
