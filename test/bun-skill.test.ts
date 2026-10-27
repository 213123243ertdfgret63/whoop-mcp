import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// The skill scripts run as subprocesses under the real Bun (process.execPath), fully offline:
// their caches are seeded in a temp XDG_CACHE_HOME (fresh files are inside the 6h/24h TTL), a fake
// `bun` shim on PATH reports the "installed" version, and any stray fetch is sent to a dead proxy.
const SCRIPTS = join(import.meta.dir, "..", ".claude", "skills", "bun", "scripts");
const VERSION_CHECK = join(SCRIPTS, "bun-version-check.ts");
const DOCS = join(SCRIPTS, "bun-docs.ts");

let tmp: string;
let cacheDir: string;
let project: string;
let binDir: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "bun-skill-test-"));
  cacheDir = join(tmp, "cache", "bun-skill");
  project = join(tmp, "project");
  binDir = join(tmp, "bin");
  await mkdir(cacheDir, { recursive: true });
  await mkdir(project, { recursive: true });
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function put(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

/** Puts a fake `bun` in `dir` (default: tmp/bin) that answers --version and --revision. */
async function fakeBun(version: string, revision = `${version}+0000000`, dir = binDir) {
  const shim = join(dir, "bun");
  await put(
    shim,
    `#!/bin/sh\ncase "$1" in\n  --version) echo "${version}" ;;\n  --revision) echo "${revision}" ;;\n  *) exit 1 ;;\nesac\n`,
  );
  await chmod(shim, 0o755);
  binDir = dir;
}

async function seedReleases(versions: string[], notes: Record<string, string | null> = {}) {
  await put(
    join(cacheDir, "releases.json"),
    JSON.stringify(versions.map((version, i) => ({ version, date: `2026-10-${String(20 - i).padStart(2, "0")}` }))),
  );
  for (const [version, summary] of Object.entries(notes)) {
    await put(join(cacheDir, `notes-${version}.json`), JSON.stringify(summary));
  }
}

async function run(script: string, args: string[]) {
  const proc = Bun.spawn([process.execPath, script, ...args], {
    cwd: project,
    env: {
      PATH: binDir,
      HOME: tmp,
      XDG_CACHE_HOME: join(tmp, "cache"),
      // Any fetch that escapes the seeded cache fails fast instead of reaching GitHub or bun.com.
      HTTP_PROXY: "http://127.0.0.1:9",
      HTTPS_PROXY: "http://127.0.0.1:9",
      NO_COLOR: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

const versionCheck = (...args: string[]) => run(VERSION_CHECK, ["--cwd", project, ...args]);

interface Report {
  installed: { version: string; method: string; canary: boolean };
  latest: { version: string };
  status: string;
  versions_behind: number;
  upgrade_command: string | null;
  missed_releases: { version: string; summary: string | null }[];
  project: { pins: { source: string; value: string; version: number[] | null; kind: string }[]; issues: string[] };
}

async function report(): Promise<Report> {
  const { stdout, exitCode, stderr } = await versionCheck("--json");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  return JSON.parse(stdout) as Report;
}

describe("bun-version-check.ts", () => {
  test("reports CURRENT with no upgrade line when the installed Bun is the latest release", async () => {
    await fakeBun("1.4.6");
    await seedReleases(["1.4.6", "1.4.5", "1.4.4"]);
    const { stdout, exitCode } = await versionCheck();
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Installed: Bun 1.4.6");
    expect(stdout).toContain("Latest stable: 1.4.6 (2026-10-20)");
    expect(stdout).toContain("Status: CURRENT");
    expect(stdout).not.toContain("Upgrade:");
    expect(stdout).not.toContain("Missed releases");
  });

  test("reports OUTDATED with the count behind, missed release summaries and an upgrade command", async () => {
    await fakeBun("1.4.4");
    await seedReleases(["1.4.6", "1.4.5", "1.4.4", "1.4.3"], {
      "1.4.6": "Faster installs and a new test reporter",
      "1.4.5": "Fixes a crash in Bun.serve",
    });
    const { stdout, exitCode } = await versionCheck();
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Status: OUTDATED, 2 release(s) behind");
    expect(stdout).toMatch(/^Upgrade: .+/m);
    expect(stdout).toContain("Missed releases (newest first):");
    expect(stdout).toContain("- 1.4.6 (2026-10-20) https://bun.com/blog/bun-v1.4.6");
    expect(stdout).toContain("Faster installs and a new test reporter");
    expect(stdout).toContain("Fixes a crash in Bun.serve");
    expect(stdout).not.toContain("bun-v1.4.4");
    expect(stdout.indexOf("1.4.6 (")).toBeLessThan(stdout.indexOf("1.4.5 ("));
  });

  test("lists a missed release without a summary when its notes are cached as null", async () => {
    await fakeBun("1.4.5");
    await seedReleases(["1.4.6", "1.4.5"], { "1.4.6": null });
    const { stdout } = await versionCheck();
    expect(stdout).toContain("- 1.4.6 (2026-10-20) https://bun.com/blog/bun-v1.4.6\n");
  });

  test("suggests `bun upgrade` for a Bun installed by the install script in ~/.bun/bin", async () => {
    await fakeBun("1.4.4", undefined, join(tmp, ".bun", "bin"));
    await seedReleases(["1.4.5", "1.4.4"], { "1.4.5": null });
    const r = await report();
    expect(r.installed.method).toBe("install-script");
    expect(r.upgrade_command).toBe("bun upgrade");
  });

  test("reports AHEAD for a canary build even when its version equals the latest stable", async () => {
    await fakeBun("1.4.6", "1.4.6-canary.20+abcdef0");
    await seedReleases(["1.4.6", "1.4.5"]);
    const r = await report();
    expect(r.installed.canary).toBe(true);
    expect(r.status).toBe("ahead");
    expect(r.upgrade_command).toBeNull();
  });

  test("--json output parses and carries status, versions_behind and project.issues", async () => {
    await fakeBun("1.4.4");
    await seedReleases(["1.4.6", "1.4.5", "1.4.4"], { "1.4.6": "six", "1.4.5": "five" });
    const r = await report();
    expect(r.status).toBe("outdated");
    expect(r.versions_behind).toBe(2);
    expect(r.installed.version).toBe("1.4.4");
    expect(r.latest.version).toBe("1.4.6");
    expect(r.missed_releases.map((m) => [m.version, m.summary])).toEqual([
      ["1.4.6", "six"],
      ["1.4.5", "five"],
    ]);
    expect(Array.isArray(r.project.issues)).toBe(true);
    expect(r.upgrade_command).toEqual(expect.any(String));
  });

  test('says "none found" when the project has no Bun pins', async () => {
    await fakeBun("1.4.6");
    await seedReleases(["1.4.6"]);
    await put(join(project, "package.json"), JSON.stringify({ name: "x", dependencies: { zod: "^4.0.0" } }));
    const { stdout } = await versionCheck();
    expect(stdout).toContain(`Project pins in ${project}:\n- none found`);
    expect(stdout).not.toContain("Pin issues:");
  });

  test("flags engines.bun that requires a newer Bun than the one installed", async () => {
    await fakeBun("1.4.4");
    await seedReleases(["1.4.6", "1.4.5", "1.4.4"], { "1.4.6": null, "1.4.5": null });
    await put(join(project, "package.json"), JSON.stringify({ engines: { bun: ">=1.4.5" } }));
    const r = await report();
    expect(r.project.pins).toContainEqual({
      source: "package.json engines.bun",
      value: ">=1.4.5",
      version: [1, 4, 5],
      kind: "runtime",
    });
    expect(r.project.issues).toEqual(["package.json engines.bun: requires >=1.4.5 but the installed Bun is 1.4.4"]);
  });

  test("does not flag an engines.bun range the installed Bun satisfies", async () => {
    await fakeBun("1.4.4");
    await seedReleases(["1.4.6", "1.4.5", "1.4.4"], { "1.4.6": null, "1.4.5": null });
    await put(join(project, "package.json"), JSON.stringify({ engines: { bun: ">=1.4.0" } }));
    expect((await report()).project.issues).toEqual([]);
  });

  test("flags exact packageManager and Docker pins older than the latest release", async () => {
    await fakeBun("1.4.6");
    await seedReleases(["1.4.6", "1.4.5"]);
    await put(join(project, "package.json"), JSON.stringify({ packageManager: "bun@1.4.5" }));
    await put(join(project, "Dockerfile"), "FROM oven/bun:1.4.5-alpine AS build\nRUN bun install\n");
    const r = await report();
    expect(r.project.issues).toEqual([
      "package.json packageManager: pins bun@1.4.5, older than the latest 1.4.6",
      "Dockerfile: pins oven/bun:1.4.5-alpine, older than the latest 1.4.6",
    ]);
  });

  test("does not flag exact pins that match the latest release", async () => {
    await fakeBun("1.4.6");
    await seedReleases(["1.4.6", "1.4.5"]);
    await put(join(project, "package.json"), JSON.stringify({ packageManager: "bun@1.4.6" }));
    await put(join(project, ".bun-version"), "1.4.6\n");
    const r = await report();
    expect(r.project.pins.map((p) => p.source).sort()).toEqual([".bun-version", "package.json packageManager"]);
    expect(r.project.issues).toEqual([]);
  });

  test("flags installed @types/bun whose minor version differs from the runtime", async () => {
    await fakeBun("1.4.6");
    await seedReleases(["1.4.6"]);
    await put(join(project, "package.json"), JSON.stringify({ devDependencies: { "@types/bun": "latest" } }));
    await put(join(project, "node_modules", "@types", "bun", "package.json"), JSON.stringify({ version: "1.3.9" }));
    const r = await report();
    expect(r.project.pins).toContainEqual(
      expect.objectContaining({ value: "latest (installed 1.3.9)", version: [1, 3, 9], kind: "types" }),
    );
    expect(r.project.issues).toEqual([
      "package.json @types/bun: types are for 1.3.9 but the runtime is 1.4.6; APIs may be missing from or extra in the types",
    ]);
  });

  test("accepts @types/bun with the same minor version as the runtime", async () => {
    await fakeBun("1.4.6");
    await seedReleases(["1.4.6"]);
    await put(join(project, "package.json"), JSON.stringify({ devDependencies: { "@types/bun": "^1.4.0" } }));
    await put(join(project, "node_modules", "@types", "bun", "package.json"), JSON.stringify({ version: "1.4.2" }));
    expect((await report()).project.issues).toEqual([]);
  });

  test("warns that an unversioned setup-bun in CI tracks latest while the local Bun is outdated", async () => {
    await fakeBun("1.4.4");
    await seedReleases(["1.4.5", "1.4.4"], { "1.4.5": null });
    await put(
      join(project, ".github", "workflows", "ci.yml"),
      "jobs:\n  test:\n    steps:\n      - uses: oven-sh/setup-bun@v2\n      - run: bun test\n",
    );
    await put(join(project, ".github", "workflows", "notes.txt"), "setup-bun");
    const r = await report();
    expect(r.project.pins).toEqual([
      {
        source: join(".github", "workflows", "ci.yml"),
        value: "setup-bun (no bun-version → latest)",
        version: null,
        kind: "ci",
      },
    ]);
    expect(r.project.issues).toEqual([
      ".github/workflows/ci.yml: setup-bun (no bun-version → latest) resolves to 1.4.5, but local Bun is 1.4.4; CI and local may behave differently",
    ]);
  });

  test("does not warn about an unversioned setup-bun when the local Bun is current", async () => {
    await fakeBun("1.4.5");
    await seedReleases(["1.4.5", "1.4.4"]);
    await put(join(project, ".github", "workflows", "ci.yaml"), "steps:\n  - uses: oven-sh/setup-bun@v2\n");
    const r = await report();
    expect(r.project.pins).toHaveLength(1);
    expect(r.project.issues).toEqual([]);
  });

  test("reads a Dockerfile once even where the filesystem also resolves `dockerfile` to it", async () => {
    await fakeBun("1.4.6");
    await seedReleases(["1.4.6", "1.4.5"]);
    await put(join(project, "Dockerfile"), "FROM oven/bun:1.4.5\n");
    const caseInsensitive =
      (await readdir(project)).length === 1 && (await Bun.file(join(project, "dockerfile")).exists());
    const r = await report();
    const containerPins = r.project.pins.filter((p) => p.kind === "container");
    expect(containerPins).toHaveLength(1);
    expect(r.project.issues).toHaveLength(1);
    // On case-sensitive filesystems there is nothing to deduplicate; the assertion above still holds.
    if (caseInsensitive) expect(containerPins[0]!.value).toBe("oven/bun:1.4.5");
  });

  test("never touches the network when the cache is fresh", async () => {
    await fakeBun("1.4.4");
    await seedReleases(["1.4.5", "1.4.4"], { "1.4.5": "cached" });
    const before = (await readdir(cacheDir)).sort();
    const { exitCode, stderr } = await versionCheck();
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect((await readdir(cacheDir)).sort()).toEqual(before);
  });
});

describe("bun-docs.ts", () => {
  const LLMS_TXT = [
    "# Bun",
    "",
    "## Docs",
    "",
    "- [Install](https://bun.com/docs/installation.md): Install Bun with curl, npm or Homebrew",
    "- [Test runner](https://bun.com/docs/test.md): Run tests with bun test, a Jest-compatible runner",
    "- [Mocks](https://bun.com/docs/test/mocks.md): Mock functions and modules in tests",
    "- [Bun.serve](https://bun.com/docs/api/http.md): Start an HTTP server",
    "- [YAML](https://bun.com/docs/api/yaml.md)",
    "",
  ].join("\n");

  const LLMS_FULL = [
    "# Test runner",
    "Bun ships with a fast test runner.",
    "Use spyOn to watch calls.",
    "# HTTP server",
    "Bun.serve starts a server.",
    "Call server.stop() to close it.",
    "",
  ].join("\n");

  beforeEach(async () => {
    await put(join(cacheDir, "llms.txt"), LLMS_TXT);
    await put(join(cacheDir, "llms-full.txt"), LLMS_FULL);
  });

  test("search ranks entries whose title matches above entries that only mention the term", async () => {
    const { stdout, exitCode } = await run(DOCS, ["search", "test"]);
    expect(exitCode).toBe(0);
    const lines = stdout.split("\n").filter((l) => l.startsWith("- "));
    expect(lines[0]).toBe("- Test runner: https://bun.com/docs/test.md");
    expect(lines.slice(1)).toContain("- Mocks: https://bun.com/docs/test/mocks.md");
    expect(stdout).toContain("    Run tests with bun test, a Jest-compatible runner");
    expect(stdout).not.toContain("Install");
  });

  test("search matches case-insensitively and prints entries that have no description", async () => {
    const { stdout } = await run(DOCS, ["search", "yaml"]);
    expect(stdout.trim()).toBe("- YAML: https://bun.com/docs/api/yaml.md");
  });

  test('search prints "No matches" when nothing in llms.txt matches', async () => {
    const { stdout, exitCode } = await run(DOCS, ["search", "kubernetes"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("No matches in llms.txt");
  });

  test("grep prints each hit with the heading of the page it is on", async () => {
    const { stdout, exitCode } = await run(DOCS, ["grep", "server"]);
    expect(exitCode).toBe(0);
    expect(stdout.trim().split("\n")).toEqual([
      "[HTTP server] # HTTP server",
      "[HTTP server] Bun.serve starts a server.",
      "[HTTP server] Call server.stop() to close it.",
    ]);
  });

  test("grep treats the pattern as a case-insensitive regex", async () => {
    const { stdout } = await run(DOCS, ["grep", "SPYON|fast"]);
    expect(stdout.trim().split("\n")).toEqual([
      "[Test runner] Bun ships with a fast test runner.",
      "[Test runner] Use spyOn to watch calls.",
    ]);
  });

  test('grep prints "No matches." when the pattern is not found', async () => {
    const { stdout } = await run(DOCS, ["grep", "kubernetes"]);
    expect(stdout.trim()).toBe("No matches.");
  });

  test("an unknown command exits 2 with usage on stderr", async () => {
    const { stdout, stderr, exitCode } = await run(DOCS, ["frobnicate"]);
    expect(exitCode).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("usage: bun-docs.ts");
  });

  test("no command at all exits 2 with usage", async () => {
    const { stderr, exitCode } = await run(DOCS, []);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("usage:");
  });
});
