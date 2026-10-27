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
      ...extraEnv,
    })
    .nothrow()
    .quiet();
}

const installedBin = () => join(home, ".whoop-mcp", "bin", "whoop-mcp");
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

    test("warns to quit the Claude desktop app when it's running (it would overwrite its config)", async () => {
      const r = await run(shell, "install.sh", [], { WHOOP_MCP_ASSUME_DESKTOP_RUNNING: "1" });
      expect(r.exitCode).toBe(0);
      const out = r.stdout.toString();
      expect(out).toContain("Claude Desktop is running");
      expect(out).toContain(`"${installedBin()}" claude add`);
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
