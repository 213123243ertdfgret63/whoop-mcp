import { appendFileSync, chmodSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Logging for the server: one line per event, to a rotating file and to stderr.
 *
 * stdout belongs to the MCP stdio transport, so nothing is ever written there. Claude Desktop also copies
 * stderr into its own log (~/Library/Logs/Claude/mcp-server-whoop.log), but that file mixes in the protocol
 * traffic and is cut by Desktop; ours keeps only the server's own events.
 *
 * What is logged: startup and shutdown, every tool call (name, arguments, duration, outcome), every WHOOP API
 * request (path, status, duration, trace id), token refreshes and login steps. What is never logged: tokens,
 * secrets, authorization codes, and WHOOP health data (response bodies), which WHOOP's terms don't allow us to
 * keep. `redact` is a last line of defence for the first three.
 *
 * Settings (environment):
 * - WHOOP_MCP_LOG_LEVEL: debug, info (default), warn or error.
 * - WHOOP_MCP_LOG_FILE: a file path, or "off" for stderr only. Defaults to `defaultLogFile()`.
 * - WHOOP_MCP_LOG_STDERR_LEVEL: the lowest level also copied to stderr (default: same as the file). The server
 *   sets it to warn, because Claude Desktop already keeps stderr in its own log.
 */

export type Level = "debug" | "info" | "warn" | "error";
const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type Fields = Record<string, unknown>;

const MAX_BYTES = 5 * 1024 * 1024;
const KEEP_FILES = 3; // whoop-mcp.log.1 .. .3
const CHECK_EVERY = 200; // writes between size checks

/** The platform's usual place for an app's logs. */
export function defaultLogFile(env = process.env, platform = process.platform): string {
  if (env.WHOOP_MCP_HOME) return join(env.WHOOP_MCP_HOME, "logs", "whoop-mcp.log");
  if (platform === "darwin") return join(homedir(), "Library", "Logs", "whoop-mcp", "whoop-mcp.log");
  if (platform === "win32") {
    return join(env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "whoop-mcp", "Logs", "whoop-mcp.log");
  }
  return join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "whoop-mcp", "whoop-mcp.log");
}

/** The log file in use, or null when file logging is off. */
export function logFile(env = process.env): string | null {
  const configured = env.WHOOP_MCP_LOG_FILE?.trim();
  if (configured?.toLowerCase() === "off") return null;
  return configured || defaultLogFile(env);
}

function levelFromEnv(value: string | undefined, fallback: Level): Level {
  const v = value?.trim().toLowerCase();
  return v && v in RANK ? (v as Level) : fallback;
}

const SECRET_PATTERNS: [RegExp, string][] = [
  [/(Bearer\s+)[\w.~+/=-]+/gi, "$1[redacted]"],
  [
    // Also matches escaped quotes, for JSON that was itself JSON-encoded into a field.
    /((?:\\?")?\b(?:access_token|refresh_token|id_token|client_secret|code|code_verifier|token)(?:\\?")?\s*[:=]\s*(?:\\?")?)[^"\\&\s,}]+/gi,
    "$1[redacted]",
  ],
];

/** Removes anything that looks like a token or secret from a log line. */
export function redact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

function formatValue(v: unknown): string {
  if (v instanceof Error) return JSON.stringify(v.message);
  // Bare when unambiguous (paths, URLs, ids); quoted when it has spaces, quotes or line breaks.
  if (typeof v === "string") return /^[\w.:/@+?=&%~,#-]+$/.test(v) ? v : JSON.stringify(v);
  if (v === undefined) return "undefined";
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** `2026-10-28T18:40:12.345Z INFO  tool whoop_today ok ms=412 args={"raw":false}` */
export function formatLine(level: Level, message: string, fields: Fields = {}, now = new Date()): string {
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${formatValue(v)}`);
  const body = [message, ...parts].join(" ").replace(/\r?\n/g, "\\n");
  return redact(`${now.toISOString()} ${level.toUpperCase().padEnd(5)} ${body}`);
}

class Logger {
  private level: Level = levelFromEnv(process.env.WHOOP_MCP_LOG_LEVEL, "info");
  private stderrLevel: Level = levelFromEnv(process.env.WHOOP_MCP_LOG_STDERR_LEVEL, this.level);
  private file: string | null = logFile();
  private writes = 0;
  private fileFailed = false;

  /** Re-reads the environment; for tests and for settings Claude Desktop passes in after start-up. */
  configure(env = process.env): void {
    this.level = levelFromEnv(env.WHOOP_MCP_LOG_LEVEL, "info");
    this.stderrLevel = levelFromEnv(env.WHOOP_MCP_LOG_STDERR_LEVEL, this.level);
    this.file = logFile(env);
    this.writes = 0;
    this.fileFailed = false;
  }

  get settings() {
    return { level: this.level, file: this.fileFailed ? null : this.file };
  }

  enabled(level: Level): boolean {
    return RANK[level] >= RANK[this.level];
  }

  write(level: Level, message: string, fields?: Fields): void {
    if (!this.enabled(level)) return;
    const line = formatLine(level, message, fields);
    if (RANK[level] >= RANK[this.stderrLevel]) console.error(`[whoop-mcp] ${line}`);
    this.toFile(line);
  }

  private toFile(line: string): void {
    if (!this.file || this.fileFailed) return;
    try {
      if (this.writes === 0) mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      if (this.writes % CHECK_EVERY === 0) this.rotateIfLarge(this.file);
      appendFileSync(this.file, `${line}\n`, { mode: 0o600 });
      if (this.writes === 0) chmodSync(this.file, 0o600);
      this.writes++;
    } catch (err) {
      // Never let logging break the server: fall back to stderr only, and say so once.
      this.fileFailed = true;
      console.error(`[whoop-mcp] could not write the log file ${this.file}: ${(err as Error).message}`);
    }
  }

  private rotateIfLarge(file: string): void {
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      return; // not created yet
    }
    if (size < MAX_BYTES) return;
    rmSync(`${file}.${KEEP_FILES}`, { force: true });
    for (let i = KEEP_FILES - 1; i >= 1; i--) {
      try {
        renameSync(`${file}.${i}`, `${file}.${i + 1}`);
      } catch {
        // that generation doesn't exist yet
      }
    }
    try {
      renameSync(file, `${file}.1`);
    } catch {
      // Another process sharing the file rotated it first; appending recreates it.
    }
  }
}

const logger = new Logger();

/** Info-level message; kept as a plain function because most call sites only need this. */
export function log(message: string, fields?: Fields): void {
  logger.write("info", message, fields);
}

log.write = (level: Level, message: string, fields?: Fields) => logger.write(level, message, fields);
log.debug = (message: string, fields?: Fields) => logger.write("debug", message, fields);
log.info = (message: string, fields?: Fields) => logger.write("info", message, fields);
log.warn = (message: string, fields?: Fields) => logger.write("warn", message, fields);
log.error = (message: string, fields?: Fields) => logger.write("error", message, fields);
log.enabled = (level: Level) => logger.enabled(level);
log.configure = (env?: NodeJS.ProcessEnv) => logger.configure(env);
log.settings = () => logger.settings;

/** An error as log fields: message, plus the stack at debug level. */
export function errorFields(err: unknown): Fields {
  if (!(err instanceof Error)) return { error: String(err) };
  return { error: err.message, kind: err.name, ...(logger.enabled("debug") ? { stack: err.stack } : {}) };
}
