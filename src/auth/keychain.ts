import { spawn } from "node:child_process";

/**
 * The macOS keychain, through Apple's own `security` tool.
 *
 * Why not a native keychain API: on macOS only the program that saved an item may read it without asking, or
 * change or delete it at all, and a program is identified by its code signature. The Bun builds were ad-hoc
 * signed, so every release counted as a new program and couldn't delete what the previous one saved
 * (errSecInvalidOwnerEdit). `security` is the same Apple-signed program in every version, so an item it saves
 * stays readable and deletable across whoop-mcp updates. An item an old Bun build saved is still readable: the
 * first read shows macOS's "security wants to use your confidential information" prompt once.
 *
 * The secret never appears in a command line, where any process could read it: `security -i` reads the command
 * from stdin, and the value goes in hex (-X), so it needs no quoting.
 */

export interface KeychainItem {
  service: string;
  account: string;
}

/** Exit status of `security` when there is no such item (errSecItemNotFound). */
const NOT_FOUND = 44;

/** A read can show macOS's access prompt (an item an older build saved), so give the user time to answer it. */
const READ_TIMEOUT_MS = 60_000;
const WRITE_TIMEOUT_MS = 15_000;

/** Test hook: a stand-in for /usr/bin/security, so tests never touch the real keychain. */
const securityPath = () => process.env.WHOOP_MCP_SECURITY || "/usr/bin/security";

export class KeychainError extends Error {
  override name = "KeychainError";
  readonly exitCode: number | null;
  constructor(message: string, exitCode: number | null) {
    super(message);
    this.exitCode = exitCode;
  }
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(args: string[], opts: { input?: string; timeoutMs: number }): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(securityPath(), args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => {
      stdout += d;
    });
    child.stderr.setEncoding("utf8").on("data", (d: string) => {
      stderr += d;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: signal ? null : code, stdout, stderr: stderr.trim() });
    });
    child.stdin.on("error", () => {}); // it may exit before reading stdin; the exit code tells
    child.stdin.end(opts.input ?? "");
  });
}

function failure(what: string, r: Run): KeychainError {
  const why = r.code === null ? "timed out" : `exit ${r.code}${r.stderr ? `: ${r.stderr}` : ""}`;
  return new KeychainError(`Couldn't ${what} the keychain item (${why}).`, r.code);
}

const target = (item: KeychainItem) => ["-s", item.service, "-a", item.account];

/** The item's value, or null when there is none. Throws when the keychain refuses (locked, Deny clicked). */
export async function getItem(item: KeychainItem): Promise<string | null> {
  const r = await run(["find-generic-password", ...target(item), "-w"], { timeoutMs: READ_TIMEOUT_MS });
  if (r.code === NOT_FOUND) return null;
  if (r.code !== 0) throw failure("read", r);
  // `security` adds a newline after the value.
  return decodeOutput(r.stdout.endsWith("\n") ? r.stdout.slice(0, -1) : r.stdout);
}

/**
 * `security -w` prints a value as bare hex when any byte isn't printable ASCII (a non-ASCII letter, say). Values
 * are saved as UTF-8, so hex that decodes to valid UTF-8 with such a byte is that encoding; anything else (a
 * printable value that merely looks like hex, such as "cafe") is the value itself. The values saved here are
 * JSON, which never looks like hex.
 */
export function decodeOutput(out: string): string {
  if (!/^(?:[0-9a-f]{2})+$/.test(out)) return out;
  const bytes = Buffer.from(out, "hex");
  if (!bytes.some((b) => b < 0x20 || b > 0x7e)) return out;
  const text = bytes.toString("utf8");
  return Buffer.from(text, "utf8").equals(bytes) ? text : out;
}

/** True if it was there, false if not; throws if it couldn't be deleted. */
export async function deleteItem(item: KeychainItem): Promise<boolean> {
  const r = await run(["delete-generic-password", ...target(item)], { timeoutMs: WRITE_TIMEOUT_MS });
  if (r.code === NOT_FOUND) return false;
  if (r.code !== 0) throw failure("delete", r);
  return true;
}

/**
 * Saves the value, replacing any item there. Replacing is delete-then-add rather than `-U`: an item another
 * program saved can be deleted but not updated, and the new item then belongs to `security`.
 */
export async function setItem(item: KeychainItem, value: string): Promise<void> {
  await deleteItem(item);
  const hex = Buffer.from(value, "utf8").toString("hex");
  // Service and account are our own constants, but quote them anyway: `security -i` splits on spaces.
  const quote = (s: string) => `"${s.replace(/["\\]/g, "\\$&")}"`;
  const command = `add-generic-password -s ${quote(item.service)} -a ${quote(item.account)} -X ${hex}\n`;
  const r = await run(["-i"], { input: command, timeoutMs: WRITE_TIMEOUT_MS });
  if (r.code !== 0) throw failure("save", r);
}

/** One object, so tests can stand in for the keychain without touching the real one. */
export const keychain = { get: getItem, set: setItem, delete: deleteItem };
