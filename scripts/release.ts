#!/usr/bin/env bun
import { join } from "node:path";
/**
 * Cuts a release:  bun run release <patch|minor|major|x.y.z> [--push] [--dry-run]
 *
 * 1. Requires a clean `main` that matches `origin/main`.
 * 2. Runs lint, typecheck and tests.
 * 3. Bumps package.json and prepends CHANGELOG.md with the commits since the last tag.
 * 4. Commits "Release vX.Y.Z" and creates the annotated tag vX.Y.Z.
 * 5. With --push, pushes both atomically; the tag triggers .github/workflows/release.yml (binaries + GitHub release).
 *
 * If anything fails after files were written, the commit/tag are rolled back so a re-run starts clean.
 */
import { $ } from "bun";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export function nextVersion(current: string, bump: string): string {
  const m = current.match(SEMVER);
  if (!m) throw new Error(`package.json version "${current}" is not plain x.y.z semver`);
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  if (bump === "patch") return `${major}.${minor}.${patch + 1}`;
  const explicit = bump.replace(/^v/, "");
  if (!SEMVER.test(explicit)) throw new Error(`Expected patch, minor, major or x.y.z, got "${bump}"`);
  const parts = (v: string) => v.split(".").map(Number) as [number, number, number];
  const [a, b] = [parts(explicit), parts(current)];
  const cmp = a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  if (cmp <= 0) throw new Error(`New version ${explicit} must be greater than ${current}`);
  return explicit;
}

/** Keeps a subject like "# Foo" or "1. Foo" from turning into a heading or nested list inside its bullet. */
function escapeLeadingMarkdown(subject: string): string {
  return subject.replace(/^(\d+)\./, "$1\\.").replace(/^(#|[-*+] )/, "\\$1");
}

/** `- subject (abc1234)` lines, skipping earlier release commits. */
export function changelogSection(version: string, date: string, commits: { hash: string; subject: string }[]): string {
  const lines = commits
    .filter((c) => !/^Release v\d/.test(c.subject))
    .map((c) => `- ${escapeLeadingMarkdown(c.subject)} (${c.hash})`);
  return `## v${version} (${date})\n\n${lines.length ? lines.join("\n") : "- No changes recorded"}\n`;
}

export function prependChangelog(existing: string | null, section: string): string {
  const header = "# Changelog\n";
  const body = (existing ?? header).replace(/^# Changelog\n+/, "");
  return `${header}\n${section}${body ? `\n${body}` : ""}`;
}

/** Extracts one version's section (used by the release workflow for the GitHub release notes). */
export function releaseNotes(changelog: string, version: string): string | null {
  const start = changelog.indexOf(`## v${version} `);
  if (start === -1) return null;
  const next = changelog.indexOf("\n## v", start + 1);
  return changelog
    .slice(start, next === -1 ? undefined : next)
    .replace(/^## .*\n+/, "")
    .trim();
}

/** Rewrites only the "version" field, keeping the rest of package.json byte-for-byte. */
export function setPackageVersion(pkgText: string, version: string): string {
  const updated = pkgText.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
  if (updated === pkgText) throw new Error('No "version" field found in package.json');
  return updated;
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  const bump = args.find((a) => !a.startsWith("--"));
  const push = args.includes("--push");
  const dryRun = args.includes("--dry-run");
  if (!bump) throw new Error("Usage: bun run release <patch|minor|major|x.y.z> [--push] [--dry-run]");

  const root = join(import.meta.dir, "..");
  $.cwd(root);

  const branch = (await $`git rev-parse --abbrev-ref HEAD`.text()).trim();
  if (branch !== "main") throw new Error(`Releases are cut from main (on ${branch}).`);
  if ((await $`git status --porcelain`.text()).trim()) throw new Error("Working tree is not clean.");
  await $`git fetch --quiet origin main`;
  const [head, remote] = await Promise.all([$`git rev-parse HEAD`.text(), $`git rev-parse origin/main`.text()]);
  if (head.trim() !== remote.trim()) throw new Error("main is not in sync with origin/main; pull or push first.");

  const pkgPath = join(root, "package.json");
  const pkgText = await Bun.file(pkgPath).text();
  const current = (JSON.parse(pkgText) as { version: string }).version;
  const version = nextVersion(current, bump);
  const tag = `v${version}`;
  if ((await $`git tag --list ${tag}`.text()).trim()) throw new Error(`Tag ${tag} already exists.`);
  // `git fetch origin main` only follows tags inside main's history, so ask the remote directly too.
  if ((await $`git ls-remote --tags origin ${`refs/tags/${tag}`}`.text()).trim())
    throw new Error(`Tag ${tag} already exists on origin.`);

  // Interpolated so Bun's shell passes the pattern to git instead of globbing it against files.
  const lastTag = (await $`git describe --tags --abbrev=0 --match ${"v*"}`.nothrow().quiet().text()).trim();
  const range = lastTag ? `${lastTag}..HEAD` : "HEAD";
  const log = (await $`git log ${range} --format=%h%x09%s`.text()).trim();
  const commits = log
    ? log.split("\n").map((line) => {
        const [hash = "", ...subject] = line.split("\t");
        return { hash, subject: subject.join("\t") };
      })
    : [];
  const section = changelogSection(version, new Date().toISOString().slice(0, 10), commits);

  console.error(`Releasing ${current} → ${version} (${commits.length} commit(s) since ${lastTag || "the start"})\n`);
  console.error(section);
  if (dryRun) {
    console.error("Dry run: nothing written.");
    return;
  }

  console.error("Running checks…");
  await $`bun run lint`;
  await $`bun run typecheck`;
  await $`bun test`;

  const changelogPath = join(root, "CHANGELOG.md");
  const changelogFile = Bun.file(changelogPath);
  const startHead = head.trim();
  try {
    await Bun.write(
      changelogPath,
      prependChangelog((await changelogFile.exists()) ? await changelogFile.text() : null, section),
    );
    await Bun.write(pkgPath, setPackageVersion(pkgText, version));
    // Format here rather than relying on the pre-commit hook (which may be disabled), so the tagged
    // commit always passes `biome ci` in the release workflow.
    await $`bunx biome format --write CHANGELOG.md package.json`.quiet();

    await $`git add package.json CHANGELOG.md`;
    await $`git commit --quiet -m ${`Release ${tag}`}`;
    await $`git tag -a ${tag} -m ${`Release ${tag}`}`;
  } catch (err) {
    await $`git tag -d ${tag}`.nothrow().quiet();
    await $`git reset --quiet --hard ${startHead}`.nothrow();
    throw new Error(`Release aborted and rolled back to ${startHead.slice(0, 7)}: ${describe(err)}`);
  }
  console.error(`\nCreated commit and tag ${tag}.`);

  // --atomic: either main and the tag both land, or neither does (no release from a tag that isn't on main).
  const pushCommand = `git push --atomic origin main ${tag}`;
  if (push) {
    const result = await $`git push --quiet --atomic origin main ${tag}`.nothrow();
    if (result.exitCode !== 0) {
      throw new Error(
        `Push failed; nothing was published. Local commit and tag ${tag} are kept.\n` +
          `Fix the cause (e.g. pull new commits: git tag -d ${tag} && git reset --hard origin/main, then release again), or retry: ${pushCommand}`,
      );
    }
    console.error(`Pushed. The release workflow will publish binaries for ${tag}.`);
  } else {
    console.error(`Push when ready:  ${pushCommand}`);
  }
}

/** Bun shell errors carry the failing command's stderr; surface it instead of just "exit code 1". */
function describe(err: unknown): string {
  if (err instanceof $.ShellError) return `${err.message}\n${err.stderr.toString().trim()}`;
  return err instanceof Error ? err.message : String(err);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(describe(err));
    process.exit(1);
  });
}
