import { describe, expect, test } from "bun:test";
import { DIRNAME, manifest, NODE_RUNTIME, summary } from "../scripts/build-mcpb.ts";
import { VERSION } from "../src/config.ts";
import { PROMPTS } from "../src/server.ts";

const tools = [{ name: "whoop_today", description: "Start here." }];

describe("extension manifest", () => {
  test("a Node server Desktop runs on its built-in Node.js: command node with the script as the argument", () => {
    const m = manifest(tools);
    expect(m.server).toEqual({
      type: "node",
      entry_point: "server/index.mjs",
      mcp_config: {
        command: "node",
        args: [`${DIRNAME}/server/index.mjs`],
        env: { WHOOP_MCP_INSTALL_SKILLS: ["$", "{user_config.claude_code_commands}"].join("") },
      },
    });
    expect(m.compatibility).toEqual({ platforms: ["darwin"], runtimes: { node: NODE_RUNTIME } });
    // Desktop's built-in Node (24.22 in Desktop 4.4212) must satisfy it, or Desktop needs a Node of the user's own.
    expect(Bun.semver.satisfies("24.22.0", NODE_RUNTIME)).toBe(true);
    expect(Bun.semver.satisfies("20.19.0", NODE_RUNTIME)).toBe(false);
  });

  test("the placeholder is the one Desktop substitutes", () => {
    expect(DIRNAME).toBe(["$", "{__dirname}"].join(""));
  });

  test("carries the version, tools, privacy policy and only the Claude Code commands setting", () => {
    const m = manifest(tools) as Record<string, unknown>;
    expect(m.version).toBe(VERSION);
    expect(m.tools).toEqual(tools);
    expect(m.privacy_policies).toHaveLength(1);
    // Settings from Desktop don't reliably reach the server (mcpb#297), so the setup page collects credentials.
    // The one setting is optional and on by default, and the server treats an unexpanded value as on.
    expect(Object.keys(m.user_config as object)).toEqual(["claude_code_commands"]);
    expect(
      (m.user_config as Record<string, { default: unknown; required: boolean }>).claude_code_commands,
    ).toMatchObject({
      type: "boolean",
      default: true,
      required: false,
    });
    expect(String(m.description)).toContain("unofficial");
    // The ID Desktop derives from `name` must not change, or upgrades install next to the old extension.
    expect(m.name).toBe("whoop-mcp");
    expect(m.display_name).toBe("WHOOP (unofficial)");
  });

  test("lists the connect, disconnect and status prompts with the text the server returns", () => {
    const m = manifest(tools);
    expect(m.prompts.map((p) => p.name)).toEqual(["whoop-connect", "whoop-disconnect", "whoop-status"]);
    expect(m.prompts[0]).not.toHaveProperty("tool");
    expect(m.prompts.map((p) => p.text)).toEqual(PROMPTS.map((p) => p.text));
    expect(m.prompts_generated).toBe(false);
  });
});

describe("tool summaries for the install dialog", () => {
  test("first sentence, not cut at e.g. or vs.", () => {
    expect(summary("Compare A vs. B, e.g. this week. More detail here.")).toBe("Compare A vs. B, e.g. this week.");
    expect(summary("No full stop")).toBe("No full stop.");
  });

  test("long sentences end at a word boundary with an ellipsis", () => {
    const s = summary(`${"word ".repeat(60)}end.`, 40);
    expect(s.length).toBeLessThanOrEqual(41);
    expect(s.endsWith("word…")).toBe(true);
  });
});
