import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import {
  changelogSection,
  nextVersion,
  prependChangelog,
  releaseNotes,
  setPackageVersion,
} from "../scripts/release.ts";

describe("nextVersion", () => {
  test("bumps patch, minor and major like npm", () => {
    expect(nextVersion("1.2.3", "patch")).toBe("1.2.4");
    expect(nextVersion("1.2.3", "minor")).toBe("1.3.0");
    expect(nextVersion("1.2.3", "major")).toBe("2.0.0");
  });

  test("accepts an explicit higher version, with or without a leading v", () => {
    expect(nextVersion("0.0.1", "0.1.0")).toBe("0.1.0");
    expect(nextVersion("0.0.1", "v1.0.0")).toBe("1.0.0");
  });

  test("rejects an explicit version that isn't higher", () => {
    expect(() => nextVersion("1.2.3", "1.2.3")).toThrow(/greater than/);
    expect(() => nextVersion("1.2.3", "1.2.0")).toThrow(/greater than/);
    expect(() => nextVersion("1.10.0", "1.9.9")).toThrow(/greater than/);
  });

  test("rejects unknown bumps and non-semver current versions", () => {
    expect(() => nextVersion("1.2.3", "huge")).toThrow(/patch, minor, major/);
    expect(() => nextVersion("1.2", "patch")).toThrow(/semver/);
  });
});

describe("changelog", () => {
  const commits = [
    { hash: "abc1234", subject: "Add whoop_today tool" },
    { hash: "def5678", subject: "Release v0.1.0" },
    { hash: "0a1b2c3", subject: "Fix refresh race" },
  ];

  test("a section lists commits and leaves out earlier release commits", () => {
    expect(changelogSection("0.2.0", "2026-10-27", commits)).toBe(
      "## v0.2.0 (2026-10-27)\n\n- Add whoop_today tool (abc1234)\n- Fix refresh race (0a1b2c3)\n",
    );
  });

  test("an empty range still produces a valid section", () => {
    expect(changelogSection("0.2.0", "2026-10-27", [])).toContain("- No changes recorded");
  });

  test("creates CHANGELOG.md with a header, then prepends newer sections above older ones", () => {
    const first = prependChangelog(null, changelogSection("0.1.0", "2026-10-01", [commits[0]!]));
    expect(first.startsWith("# Changelog\n\n## v0.1.0")).toBe(true);
    const second = prependChangelog(first, changelogSection("0.2.0", "2026-10-27", [commits[2]!]));
    expect(second.indexOf("## v0.2.0")).toBeLessThan(second.indexOf("## v0.1.0"));
    expect(second.match(/# Changelog/g)).toHaveLength(1);
  });

  test("releaseNotes extracts exactly one version's section", () => {
    const log = prependChangelog(
      prependChangelog(null, changelogSection("0.1.0", "2026-10-01", [commits[0]!])),
      changelogSection("0.2.0", "2026-10-27", [commits[2]!]),
    );
    expect(releaseNotes(log, "0.2.0")).toBe("- Fix refresh race (0a1b2c3)");
    expect(releaseNotes(log, "0.1.0")).toBe("- Add whoop_today tool (abc1234)");
    expect(releaseNotes(log, "0.3.0")).toBeNull();
  });

  test("releaseNotes does not confuse 0.1.0 with 0.1.01-style prefixes", () => {
    const log = "# Changelog\n\n## v0.1.10 (d)\n\n- ten\n\n## v0.1.1 (d)\n\n- one\n";
    expect(releaseNotes(log, "0.1.1")).toBe("- one");
  });
});

describe("setPackageVersion", () => {
  test("changes only the version field and keeps formatting", () => {
    const text = '{\n  "name": "whoop-mcp",\n  "version": "0.0.1",\n  "dependencies": { "x": "1.0.0" }\n}\n';
    expect(setPackageVersion(text, "0.1.0")).toBe(text.replace('"0.0.1"', '"0.1.0"'));
  });

  test("throws when there is no version field", () => {
    expect(() => setPackageVersion('{ "name": "x" }', "1.0.0")).toThrow(/version/);
  });
});

describe("release script guards", () => {
  const SCRIPT = join(import.meta.dir, "..", "scripts", "release.ts");
  let dir: string;
  let repo: string;

  // Per-command cwd: `$.cwd()` would change the default directory for every `$` in this process.
  const git =
    (cwd: string) =>
    (strings: TemplateStringsArray, ...values: unknown[]) =>
      $(strings, ...(values as string[])).cwd(cwd);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "whoop-release-test-"));
    const remote = join(dir, "remote.git");
    repo = join(dir, "repo");
    await $`git init --quiet --bare --initial-branch=main ${remote}`.quiet();
    await $`git init --quiet --initial-branch=main ${repo}`.quiet();
    // The script resolves the repo from its own location, so run a copy that lives inside the temp repo.
    await $`mkdir -p ${join(repo, "scripts")}`.quiet();
    await Bun.write(join(repo, "scripts", "release.ts"), Bun.file(SCRIPT));
    await Bun.write(join(repo, "package.json"), '{\n  "name": "t",\n  "version": "0.1.0"\n}\n');
    const g = git(repo);
    await g`git -c user.email=t@t -c user.name=t add -A`.quiet();
    await g`git -c user.email=t@t -c user.name=t commit --quiet -m init`.quiet();
    await g`git remote add origin ${remote}`.quiet();
    await g`git push --quiet origin main`.quiet();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const release = (...args: string[]) =>
    $`${process.execPath} ${join(repo, "scripts", "release.ts")} ${args}`.cwd(repo).nothrow().quiet();

  test("dry run prints the next version and changelog without writing anything", async () => {
    const result = await release("minor", "--dry-run");
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toContain("0.1.0 → 0.2.0");
    expect(result.stderr.toString()).toContain("- init");
    expect(await Bun.file(join(repo, "CHANGELOG.md")).exists()).toBe(false);
    expect((await git(repo)`git tag`.text()).trim()).toBe("");
  });

  test("refuses to release from a dirty working tree", async () => {
    await Bun.write(join(repo, "dirty.txt"), "x");
    const result = await release("patch", "--dry-run");
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("not clean");
  });

  test("refuses to release from a branch other than main", async () => {
    await git(repo)`git checkout --quiet -b feature`.quiet();
    const result = await release("patch", "--dry-run");
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("from main");
  });

  test("refuses when main has commits that aren't on origin", async () => {
    await git(repo)`git -c user.email=t@t -c user.name=t commit --quiet --allow-empty -m local`.quiet();
    const result = await release("patch", "--dry-run");
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("not in sync");
  });

  test("refuses when the tag already exists", async () => {
    await git(repo)`git tag v0.1.1`.quiet();
    const result = await release("patch", "--dry-run");
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("already exists");
  });

  test("refuses when the tag exists only on origin (on a commit outside main)", async () => {
    const g = git(repo);
    await g`git checkout --quiet -b side`.quiet();
    await g`git -c user.email=t@t -c user.name=t commit --quiet --allow-empty -m side`.quiet();
    await g`git tag v0.1.1`.quiet();
    await g`git push --quiet origin v0.1.1`.quiet();
    await g`git tag -d v0.1.1`.quiet();
    await g`git checkout --quiet main`.quiet();
    await g`git branch --quiet -D side`.quiet();
    const result = await release("patch", "--dry-run");
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("already exists on origin");
  });

  test("lists only the commits since the last release tag", async () => {
    const g = git(repo);
    await g`git tag v0.1.0`.quiet();
    await g`git -c user.email=t@t -c user.name=t commit --quiet --allow-empty -m ${"Add trends tool"}`.quiet();
    await g`git push --quiet origin main`.quiet();
    const out = (await release("minor", "--dry-run")).stderr.toString();
    expect(out).toContain("- Add trends tool");
    expect(out).not.toContain("- init");
    expect(out).toContain("since v0.1.0");
  });
});
