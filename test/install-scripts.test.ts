import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import pkg from "../package.json" with { type: "json" };

const ROOT = join(import.meta.dir, "..");
const ASSET = `whoop-mcp-${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`;
const SHELLS = ["sh", ...(Bun.which("dash") ? ["dash"] : [])];

let release: string; // a fake GitHub release: the binary + SHA256SUMS
let work: string;
let home: string;
let fakeBin: string;

beforeAll(async () => {
  release = await mkdtemp(join(tmpdir(), "whoop-release-"));
  await $`${process.execPath} build ${join(ROOT, "src", "index.ts")} --compile --outfile ${join(release, ASSET)}`.quiet();
  const sum = new Bun.CryptoHasher("sha256").update(await Bun.file(join(release, ASSET)).arrayBuffer()).digest("hex");
  await writeFile(join(release, "SHA256SUMS"), `${sum}  ${ASSET}\n`);
}, 60_000);

afterAll(async () => {
  await rm(release, { recursive: true, force: true });
});

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "whoop-install-"));
  home = join(work, "home");
  fakeBin = join(work, "bin");
  await mkdir(join(home, "Library", "Application Support", "Claude"), { recursive: true });
  await mkdir(join(home, ".config", "Claude"), { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  // A fake `claude` CLI that logs its arguments, so we can see what the installer asked Claude Code to do.
  await writeFile(join(fakeBin, "claude"), `#!/bin/sh\necho "$@" >> "${join(work, "claude.log")}"\n`);
  await chmod(join(fakeBin, "claude"), 0o755);
  // Fake `osascript` and `open`: the restart path must never quit or launch the real Claude app in tests.
  for (const cmd of ["osascript", "open"]) {
    await writeFile(join(fakeBin, cmd), `#!/bin/sh\necho "${cmd} $@" >> "${join(work, "apple.log")}"\n`);
    await chmod(join(fakeBin, cmd), 0o755);
  }
  return () => rm(work, { recursive: true, force: true });
});

function run(shell: string, script: string, args: string[] = [], extraEnv: Record<string, string> = {}) {
  return $`${shell} ${join(ROOT, script)} ${args}`
    .env({
      HOME: home,
      PATH: `${fakeBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      WHOOP_MCP_DOWNLOAD_URL: `file://${release}`,
      // Keep the installed binary off the real keychain.
      WHOOP_MCP_CREDENTIAL_STORE: "file",
      // Never prompt (a developer's terminal would otherwise be asked) unless a test opts in.
      WHOOP_MCP_RESTART_CLAUDE: "no",
      // A real Claude may be running on this machine; the restart job must not wait for it to quit.
      WHOOP_MCP_CLAUDE_APP_PATTERN: "no-such-process-whoop-test",
      ...extraEnv,
    })
    .nothrow()
    .quiet();
}

const installedBin = () => join(home, ".whoop-mcp", "bin", "whoop-mcp");
const appleLog = async () => {
  const f = Bun.file(join(work, "apple.log"));
  return (await f.exists()) ? (await f.text()).trim().split("\n") : [];
};
const QUIT = 'osascript -e tell application id "com.anthropic.claudefordesktop" to quit';
const REOPEN = "open -b com.anthropic.claudefordesktop";

/** A stand-in "Claude" process that ignores the (fake) quit request, like a cancelled quit dialog. */
async function startFakeClaude() {
  const exe = join(work, "FakeClaudeProc");
  // A symlink (a copied system binary is killed by macOS code signing); `ps` reports the name it ran as.
  await $`ln -s /bin/sleep ${exe}`.quiet();
  const proc = Bun.spawn([exe, "60"], { stdout: "ignore", stderr: "ignore" });
  return { pattern: "FakeClaudeProc$", stop: () => proc.kill() };
}

/** The restart runs detached; wait for its log to say it finished. */
async function waitForRestart(log: string) {
  for (let i = 0; i < 200; i++) {
    const f = Bun.file(log);
    if ((await f.exists()) && (await f.text()).includes("restart finished")) return;
    await Bun.sleep(50);
  }
  throw new Error(
    `restart job didn't finish; log: ${await Bun.file(log)
      .text()
      .catch(() => "(none)")}`,
  );
}
const desktopConfig = () =>
  process.platform === "darwin"
    ? join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
    : join(home, ".config", "Claude", "claude_desktop_config.json");
const claudeLog = async () => {
  const f = Bun.file(join(work, "claude.log"));
  return (await f.exists()) ? (await f.text()).trim().split("\n") : [];
};

for (const shell of SHELLS) {
  describe(`install.sh / uninstall.sh under ${shell}`, () => {
    test("install verifies the download, installs the binary and adds it to Claude Code and Claude Desktop", async () => {
      const r = await run(shell, "install.sh");
      expect(r.exitCode).toBe(0);
      expect(r.stdout.toString()).toContain(`Installed whoop-mcp ${pkg.version}`);
      expect((await $`${installedBin()} --version`.text()).trim()).toBe(pkg.version);
      expect(await claudeLog()).toContain(`mcp add --scope user whoop -- ${installedBin()}`);
      const desktop = (await Bun.file(desktopConfig()).json()) as { mcpServers: Record<string, unknown> };
      expect(desktop.mcpServers.whoop).toEqual({ command: installedBin(), args: [] });
    }, 30_000);

    test("with Claude running and no answer given, it asks nothing and prints the manual steps", async () => {
      const r = await run(shell, "install.sh", [], { WHOOP_MCP_ASSUME_DESKTOP_RUNNING: "1" });
      expect(r.exitCode).toBe(0);
      const out = r.stdout.toString();
      expect(out).toContain("Claude Desktop is running");
      expect(out).toContain(`"${installedBin()}" claude add`);
      expect(await appleLog()).toEqual([]);
    }, 30_000);

    test("answering yes quits Claude, re-adds whoop once it's closed, reopens it, and reports the result", async () => {
      const r = await run(shell, "install.sh", [], {
        WHOOP_MCP_ASSUME_DESKTOP_RUNNING: "1",
        WHOOP_MCP_RESTART_CLAUDE: "yes",
      });
      expect(r.exitCode).toBe(0);
      expect(r.stdout.toString()).toContain("restart finished");
      expect(await appleLog()).toEqual([QUIT, REOPEN]);
      // Once by the installer, once more after Claude closed.
      expect((await claudeLog()).filter((l) => l.startsWith("mcp add"))).toHaveLength(2);
      const desktop = (await Bun.file(desktopConfig()).json()) as { mcpServers: Record<string, unknown> };
      expect(desktop.mcpServers.whoop).toEqual({ command: installedBin(), args: [] });
    }, 30_000);

    test("inside Claude's own terminal, the restart runs detached and logs its result", async () => {
      const r = await run(shell, "install.sh", [], {
        WHOOP_MCP_ASSUME_DESKTOP_RUNNING: "1",
        WHOOP_MCP_RESTART_CLAUDE: "yes",
        __CFBundleIdentifier: "com.anthropic.claudefordesktop",
      });
      expect(r.exitCode).toBe(0);
      expect(r.stdout.toString()).toContain("This terminal is inside Claude");
      await waitForRestart(join(home, ".whoop-mcp", "restart.log"));
      expect(await appleLog()).toEqual([QUIT, REOPEN]);
    }, 30_000);

    test("if Claude doesn't quit (dialog cancelled, permission denied), nothing is changed and it says what to do", async () => {
      const fake = await startFakeClaude();
      try {
        const r = await run(shell, "install.sh", [], {
          WHOOP_MCP_ASSUME_DESKTOP_RUNNING: "1",
          WHOOP_MCP_RESTART_CLAUDE: "yes",
          WHOOP_MCP_CLAUDE_APP_PATTERN: fake.pattern,
          WHOOP_MCP_QUIT_TIMEOUT: "1",
        });
        expect(r.exitCode).toBe(0);
        const out = r.stdout.toString();
        expect(out).toContain("Claude did not quit");
        expect(out).toContain("restart failed");
        expect(out).toContain("wasn't updated");
        expect(await appleLog()).toEqual([QUIT]); // no reopen
        expect((await claudeLog()).filter((l) => l.startsWith("mcp add"))).toHaveLength(1); // no re-add
      } finally {
        fake.stop();
      }
    }, 30_000);

    test("uninstall with Claude running, answering yes, removes whoop after Claude closes and deletes the install", async () => {
      expect((await run(shell, "install.sh")).exitCode).toBe(0);
      const r = await run(shell, "uninstall.sh", [], {
        WHOOP_MCP_ASSUME_DESKTOP_RUNNING: "1",
        WHOOP_MCP_RESTART_CLAUDE: "yes",
      });
      expect(r.exitCode).toBe(0);
      expect(r.stdout.toString()).toContain("restart finished");
      expect(await appleLog()).toEqual([QUIT, REOPEN]);
      expect(await claudeLog()).toContain("mcp remove whoop --scope user");
      const desktop = (await Bun.file(desktopConfig()).json()) as { mcpServers: Record<string, unknown> };
      expect(desktop.mcpServers.whoop).toBeUndefined();
      expect(await Bun.file(installedBin()).exists()).toBe(false);
    }, 30_000);

    test("uninstall keeps the binary when Claude doesn't quit, so it can be finished later", async () => {
      expect((await run(shell, "install.sh")).exitCode).toBe(0);
      const fake = await startFakeClaude();
      try {
        const r = await run(shell, "uninstall.sh", [], {
          WHOOP_MCP_ASSUME_DESKTOP_RUNNING: "1",
          WHOOP_MCP_RESTART_CLAUDE: "yes",
          WHOOP_MCP_CLAUDE_APP_PATTERN: fake.pattern,
          WHOOP_MCP_QUIT_TIMEOUT: "1",
        });
        expect(r.exitCode).toBe(0);
        expect(r.stdout.toString()).toContain("run this uninstaller again");
        expect(await Bun.file(installedBin()).exists()).toBe(true);
      } finally {
        fake.stop();
      }
    }, 30_000);

    test("uninstall with Claude running, answering no, removes it now and says what to do if it reappears", async () => {
      expect((await run(shell, "install.sh")).exitCode).toBe(0);
      const r = await run(shell, "uninstall.sh", [], { WHOOP_MCP_ASSUME_DESKTOP_RUNNING: "1" });
      expect(r.exitCode).toBe(0);
      expect(r.stdout.toString()).toContain("If whoop reappears in Claude Desktop");
      expect(await appleLog()).toEqual([]);
      expect(await Bun.file(installedBin()).exists()).toBe(false);
    }, 30_000);

    test("running install again updates in place", async () => {
      expect((await run(shell, "install.sh")).exitCode).toBe(0);
      expect((await run(shell, "install.sh")).exitCode).toBe(0);
      const desktop = (await Bun.file(desktopConfig()).json()) as { mcpServers: Record<string, unknown> };
      expect(Object.keys(desktop.mcpServers)).toEqual(["whoop"]);
    }, 30_000);

    test("a checksum mismatch aborts without installing anything", async () => {
      const bad = await mkdtemp(join(tmpdir(), "whoop-bad-release-"));
      try {
        await $`cp ${join(release, ASSET)} ${bad}/`.quiet();
        await writeFile(join(bad, "SHA256SUMS"), `${"0".repeat(64)}  ${ASSET}\n`);
        const r = await run(shell, "install.sh", [], { WHOOP_MCP_DOWNLOAD_URL: `file://${bad}` });
        expect(r.exitCode).not.toBe(0);
        expect(r.stderr.toString()).toContain("checksum mismatch");
        expect(await Bun.file(installedBin()).exists()).toBe(false);
        expect(await claudeLog()).toEqual([]);
      } finally {
        await rm(bad, { recursive: true, force: true });
      }
    }, 30_000);

    test("a missing release asset fails clearly", async () => {
      const r = await run(shell, "install.sh", [], { WHOOP_MCP_DOWNLOAD_URL: `file://${join(work, "nothing-here")}` });
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr.toString()).toContain("download failed");
    }, 30_000);

    test("WHOOP_MCP_NO_CLAUDE=1 installs without touching Claude", async () => {
      const r = await run(shell, "install.sh", [], { WHOOP_MCP_NO_CLAUDE: "1" });
      expect(r.exitCode).toBe(0);
      expect(await Bun.file(installedBin()).exists()).toBe(true);
      expect(await claudeLog()).toEqual([]);
      expect(await Bun.file(desktopConfig()).exists()).toBe(false);
    }, 30_000);

    test("uninstall removes it from Claude, deletes saved WHOOP data and the install folder", async () => {
      expect((await run(shell, "install.sh")).exitCode).toBe(0);
      const dataDir = join(home, ".config", "whoop-mcp");
      await mkdir(dataDir, { recursive: true });
      await writeFile(join(dataDir, "tokens.json"), "{}");
      await writeFile(join(dataDir, "client.json"), JSON.stringify({ clientId: "a", clientSecret: "b" }));

      const r = await run(shell, "uninstall.sh");
      expect(r.exitCode).toBe(0);
      expect(await claudeLog()).toContain("mcp remove whoop --scope user");
      const desktop = (await Bun.file(desktopConfig()).json()) as { mcpServers: Record<string, unknown> };
      expect(desktop.mcpServers.whoop).toBeUndefined();
      expect(await Bun.file(join(dataDir, "tokens.json")).exists()).toBe(false);
      expect(await Bun.file(join(dataDir, "client.json")).exists()).toBe(false);
      expect(await Bun.file(installedBin()).exists()).toBe(false);
    }, 30_000);

    test("uninstall --keep-data keeps the saved tokens and credentials", async () => {
      expect((await run(shell, "install.sh")).exitCode).toBe(0);
      const dataDir = join(home, ".config", "whoop-mcp");
      await mkdir(dataDir, { recursive: true });
      await writeFile(join(dataDir, "tokens.json"), "{}");
      const r = await run(shell, "uninstall.sh", ["--keep-data"]);
      expect(r.exitCode).toBe(0);
      expect(await Bun.file(join(dataDir, "tokens.json")).exists()).toBe(true);
      expect(await Bun.file(installedBin()).exists()).toBe(false);
    }, 30_000);

    test("uninstall when nothing is installed is a harmless no-op", async () => {
      const r = await run(shell, "uninstall.sh");
      expect(r.exitCode).toBe(0);
      expect(r.stdout.toString()).toContain("nothing to remove");
    }, 30_000);
  });
}
