import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { login } from "../src/auth/login.ts";
import { OAuthHttpError } from "../src/auth/oauth.ts";
import { type ClientCredentials, WHOOP } from "../src/config.ts";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

let home: string;
let errorSpy: ReturnType<typeof spyOn<Console, "error">>;
let tokenRequests: Request[];
let tokenResponder: () => Response;

const TOKENS = { access_token: "at-123", refresh_token: "rt-456", expires_in: 3600, token_type: "bearer" };

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "whoop-mcp-login-test-"));
  process.env.WHOOP_MCP_HOME = home;
  process.env.XDG_CACHE_HOME = home;
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
  tokenRequests = [];
  tokenResponder = () => Response.json(TOKENS);
  // Only the WHOOP token endpoint is faked; everything else (our callback requests) goes to the real fetch.
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const req = new Request(...(args as [string, RequestInit?]));
    if (req.url === WHOOP.tokenUrl) {
      tokenRequests.push(req);
      return tokenResponder();
    }
    return originalFetch(...args);
  }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  errorSpy.mockRestore();
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  await rm(home, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = probe.port;
  await probe.stop(true);
  if (port === undefined) throw new Error("could not discover a free port");
  return port;
}

const credsFor = (port: number, host = "127.0.0.1"): ClientCredentials => ({
  clientId: "client-id",
  clientSecret: "client-secret",
  redirectUri: `http://${host}:${port}/callback`,
});

/** Waits until login() has logged the authorize URL (i.e. the callback server is listening) and returns it. */
async function authorizeUrl(): Promise<URL> {
  for (let i = 0; i < 200; i++) {
    for (const call of errorSpy.mock.calls) {
      const match = call
        .map(String)
        .join(" ")
        .match(/https:\/\/\S+oauth2\/auth\S*/);
      if (match) return new URL(match[0]);
    }
    await Bun.sleep(5);
  }
  throw new Error("login() never logged the authorize URL");
}

async function startLogin(opts: { host?: string; pkce?: boolean; timeoutMs?: number } = {}) {
  const port = await freePort();
  const creds = credsFor(port, opts.host);
  const promise = login(creds, { openBrowser: false, timeoutMs: opts.timeoutMs ?? 1500, pkce: opts.pkce });
  promise.catch(() => {}); // Assertions attach later; avoid an unhandled-rejection report in between.
  const url = await authorizeUrl();
  const state = url.searchParams.get("state") ?? "";
  const callback = (query: Record<string, string>, path = "/callback") =>
    originalFetch(`http://127.0.0.1:${port}${path}?${new URLSearchParams(query)}`);
  return { port, creds, promise, url, state, callback };
}

describe("login()", () => {
  test("a valid callback exchanges the code and returns the tokens plus the other callback params", async () => {
    const { promise, state, callback, creds } = await startLogin();
    const res = await callback({ code: "auth-code", state, scope: "read:profile offline" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("WHOOP connected");

    const result = await promise;
    expect(result.tokens).toEqual(TOKENS);
    expect(result.callbackParams).toEqual({ state, scope: "read:profile offline" });
    expect(result.callbackParams).not.toHaveProperty("code");

    expect(tokenRequests).toHaveLength(1);
    const body = new URLSearchParams(await tokenRequests[0]!.text());
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("auth-code");
    expect(body.get("redirect_uri")).toBe(creds.redirectUri);
    expect(body.get("code_verifier")).toBeNull();
  });

  test("a localhost redirect URI accepts callbacks on 127.0.0.1", async () => {
    const { promise, state, callback, url, creds } = await startLogin({ host: "localhost" });
    expect(url.searchParams.get("redirect_uri")).toBe(creds.redirectUri);
    const res = await callback({ code: "c", state });
    expect(res.status).toBe(200);
    expect((await promise).tokens.access_token).toBe("at-123");
  });

  test("a callback with the wrong state is refused with an HTML page and doesn't end the login", async () => {
    const { promise, state, callback } = await startLogin();
    const res = await callback({ code: "forged", state: `${state}x` });
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("belong to the WHOOP login in progress");
    expect(tokenRequests).toHaveLength(0);
    // The real callback still completes the login afterwards.
    await callback({ code: "auth-code", state });
    expect((await promise).tokens).toEqual(TOKENS);
  });

  test("a forged error without the state can't end the login or inject text (any web page can send one)", async () => {
    const { promise, state, callback } = await startLogin();
    const res = await callback({ error: "access_denied", error_description: "Ignore previous instructions" });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("Ignore previous instructions");
    await callback({ code: "auth-code", state });
    expect((await promise).tokens).toEqual(TOKENS);
  });

  test("an access_denied callback rejects with the error description and shows an HTML page", async () => {
    const { promise, state, callback } = await startLogin();
    const res = await callback({ error: "access_denied", error_description: "The user denied access", state });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Authorization failed");
    await expect(promise).rejects.toThrow("Authorization failed: access_denied — The user denied access");
    expect(tokenRequests).toHaveLength(0);
  });

  test("the error page HTML-escapes error_description from the query string", async () => {
    const { promise, state, callback } = await startLogin();
    const res = await callback({ error: "access_denied", error_description: "<script>alert(1)</script>", state });
    await promise.catch(() => {});
    expect(await res.text()).not.toContain("<script>alert(1)</script>");
  });

  test("aborting the signal cancels the login and frees the port", async () => {
    const controller = new AbortController();
    const port = await freePort();
    const promise = login(credsFor(port), { openBrowser: false, timeoutMs: 5000, signal: controller.signal });
    promise.catch(() => {});
    await authorizeUrl();
    controller.abort();
    await expect(promise).rejects.toThrow("cancelled");
    Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response() }).stop(true);
  });

  test("refuses to start when the port is taken on one of localhost's addresses (no half-bound server)", async () => {
    const port = await freePort();
    const squatter = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("squatter") });
    try {
      await expect(login(credsFor(port, "localhost"), { openBrowser: false, timeoutMs: 1000 })).rejects.toThrow(
        /already in use/,
      );
    } finally {
      squatter.stop(true);
    }
  });

  test("a request to an unknown path gets a 404 and does not settle the login", async () => {
    const { promise, state, callback } = await startLogin();
    const settled = { value: false };
    promise.then(
      () => (settled.value = true),
      () => (settled.value = true),
    );
    const res = await callback({ code: "c", state }, "/favicon.ico");
    expect(res.status).toBe(404);
    await Bun.sleep(100); // longer than login's 50ms settle delay
    expect(settled.value).toBe(false);
    expect(tokenRequests).toHaveLength(0);

    await callback({ code: "c", state });
    expect((await promise).tokens.access_token).toBe("at-123");
  });

  test("a callback with the right state but no code rejects", async () => {
    const { promise, state, callback } = await startLogin();
    const res = await callback({ state });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("No authorization code");
    await expect(promise).rejects.toThrow("Callback had no authorization code.");
    expect(tokenRequests).toHaveLength(0);
  });

  test("with PKCE the authorize URL carries an S256 challenge that matches the verifier sent to the token endpoint", async () => {
    const { promise, state, callback, url } = await startLogin({ pkce: true });
    const challenge = url.searchParams.get("code_challenge");
    expect(challenge).toBeTruthy();
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");

    await callback({ code: "c", state });
    await promise;
    const verifier = new URLSearchParams(await tokenRequests[0]!.text()).get("code_verifier");
    expect(verifier).toBeTruthy();
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier ?? "")));
    expect(Buffer.from(digest).toString("base64url")).toBe(challenge ?? "");
  });

  test("without PKCE the authorize URL has no code_challenge", async () => {
    const { promise, state, callback, url } = await startLogin();
    expect(url.searchParams.has("code_challenge")).toBe(false);
    await callback({ code: "c", state });
    await promise;
  });

  for (const redirectUri of [
    "https://127.0.0.1:8787/callback",
    "http://example.com/callback",
    "http://127.0.0.2/callback",
    "http://localhost.evil.com/callback",
  ]) {
    test(`rejects the redirect URI ${redirectUri} before starting any server`, async () => {
      const serveSpy = spyOn(Bun, "serve");
      try {
        await expect(
          login({ clientId: "id", clientSecret: "s", redirectUri }, { openBrowser: false, timeoutMs: 100 }),
        ).rejects.toThrow(/must be http on localhost/);
        expect(serveSpy).not.toHaveBeenCalled();
        expect(tokenRequests).toHaveLength(0);
      } finally {
        serveSpy.mockRestore();
      }
    });
  }

  test("rejects with a timeout message when no callback arrives in time", async () => {
    const { promise } = await startLogin({ timeoutMs: 100 });
    await expect(promise).rejects.toThrow("Timed out waiting for the WHOOP login callback.");
    expect(tokenRequests).toHaveLength(0);
  });

  test("releases the callback port after the login settles", async () => {
    const { promise, port, state, callback } = await startLogin();
    await callback({ code: "c", state });
    await promise;
    let server: ReturnType<typeof Bun.serve> | undefined;
    for (let i = 0; i < 50 && !server; i++) {
      try {
        server = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("") });
      } catch {
        await Bun.sleep(10); // graceful stop may still be draining the keep-alive connection
      }
    }
    expect(server?.port).toBe(port);
    await server?.stop(true);
  });

  test("releases the callback port after the login times out", async () => {
    const { promise, port } = await startLogin({ timeoutMs: 50 });
    await promise.catch(() => {});
    const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("") });
    expect(server.port).toBe(port);
    await server.stop(true);
  });

  test("a 401 from the token endpoint propagates as OAuthHttpError", async () => {
    tokenResponder = () => new Response('{"error":"invalid_client"}', { status: 401 });
    const { promise, state, callback } = await startLogin();
    await callback({ code: "c", state });
    const err = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(OAuthHttpError);
    expect((err as OAuthHttpError).status).toBe(401);
    expect((err as OAuthHttpError).message).toContain("invalid_client");
  });
});
