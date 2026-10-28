import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { configDir, DEFAULT_REDIRECT_URI, loadClientCredentials } from "../src/config.ts";

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
    expect(creds?.redirectUri).toBe("http://127.0.0.1:9999/cb");
  });

  test("falls back to the default redirect URI when the override is blank", () => {
    const creds = loadClientCredentials({
      WHOOP_CLIENT_ID: "id",
      WHOOP_CLIENT_SECRET: "secret",
      WHOOP_REDIRECT_URI: " ",
    });
    expect(creds?.redirectUri).toBe(DEFAULT_REDIRECT_URI);
  });

  test("returns null when either value is missing or blank", () => {
    expect(loadClientCredentials({})).toBeNull();
    expect(loadClientCredentials({ WHOOP_CLIENT_ID: "id" })).toBeNull();
    expect(loadClientCredentials({ WHOOP_CLIENT_ID: "   ", WHOOP_CLIENT_SECRET: "secret" })).toBeNull();
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
