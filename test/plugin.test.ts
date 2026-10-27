// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these are literal Claude Code plugin placeholders, not JS templates
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { $ } from "bun";

const ROOT = join(import.meta.dir, "..");
const PLUGIN = join(ROOT, "plugin");
const BUNDLE = join(PLUGIN, "server", "whoop-mcp.js");

const readJson = async <T>(path: string) => (await Bun.file(path).json()) as T;

interface PluginManifest {
  name: string;
  version: string;
  userConfig: Record<string, { sensitive?: boolean; required?: boolean; default?: string }>;
  mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
}

describe("Claude Code plugin", () => {
  test("the marketplace lists the plugin under its manifest name, sourced from ./plugin", async () => {
    const market = await readJson<{ plugins: { name: string; source: string }[] }>(
      join(ROOT, ".claude-plugin", "marketplace.json"),
    );
    const manifest = await readJson<PluginManifest>(join(PLUGIN, ".claude-plugin", "plugin.json"));
    expect(market.plugins).toHaveLength(1);
    expect(market.plugins[0]).toMatchObject({ name: manifest.name, source: "./plugin" });
  });

  test("plugin.json version matches package.json (plugin users only get updates when it changes)", async () => {
    const pkg = await readJson<{ version: string }>(join(ROOT, "package.json"));
    const manifest = await readJson<PluginManifest>(join(PLUGIN, ".claude-plugin", "plugin.json"));
    expect(manifest.version).toBe(pkg.version);
  });

  test("the committed bundle is built from the current version", async () => {
    const pkg = await readJson<{ version: string }>(join(ROOT, "package.json"));
    expect((await $`${process.execPath} ${BUNDLE} --version`.text()).trim()).toBe(pkg.version);
  });

  test("the plugin folder has no package.json, so Claude Code doesn't try to install dependencies", async () => {
    expect(await Bun.file(join(PLUGIN, "package.json")).exists()).toBe(false);
  });

  test("the MCP server runs the bundle with the user's config and keeps state in the plugin data dir", async () => {
    const manifest = await readJson<PluginManifest>(join(PLUGIN, ".claude-plugin", "plugin.json"));
    const server = manifest.mcpServers.whoop;
    expect(server?.command).toBe("bun");
    expect(server?.args).toEqual(["${CLAUDE_PLUGIN_ROOT}/server/whoop-mcp.js"]);
    expect(server?.env).toMatchObject({
      WHOOP_CLIENT_ID: "${user_config.client_id}",
      WHOOP_CLIENT_SECRET: "${user_config.client_secret}",
      WHOOP_REDIRECT_URI: "${user_config.redirect_uri}",
      WHOOP_MCP_HOME: "${CLAUDE_PLUGIN_DATA}",
    });
    // Every ${user_config.X} the server uses must be declared.
    for (const value of Object.values(server?.env ?? {})) {
      const key = value.match(/^\$\{user_config\.(\w+)\}$/)?.[1];
      if (key) expect(manifest.userConfig[key]).toBeDefined();
    }
  });

  test("the client secret is marked sensitive (kept in the OS keychain by Claude Code)", async () => {
    const manifest = await readJson<PluginManifest>(join(PLUGIN, ".claude-plugin", "plugin.json"));
    expect(manifest.userConfig.client_secret?.sensitive).toBe(true);
    expect(manifest.userConfig.client_id?.sensitive).not.toBe(true);
    expect(manifest.userConfig.redirect_uri?.default).toBe("http://localhost:8787/callback");
  });

  test("the setup skill names the tools the server actually exposes", async () => {
    const skill = await Bun.file(join(PLUGIN, "skills", "setup", "SKILL.md")).text();
    for (const tool of ["whoop_status", "whoop_login"]) expect(skill).toContain(tool);
    expect(skill).toContain("/plugin configure whoop@whoop-mcp");
  });
});
