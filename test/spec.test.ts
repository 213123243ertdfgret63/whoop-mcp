import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SPEC_PATH = join(ROOT, "openapi", "whoop.yaml");
const TYPES_PATH = join(ROOT, "src", "whoop", "openapi.d.ts");

type Spec = { paths: Record<string, Record<string, unknown>> };
const spec = Bun.YAML.parse(readFileSync(SPEC_PATH, "utf8")) as Spec;
const specPaths = Object.keys(spec.paths);

const CONSUMER_PATHS = [
  "/v2/cycle",
  "/v2/cycle/{cycleId}",
  "/v2/recovery",
  "/v2/activity/sleep",
  "/v2/activity/workout",
  "/v2/user/profile/basic",
  "/v2/user/measurement/body",
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.ts$/.test(name) && !name.endsWith(".d.ts") ? [path] : [];
  });
}

/**
 * Every "/v2/..." string or template literal in src/ (comments are excluded because they are not quoted).
 * Template substitutions become a placeholder so they can match a spec path template like {cycleId}.
 */
function pathsCalledByCode(): string[] {
  const found = new Set<string>();
  for (const file of sourceFiles(join(ROOT, "src"))) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/(["'`])(\/v2\/[^"'`?\s]*)/g)) {
      found.add(m[2]!.replace(/\$\{[^}]*\}/g, "{param}"));
    }
  }
  return [...found].sort();
}

/** Finds the spec path a concrete or templated code path refers to. */
function matchSpecPath(codePath: string): string | undefined {
  const segments = codePath.split("/");
  return specPaths.find((p) => {
    const specSegments = p.split("/");
    return (
      specSegments.length === segments.length &&
      specSegments.every((s, i) => s === segments[i] || (/^\{.+\}$/.test(s) && /^\{.+\}$/.test(segments[i]!)))
    );
  });
}

describe("openapi/whoop.yaml", () => {
  test("has a paths object", () => {
    expect(specPaths.length).toBeGreaterThan(0);
  });

  test("contains no Trusted Partner paths", () => {
    expect(specPaths.filter((p) => p.includes("/partner/"))).toEqual([]);
  });

  test.each(CONSUMER_PATHS)("contains the consumer path %s as a GET", (path) => {
    expect(spec.paths[path]).toBeDefined();
    expect(spec.paths[path]!.get).toBeDefined();
  });

  test("finds at least one /v2/ path the server code calls", () => {
    // Guards the contract test below against a regex that silently matches nothing.
    expect(pathsCalledByCode()).toContain("/v2/user/profile/basic");
  });

  test("every /v2/ path the server code calls exists in the spec as a GET", () => {
    const missing = pathsCalledByCode().filter((p) => {
      const specPath = matchSpecPath(p);
      return !specPath || !spec.paths[specPath]!.get;
    });
    expect(missing).toEqual([]);
  });
});

describe("generated src/whoop/openapi.d.ts", () => {
  test("exists (bun run gen:types produces it on install)", () => {
    expect(existsSync(TYPES_PATH)).toBe(true);
  });

  test("declares every consumer path and every path the code calls", () => {
    const types = readFileSync(TYPES_PATH, "utf8");
    const wanted = new Set([...CONSUMER_PATHS, ...pathsCalledByCode().map((p) => matchSpecPath(p) ?? p)]);
    const missing = [...wanted].filter((p) => !types.includes(`"${p}"`));
    expect(missing).toEqual([]);
  });

  test("contains no Trusted Partner paths", () => {
    expect(readFileSync(TYPES_PATH, "utf8")).not.toContain("/partner/");
  });
});
