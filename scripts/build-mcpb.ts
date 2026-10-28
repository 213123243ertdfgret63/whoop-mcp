#!/usr/bin/env bun
import { chmod, cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
/**
 * Builds the Claude Desktop extensions (MCP Bundles):  bun run build:mcpb [macos|windows|all]
 *
 * - dist/whoop-mcp-macos.mcpb:   darwin-arm64 and darwin-x64 binaries plus server/launch.sh, which picks the one
 *                                for the Mac's CPU (the manifest has no architecture field, mcpb#10).
 * - dist/whoop-mcp-windows.mcpb: the windows-x64 binary.
 *
 * Must run on macOS or Linux: the zip has to carry Unix file modes, because Claude Desktop only marks an
 * extracted file executable when its zip entry has the owner-exec bit (mcpb#294, #235). launch.sh also restores
 * the bit itself, for Desktop builds that drop it. The bundles are not signed: `mcpb sign` 2.1.2 produces files
 * Desktop refuses to install (mcpb#278).
 */
import { $ } from "bun";
import { VERSION } from "../src/config.ts";
import { log } from "../src/log.ts";
import { createServer } from "../src/server.ts";
import { PRIVACY_URL } from "../src/setup.ts";

const ROOT = join(import.meta.dir, "..");
const DIST = join(ROOT, "dist");
const REPO = "https://github.com/213123243ertdfgret63/whoop-mcp";

type Bundle = "macos" | "windows";

/** Claude Desktop replaces this with the folder it unpacked the extension into. */
// biome-ignore lint/suspicious/noTemplateCurlyInString: an mcpb placeholder, not a template literal
export const DIRNAME = "${__dirname}";

const LAUNCH_SH = `#!/bin/sh
# Claude Desktop starts the whoop-mcp extension through this script. It picks the binary for this Mac's CPU and
# makes sure it is executable, since some Desktop builds unpack extension files without the execute bit.
dir=$(cd "$(dirname "$0")" && pwd)
case "$(uname -m)" in
  arm64) bin="$dir/whoop-mcp-darwin-arm64" ;;
  *) bin="$dir/whoop-mcp-darwin-x64" ;;
esac
[ -x "$bin" ] || chmod 755 "$bin" 2>/dev/null
exec "$bin" "$@"
`;

const LONG_DESCRIPTION = `Gives Claude read-only access to your own WHOOP data: recovery, HRV, resting heart rate, sleep, strain, steps and workouts. Ask things like "how am I today?", "how was my week?" or "am I overdoing it?".

**Setup:** after installing, ask Claude to "connect WHOOP". A page opens in your browser that walks you through creating a free WHOOP developer app, then asks you to approve access. Your credentials and tokens stay on this computer.

Logs: ~/Library/Logs/whoop-mcp/whoop-mcp.log on macOS, %LOCALAPPDATA%\\whoop-mcp\\Logs\\whoop-mcp.log on Windows.

Not affiliated with or endorsed by WHOOP. Not medical advice.`;

/** Tool names and first sentences, straight from the server, so the install dialog can't drift from the code. */
async function toolList(): Promise<{ name: string; description: string }[]> {
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "build-mcpb", version: VERSION });
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  await client.close();
  return tools.map((t) => ({ name: t.name, description: summary(t.description ?? "") }));
}

/** The first sentence (not fooled by "e.g." or "vs."), cut at a word boundary if it is still long. */
export function summary(description: string, max = 160): string {
  const first = description.split(/(?<!\b(?:e\.g|i\.e|vs|etc))\.\s+(?=[A-Z])/)[0] ?? "";
  const sentence = first.endsWith(".") ? first : `${first}.`;
  if (sentence.length <= max) return sentence;
  return `${sentence.slice(0, max).replace(/\s+\S*$/, "")}…`;
}

function manifest(bundle: Bundle, tools: { name: string; description: string }[]) {
  const server =
    bundle === "macos"
      ? {
          type: "binary",
          entry_point: "server/launch.sh",
          mcp_config: { command: "/bin/sh", args: [`${DIRNAME}/server/launch.sh`] },
        }
      : {
          type: "binary",
          entry_point: "server/whoop-mcp.exe",
          mcp_config: { command: `${DIRNAME}/server/whoop-mcp.exe`, args: [] },
        };
  return {
    manifest_version: "0.3",
    name: "whoop-mcp",
    display_name: "whoop-mcp",
    version: VERSION,
    description: "Your WHOOP recovery, sleep, strain and workouts in Claude (read-only, unofficial).",
    long_description: LONG_DESCRIPTION,
    author: { name: "whoop-mcp contributors", url: REPO },
    repository: { type: "git", url: `${REPO}.git` },
    homepage: REPO,
    documentation: `${REPO}#readme`,
    support: `${REPO}/issues`,
    icon: "icon.png",
    server,
    tools,
    tools_generated: false,
    keywords: ["whoop", "fitness", "recovery", "sleep", "training", "health"],
    privacy_policies: [PRIVACY_URL],
    compatibility: { platforms: [bundle === "macos" ? "darwin" : "win32"] },
  };
}

async function compile(target: string, outfile: string): Promise<void> {
  await $`bun build ${join(ROOT, "src/index.ts")} --compile --minify --no-compile-autoload-dotenv --no-compile-autoload-bunfig --target=bun-${target} --outfile ${outfile}`.quiet();
  await chmod(outfile, 0o755);
}

/** Bun signs native builds ad hoc; cross-compiled ones may not be, and Apple Silicon won't run unsigned code. */
async function adHocSign(file: string): Promise<void> {
  if (process.platform !== "darwin") return;
  await $`codesign --force --sign - ${file}`.quiet();
  await $`codesign --verify ${file}`.quiet();
}

const MAX_MACOS_MINIMUM = 13;

/**
 * For the native target `bun build --compile` copies the running bun, so the binary only runs on the macOS
 * version that bun was built for. A Homebrew or self-built bun is built for the host's version; official
 * releases target macOS 13. Release builds must not raise the bar for everyone else.
 */
async function checkMinimumMacOS(file: string): Promise<void> {
  if (process.platform !== "darwin") return;
  const minos = Number(/minos (\d+)/.exec(await $`otool -l ${file}`.text())?.[1]);
  if (!(minos > MAX_MACOS_MINIMUM)) return;
  const message = `${file} needs macOS ${minos} or later, because the bun running this build was built for it. Use an official bun (https://bun.sh) to build bundles for other Macs.`;
  if (process.env.CI) throw new Error(message);
  console.error(`Warning: ${message}`);
}

/**
 * Fails unless every listed entry in the bundle is stored with the owner-exec bit. mcpb stores only the
 * permission bits (zipinfo shows "?rwx..."), which is all Desktop reads.
 */
async function checkExecutable(mcpb: string, entries: string[]): Promise<void> {
  const listing = await $`zipinfo ${mcpb}`.text();
  for (const entry of entries) {
    const line = listing.split("\n").find((l) => l.trim().endsWith(` ${entry}`));
    if (line?.slice(1, 4) !== "rwx") throw new Error(`${entry} is not stored as executable in ${mcpb}:\n${line}`);
  }
}

async function build(bundle: Bundle, tools: { name: string; description: string }[]): Promise<string> {
  const stage = join(DIST, "mcpb", bundle);
  await rm(stage, { recursive: true, force: true });
  await mkdir(join(stage, "server"), { recursive: true });
  await cp(join(ROOT, "assets/icon.png"), join(stage, "icon.png"));

  const executables: string[] = [];
  if (bundle === "macos") {
    for (const arch of ["arm64", "x64"]) {
      const bin = join(stage, "server", `whoop-mcp-darwin-${arch}`);
      await compile(`darwin-${arch}`, bin);
      await adHocSign(bin);
      await checkMinimumMacOS(bin);
      executables.push(`server/whoop-mcp-darwin-${arch}`);
    }
    await Bun.write(join(stage, "server/launch.sh"), LAUNCH_SH);
    await chmod(join(stage, "server/launch.sh"), 0o755);
    executables.push("server/launch.sh");
  } else {
    await compile("windows-x64", join(stage, "server/whoop-mcp.exe"));
  }

  await Bun.write(join(stage, "manifest.json"), `${JSON.stringify(manifest(bundle, tools), null, 2)}\n`);
  const mcpbCli = join(ROOT, "node_modules/.bin/mcpb");
  await $`${mcpbCli} validate ${join(stage, "manifest.json")}`.quiet();
  const out = join(DIST, `whoop-mcp-${bundle}.mcpb`);
  await rm(out, { force: true });
  await $`${mcpbCli} pack ${stage} ${out}`.quiet();
  if (executables.length) await checkExecutable(out, executables);
  await rm(stage, { recursive: true, force: true }); // ~300 MB of unpacked binaries, no longer needed
  return out;
}

if (import.meta.main) {
  if (process.platform === "win32") {
    console.error("Build the bundles on macOS or Linux: Windows zips carry no Unix file modes.");
    process.exit(1);
  }
  const which = process.argv[2] ?? "all";
  if (!["macos", "windows", "all"].includes(which)) {
    console.error("Usage: bun run build:mcpb [macos|windows|all]");
    process.exit(2);
  }
  // Building starts a server in-process to list the tools; keep its routine log lines out of the output.
  log.configure({ ...process.env, WHOOP_MCP_LOG_FILE: "off", WHOOP_MCP_LOG_LEVEL: "warn" });
  const tools = await toolList();
  for (const bundle of ["macos", "windows"] as const) {
    if (which !== "all" && which !== bundle) continue;
    const out = await build(bundle, tools);
    console.error(`Built ${out} (${(Bun.file(out).size / 1e6).toFixed(1)} MB)`);
  }
}

export { LAUNCH_SH, manifest };
