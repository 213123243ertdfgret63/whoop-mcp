import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { ConfigError, configDir, DEFAULT_REDIRECT_URI, loadClientCredentials } from "../src/config.ts";

describe("loadClientCredentials", () => {
  test("returns trimmed credentials with the default redirect URI", () => {
    const creds = loadClientCredentials({ WHOOP_CLIENT_ID: "  id  ", WHOOP_CLIENT_SECRET: "\tsecret\n" });
    expect(creds).toEqual({ clientId: "id", clientSecret: "secret", redirectUri: DEFAULT_REDIRECT_URI });
    expect(DEFAULT_REDIRECT_URI).toBe("http://localhost:8787/callback");
  });

  test("uses a trimmed WHOOP_REDIRECT_URI override", () => {
    const creds = loadClientCredentials({
      WHOOP_CLIENT_ID: "id",
      WHOOP_CLIENT_SECRET: "secret",
      WHOOP_REDIRECT_URI: " http://127.0.0.1:9999/cb ",
    });
    expect(creds.redirectUri).toBe("http://127.0.0.1:9999/cb");
  });

  test("falls back to the default redirect URI when the override is blank", () => {
    const creds = loadClientCredentials({
      WHOOP_CLIENT_ID: "id",
      WHOOP_CLIENT_SECRET: "secret",
      WHOOP_REDIRECT_URI: " ",
    });
    expect(creds.redirectUri).toBe(DEFAULT_REDIRECT_URI);
  });

  const missing: [label: string, env: Record<string, string>][] = [
    ["both are missing", {}],
    ["the client id is missing", { WHOOP_CLIENT_SECRET: "secret" }],
    ["the client secret is missing", { WHOOP_CLIENT_ID: "id" }],
    ["the client id is blank", { WHOOP_CLIENT_ID: "   ", WHOOP_CLIENT_SECRET: "secret" }],
    ["the client secret is blank", { WHOOP_CLIENT_ID: "id", WHOOP_CLIENT_SECRET: "" }],
  ];
  for (const [label, env] of missing) {
    test(`throws an actionable ConfigError when ${label}`, () => {
      let caught: unknown;
      try {
        loadClientCredentials(env);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ConfigError);
      const err = caught as ConfigError;
      expect(err.name).toBe("ConfigError");
      expect(err.message).toContain("WHOOP_CLIENT_ID");
      expect(err.message).toContain("WHOOP_CLIENT_SECRET");
      expect(err.message).toContain("https://developer-dashboard.whoop.com");
    });
  }

  test("the error message never echoes a provided secret", () => {
    let message = "";
    try {
      loadClientCredentials({ WHOOP_CLIENT_SECRET: "super-secret-value" });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toBe("");
    expect(message).not.toContain("super-secret-value");
  });
});

describe("configDir", () => {
  test("WHOOP_MCP_HOME wins over XDG_CONFIG_HOME", () => {
    expect(configDir({ WHOOP_MCP_HOME: "/custom/home", XDG_CONFIG_HOME: "/xdg" })).toBe("/custom/home");
  });

  test("uses XDG_CONFIG_HOME/whoop-mcp when WHOOP_MCP_HOME is unset", () => {
    expect(configDir({ XDG_CONFIG_HOME: "/xdg" })).toBe(join("/xdg", "whoop-mcp"));
  });

  test("falls back to ~/.config/whoop-mcp when neither is set", () => {
    expect(configDir({})).toBe(join(homedir(), ".config", "whoop-mcp"));
  });

  test("treats an empty WHOOP_MCP_HOME as unset", () => {
    expect(configDir({ WHOOP_MCP_HOME: "", XDG_CONFIG_HOME: "/xdg" })).toBe(join("/xdg", "whoop-mcp"));
  });

  // XDG Base Directory spec: an empty XDG_CONFIG_HOME must be treated as unset. Currently it yields
  // the relative path "whoop-mcp", so tokens would be written relative to the process cwd.
  test("treats an empty XDG_CONFIG_HOME as unset (XDG spec)", () => {
    expect(configDir({ XDG_CONFIG_HOME: "" })).toBe(join(homedir(), ".config", "whoop-mcp"));
  });
});
