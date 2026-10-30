#!/usr/bin/env bun
/**
 * Removes everything whoop-mcp and its Claude Desktop extension leave on this Mac, so a test can start from
 * scratch: the WHOOP login (revoked at WHOOP first), the keychain item, config, logs, Desktop's extension and its
 * records of it, and leftovers from earlier Claude Code / plugin builds.
 *
 *   bun .claude/skills/whoop-reset/scripts/whoop-reset.ts            # dry run: lists what it would remove
 *   bun .claude/skills/whoop-reset/scripts/whoop-reset.ts --yes      # removes it
 *
 * Options: --no-revoke (don't call WHOOP), --include-downloads (also delete downloaded whoop-mcp*.mcpb installers),
 * --json (machine-readable report).
 *
 * Claude Desktop keeps its list of installed extensions in memory and writes it back, so the extension itself is
 * only removed while Desktop isn't running. When it is, the script stops the extension's process, cleans up the
 * rest, and leaves a background job that finishes once Desktop has quit (it waits up to an hour).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { chmod, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const EXTENSION_ID = "local.mcpb.whoop-mcp-contributors.whoop-mcp";
const KEYCHAIN_SERVICE = "whoop-mcp";
const SECURITY_NOT_FOUND = 44;
const REPO = join(import.meta.dir, "..", "..", "..", "..");

const args = new Set(process.argv.slice(2));
const OPTIONS = ["--yes", "--no-revoke", "--include-downloads", "--json"];
const unknown = [...args].filter((a) => !OPTIONS.includes(a) && a !== "--finish-extension");
if (unknown.length) {
  console.error(`Unknown option ${unknown.join(", ")}. Options: ${OPTIONS.join(" ")}`);
  process.exit(2);
}
const apply = args.has("--yes") || args.has("--finish-extension");

// Test hooks: a fake `security`, a fake "is Desktop running" check, and a fixed answer to that check.
const SECURITY = process.env.WHOOP_RESET_SECURITY ?? "/usr/bin/security";
/** Exits 0 while Claude Desktop runs. `pgrep` can't see Desktop's main process from inside a Claude session. */
const DESKTOP_RUNNING =
  process.env.WHOOP_RESET_DESKTOP_CHECK ??
  "/bin/ps -axo comm= | /usr/bin/grep -q '/Claude\\.app/Contents/MacOS/Claude$'";

const home = homedir();
const desktopSupport = join(home, "Library", "Application Support", "Claude");
const extensionDir = join(desktopSupport, "Claude Extensions", EXTENSION_ID);
const extensionSettings = join(desktopSupport, "Claude Extensions Settings", `${EXTENSION_ID}.json`);
const registry = join(desktopSupport, "extensions-installations.json");
const desktopLogs = join(home, "Library", "Logs", "Claude");

type Status = "found" | "removed" | "failed" | "deferred" | "kept" | "skipped";
type Item = { what: string; path?: string; status: Status; note?: string };
const report: Item[] = [];
const add = (item: Item) => report.push(item);

/**
 * Where whoop-mcp may keep its login: the extension always uses ~/.config/whoop-mcp (Desktop starts it without the
 * shell's variables), and a source run may use WHOOP_MCP_HOME or XDG_CONFIG_HOME. A folder from a variable is only
 * touched if it's named whoop-mcp: a stray value (".", $HOME, in the shell or the repo's .env) must never be wiped.
 */
function configDirs(): string[] {
  const dirs = [join(home, ".config", "whoop-mcp")];
  if (process.env.XDG_CONFIG_HOME) dirs.push(join(process.env.XDG_CONFIG_HOME, "whoop-mcp"));
  const custom = process.env.WHOOP_MCP_HOME;
  if (custom) {
    if (basename(resolve(custom)) === "whoop-mcp") dirs.push(resolve(custom));
    else if (existsSync(custom)) {
      add({
        what: "WHOOP_MCP_HOME folder",
        path: resolve(custom),
        status: "skipped",
        note: "not named whoop-mcp, so it's left alone; delete its tokens.json and client.json by hand",
      });
    }
  }
  return [...new Set(dirs.map((d) => resolve(d)))];
}

function desktopRunning(): boolean {
  const forced = process.env.WHOOP_RESET_DESKTOP_RUNNING;
  if (forced !== undefined) return forced === "1";
  return Bun.spawnSync(["/bin/sh", "-c", DESKTOP_RUNNING]).exitCode === 0;
}

/** Files and folders in `dir` whose names match, without failing on a missing folder. */
function matching(dir: string, test: (name: string) => boolean): string[] {
  try {
    return readdirSync(dir)
      .filter(test)
      .map((n) => join(dir, n));
  } catch {
    return [];
  }
}

async function removePath(what: string, path: string) {
  if (!existsSync(path)) return;
  if (!apply) return add({ what, path, status: "found" });
  try {
    await rm(path, { recursive: true, force: true });
    add({ what, path, status: "removed" });
  } catch (err) {
    add({ what, path, status: "failed", note: (err as Error).message });
  }
}

/** The extension's server processes: those whose command runs something from the extension's server folder. */
function stopExtension() {
  const server = join(extensionDir, "server");
  const ps = Bun.spawnSync(["/bin/ps", "-axo", "pid=,command="]).stdout.toString();
  const pids = ps
    .split("\n")
    .map((l) => l.trim().match(/^(\d+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null && m[2]!.includes(`${server}/`) && Number(m[1]) !== process.pid)
    .map((m) => m[1]!);
  if (!pids.length) return;
  if (!apply) return add({ what: "running extension process", status: "found", note: `pid ${pids.join(", ")}` });
  Bun.spawnSync(["/bin/kill", ...pids]);
  add({ what: "running extension process", status: "removed", note: `stopped pid ${pids.join(", ")}` });
}

/** Revokes whoop-mcp's access at WHOOP with the repo's own `logout`, which refreshes an expired token first. */
async function revoke(dir: string) {
  const tokens = join(dir, "tokens.json");
  if (!existsSync(tokens) || args.has("--no-revoke")) return;
  if (!apply) return add({ what: "WHOOP access (revoked at WHOOP)", path: tokens, status: "found" });
  const proc = Bun.spawn([process.execPath, join(REPO, "src", "index.ts"), "logout", "--keep-app"], {
    cwd: REPO,
    env: { ...process.env, WHOOP_MCP_HOME: dir, WHOOP_MCP_LOG_FILE: "off" },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000, // a keychain prompt nobody answers mustn't hang the reset
  });
  const [out, err, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  const text = out + err;
  if (text.includes("Revoked access at WHOOP."))
    return add({ what: "WHOOP access (revoked at WHOOP)", status: "removed" });
  add({
    what: "WHOOP access (revoked at WHOOP)",
    status: text.includes("Couldn't revoke") || code !== 0 ? "failed" : "removed",
    note:
      text.includes("Couldn't revoke") || code !== 0
        ? "couldn't revoke; the login is deleted anyway. Remove the app's access in the WHOOP developer dashboard if needed."
        : "no usable login to revoke",
  });
}

function security(...a: string[]): number | null {
  return Bun.spawnSync([SECURITY, ...a], { timeout: 15_000 }).exitCode;
}

/** Deletes every whoop-mcp keychain item (one per account; older builds may have left more than one). */
function keychain() {
  if (process.platform !== "darwin" && !process.env.WHOOP_RESET_SECURITY) return;
  if (security("find-generic-password", "-s", KEYCHAIN_SERVICE) !== 0) return;
  const what = "keychain item";
  const note = `service "${KEYCHAIN_SERVICE}"`;
  if (!apply) return add({ what, note, status: "found" });
  for (let i = 0; i < 20; i++) {
    const code = security("delete-generic-password", "-s", KEYCHAIN_SERVICE);
    if (code === SECURITY_NOT_FOUND) return add({ what, note, status: "removed" });
    if (code !== 0) break;
  }
  add({ what, status: "failed", note: `delete it in Keychain Access (search "${KEYCHAIN_SERVICE}")` });
}

function registered(): boolean {
  try {
    return EXTENSION_ID in (JSON.parse(readFileSync(registry, "utf8")).extensions ?? {});
  } catch {
    return false;
  }
}

/** Drops the extension's entry from Desktop's list of installed extensions, keeping every other entry. */
async function unregister() {
  if (!existsSync(registry)) return;
  const what = "Desktop's extension list entry";
  let data: { extensions?: Record<string, unknown> };
  try {
    data = JSON.parse(readFileSync(registry, "utf8"));
  } catch (err) {
    return add({ what, path: registry, status: "failed", note: (err as Error).message });
  }
  if (!data.extensions || !(EXTENSION_ID in data.extensions)) return;
  if (!apply) return add({ what, path: registry, status: "found" });
  delete data.extensions[EXTENSION_ID];
  const tmp = `${registry}.whoop-reset-${process.pid}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600); // the original is owner-only; keep it that way whatever the umask
    await rename(tmp, registry);
    add({ what, path: registry, status: "removed" });
  } catch (err) {
    await rm(tmp, { force: true });
    add({ what, path: registry, status: "failed", note: (err as Error).message });
  }
}

async function desktopLogFiles() {
  for (const f of matching(desktopLogs, (n) => /^mcp-server-.*whoop.*\.log$/i.test(n))) {
    await removePath("Claude Desktop's log for the extension", f);
  }
}

async function removeExtension() {
  await removePath("Claude Desktop extension", extensionDir);
  await removePath("Claude Desktop extension settings", extensionSettings);
  await unregister();
  await desktopLogFiles();
}

/** Desktop is open: finish the extension's removal from a background job once it has quit. */
function deferExtension() {
  if (!existsSync(extensionDir) && !existsSync(extensionSettings) && !registered()) return;
  const what = "Claude Desktop extension";
  if (!apply) return add({ what, path: extensionDir, status: "found", note: "removed after Claude Desktop quits" });
  if (process.env.WHOOP_RESET_NO_WAITER !== "1") {
    // Its own session (detached), so it outlives this process and the Claude session running it, which Desktop
    // stops when it quits. Desktop must stay gone for 3s in a row (a restart to update comes straight back); it
    // gives up after an hour. What it did goes to $TMPDIR/whoop-reset.log.
    const waiter = `gone=0; for i in $(seq 1 3600); do
  if ${DESKTOP_RUNNING}; then gone=0; else gone=$((gone + 1)); fi
  if [ "$gone" -ge 3 ]; then exec "$0" "$1" --finish-extension; fi
  sleep 1
done
echo "Claude Desktop didn't quit within an hour; run the whoop-reset skill again."`;
    const log = Bun.file(join(tmpdir(), "whoop-reset.log"));
    Bun.spawn(["/bin/sh", "-c", waiter, process.execPath, import.meta.path], {
      detached: true,
      cwd: tmpdir(),
      stdio: ["ignore", log, log],
    }).unref();
  }
  add({
    what,
    path: extensionDir,
    status: "deferred",
    note: "quit Claude Desktop (⌘Q) to finish; it's removed in the background, then reopen Desktop",
  });
}

async function main() {
  if (args.has("--finish-extension")) {
    await removeExtension();
    return print();
  }
  stopExtension();
  const dirs = configDirs();
  for (const dir of dirs) await revoke(dir);
  keychain();
  for (const dir of dirs) await removePath("whoop-mcp config (login, app credentials, setup leftovers)", dir);
  await removePath("whoop-mcp log", join(home, "Library", "Logs", "whoop-mcp"));
  await desktopLogFiles();
  const cliCaches = join(home, "Library", "Caches", "claude-cli-nodejs");
  for (const project of matching(cliCaches, () => true)) {
    for (const f of matching(project, (n) => /^mcp-logs-.*whoop/i.test(n))) await removePath("Claude Code MCP log", f);
  }
  await removePath("Claude Code plugin cache", join(home, ".claude", "plugins", "cache", "whoop-mcp"));
  if (desktopRunning()) deferExtension();
  else await removeExtension();
  for (const f of matching(join(home, "Downloads"), (n) => /^whoop-mcp.*\.mcpb$/i.test(n))) {
    if (args.has("--include-downloads")) await removePath("downloaded installer", f);
    else add({ what: "downloaded installer", path: f, status: "kept", note: "pass --include-downloads to delete" });
  }
  print();
}

function print() {
  if (report.some((r) => r.status === "failed")) process.exitCode = 1;
  if (args.has("--json")) return console.log(JSON.stringify({ applied: apply, items: report }, null, 2));
  const label: Record<Status, string> = {
    found: "would remove",
    removed: "removed",
    failed: "FAILED",
    deferred: "pending",
    kept: "kept",
    skipped: "skipped",
  };
  for (const r of report) {
    console.log(`${label[r.status].padEnd(12)} ${r.what}${r.path ? `: ${r.path}` : ""}${r.note ? ` (${r.note})` : ""}`);
  }
  if (!report.some((r) => r.status !== "kept")) console.log("Nothing of whoop-mcp left: already clean.");
  else if (!apply) console.log("\nDry run: nothing was removed. Run again with --yes to remove it.");
}

await main();
