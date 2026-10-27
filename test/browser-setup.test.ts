import { afterEach, describe, expect, test } from "bun:test";
import { type BrowserSetupOptions, type BrowserSetupResult, browserSetup } from "../src/auth/browser-setup.ts";
import type { TokenResponse } from "../src/auth/oauth.ts";
import { type ClientCredentials, WHOOP } from "../src/config.ts";
import type { VerifyResult } from "../src/setup.ts";

const TOKENS: TokenResponse = { access_token: "at", refresh_token: "rt", expires_in: 3600, token_type: "bearer" };

function freePort(): number {
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = s.port as number;
  s.stop(true);
  return port;
}

interface Harness {
  base: string;
  setupUrl: string;
  token: string;
  origin: string;
  redirectUri: string;
  result: Promise<BrowserSetupResult>;
  verified: ClientCredentials[];
  saved: ClientCredentials[];
  exchanged: { creds: ClientCredentials; code: string }[];
  /** Ends the flow now (instead of waiting for its timeout) and waits for it to settle. */
  cancel: () => Promise<void>;
}

let running: Promise<unknown>[] = [];
afterEach(async () => {
  // Let every flow finish (or time out) so ports are released between tests.
  await Promise.allSettled(running);
  running = [];
});

async function start(
  overrides: Partial<BrowserSetupOptions> & { verifyResult?: (c: ClientCredentials) => VerifyResult } = {},
): Promise<Harness> {
  const port = freePort();
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const verified: ClientCredentials[] = [];
  const saved: ClientCredentials[] = [];
  const exchanged: { creds: ClientCredentials; code: string }[] = [];
  const urlReady = Promise.withResolvers<string>();
  const controller = new AbortController();
  const result = browserSetup({
    signal: controller.signal,
    redirectUri,
    openBrowser: false,
    timeoutMs: 2000,
    onSetupUrl: urlReady.resolve,
    verify: async (c) => {
      verified.push(c);
      return overrides.verifyResult?.(c) ?? { ok: true };
    },
    save: async (c) => {
      saved.push(c);
      return "keychain";
    },
    exchange: async (creds, code) => {
      exchanged.push({ creds, code });
      return TOKENS;
    },
    ...overrides,
  });
  running.push(result.catch(() => {}));
  const setupUrl = await urlReady.promise;
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    setupUrl,
    token: new URL(setupUrl).searchParams.get("t") ?? "",
    origin: base,
    redirectUri,
    result,
    verified,
    saved,
    exchanged,
    cancel: async () => {
      controller.abort();
      await result.catch(() => {});
    },
  };
}

/** Submits the form the way a browser would: same-origin, urlencoded, without following the redirect. */
function submit(h: Harness, fields: Record<string, string>, headers: Record<string, string> = { Origin: h.origin }) {
  return fetch(`${h.base}/setup`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields),
  });
}

const goodForm = (h: Harness) => ({ token: h.token, client_id: "my-client", client_secret: "my-secret" });

describe("setup page", () => {
  test("the setup URL is a one-time link on the redirect URI's host", async () => {
    const h = await start();
    const url = new URL(h.setupUrl);
    expect(url.origin).toBe(h.base);
    expect(url.pathname).toBe("/setup");
    expect(h.token.length).toBeGreaterThanOrEqual(32);
    await h.cancel();
  });

  test("serves the form with instructions, no caching and a locked-down CSP", async () => {
    const h = await start();
    const res = await fetch(h.setupUrl);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("developer-dashboard.whoop.com");
    expect(html).toContain(h.redirectUri);
    expect(html).toContain('type="password"');
    expect(res.headers.get("cache-control")).toBe("no-store");
    // "no-referrer" would make browsers send `Origin: null` on the form post, which the CSRF check refuses.
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    // No form-action: Chrome would apply it to WHOOP's own redirects after the 303 and block the consent page.
    expect(csp).not.toContain("form-action");
    await h.cancel();
  });

  test("refuses the page without the right token", async () => {
    const h = await start();
    expect((await fetch(`${h.base}/setup`)).status).toBe(403);
    expect((await fetch(`${h.base}/setup?t=wrong`)).status).toBe(403);
    await h.cancel();
  });

  test("refuses requests for another Host (DNS rebinding)", async () => {
    const h = await start();
    const res = await fetch(h.setupUrl, { headers: { Host: "evil.example:80" } });
    expect(res.status).toBe(421);
    await h.cancel();
  });

  test("refuses cross-site, opaque-origin and origin-less form posts", async () => {
    const h = await start();
    expect((await submit(h, goodForm(h), { Origin: "https://evil.example" })).status).toBe(403);
    expect((await submit(h, goodForm(h), { Origin: "null" })).status).toBe(403);
    expect((await submit(h, goodForm(h), {})).status).toBe(403);
    expect(h.verified).toEqual([]);
    expect(h.saved).toEqual([]);
    await h.cancel();
  });

  test("refuses a post with the wrong token", async () => {
    const h = await start();
    expect((await submit(h, { ...goodForm(h), token: "nope" })).status).toBe(403);
    expect(h.saved).toEqual([]);
    await h.cancel();
  });

  test("refuses oversized bodies", async () => {
    const h = await start();
    const res = await submit(h, { ...goodForm(h), padding: "x".repeat(10_000) });
    expect(res.status).toBe(413);
    await h.cancel();
  });

  test("blank fields re-render the form with an error, without contacting WHOOP", async () => {
    const h = await start();
    const res = await submit(h, { token: h.token, client_id: "my-client", client_secret: "  " });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Enter both");
    expect(h.verified).toEqual([]);
    await h.cancel();
  });

  test("rejected credentials re-render the form keeping the ID but never echoing the secret, and can be retried", async () => {
    const h = await start({
      verifyResult: (c) =>
        c.clientSecret === "right" ? { ok: true } : { ok: false, reason: "WHOOP rejected the client ID or secret." },
    });
    const bad = await submit(h, { token: h.token, client_id: "my-client", client_secret: "wrong-secret-123" });
    const html = await bad.text();
    expect(bad.status).toBe(400);
    expect(html).toContain("WHOOP rejected the client ID or secret.");
    expect(html).toContain('value="my-client"');
    expect(html).not.toContain("wrong-secret-123");
    expect(h.saved).toEqual([]);

    const good = await submit(h, { token: h.token, client_id: "my-client", client_secret: "right" });
    expect(good.status).toBe(303);
    expect(h.saved).toHaveLength(1);
    await h.cancel();
  });

  test("HTML in submitted values is escaped when the form is re-rendered", async () => {
    const h = await start({ verifyResult: () => ({ ok: false, reason: "nope." }) });
    const res = await submit(h, { token: h.token, client_id: '"><script>alert(1)</script>', client_secret: "s" });
    const html = await res.text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    await h.cancel();
  });
});

describe("full flow", () => {
  test("valid credentials are saved, then the browser is sent on to WHOOP's consent page", async () => {
    const h = await start();
    const res = await submit(h, goodForm(h));
    expect(res.status).toBe(303);
    const location = new URL(res.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(WHOOP.authorizeUrl);
    expect(location.searchParams.get("client_id")).toBe("my-client");
    expect(location.searchParams.get("redirect_uri")).toBe(h.redirectUri);
    expect(location.searchParams.get("state")?.length).toBeGreaterThanOrEqual(32);
    expect(location.toString()).not.toContain("my-secret");
    expect(h.saved).toEqual([{ clientId: "my-client", clientSecret: "my-secret", redirectUri: h.redirectUri }]);
    await h.cancel();
  });

  test("WHOOP's callback completes the setup: tokens are exchanged with the new credentials", async () => {
    const h = await start();
    const res = await submit(h, goodForm(h));
    const state = new URL(res.headers.get("location") ?? "").searchParams.get("state");
    const cb = await fetch(`${h.base}/callback?code=the-code&state=${state}`);
    expect(cb.status).toBe(200);
    expect(await cb.text()).toContain("go back to Claude");
    const result = await h.result;
    expect(result).toEqual({
      creds: { clientId: "my-client", clientSecret: "my-secret", redirectUri: h.redirectUri },
      saved: "keychain",
      tokens: TOKENS,
    });
    expect(h.exchanged).toEqual([{ creds: result.creds, code: "the-code" }]);
  });

  test("after submitting, the setup link shows a 'continue to WHOOP' page and further posts are refused", async () => {
    const h = await start();
    const res = await submit(h, goodForm(h));
    const html = await (await fetch(h.setupUrl)).text();
    expect(html).toContain("Almost done");
    expect(html).toContain(Bun.escapeHTML(res.headers.get("location") ?? "missing"));
    expect((await submit(h, goodForm(h))).status).toBe(409);
    expect(h.saved).toHaveLength(1);
    await h.cancel();
  });

  test("a callback before the form was submitted is ignored", async () => {
    const h = await start();
    expect((await fetch(`${h.base}/callback?code=x&state=y`)).status).toBe(409);
    await submit(h, goodForm(h));
    await h.cancel();
  });

  test("a callback with the wrong state is refused and the real one still completes the setup", async () => {
    const h = await start();
    const res = await submit(h, goodForm(h));
    const state = new URL(res.headers.get("location") ?? "").searchParams.get("state");
    expect((await fetch(`${h.base}/callback?code=forged&state=nope`)).status).toBe(400);
    expect((await fetch(`${h.base}/callback?error=access_denied&error_description=injected`)).status).toBe(400);
    expect(h.exchanged).toEqual([]);
    await fetch(`${h.base}/callback?code=real&state=${state}`);
    expect((await h.result).tokens).toEqual(TOKENS);
    expect(h.exchanged.map((e) => e.code)).toEqual(["real"]);
  });

  test("denying access in WHOOP fails the setup with WHOOP's reason", async () => {
    const h = await start();
    const res = await submit(h, goodForm(h));
    const state = new URL(res.headers.get("location") ?? "").searchParams.get("state");
    await fetch(`${h.base}/callback?error=access_denied&error_description=User+said+no&state=${state}`);
    await expect(h.result).rejects.toThrow("access_denied — User said no");
  });

  test("'Use different credentials' goes back to the form and the old authorization stops counting", async () => {
    const h = await start();
    const first = await submit(h, { token: h.token, client_id: "typo-id", client_secret: "s" });
    const oldState = new URL(first.headers.get("location") ?? "").searchParams.get("state");

    const reset = await submit(h, { token: h.token, action: "reset" });
    expect(reset.status).toBe(200);
    expect(await reset.text()).toContain('value="typo-id"');

    const second = await submit(h, { token: h.token, client_id: "right-id", client_secret: "s2" });
    const newState = new URL(second.headers.get("location") ?? "").searchParams.get("state");
    expect(h.saved.map((c) => c.clientId)).toEqual(["typo-id", "right-id"]);

    expect((await fetch(`${h.base}/callback?code=old&state=${oldState}`)).status).toBe(400);
    await fetch(`${h.base}/callback?code=new&state=${newState}`);
    const result = await h.result;
    expect(result.creds.clientId).toBe("right-id");
    expect(h.exchanged.map((e) => e.code)).toEqual(["new"]);
  });

  test("reset needs the token and the same origin like any other post", async () => {
    const h = await start();
    await submit(h, goodForm(h));
    expect((await submit(h, { token: "nope", action: "reset" })).status).toBe(403);
    expect((await submit(h, { token: h.token, action: "reset" }, { Origin: "https://evil.example" })).status).toBe(403);
    await h.cancel();
  });

  test("an unverifiable check (WHOOP unreachable) still lets the user continue", async () => {
    const h = await start({ verifyResult: () => ({ ok: "unknown", reason: "offline" }) });
    expect((await submit(h, goodForm(h))).status).toBe(303);
    await h.cancel();
  });

  test("cancelling stops the flow and the setup link stops working", async () => {
    const h = await start();
    await h.cancel();
    await expect(h.result).rejects.toThrow("cancelled");
    expect(await fetch(h.setupUrl).catch(() => "refused")).toBe("refused");
  });

  test("times out when the user never finishes, and frees the port", async () => {
    const h = await start({ timeoutMs: 150 });
    await expect(h.result).rejects.toThrow(/Timed out/);
    const port = Number(new URL(h.base).port);
    const again = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response() });
    again.stop(true);
  });

  test("bodies over the limit are refused even without a Content-Length (streamed)", async () => {
    const h = await start();
    const big = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(`token=${h.token}&x=${"a".repeat(64 * 1024)}`));
        c.close();
      },
    });
    const res = await fetch(`${h.base}/setup`, {
      method: "POST",
      headers: { Origin: h.origin, "Content-Type": "application/x-www-form-urlencoded" },
      body: big,
    }).catch(() => null);
    // Bun may also just reset the connection mid-upload; either way nothing was read or verified.
    expect(res === null || res.status === 413).toBe(true);
    expect(h.verified).toEqual([]);
    await h.cancel();
  });

  test("a non-localhost redirect URI is refused before anything listens", async () => {
    await expect(browserSetup({ redirectUri: "https://example.com/cb", openBrowser: false })).rejects.toThrow(
      /must be http on localhost/,
    );
  });
});
