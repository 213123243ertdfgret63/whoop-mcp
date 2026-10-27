import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addToClaude,
  desktopConfigPath,
  type Env,
  findClaudeCli,
  removeFromClaude,
  type ServerCommand,
} from "../src/cli/claude-config.ts";

const CMD: ServerCommand = { command: "/opt/whoop/bin/whoop-mcp", args: [] };

let home: string;
let runs: string[][];
let runResult: (cmd: string[]) => { exitCode: number; output: string };

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "whoop-claude-config-"));
  runs = [];
  runResult = () => ({ exitCode: 0, output: "" });
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function env(overrides: Partial<Env> = {}): Env {
  return {
    home,
    platform: "darwin",
    which: () => null,
    run: (cmd) => {
      runs.push(cmd);
      return runResult(cmd);
    },
    ...overrides,
  };
}

const desktopDir = () => join(home, "Library", "Application Support", "Claude");
const desktopJson = () => join(desktopDir(), "claude_desktop_config.json");
const readJson = async (p: string) => (await Bun.file(p).json()) as Record<string, unknown>;

describe("Claude Desktop", () => {
  test("is skipped when the app isn't installed, and nothing is created", async () => {
    const [, desktop] = await addToClaude(CMD, env());
    expect(desktop).toMatchObject({ outcome: "skipped" });
    expect(await Bun.file(desktopJson()).exists()).toBe(false);
  });

  test("adds the server while keeping the user's other settings and servers", async () => {
    await mkdir(desktopDir(), { recursive: true });
    await writeFile(
      desktopJson(),
      JSON.stringify({ preferences: { theme: "dark" }, mcpServers: { other: { command: "x", args: ["y"] } } }),
    );
    const [, desktop] = await addToClaude(CMD, env());
    expect(desktop?.outcome).toBe("added");
    expect(await readJson(desktopJson())).toEqual({
      preferences: { theme: "dark" },
      mcpServers: { other: { command: "x", args: ["y"] }, whoop: { command: CMD.command, args: [] } },
    });
  });

  test("creates the config file when the app is installed but has none yet", async () => {
    await mkdir(desktopDir(), { recursive: true });
    await addToClaude(CMD, env());
    expect((await readJson(desktopJson())).mcpServers).toEqual({ whoop: { command: CMD.command, args: [] } });
  });

  test("re-running points an existing entry at the new command", async () => {
    await mkdir(desktopDir(), { recursive: true });
    await addToClaude({ command: "/old/path", args: [] }, env());
    const [, desktop] = await addToClaude(CMD, env());
    expect(desktop?.outcome).toBe("updated");
    expect((await readJson(desktopJson())).mcpServers).toEqual({ whoop: { command: CMD.command, args: [] } });
  });

  test("refuses to touch a config file that isn't valid JSON", async () => {
    await mkdir(desktopDir(), { recursive: true });
    await writeFile(desktopJson(), "{ not json");
    const [, desktop] = await addToClaude(CMD, env());
    expect(desktop?.outcome).toBe("failed");
    expect(desktop?.detail).toContain("isn't valid JSON");
    expect(await Bun.file(desktopJson()).text()).toBe("{ not json");
  });

  test("remove deletes only the whoop entry and reports absent when there is none", async () => {
    await mkdir(desktopDir(), { recursive: true });
    await writeFile(
      desktopJson(),
      JSON.stringify({ mcpServers: { other: { command: "x" }, whoop: { command: "w" } } }),
    );
    const [, removed] = await removeFromClaude(env());
    expect(removed?.outcome).toBe("removed");
    expect((await readJson(desktopJson())).mcpServers).toEqual({ other: { command: "x" } });
    const [, again] = await removeFromClaude(env());
    expect(again?.outcome).toBe("absent");
  });

  test("uses the platform's config location", () => {
    expect(desktopConfigPath(env({ platform: "linux" }))).toBe(
      join(home, ".config", "Claude", "claude_desktop_config.json"),
    );
    expect(desktopConfigPath(env({ platform: "win32", appData: "C:\\AppData" }))).toBe(
      join("C:\\AppData", "Claude", "claude_desktop_config.json"),
    );
  });
});

describe("Claude Code", () => {
  test("uses `claude mcp add --scope user`, replacing any previous registration first", async () => {
    const [code] = await addToClaude(CMD, env({ which: () => "/usr/local/bin/claude" }));
    expect(code).toMatchObject({ outcome: "added" });
    expect(runs).toEqual([
      ["/usr/local/bin/claude", "mcp", "remove", "whoop", "--scope", "user"],
      ["/usr/local/bin/claude", "mcp", "add", "--scope", "user", "whoop", "--", CMD.command],
    ]);
  });

  test("passes the command's arguments after `--` (running from a source checkout)", async () => {
    await addToClaude({ command: "/bin/bun", args: ["/src/index.ts"] }, env({ which: () => "claude" }));
    expect(runs[1]).toEqual(["claude", "mcp", "add", "--scope", "user", "whoop", "--", "/bin/bun", "/src/index.ts"]);
  });

  test("reports a failed `claude mcp add` with its output", async () => {
    runResult = (cmd) => (cmd[2] === "add" ? { exitCode: 1, output: "boom" } : { exitCode: 0, output: "" });
    const [code] = await addToClaude(CMD, env({ which: () => "claude" }));
    expect(code).toMatchObject({ outcome: "failed", detail: "boom" });
  });

  test("falls back to the CLI bundled in the Claude desktop app, newest version first", async () => {
    const root = join(home, "Library", "Application Support", "Claude", "claude-code");
    for (const version of ["2.1.9", "2.1.308", "2.1.40"]) {
      const bin = join(root, version, "abc", "claude.app", "Contents", "MacOS", "claude");
      await mkdir(join(bin, ".."), { recursive: true });
      await writeFile(bin, "#!/bin/sh\n");
      await chmod(bin, 0o755);
    }
    expect(findClaudeCli(env())).toBe(join(root, "2.1.308", "abc", "claude.app", "Contents", "MacOS", "claude"));
  });

  test("without any CLI, edits ~/.claude.json directly, keeping everything else", async () => {
    await writeFile(join(home, ".claude.json"), JSON.stringify({ userID: "u", projects: { "/p": {} } }));
    const [code] = await addToClaude(CMD, env());
    expect(code?.outcome).toBe("added");
    expect(code?.detail).toContain("directly");
    expect(await readJson(join(home, ".claude.json"))).toEqual({
      userID: "u",
      projects: { "/p": {} },
      mcpServers: { whoop: { type: "stdio", command: CMD.command, args: [], env: {} } },
    });
  });

  test("is skipped when Claude Code isn't installed at all", async () => {
    const [code] = await addToClaude(CMD, env());
    expect(code?.outcome).toBe("skipped");
    expect(await Bun.file(join(home, ".claude.json")).exists()).toBe(false);
  });

  test("remove uses the CLI, and treats 'not found' as already absent", async () => {
    const [removed] = await removeFromClaude(env({ which: () => "claude" }));
    expect(removed?.outcome).toBe("removed");
    expect(runs).toEqual([["claude", "mcp", "remove", "whoop", "--scope", "user"]]);

    runResult = () => ({ exitCode: 1, output: 'No user-scoped MCP server found with name: "whoop"' });
    const [absent] = await removeFromClaude(env({ which: () => "claude" }));
    expect(absent?.outcome).toBe("absent");
  });

  test("remove without a CLI deletes the entry from ~/.claude.json", async () => {
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({ userID: "u", mcpServers: { whoop: { command: "w" }, other: { command: "o" } } }),
    );
    const [removed] = await removeFromClaude(env());
    expect(removed?.outcome).toBe("removed");
    expect(await readJson(join(home, ".claude.json"))).toEqual({
      userID: "u",
      mcpServers: { other: { command: "o" } },
    });
  });
});
