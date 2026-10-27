import { describe, expect, test } from "bun:test";
import { BackgroundLogin, type BackgroundLoginDeps } from "../src/auth/background-login.ts";
import type { LoginOptions, LoginResult } from "../src/auth/login.ts";
import { type ClientCredentials, ConfigError } from "../src/config.ts";

const creds: ClientCredentials = {
  clientId: "id",
  clientSecret: "secret",
  redirectUri: "http://localhost:8787/callback",
};
const URL_ = "https://api.prod.whoop.com/oauth/oauth2/auth?state=abc";
const RESULT: LoginResult = {
  tokens: {
    access_token: "at",
    refresh_token: "rt",
    expires_in: 3600,
    token_type: "bearer",
    scope: "offline read:sleep",
  },
  callbackParams: {},
};

/** A fake browser login the test drives by hand: announce the URL, then approve or fail. */
function controllableLogin() {
  const calls: LoginOptions[] = [];
  let finish: { resolve: (r: LoginResult) => void; reject: (e: Error) => void } | null = null;
  const login = (_c: ClientCredentials, opts: LoginOptions) => {
    calls.push(opts);
    const d = Promise.withResolvers<LoginResult>();
    finish = d;
    queueMicrotask(() => opts.onAuthorizeUrl?.(URL_));
    return d.promise;
  };
  return {
    login,
    calls,
    approve: () => finish?.resolve(RESULT),
    fail: (msg: string) => finish?.reject(new Error(msg)),
  };
}

function setup(overrides: Partial<BackgroundLoginDeps> = {}) {
  const fake = controllableLogin();
  const saved: LoginResult[] = [];
  const flow = new BackgroundLogin({
    resolveCreds: async () => creds,
    login: fake.login,
    save: async (r) => {
      saved.push(r);
    },
    openBrowser: false,
    timeoutMs: 1234,
    ...overrides,
  });
  return { flow, fake, saved };
}

describe("BackgroundLogin", () => {
  test("starts idle", () => {
    expect(setup().flow.status).toEqual({ state: "idle" });
  });

  test("returns the authorize URL as soon as it exists, before the user approves", async () => {
    const { flow, saved } = setup();
    expect(await flow.start()).toEqual({ authorizeUrl: URL_, alreadyPending: false });
    expect(flow.status).toMatchObject({ state: "pending", authorizeUrl: URL_ });
    expect(saved).toEqual([]);
  });

  test("passes the browser and timeout settings through to the login", async () => {
    const { flow, fake } = setup();
    await flow.start();
    expect(fake.calls[0]).toMatchObject({ openBrowser: false, timeoutMs: 1234 });
  });

  test("saves the tokens and reports success once the user approves", async () => {
    const { flow, fake, saved } = setup();
    await flow.start();
    fake.approve();
    await flow.settled();
    expect(saved).toEqual([RESULT]);
    expect(flow.status).toMatchObject({ state: "succeeded", scope: "offline read:sleep" });
  });

  test("a second start while waiting reuses the pending login instead of opening another", async () => {
    const { flow, fake } = setup();
    await flow.start();
    expect(await flow.start()).toEqual({ authorizeUrl: URL_, alreadyPending: true });
    expect(fake.calls).toHaveLength(1);
  });

  test("a failure after the URL was shown (e.g. timeout or denial) is reported through status", async () => {
    const { flow, fake, saved } = setup();
    await flow.start();
    fake.fail("Timed out waiting for the WHOOP login callback.");
    await flow.settled();
    expect(flow.status).toMatchObject({ state: "failed", error: "Timed out waiting for the WHOOP login callback." });
    expect(saved).toEqual([]);
  });

  test("a failure before any URL exists (e.g. the port is taken) makes start() throw", async () => {
    const { flow } = setup({
      login: async () => {
        throw new Error("Could not start the callback server on port 8787.");
      },
    });
    await expect(flow.start()).rejects.toThrow("port 8787");
    expect(flow.status).toMatchObject({ state: "failed" });
  });

  test("missing app credentials throw without starting a login", async () => {
    const { flow, fake } = setup({
      resolveCreds: async () => {
        throw new ConfigError("No WHOOP app credentials found. Run `whoop-mcp setup` in a terminal.");
      },
    });
    await expect(flow.start()).rejects.toBeInstanceOf(ConfigError);
    expect(fake.calls).toHaveLength(0);
    expect(flow.status).toEqual({ state: "idle" });
  });

  test("a new login can start after the previous one finished", async () => {
    const { flow, fake } = setup();
    await flow.start();
    fake.fail("denied");
    await flow.settled();
    expect((await flow.start()).alreadyPending).toBe(false);
    expect(fake.calls).toHaveLength(2);
  });

  test("a failed save is reported as a failed login", async () => {
    const { flow, fake } = setup({
      save: async () => {
        throw new Error("disk full");
      },
    });
    await flow.start();
    fake.approve();
    await flow.settled();
    expect(flow.status).toMatchObject({ state: "failed", error: "disk full" });
  });
});
