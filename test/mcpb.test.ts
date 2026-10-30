import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIRNAME, LAUNCH_SH, manifest, summary } from "../scripts/build-mcpb.ts";
import { VERSION } from "../src/config.ts";
import { PROMPTS } from "../src/server.ts";

const tools = [{ name: "whoop_today", description: "Start here." }];

describe("extension manifest", () => {
  test("macOS starts through the launcher with /bin/sh, so a dropped execute bit can't stop it", () => {
    const m = manifest(tools);
    expect(m.server).toEqual({
      type: "binary",
      entry_point: "server/launch.sh",
      mcp_config: {
        command: "/bin/sh",
        args: [`${DIRNAME}/server/launch.sh`],
        env: { WHOOP_MCP_INSTALL_SKILLS: ["$", "{user_config.claude_code_commands}"].join("") },
      },
    });
    expect(m.compatibility.platforms).toEqual(["darwin"]);
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

describe("launch.sh", () => {
  test("picks the binary for the CPU and restores its execute bit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "whoop-launch-"));
    try {
      const arch = process.arch === "arm64" ? "arm64" : "x64";
      const bin = join(dir, `whoop-mcp-darwin-${arch}`);
      // A stand-in binary saved without the execute bit, as some Desktop builds unpack it.
      await writeFile(bin, '#!/bin/sh\necho "ran $1"\n', { mode: 0o600 });
      await writeFile(join(dir, "launch.sh"), LAUNCH_SH, { mode: 0o600 });
      if (process.platform !== "darwin") return; // uname -m names differ off macOS
      const out = await Bun.$`/bin/sh ${join(dir, "launch.sh")} --version`.text();
      expect(out.trim()).toBe("ran --version");
      expect((await Bun.file(bin).stat()).mode & 0o100).toBe(0o100);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
