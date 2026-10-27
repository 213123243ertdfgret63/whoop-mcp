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

const out = join(import.meta.dir, "..", "openapi", "whoop.yaml");
const header = [
  `# WHOOP Developer API spec, from ${WHOOP.openapiUrl}`,
  `# Trusted Partner paths removed (${dropped.length}). Regenerate with \`bun run spec:update\`, then \`bun run gen:types\`.`,
  "",
].join("\n");
await Bun.write(out, header + Bun.YAML.stringify(spec, null, 2));
console.error(`Wrote ${out} (${Object.keys(spec.paths).length} paths, ${dropped.length} partner paths dropped).`);
