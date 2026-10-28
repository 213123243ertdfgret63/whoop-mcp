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
    // Tests check the grace period on purpose; elsewhere the port must be free as soon as the flow ends.
    graceMs: 0,
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
    expect(await res.text()).toContain("Paste both");
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
    expect(html).toContain("accept this Client ID and Secret");
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
    // It doesn't claim success before the token exchange has run.
    expect(await cb.text()).toContain("Finishing");
    const result = await h.result;
    expect(result).toEqual({
      creds: { clientId: "my-client", clientSecret: "my-secret", redirectUri: h.redirectUri },
      saved: "keychain",
      tokens: TOKENS,
    });
    expect(h.exchanged).toEqual([{ creds: result.creds, code: "the-code" }]);
  });

  test("after submitting, the page shows the approve step, and a double submit gets the same redirect", async () => {
    const h = await start();
    const res = await submit(h, goodForm(h));
    const html = await (await fetch(h.setupUrl)).text();
    expect(html).toContain('"phase":"authorizing"');
    const again = await submit(h, goodForm(h));
    expect(again.status).toBe(303);
    expect(again.headers.get("location")).toBe(res.headers.get("location"));
    expect(h.saved).toHaveLength(1);
    expect(h.verified).toHaveLength(1);
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

  test("an error from WHOOP keeps the flow alive: the page explains it and Try again starts a new approval", async () => {
    const phases: [string, string | undefined][] = [];
    const h = await start({ onPhase: (p, problem) => phases.push([p, problem]) });
    const res = await submit(h, goodForm(h));
    const state = new URL(res.headers.get("location") ?? "").searchParams.get("state");
    const denied = await fetch(
      `${h.base}/callback?error=invalid_request&error_description=redirect_uri+mismatch&state=${state}`,
    );
    expect(await denied.text()).toContain("exactly http://localhost:8787/callback");
    const status = await (await fetch(`${h.base}/setup/status`, { headers: { "X-Setup-Token": h.token } })).json();
    expect(status).toMatchObject({ phase: "authorizing", problem: expect.stringContaining("redirect URL") });
    expect(phases.at(-1)?.[1]).toContain("redirect URL");

    const retry = await fetch(`${h.base}/setup/authorize?t=${h.token}`, { redirect: "manual" });
    expect(retry.status).toBe(303);
    const newState = new URL(retry.headers.get("location") ?? "").searchParams.get("state");
    expect(newState).not.toBe(state);
    await fetch(`${h.base}/callback?code=ok&state=${newState}`);
    expect((await h.result).tokens).toEqual(TOKENS);
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
    await Bun.sleep(20);
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

/** Calls the JSON check-and-save endpoint the page's script uses. */
function verifyJson(h: Harness, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${h.base}/setup/verify`, {
    method: "POST",
    headers: { Origin: h.origin, "Content-Type": "application/json", "X-Setup-Token": h.token, ...headers },
    body: JSON.stringify(body),
  });
}

describe("page script endpoints", () => {
  test("verify checks, saves and returns the WHOOP approval URL", async () => {
    const h = await start();
    const res = await verifyJson(h, { client_id: " my-client ", client_secret: "my-secret" });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; authorize_url: string };
    expect(data.ok).toBe(true);
    expect(new URL(data.authorize_url).searchParams.get("client_id")).toBe("my-client");
    expect(JSON.stringify(data)).not.toContain("my-secret");
    expect(h.saved).toHaveLength(1);
    await h.cancel();
  });

  test("verify reports which field is wrong", async () => {
    const h = await start({ verifyResult: () => ({ ok: false, reason: "WHOOP rejected the client ID or secret." }) });
    const missing = await (await verifyJson(h, { client_id: "x", client_secret: "" })).json();
    expect(missing).toMatchObject({ ok: false, field: "client_secret" });
    const rejected = await (await verifyJson(h, { client_id: "x", client_secret: "y" })).json();
    expect(rejected).toMatchObject({ ok: false, field: "both" });
    await h.cancel();
  });

  test("verify refuses a missing token, another origin and non-JSON bodies", async () => {
    const h = await start();
    const good = { client_id: "a", client_secret: "b" };
    expect((await verifyJson(h, good, { "X-Setup-Token": "nope" })).status).toBe(403);
    expect((await verifyJson(h, good, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await verifyJson(h, good, { "Content-Type": "text/plain" })).status).toBe(415);
    expect(h.verified).toEqual([]);
    await h.cancel();
  });

  test("verify is rate limited", async () => {
    const h = await start({ verifyResult: () => ({ ok: false, reason: "no." }) });
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++)
      statuses.push((await verifyJson(h, { client_id: "a", client_secret: `s${i}` })).status);
    expect(statuses.at(-1)).toBe(429);
    expect(h.verified).toHaveLength(10);
    await h.cancel();
  });

  test("status needs the token and never includes the secret, tokens or OAuth state", async () => {
    const h = await start();
    expect((await fetch(`${h.base}/setup/status`)).status).toBe(403);
    const res = await submit(h, goodForm(h));
    const state = new URL(res.headers.get("location") ?? "").searchParams.get("state") ?? "";
    const text = await (await fetch(`${h.base}/setup/status`, { headers: { "X-Setup-Token": h.token } })).text();
    expect(JSON.parse(text)).toEqual({ phase: "authorizing", client_id_saved: true });
    for (const secret of ["my-secret", state, h.token]) expect(text).not.toContain(secret);
    await h.cancel();
  });

  test("every page has its own CSP nonce, matching its script and style", async () => {
    const h = await start();
    const nonces: string[] = [];
    for (let i = 0; i < 2; i++) {
      const res = await fetch(h.setupUrl);
      const csp = res.headers.get("content-security-policy") ?? "";
      const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1] ?? "";
      const html = await res.text();
      expect(html).toContain(`<script nonce="${nonce}">`);
      expect(html).toContain(`<style nonce="${nonce}">`);
      expect(csp).not.toContain("unsafe-inline");
      nonces.push(nonce);
    }
    expect(nonces[0]).not.toBe(nonces[1]);
    await h.cancel();
  });

  test("after a failed check the secret is kept server-side, so an empty secret box reuses it", async () => {
    const h = await start({
      verifyResult: (c) => (c.clientId === "right-id" ? { ok: true } : { ok: false, reason: "no." }),
    });
    const bad = await submit(h, { token: h.token, client_id: "typo-id", client_secret: "long-secret-a1f3" });
    const html = await bad.text();
    expect(html).toContain("ends …a1f3");
    expect(html).not.toContain("long-secret-a1f3");
    const good = await submit(h, { token: h.token, client_id: "right-id", client_secret: "" });
    expect(good.status).toBe(303);
    expect(h.saved.at(-1)?.clientSecret).toBe("long-secret-a1f3");
    await h.cancel();
  });

  test("the Client ID is pre-filled when given", async () => {
    const h = await start({ clientId: "from-last-time" });
    expect(await (await fetch(h.setupUrl)).text()).toContain('value="from-last-time"');
    await h.cancel();
  });
});

describe("timeouts and the end of the flow", () => {
  test("the idle timeout restarts whenever the page is used", async () => {
    const h = await start({ idleTimeoutMs: 150, timeoutMs: 5000 });
    for (let i = 0; i < 4; i++) {
      await Bun.sleep(80);
      expect((await fetch(h.setupUrl)).status).toBe(200);
    }
    await expect(h.result).rejects.toThrow(/wasn't used/);
  });

  test("after success the page keeps answering status during the grace period, and cancel ends it", async () => {
    const h = await start({ graceMs: 5000 });
    const res = await submit(h, goodForm(h));
    const state = new URL(res.headers.get("location") ?? "").searchParams.get("state");
    await fetch(`${h.base}/callback?code=c&state=${state}`);
    await h.result;
    const status = (await (
      await fetch(`${h.base}/setup/status`, { headers: { "X-Setup-Token": h.token } })
    ).json()) as {
      phase: string;
    };
    expect(status.phase).toBe("done");
    expect(await (await fetch(`${h.base}/setup/done?t=${h.token}`)).text()).toContain("WHOOP connected");
    await h.cancel();
    await Bun.sleep(20);
    expect(await fetch(`${h.base}/setup/status`).catch(() => "refused")).toBe("refused");
  });

  test("a failed token exchange is reported as failed, not connected", async () => {
    const h = await start({
      graceMs: 5000,
      exchange: async () => {
        throw new Error("token endpoint down");
      },
    });
    const res = await submit(h, goodForm(h));
    const state = new URL(res.headers.get("location") ?? "").searchParams.get("state");
    await fetch(`${h.base}/callback?code=c&state=${state}`);
    await expect(h.result).rejects.toThrow("token endpoint down");
    const status = (await (
      await fetch(`${h.base}/setup/status`, { headers: { "X-Setup-Token": h.token } })
    ).json()) as {
      phase: string;
    };
    expect(status.phase).toBe("failed");
    await h.cancel();
  });
});

describe("review fixes", () => {
  test("Try again reuses the pending approval unless WHOOP refused it", async () => {
    const h = await start();
    const res = await submit(h, goodForm(h));
    const state = new URL(res.headers.get("location") ?? "").searchParams.get("state");
    const again = await fetch(`${h.base}/setup/authorize?t=${h.token}`, { redirect: "manual" });
    expect(new URL(again.headers.get("location") ?? "").searchParams.get("state")).toBe(state);
    await fetch(`${h.base}/callback?code=c&state=${state}`);
    expect((await h.result).tokens).toEqual(TOKENS);
  });

  test("the plain form shares the check limit with the page's script", async () => {
    const h = await start({ verifyResult: () => ({ ok: false, reason: "no." }) });
    let last = 0;
    for (let i = 0; i < 11; i++)
      last = (await submit(h, { token: h.token, client_id: "a", client_secret: `s${i}` })).status;
    expect(h.verified).toHaveLength(10);
    expect(last).toBe(429);
    await h.cancel();
  });

  test("new credentials cancel the pending approval, so its late callback is refused", async () => {
    const h = await start();
    const first = await submit(h, { token: h.token, client_id: "one", client_secret: "s1" });
    const oldState = new URL(first.headers.get("location") ?? "").searchParams.get("state");
    await submit(h, { token: h.token, client_id: "two", client_secret: "s2" });
    expect((await fetch(`${h.base}/callback?code=old&state=${oldState}`)).status).toBe(400);
    expect(h.exchanged).toEqual([]);
    await h.cancel();
  });

  test("tokens are saved before the page says connected; a failed save is shown as failed", async () => {
    const h = await start({
      graceMs: 5000,
      persist: async () => {
        throw new Error("disk full");
      },
    });
    const res = await submit(h, goodForm(h));
    const state = new URL(res.headers.get("location") ?? "").searchParams.get("state");
    await fetch(`${h.base}/callback?code=c&state=${state}`);
    await expect(h.result).rejects.toThrow("disk full");
    const status = (await (
      await fetch(`${h.base}/setup/status`, { headers: { "X-Setup-Token": h.token } })
    ).json()) as {
      phase: string;
    };
    expect(status.phase).toBe("failed");
    await h.cancel();
  });

  test("the side window is opened without a link back to this page", async () => {
    const h = await start();
    const html = await (await fetch(h.setupUrl)).text();
    expect(html).toContain('rel="noopener"');
    expect(html).toContain('"noopener,popup');
    await h.cancel();
  });
});
