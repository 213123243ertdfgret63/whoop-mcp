import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Registers (or unregisters) this server with the Claude apps on this machine:
 * - Claude Code (CLI, IDEs and the desktop app's Code tab) through `claude mcp add/remove --scope user`, using
 *   `claude` from PATH or the copy bundled inside the Claude desktop app. Only when neither exists is
 *   `~/.claude.json` edited directly, because Claude Code rewrites that file while it runs.
 * - Claude Desktop (chat) by merging into its `claude_desktop_config.json`.
 * Each target is skipped when the app isn't installed. Used by install.sh / uninstall.sh.
 */
export const SERVER_NAME = "whoop";

export interface ServerCommand {
  command: string;
  args: string[];
}

export type Outcome = "added" | "updated" | "removed" | "absent" | "skipped" | "failed";

export interface TargetResult {
  target: "claude-code" | "claude-desktop";
  outcome: Outcome;
  detail: string;
}

export interface Env {
  home: string;
  platform: NodeJS.Platform;
  appData?: string;
  /** Finds an executable on PATH (Bun.which). */
  which: (cmd: string) => string | null;
  run: (cmd: string[]) => { exitCode: number; output: string };
}

export function defaultEnv(): Env {
  return {
    home: homedir(),
    platform: process.platform,
    appData: process.env.APPDATA,
    which: (cmd) => Bun.which(cmd),
    run: (cmd) => {
      const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
      return { exitCode: p.exitCode, output: `${p.stdout.toString()}${p.stderr.toString()}`.trim() };
    },
  };
}

/** How Claude should start this server: the compiled binary itself, or `bun <src/index.ts>` from a checkout. */
export function currentServerCommand(): ServerCommand {
  const compiled = import.meta.path.startsWith("/$bunfs/") || import.meta.path.includes("~BUN");
  if (compiled) return { command: process.execPath, args: [] };
  return { command: process.execPath, args: [resolve(import.meta.dir, "..", "index.ts")] };
}

export function desktopConfigPath(env: Env): string {
  if (env.platform === "darwin")
    return join(env.home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (env.platform === "win32")
    return join(env.appData ?? join(env.home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  return join(env.home, ".config", "Claude", "claude_desktop_config.json");
}

/** `claude` on PATH, else the newest CLI bundled with the Claude desktop app (macOS). */
export function findClaudeCli(env: Env): string | null {
  const onPath = env.which("claude");
  if (onPath) return onPath;
  if (env.platform !== "darwin") return null;
  const root = join(env.home, "Library", "Application Support", "Claude", "claude-code");
  if (!existsSync(root)) return null;
  const candidates = readdirSync(root)
    .flatMap((version) => {
      const vdir = join(root, version);
      if (!statSync(vdir).isDirectory()) return [];
      return readdirSync(vdir).map((build) => ({
        version,
        bin: join(vdir, build, "claude.app", "Contents", "MacOS", "claude"),
      }));
    })
    .filter((c) => existsSync(c.bin))
    .sort((a, b) => compareVersions(b.version, a.version));
  return candidates[0]?.bin ?? null;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

type Json = Record<string, unknown>;

async function readJson(path: string): Promise<Json | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  const text = (await file.text()).trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Json;
  } catch {
    // fall through
  }
  throw new Error(`${path} isn't valid JSON; fix or move it, then run this again (it was left untouched).`);
}

/** Atomic write that keeps the file's existing permissions-by-default semantics (new files: owner-only). */
async function writeJson(path: string, data: Json): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.whoop-mcp.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

function sameEntry(existing: unknown, cmd: ServerCommand): boolean {
  const e = existing as { command?: string; args?: string[] } | undefined;
  return e?.command === cmd.command && JSON.stringify(e?.args ?? []) === JSON.stringify(cmd.args);
}

// --- Claude Desktop ---------------------------------------------------------

export async function addToDesktop(cmd: ServerCommand, env: Env): Promise<TargetResult> {
  const path = desktopConfigPath(env);
  if (!existsSync(dirname(path)))
    return { target: "claude-desktop", outcome: "skipped", detail: "Claude Desktop isn't installed" };
  try {
    const config = (await readJson(path)) ?? {};
    const servers = (config.mcpServers ?? {}) as Json;
    if (sameEntry(servers[SERVER_NAME], cmd)) {
      return { target: "claude-desktop", outcome: "updated", detail: `already set up in ${path}` };
    }
    const existed = SERVER_NAME in servers;
    config.mcpServers = { ...servers, [SERVER_NAME]: { command: cmd.command, args: cmd.args } };
    await writeJson(path, config);
    return { target: "claude-desktop", outcome: existed ? "updated" : "added", detail: path };
  } catch (err) {
    return { target: "claude-desktop", outcome: "failed", detail: (err as Error).message };
  }
}

export async function removeFromDesktop(env: Env): Promise<TargetResult> {
  const path = desktopConfigPath(env);
  try {
    const config = await readJson(path);
    const servers = (config?.mcpServers ?? {}) as Json;
    if (!config || !(SERVER_NAME in servers))
      return { target: "claude-desktop", outcome: "absent", detail: "not configured" };
    delete servers[SERVER_NAME];
    config.mcpServers = servers;
    await writeJson(path, config);
    return { target: "claude-desktop", outcome: "removed", detail: path };
  } catch (err) {
    return { target: "claude-desktop", outcome: "failed", detail: (err as Error).message };
  }
}

// --- Claude Code ------------------------------------------------------------

function claudeCodeJsonPath(env: Env): string {
  return join(env.home, ".claude.json");
}

export async function addToClaudeCode(cmd: ServerCommand, env: Env): Promise<TargetResult> {
  const cli = findClaudeCli(env);
  if (cli) {
    // `add` refuses to overwrite, so replace any previous registration (e.g. an older install path).
    env.run([cli, "mcp", "remove", SERVER_NAME, "--scope", "user"]);
    const r = env.run([cli, "mcp", "add", "--scope", "user", SERVER_NAME, "--", cmd.command, ...cmd.args]);
    return r.exitCode === 0
      ? { target: "claude-code", outcome: "added", detail: `via ${cli}` }
      : { target: "claude-code", outcome: "failed", detail: r.output || `claude mcp add exited ${r.exitCode}` };
  }
  const path = claudeCodeJsonPath(env);
  if (!existsSync(path)) return { target: "claude-code", outcome: "skipped", detail: "Claude Code isn't installed" };
  try {
    const config = (await readJson(path)) ?? {};
    const servers = (config.mcpServers ?? {}) as Json;
    servers[SERVER_NAME] = { type: "stdio", command: cmd.command, args: cmd.args, env: {} };
    config.mcpServers = servers;
    await writeJson(path, config);
    return {
      target: "claude-code",
      outcome: "added",
      detail: `edited ${path} directly (no claude CLI found); quit Claude Code first if it was running, then run this again if whoop is missing`,
    };
  } catch (err) {
    return { target: "claude-code", outcome: "failed", detail: (err as Error).message };
  }
}

export async function removeFromClaudeCode(env: Env): Promise<TargetResult> {
  const cli = findClaudeCli(env);
  if (cli) {
    const r = env.run([cli, "mcp", "remove", SERVER_NAME, "--scope", "user"]);
    if (r.exitCode === 0) return { target: "claude-code", outcome: "removed", detail: `via ${cli}` };
    return /not found|no .*server/i.test(r.output)
      ? { target: "claude-code", outcome: "absent", detail: "not configured" }
      : { target: "claude-code", outcome: "failed", detail: r.output || `claude mcp remove exited ${r.exitCode}` };
  }
  const path = claudeCodeJsonPath(env);
  try {
    const config = await readJson(path);
    const servers = (config?.mcpServers ?? {}) as Json;
    if (!config || !(SERVER_NAME in servers))
      return { target: "claude-code", outcome: "absent", detail: "not configured" };
    delete servers[SERVER_NAME];
    config.mcpServers = servers;
    await writeJson(path, config);
    return { target: "claude-code", outcome: "removed", detail: `edited ${path} directly` };
  } catch (err) {
    return { target: "claude-code", outcome: "failed", detail: (err as Error).message };
  }
}

export async function addToClaude(cmd = currentServerCommand(), env = defaultEnv()): Promise<TargetResult[]> {
  return [await addToClaudeCode(cmd, env), await addToDesktop(cmd, env)];
}

export async function removeFromClaude(env = defaultEnv()): Promise<TargetResult[]> {
  return [await removeFromClaudeCode(env), await removeFromDesktop(env)];
}

const LABEL: Record<TargetResult["target"], string> = {
  "claude-code": "Claude Code",
  "claude-desktop": "Claude Desktop",
};

export function describeResults(results: TargetResult[]): string {
  return results.map((r) => `  ${LABEL[r.target]}: ${r.outcome} (${r.detail})`).join("\n");
}
