#!/usr/bin/env bun
/**
 * Reports whether the installed Bun is outdated and whether the project's Bun pins agree with it.
 *
 *   bun .claude/skills/bun/scripts/bun-version-check.ts [--cwd <project>] [--json] [--refresh]
 *
 * Network results (latest release, release-note summaries) are cached for 6h in ~/.cache/bun-skill.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    cwd: { type: "string", default: process.cwd() },
    json: { type: "boolean", default: false },
    refresh: { type: "boolean", default: false },
  },
});
const cwd = values.cwd!;
const CACHE_DIR = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "bun-skill");
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

type Version = [number, number, number];

function parseVersion(v: string): Version | null {
  const m = v.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compare(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const file = join(CACHE_DIR, `${key}.json`);
  const f = Bun.file(file);
  if (!values.refresh && (await f.exists()) && Date.now() - f.lastModified < CACHE_TTL_MS) {
    return (await f.json()) as T;
  }
  const value = await load();
  await mkdir(CACHE_DIR, { recursive: true });
  await Bun.write(file, JSON.stringify(value));
  return value;
}

// --- Installed Bun ---------------------------------------------------------

function installed() {
  // The script runs under the Bun it is checking, unless invoked via a different binary than `bun` on PATH.
  const which = Bun.which("bun");
  const pathVersion = which ? Bun.spawnSync([which, "--version"]).stdout.toString().trim() : null;
  const revision = which ? Bun.spawnSync([which, "--revision"]).stdout.toString().trim() : null;
  const binPath = which ?? process.execPath;
  const p = binPath.toLowerCase();
  const method =
    p.includes("/homebrew/") || p.includes("/cellar/") || p.includes("linuxbrew")
      ? "homebrew"
      : p.includes("/.bun/bin/")
        ? "install-script"
        : p.includes("/mise/")
          ? "mise"
          : p.includes("/.asdf/")
            ? "asdf"
            : p.includes("/.proto/")
              ? "proto"
              : p.includes("node_modules") || p.includes("/npm/") || p.includes("/.npm")
                ? "npm"
                : p.includes("scoop")
                  ? "scoop"
                  : "unknown";
  return {
    version: pathVersion || Bun.version,
    revision,
    path: binPath,
    method,
    canary: /canary/.test(revision || pathVersion || ""),
  };
}

const UPGRADE_COMMAND: Record<string, string> = {
  homebrew: "brew upgrade bun   # not `bun upgrade`: Homebrew owns this binary",
  "install-script": "bun upgrade",
  mise: "mise use -g bun@latest   # or bump the version in mise.toml",
  asdf: "asdf install bun latest && asdf global bun latest",
  proto: "proto install bun latest --pin",
  npm: "npm install -g bun@latest",
  scoop: "scoop update bun",
  unknown: "bun upgrade   # check how Bun was installed first",
};

// --- Latest release + what changed -----------------------------------------

interface Release {
  version: string;
  date: string;
}

async function releases(): Promise<Release[]> {
  return cached("releases", async () => {
    try {
      const res = await fetch("https://api.github.com/repos/oven-sh/bun/releases?per_page=30", {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "bun-skill" },
      });
      if (!res.ok) throw new Error(`GitHub ${res.status}`);
      const list = (await res.json()) as {
        tag_name: string;
        published_at: string;
        prerelease: boolean;
        draft: boolean;
      }[];
      return list
        .filter((r) => !r.prerelease && !r.draft && r.tag_name.startsWith("bun-v"))
        .map((r) => ({ version: r.tag_name.slice("bun-v".length), date: r.published_at.slice(0, 10) }));
    } catch {
      // GitHub's unauthenticated rate limit is 60/h; the npm registry is a fine fallback for "latest".
      const res = await fetch("https://registry.npmjs.org/bun/latest");
      const { version } = (await res.json()) as { version: string };
      return [{ version, date: "unknown" }];
    }
  });
}

async function releaseSummary(version: string): Promise<string | null> {
  return cached(`notes-${version}`, async () => {
    const res = await fetch(`https://bun.com/blog/bun-v${version}.md`);
    if (!res.ok) return null;
    const text = await res.text();
    const m = text.match(/^description:\s*"?(.*?)"?\s*$/m);
    return m?.[1] ?? null;
  });
}

// --- Project pins ----------------------------------------------------------

interface Pin {
  source: string;
  value: string;
  /** The lowest version this pin allows, or the exact version it pins. */
  version: Version | null;
  kind: "runtime" | "types" | "ci" | "container";
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** The Bun version a setup-bun `bun-version-file` points at (.bun-version, .tool-versions or package.json). */
function versionFromFile(path: string): string | null {
  const text = readText(path);
  if (!text) return null;
  if (path.endsWith("package.json")) {
    const pkg = JSON.parse(text) as { packageManager?: string; engines?: Record<string, string> };
    return pkg.packageManager?.startsWith("bun@") ? pkg.packageManager.slice(4) : (pkg.engines?.bun ?? null);
  }
  if (path.endsWith(".tool-versions")) return text.match(/^bun\s+(\S+)/m)?.[1] ?? null;
  return text.trim() || null;
}

function projectPins(): Pin[] {
  const pins: Pin[] = [];
  const add = (source: string, value: string, kind: Pin["kind"]) =>
    pins.push({ source: relative(cwd, source) || source, value, version: parseVersion(value), kind });

  const pkgPath = join(cwd, "package.json");
  const pkgText = readText(pkgPath);
  if (pkgText) {
    const pkg = JSON.parse(pkgText) as {
      engines?: Record<string, string>;
      packageManager?: string;
      devDependencies?: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    if (pkg.engines?.bun) add(`${pkgPath} engines.bun`, pkg.engines.bun, "runtime");
    if (pkg.packageManager?.startsWith("bun@")) add(`${pkgPath} packageManager`, pkg.packageManager, "runtime");
    for (const dep of ["@types/bun", "bun-types"]) {
      const v = pkg.devDependencies?.[dep] ?? pkg.dependencies?.[dep];
      if (v) {
        // Resolve the installed types version too: a "latest" range says nothing on its own.
        const installedPkg = readText(join(cwd, "node_modules", dep, "package.json"));
        const resolved = installedPkg ? (JSON.parse(installedPkg) as { version: string }).version : null;
        add(`${pkgPath} ${dep}`, resolved ? `${v} (installed ${resolved})` : v, "types");
        if (resolved) pins[pins.length - 1]!.version = parseVersion(resolved);
      }
    }
  }

  const bunVersionFile = readText(join(cwd, ".bun-version"));
  if (bunVersionFile) add(join(cwd, ".bun-version"), bunVersionFile.trim(), "runtime");

  const toolVersions = readText(join(cwd, ".tool-versions"));
  const tv = toolVersions?.match(/^bun\s+(\S+)/m);
  if (tv) add(join(cwd, ".tool-versions"), tv[1]!, "runtime");

  for (const mise of ["mise.toml", ".mise.toml"]) {
    const m = readText(join(cwd, mise))?.match(/^\s*bun\s*=\s*"([^"]+)"/m);
    if (m) add(join(cwd, mise), m[1]!, "runtime");
  }

  // Case-insensitive filesystems (macOS) resolve Dockerfile and dockerfile to the same file.
  const seen = new Set<string>();
  for (const file of ["Dockerfile", "dockerfile", "Containerfile"]) {
    const path = join(cwd, file);
    if (!existsSync(path) || seen.has(realpathSync.native(path))) continue;
    seen.add(realpathSync.native(path));
    const text = readText(path);
    for (const m of text?.matchAll(/^FROM\s+(?:docker\.io\/)?oven\/bun:(\S+)/gim) ?? [])
      add(join(cwd, file), `oven/bun:${m[1]}`, "container");
  }

  const wfDir = join(cwd, ".github", "workflows");
  if (existsSync(wfDir)) {
    for (const f of readdirSync(wfDir).filter((n) => /\.ya?ml$/.test(n))) {
      const text = readText(join(wfDir, f)) ?? "";
      if (!text.includes("setup-bun")) continue;
      const m = text.match(/bun-version:\s*['"]?([^'"\s#]+)/);
      const fileRef = text.match(/bun-version-file:\s*['"]?([^'"\s#]+)/)?.[1];
      if (m) add(join(wfDir, f), `setup-bun bun-version: ${m[1]}`, "ci");
      else if (fileRef) {
        // setup-bun reads the version from a file; resolve it so CI is compared like any other pin.
        const resolved = versionFromFile(join(cwd, fileRef));
        add(join(wfDir, f), `setup-bun bun-version: ${resolved ?? "?"} (from ${fileRef})`, "ci");
      } else add(join(wfDir, f), "setup-bun (no bun-version → latest)", "ci");
    }
  }
  return pins;
}

// --- Report ----------------------------------------------------------------

const inst = installed();
const all = await releases();
const latest = all[0]!;
const iv = parseVersion(inst.version);
const lv = parseVersion(latest.version)!;
const behind = iv ? all.filter((r) => compare(parseVersion(r.version)!, iv) > 0) : [];
const status = !iv
  ? "unknown"
  : compare(iv, lv) >= 0
    ? compare(iv, lv) > 0 || inst.canary
      ? "ahead"
      : "current"
    : "outdated";

const missed = await Promise.all(
  behind.slice(0, 8).map(async (r) => ({
    ...r,
    notes: `https://bun.com/blog/bun-v${r.version}`,
    summary: await releaseSummary(r.version),
  })),
);

/** An exact pin (bun@1.3.0, oven/bun:1.3.0-alpine, 1.3.0) as opposed to a range (^1.3.0, >=1.3, latest). */
const isExactPin = (value: string) =>
  /^(bun@|oven\/bun:|setup-bun bun-version: )?v?\d+\.\d+\.\d+(-[a-z]+)?( \(from [^)]+\))?$/i.test(value);

const pins = projectPins();
const pinIssues = pins.flatMap((p) => {
  if (!iv) return [];
  if (!p.version) {
    // An unversioned setup-bun or oven/bun:latest follows the newest release, unlike an outdated local install.
    if ((p.kind === "ci" || p.kind === "container") && status === "outdated")
      return [
        `${p.source}: ${p.value} resolves to ${latest.version}, but local Bun is ${inst.version}; CI and local may behave differently`,
      ];
    return [];
  }
  if (p.kind === "types") {
    return p.version[0] !== iv[0] || p.version[1] !== iv[1]
      ? [
          `${p.source}: types are for ${p.version.join(".")} but the runtime is ${inst.version}; APIs may be missing from or extra in the types`,
        ]
      : [];
  }
  if (compare(p.version, iv) > 0) return [`${p.source}: requires ${p.value} but the installed Bun is ${inst.version}`];
  if (isExactPin(p.value) && compare(p.version, lv) < 0)
    return [`${p.source}: pins ${p.value}, older than the latest ${latest.version}`];
  return [];
});

const report = {
  installed: inst,
  latest,
  status,
  versions_behind: behind.length,
  upgrade_command: status === "outdated" ? UPGRADE_COMMAND[inst.method] : null,
  missed_releases: missed,
  project: { cwd, pins, issues: pinIssues },
};

if (values.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const lines = [
    `Installed: Bun ${inst.version}${inst.canary ? " (canary)" : ""} at ${inst.path} [${inst.method}]`,
    `Latest stable: ${latest.version} (${latest.date})`,
    `Status: ${status.toUpperCase()}${status === "outdated" ? `, ${behind.length} release(s) behind` : ""}`,
  ];
  if (report.upgrade_command) lines.push(`Upgrade: ${report.upgrade_command}`);
  if (missed.length) {
    lines.push("", "Missed releases (newest first):");
    for (const r of missed)
      lines.push(
        `- ${r.version} (${r.date}) ${r.notes}${r.summary ? `\n    ${r.summary.slice(0, 400)}${r.summary.length > 400 ? "…" : ""}` : ""}`,
      );
    if (behind.length > missed.length) lines.push(`- …and ${behind.length - missed.length} older`);
  }
  lines.push("", `Project pins in ${cwd}:`);
  if (pins.length === 0) lines.push("- none found");
  for (const p of pins) lines.push(`- [${p.kind}] ${p.source}: ${p.value}`);
  if (pinIssues.length) lines.push("", "Pin issues:", ...pinIssues.map((i) => `- ${i}`));
  console.log(lines.join("\n"));
}
