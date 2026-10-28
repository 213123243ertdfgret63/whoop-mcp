import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultLogFile, formatLine, log, logFile, redact } from "../src/log.ts";

describe("redact", () => {
  test("removes bearer tokens, OAuth tokens, secrets and codes", () => {
    expect(redact("Authorization: Bearer abc.def-123")).toBe("Authorization: Bearer [redacted]");
    expect(redact('{"access_token":"a1","refresh_token":"r1","scope":"x"}')).toBe(
      '{"access_token":"[redacted]","refresh_token":"[redacted]","scope":"x"}',
    );
    expect(redact("client_secret=s3cr3t&code=xyz&state=ok")).toBe("client_secret=[redacted]&code=[redacted]&state=ok");
  });

  test("leaves ordinary text alone, including field names that merely end in code or token", () => {
    expect(redact("tool whoop_today ok ms=41 status=200")).toBe("tool whoop_today ok ms=41 status=200");
    expect(redact("exited exit_code=0 next_token=abc")).toBe("exited exit_code=0 next_token=abc");
  });
});

describe("formatLine", () => {
  const now = new Date("2026-10-28T18:40:12.345Z");

  test("timestamp, padded level, message and key=value fields", () => {
    expect(formatLine("info", "whoop request", { path: "/v2/cycle", status: 200, ms: 41 }, now)).toBe(
      "2026-10-28T18:40:12.345Z INFO  whoop request path=/v2/cycle status=200 ms=41",
    );
  });

  test("quotes values with spaces, JSON-encodes objects, drops undefined and keeps one line", () => {
    const line = formatLine("warn", "x", { error: "two words", args: { days: 7 }, skip: undefined, s: "a\nb" }, now);
    expect(line).toBe('2026-10-28T18:40:12.345Z WARN  x error="two words" args={"days":7} s="a\\nb"');
    expect(line).not.toContain("\n");
  });
});

describe("log file location", () => {
  test("follows each platform's convention", () => {
    expect(defaultLogFile({}, "darwin")).toMatch(/Library\/Logs\/whoop-mcp\/whoop-mcp\.log$/);
    expect(defaultLogFile({ LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }, "win32")).toContain(
      join("C:\\Users\\a\\AppData\\Local", "whoop-mcp", "Logs", "whoop-mcp.log"),
    );
    expect(defaultLogFile({ XDG_STATE_HOME: "/state" }, "linux")).toBe("/state/whoop-mcp/whoop-mcp.log");
    expect(defaultLogFile({ WHOOP_MCP_HOME: "/h" }, "darwin")).toBe("/h/logs/whoop-mcp.log");
  });

  test("WHOOP_MCP_LOG_FILE overrides it, and 'off' turns file logging off", () => {
    expect(logFile({ WHOOP_MCP_LOG_FILE: "/tmp/x.log" })).toBe("/tmp/x.log");
    expect(logFile({ WHOOP_MCP_LOG_FILE: "OFF" })).toBeNull();
  });
});

describe("logger", () => {
  let dir: string;
  let file: string;
  let stderr: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "whoop-log-test-"));
    file = join(dir, "logs", "whoop-mcp.log");
    stderr = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    stderr.mockRestore();
    log.configure();
    await rm(dir, { recursive: true, force: true });
  });

  test("writes owner-only lines to the file and to stderr, filtered by level", async () => {
    log.configure({ WHOOP_MCP_LOG_FILE: file, WHOOP_MCP_LOG_LEVEL: "info" });
    log.debug("hidden");
    log.info("shown", { n: 1 });
    log.error("bad", { error: "boom" });
    const text = await readFile(file, "utf8");
    expect(text).not.toContain("hidden");
    expect(text).toMatch(/INFO {2}shown n=1\n.*ERROR bad error=boom\n$/);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(stderr.mock.calls.map((c: unknown[]) => String(c[0])).join("")).toContain("[whoop-mcp] ");
  });

  test("stderr can be limited to problems while the file keeps everything", async () => {
    log.configure({ WHOOP_MCP_LOG_FILE: file, WHOOP_MCP_LOG_STDERR_LEVEL: "warn" });
    log.info("routine");
    log.warn("problem");
    const printed = stderr.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(printed).not.toContain("routine");
    expect(printed).toContain("problem");
    expect(await readFile(file, "utf8")).toContain("routine");
  });

  test("debug level includes debug lines", async () => {
    log.configure({ WHOOP_MCP_LOG_FILE: file, WHOOP_MCP_LOG_LEVEL: "debug" });
    log.debug("detail");
    expect(await readFile(file, "utf8")).toContain("DEBUG detail");
    expect(log.enabled("debug")).toBe(true);
  });

  test("rotates a file over 5 MB, keeping three old generations", async () => {
    log.configure({ WHOOP_MCP_LOG_FILE: file });
    log.info("first"); // creates the directory
    await writeFile(file, "x".repeat(5 * 1024 * 1024));
    await writeFile(`${file}.1`, "gen1");
    log.configure({ WHOOP_MCP_LOG_FILE: file }); // a new process checks the size on its first write
    log.info("after rotation");
    expect(await readFile(file, "utf8")).toContain("after rotation");
    expect((await stat(`${file}.1`)).size).toBe(5 * 1024 * 1024);
    expect(await readFile(`${file}.2`, "utf8")).toBe("gen1");
  });

  test("a log file that can't be written falls back to stderr instead of failing", () => {
    log.configure({ WHOOP_MCP_LOG_FILE: "/dev/null/not-a-dir/whoop.log" });
    expect(() => log.info("still fine")).not.toThrow();
    expect(log.settings().file).toBeNull();
    expect(stderr.mock.calls.map((c: unknown[]) => String(c[0])).join("")).toContain("could not write the log file");
  });

  test("redacts secrets that reach a log line", async () => {
    log.configure({ WHOOP_MCP_LOG_FILE: file });
    log.warn("oops", { body: '{"refresh_token":"r-123"}' });
    expect(await readFile(file, "utf8")).not.toContain("r-123");
  });
});
