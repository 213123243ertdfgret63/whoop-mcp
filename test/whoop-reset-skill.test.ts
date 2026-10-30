import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { skills } from "../src/skills.ts";

// The reset script runs as a subprocess against a temporary HOME, with a fake `security` that keeps its "keychain"
// in a file, so neither the real keychain nor the real Claude Desktop is touched. Every test checks the dry run
// reports only paths under that HOME before it lets the script remove anything.
const SCRIPT = join(import.meta.dir, "..", ".claude", "skills", "whoop-reset", "scripts", "whoop-reset.ts");
const EXTENSION_ID = "local.mcpb.whoop-mcp-contributors.whoop-mcp";

let home: string;
/** Bun's and the background job's temporary files go here, outside HOME, so snapshots of HOME stay exact. */
let tmp: string;
let keychainFile: string;
let securityLog: string;
const support = () => join(home, "Library", "Application Support", "Claude");

beforeEach(async () => {
  // The real path (/private/var/..., not /var/...): the script resolves paths, and they must compare equal.
  home = await realpath(await mkdtemp(join(tmpdir(), "whoop-reset-test-")));
  tmp = await realpath(await mkdtemp(join(tmpdir(), "whoop-reset-tmp-")));
  keychainFile = join(home, "fake-keychain");
  securityLog = join(home, "security-calls");
  const security = join(home, "bin", "security");
  await put(
    security,
    `#!/bin/sh
echo "$*" >> "${securityLog}"
case "$1" in
  find-generic-password) [ -s "${keychainFile}" ] && exit 0 || exit 44 ;;
  delete-generic-password)
    n=$(cat "${keychainFile}" 2>/dev/null || echo 0)
    [ "$n" -gt 0 ] 2>/dev/null || exit 44
    n=$((n - 1)); if [ "$n" -gt 0 ]; then echo "$n" > "${keychainFile}"; else : > "${keychainFile}"; fi
    exit 0 ;;
esac
exit 1
`,
  );
  await chmod(security, 0o755);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(tmp, { recursive: true, force: true });
});

async function put(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

/** Everything a full install, a login and older builds leave behind, plus another extension that must survive. */
async function seed({ keychainItems = 1 } = {}) {
  if (keychainItems) await writeFile(keychainFile, String(keychainItems));
  await put(join(home, ".config", "whoop-mcp", "tokens.json"), "{}");
  await put(join(home, ".config", "whoop-mcp", "browser", "Cookies"), "x");
  await put(join(home, "Library", "Logs", "whoop-mcp", "whoop-mcp.log"), "log");
  await put(join(home, "Library", "Logs", "Claude", "mcp-server-WHOOP (unofficial).log"), "log");
  await put(join(home, "Library", "Logs", "Claude", "mcp-server-whoop.log"), "log");
  await put(join(home, "Library", "Logs", "Claude", "mcp-server-other.log"), "keep");
  await put(join(home, "Library", "Caches", "claude-cli-nodejs", "-Users-x", "mcp-logs-whoop", "a.txt"), "log");
  await put(join(home, ".claude", "plugins", "cache", "whoop-mcp", "whoop", "x"), "x");
  await put(join(support(), "Claude Extensions", EXTENSION_ID, "manifest.json"), "{}");
  await put(join(support(), "Claude Extensions", "local.other", "manifest.json"), "{}");
  await put(join(support(), "Claude Extensions Settings", `${EXTENSION_ID}.json`), '{"isEnabled":true}');
  await put(
    join(support(), "extensions-installations.json"),
    JSON.stringify({ extensions: { [EXTENSION_ID]: { version: "0.6.2" }, "local.other": { version: "1.0.0" } } }),
  );
  await put(join(home, "Downloads", "whoop-mcp-macos (1).mcpb"), "zip");
  // The extension's /whoop-* skills, except whoop-status, which here is the user's own and must survive.
  await putSkills(["whoop-connect", "whoop-disconnect"]);
  await put(join(home, ".claude", "skills", "whoop-status", "SKILL.md"), "---\nname: whoop-status\n---\nmine\n");
}

/** The skills exactly as the extension writes them. */
async function putSkills(names: string[]) {
  for (const s of skills()) {
    if (names.includes(s.name)) await put(join(home, ".claude", "skills", s.name, "SKILL.md"), s.content);
  }
}

async function run(args: string[], { desktopRunning = false, env = {} as Record<string, string>, json = true } = {}) {
  const proc = Bun.spawn([process.execPath, SCRIPT, "--no-revoke", ...(json ? ["--json"] : []), ...args], {
    cwd: home,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: home,
      TMPDIR: tmp,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", // Bun would cache compiled code under HOME
      WHOOP_RESET_SECURITY: join(home, "bin", "security"),
      WHOOP_RESET_DESKTOP_RUNNING: desktopRunning ? "1" : "0",
      WHOOP_RESET_NO_WAITER: "1",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), proc.stderr.text()]);
  if (code !== 0 && code !== 1) throw new Error(`exit ${code}: ${err}`);
  if (!json) return { code, text: out, report: { applied: false, items: [] } };
  return {
    code,
    report: JSON.parse(out) as { applied: boolean; items: { what: string; path?: string; status: string }[] },
  };
}

/** Refuses to go on unless every path the script reports is inside the temporary HOME. */
async function dryRunInsideHome(opts: { desktopRunning?: boolean; env?: Record<string, string> } = {}) {
  const { report } = await run([], opts);
  for (const item of report.items) if (item.path) expect(item.path.startsWith(home)).toBe(true);
  return report;
}

const exists = (...p: string[]) => Bun.file(join(...p)).exists();

/** Every file under HOME with its contents and mode, to prove a dry run changes nothing at all. */
async function snapshot() {
  const out: Record<string, string> = {};
  for (const name of await readdir(home, { recursive: true })) {
    const path = join(home, name);
    const st = await stat(path);
    if (name === "security-calls") continue; // the fake security's own call log
    out[name] = st.isDirectory() ? "dir" : `${st.mode.toString(8)}:${await readFile(path, "utf8")}`;
  }
  return out;
}
const dirExists = async (...p: string[]) => (await Bun.$`test -e ${join(...p)}`.nothrow().quiet()).exitCode === 0;

describe("whoop-reset skill", () => {
  test("a dry run lists everything and changes nothing", async () => {
    await seed();
    const before = await snapshot();
    const report = await dryRunInsideHome();
    expect(await snapshot()).toEqual(before);
    expect(report.applied).toBe(false);
    const whats = report.items.map((i) => i.what);
    expect(whats).toContain("keychain item");
    expect(whats).toContain("Claude Desktop extension");
    expect(whats).toContain("Desktop's extension list entry");
    expect(report.items.filter((i) => i.status === "found").length).toBeGreaterThanOrEqual(10);
    expect(await exists(home, ".config", "whoop-mcp", "tokens.json")).toBe(true);
    expect(await readFile(keychainFile, "utf8")).toBe("1");
    expect(await readFile(securityLog, "utf8")).not.toContain("delete");
  });

  test("--yes removes everything of whoop-mcp and nothing else", async () => {
    await seed({ keychainItems: 2 });
    await dryRunInsideHome();
    const { code, report } = await run(["--yes"]);
    expect(code).toBe(0);
    expect(report.items.filter((i) => i.status === "failed")).toEqual([]);

    expect(await dirExists(home, ".config", "whoop-mcp")).toBe(false);
    expect(await dirExists(home, "Library", "Logs", "whoop-mcp")).toBe(false);
    expect(await exists(home, "Library", "Logs", "Claude", "mcp-server-WHOOP (unofficial).log")).toBe(false);
    expect(await exists(home, "Library", "Logs", "Claude", "mcp-server-whoop.log")).toBe(false);
    expect(await dirExists(home, "Library", "Caches", "claude-cli-nodejs", "-Users-x", "mcp-logs-whoop")).toBe(false);
    expect(await dirExists(home, ".claude", "plugins", "cache", "whoop-mcp")).toBe(false);
    expect(await dirExists(home, ".claude", "skills", "whoop-connect")).toBe(false);
    expect(await dirExists(home, ".claude", "skills", "whoop-disconnect")).toBe(false);
    expect(await dirExists(support(), "Claude Extensions", EXTENSION_ID)).toBe(false);
    expect(await exists(support(), "Claude Extensions Settings", `${EXTENSION_ID}.json`)).toBe(false);
    // Both keychain items are gone.
    expect(await readFile(keychainFile, "utf8")).toBe("");

    // Left alone: other extensions, other logs, and the downloaded installer.
    const registry = JSON.parse(await readFile(join(support(), "extensions-installations.json"), "utf8"));
    expect(registry).toEqual({ extensions: { "local.other": { version: "1.0.0" } } });
    expect(await exists(support(), "Claude Extensions", "local.other", "manifest.json")).toBe(true);
    expect(await exists(home, "Library", "Logs", "Claude", "mcp-server-other.log")).toBe(true);
    expect(await exists(home, "Downloads", "whoop-mcp-macos (1).mcpb")).toBe(true);
    expect(report.items.find((i) => i.what === "downloaded installer")?.status).toBe("kept");
    // A whoop-status skill the extension didn't write is the user's own.
    expect(await readFile(join(home, ".claude", "skills", "whoop-status", "SKILL.md"), "utf8")).toContain("mine");
    expect(report.items.find((i) => i.path?.endsWith("/skills/whoop-status"))?.status).toBe("kept");

    const again = await run(["--yes"]);
    expect(again.report.items.filter((i) => i.status !== "kept")).toEqual([]);
    expect((await run([], { json: false })).text).toContain("already clean");
    // Desktop's list stays owner-only after the rewrite.
    expect((await stat(join(support(), "extensions-installations.json"))).mode & 0o777).toBe(0o600);
  });

  test("--include-downloads also deletes the downloaded installers", async () => {
    await seed();
    await dryRunInsideHome();
    await run(["--yes", "--include-downloads"]);
    expect(await exists(home, "Downloads", "whoop-mcp-macos (1).mcpb")).toBe(false);
  });

  test("while Claude Desktop runs, the extension is left for after it quits and everything else goes now", async () => {
    await seed();
    await dryRunInsideHome({ desktopRunning: true });
    const { report } = await run(["--yes"], { desktopRunning: true });
    expect(report.items.find((i) => i.what === "Claude Desktop extension")?.status).toBe("deferred");
    expect(await dirExists(support(), "Claude Extensions", EXTENSION_ID)).toBe(true);
    // (Keys, not toHaveProperty: the ID's dots would be read as a nested path.)
    expect(
      Object.keys(JSON.parse(await readFile(join(support(), "extensions-installations.json"), "utf8")).extensions),
    ).toContain(EXTENSION_ID);
    expect(await dirExists(home, ".config", "whoop-mcp")).toBe(false);

    expect(await dirExists(home, ".claude", "skills", "whoop-connect")).toBe(false);

    // The extension, still running until Desktop quits, writes its skills again when it restarts...
    await putSkills(["whoop-connect"]);
    // An empty folder, and one in a CLAUDE_CONFIG_DIR the extension wrote to, count too.
    await mkdir(join(home, ".claude", "skills", "whoop-disconnect"), { recursive: true });
    await put(join(home, "alt", "skills", "whoop-status", "SKILL.md"), skills()[2]?.content ?? "");
    // ...so what the background job runs once Desktop has quit removes them too.
    const finish = await run(["--finish-extension"], { env: { CLAUDE_CONFIG_DIR: join(home, "alt") } });
    expect(await dirExists(home, ".claude", "skills", "whoop-connect")).toBe(false);
    expect(await dirExists(home, ".claude", "skills", "whoop-disconnect")).toBe(false);
    expect(await dirExists(home, "alt", "skills", "whoop-status")).toBe(false);
    // The user's own whoop-status in ~/.claude stays.
    expect(await dirExists(home, ".claude", "skills", "whoop-status")).toBe(true);
    expect(finish.code).toBe(0);
    expect(await dirExists(support(), "Claude Extensions", EXTENSION_ID)).toBe(false);
    const registry = JSON.parse(await readFile(join(support(), "extensions-installations.json"), "utf8"));
    expect(Object.keys(registry.extensions)).toEqual(["local.other"]);
  });

  test("the background job finishes the removal once Claude Desktop has quit", async () => {
    await seed();
    const flag = join(home, "desktop-running");
    await writeFile(flag, "");
    const env = { WHOOP_RESET_DESKTOP_CHECK: `test -e '${flag}'`, WHOOP_RESET_NO_WAITER: "0" };
    // Detection goes through the check command, not the fixed answer.
    const proc = Bun.spawn([process.execPath, SCRIPT, "--no-revoke", "--json", "--yes"], {
      cwd: home,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: home,
        TMPDIR: tmp,
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", // Bun would cache compiled code under HOME
        WHOOP_RESET_SECURITY: join(home, "bin", "security"),
        ...env,
      },
      stdout: "pipe",
    });
    const report = JSON.parse(await proc.stdout.text());
    await proc.exited;
    expect(report.items.find((i: { what: string }) => i.what === "Claude Desktop extension")?.status).toBe("deferred");
    await Bun.sleep(1500);
    expect(await dirExists(support(), "Claude Extensions", EXTENSION_ID)).toBe(true); // Desktop still "running"
    await rm(flag);
    for (let i = 0; i < 40 && (await dirExists(support(), "Claude Extensions", EXTENSION_ID)); i++)
      await Bun.sleep(250);
    expect(await dirExists(support(), "Claude Extensions", EXTENSION_ID)).toBe(false);
    const registry = JSON.parse(await readFile(join(support(), "extensions-installations.json"), "utf8"));
    expect(Object.keys(registry.extensions)).toEqual(["local.other"]);
  }, 20_000);

  test("a WHOOP_MCP_HOME that isn't a whoop-mcp folder is never deleted", async () => {
    await seed();
    await put(join(home, "precious", "tokens.json"), "{}");
    await put(join(home, "precious", "thesis.docx"), "years of work");
    for (const value of [join(home, "precious"), "."]) {
      const env = { WHOOP_MCP_HOME: value };
      const report = await dryRunInsideHome({ env });
      expect(report.items.find((i) => i.what === "WHOOP_MCP_HOME folder")?.status).toBe("skipped");
      await run(["--yes"], { env });
      expect(await exists(home, "precious", "thesis.docx")).toBe(true);
      expect(await exists(home, "bin", "security")).toBe(true);
    }
  });

  test("a WHOOP_MCP_HOME named whoop-mcp, and the extension's own folder, are both cleaned", async () => {
    await seed();
    await put(join(home, "dev", "whoop-mcp", "tokens.json"), "{}");
    const env = { WHOOP_MCP_HOME: join(home, "dev", "whoop-mcp"), XDG_CONFIG_HOME: join(home, "xdg") };
    await dryRunInsideHome({ env });
    await run(["--yes"], { env });
    expect(await dirExists(home, "dev", "whoop-mcp")).toBe(false);
    // Desktop starts the extension without the shell's variables, so ~/.config/whoop-mcp goes regardless.
    expect(await dirExists(home, ".config", "whoop-mcp")).toBe(false);
  });

  test("a clean machine reports nothing to do", async () => {
    const report = await dryRunInsideHome();
    expect(report.items).toEqual([]);
  });

  test("unknown options are refused before anything happens", async () => {
    await seed();
    const proc = Bun.spawn([process.execPath, SCRIPT, "--yess"], {
      env: { PATH: "/usr/bin:/bin", HOME: home, WHOOP_RESET_SECURITY: join(home, "bin", "security") },
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(2);
    expect(await exists(home, ".config", "whoop-mcp", "tokens.json")).toBe(true);
  });
});
