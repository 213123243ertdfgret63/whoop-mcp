#!/usr/bin/env bun
/**
 * Refreshes openapi/whoop.yaml from WHOOP's published spec, without the Trusted Partner endpoints.
 * The YAML is the source of truth for `bun run gen:types`; review upstream changes with `git diff openapi/`.
 */
import { join } from "node:path";
import { WHOOP } from "../src/config.ts";

const res = await fetch(WHOOP.openapiUrl);
if (!res.ok) throw new Error(`${WHOOP.openapiUrl} returned ${res.status}`);
const spec = (await res.json()) as { paths: Record<string, unknown> };

const dropped = Object.keys(spec.paths).filter((p) => p.includes("/partner/"));
for (const p of dropped) delete spec.paths[p];

// WHOOP serves some maps (e.g. schema properties) in varying order between requests. Sorting the
// name-keyed maps, while leaving structural keys in spec order, keeps `git diff openapi/` meaningful.
const NAME_KEYED = new Set(["paths", "schemas", "properties", "responses"]);
function canonicalize(value: unknown, sortKeys = false): unknown {
  if (Array.isArray(value)) return value.map((v) => canonicalize(v));
  if (value === null || typeof value !== "object") return value;
  const entries = Object.entries(value);
  if (sortKeys) entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(entries.map(([k, v]) => [k, canonicalize(v, NAME_KEYED.has(k))]));
}

const out = join(import.meta.dir, "..", "openapi", "whoop.yaml");
const header = [
  `# WHOOP Developer API spec, from ${WHOOP.openapiUrl}`,
  `# Trusted Partner paths removed (${dropped.length}). Regenerate with \`bun run spec:update\`, then \`bun run gen:types\`.`,
  "",
].join("\n");
await Bun.write(out, `${header}${Bun.YAML.stringify(canonicalize(spec), null, 2)}\n`);
// Format like the pre-commit hook does, so an unchanged upstream spec produces no diff.
const fmt = Bun.spawnSync(["bunx", "biome", "format", "--write", out], { stderr: "inherit" });
if (fmt.exitCode !== 0) throw new Error("biome format failed");
console.error(`Wrote ${out} (${Object.keys(spec.paths).length} paths, ${dropped.length} partner paths dropped).`);
