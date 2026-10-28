import { describe, expect, test } from "bun:test";
import { BackgroundLogin, type BackgroundLoginDeps } from "../src/auth/background-login.ts";
import type { BrowserSetupOptions } from "../src/auth/browser-setup.ts";
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
};

/** A fake browser login the test drives by hand: announce the URL, then approve or fail. */
function controllableLogin() {
  const calls: LoginOptions[] = [];
  let finish: { resolve: (r: LoginResult) => void; reject: (e: Error) => void } | null = null;
  const login = (_c: ClientCredentials, opts: LoginOptions) => {
    calls.push(opts);
    const d = Promise.withResolvers<LoginResult>();
    finish = d;
    opts.signal?.addEventListener("abort", () => d.reject(new Error("WHOOP login was cancelled.")));
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
    expect(await flow.start()).toEqual({ authorizeUrl: URL_, alreadyPending: false, kind: "login" });
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
    expect(await flow.start()).toEqual({ authorizeUrl: URL_, alreadyPending: true, kind: "login" });
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

  test("without app credentials it starts the browser setup page instead of a login", async () => {
    const SETUP_URL = "http://localhost:8787/setup?t=tok";
    const setupCalls: BrowserSetupOptions[] = [];
    let finishSetup = () => {};
    const { flow, fake, saved } = setup({
      resolveCreds: async () => {
        throw new ConfigError("No WHOOP app credentials found.");
      },
      redirectUri: () => "http://127.0.0.1:9999/cb",
      setup: (opts) =>
        new Promise((resolve) => {
          setupCalls.push(opts);
          queueMicrotask(() => opts.onSetupUrl?.(SETUP_URL));
          finishSetup = () => resolve({ creds, saved: "keychain", tokens: RESULT.tokens });
        }),
    });
    expect(await flow.start()).toEqual({ authorizeUrl: SETUP_URL, alreadyPending: false, kind: "setup" });
    expect(fake.calls).toHaveLength(0);
    expect(setupCalls[0]).toMatchObject({ redirectUri: "http://127.0.0.1:9999/cb", openBrowser: false });
    expect(flow.status).toMatchObject({ state: "pending", kind: "setup", authorizeUrl: SETUP_URL });

    finishSetup();
    await flow.settled();
    expect(saved.map((r) => r.tokens)).toEqual([RESULT.tokens]);
    expect(flow.status).toMatchObject({ state: "succeeded" });
  });

  test("errors other than missing credentials still propagate", async () => {
    const { flow } = setup({
      resolveCreds: async () => {
        throw new Error("keychain locked");
      },
    });
    await expect(flow.start()).rejects.toThrow("keychain locked");
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

  test("concurrent starts share one flow instead of racing for the port", async () => {
    const { flow, fake } = setup();
    const [a, b] = await Promise.all([flow.start(), flow.start()]);
    expect(fake.calls).toHaveLength(1);
    expect(a.authorizeUrl).toBe(URL_);
    expect(b).toEqual({ authorizeUrl: URL_, alreadyPending: true, kind: "login" });
    expect(flow.status).toMatchObject({ state: "pending" });
  });

  test("cancel aborts the pending flow and returns to idle (not 'failed')", async () => {
    const { flow, fake } = setup();
    await flow.start();
    await flow.cancel();
    expect(fake.calls[0]?.signal?.aborted).toBe(true);
    expect(flow.status).toEqual({ state: "idle" });
    expect((await flow.start()).alreadyPending).toBe(false);
  });

  test("reconfigure cancels a pending login and opens the setup page even though credentials exist", async () => {
    const SETUP_URL = "http://localhost:8787/setup?t=again";
    const setupCalls: BrowserSetupOptions[] = [];
    const { flow, fake } = setup({
      setup: (opts) =>
        new Promise(() => {
          setupCalls.push(opts);
          queueMicrotask(() => opts.onSetupUrl?.(SETUP_URL));
        }),
    });
    await flow.start(); // a normal login with the (wrong) saved credentials
    const result = await flow.start({ reconfigure: true });
    expect(fake.calls[0]?.signal?.aborted).toBe(true);
    expect(result).toEqual({ authorizeUrl: SETUP_URL, alreadyPending: false, kind: "setup" });
    expect(setupCalls).toHaveLength(1);
    expect(flow.status).toMatchObject({ state: "pending", kind: "setup" });
  });

  test("a superseded flow finishing late doesn't overwrite the current status", async () => {
    const flows: { reject: (e: Error) => void }[] = [];
    const { flow } = setup({
      // Unlike the shared fake, ignores abort, so the old flow can still settle after being superseded.
      login: (_c, opts) => {
        const d = Promise.withResolvers<LoginResult>();
        flows.push(d);
        queueMicrotask(() => opts.onAuthorizeUrl?.(URL_));
        return d.promise;
      },
    });
    await flow.start();
    await Promise.race([flow.cancel(), Bun.sleep(10)]); // the old flow ignores the abort, so don't wait on it
    await flow.start();
    flows[0]?.reject(new Error("late failure from the old flow"));
    await Bun.sleep(5);
    expect(flows).toHaveLength(2);
    expect(flow.status).toMatchObject({ state: "pending" });
  });
});

describe("review fixes", () => {
  test("a login cancelled while it reads the credentials doesn't start a flow", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const started: string[] = [];
    const flow = new BackgroundLogin({
      openBrowser: false,
      resolveCreds: async () => {
        await gate;
        return creds;
      },
      login: () => {
        started.push("login");
        return new Promise(() => {});
      },
    });
    const first = flow.start().catch((e: Error) => e.message);
    await flow.cancel();
    release();
    expect(await first).toContain("cancelled");
    expect(started).toEqual([]);
  });

  test("the end of a setup flow isn't reported as a page problem", async () => {
    let phase: ((p: "failed", problem: string) => void) | undefined;
    const flow = new BackgroundLogin({
      openBrowser: false,
      resolveCreds: async () => {
        throw new ConfigError("none");
      },
      setup: (opts) =>
        new Promise(() => {
          queueMicrotask(() => opts.onSetupUrl?.("http://localhost:8787/setup?t=x"));
          phase = (p, problem) => opts.onPhase?.(p, problem);
        }),
    });
    await flow.start();
    phase?.("failed", "timed out");
    expect(flow.status).toMatchObject({ state: "pending" });
    expect((flow.status as { problem?: string }).problem).toBeUndefined();
  });
});
