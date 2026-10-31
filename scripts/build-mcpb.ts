#!/usr/bin/env bun
import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
/**
 * Builds the Claude Desktop extension (MCP Bundle) for macOS:  bun run build:mcpb
 *
 * dist/whoop-mcp-macos.mcpb holds the server as one JavaScript file, server/index.mjs, bundled for Node by
 * `bun build --target=node`. Claude Desktop runs it on its own built-in Node.js (an Electron utility process),
 * so users need nothing installed. Desktop uses the built-in Node when the manifest's server type is "node",
 * its command is `node` with the script as the argument, and the built-in version satisfies
 * compatibility.runtimes.node; otherwise (or with "Use built-in Node.js for MCP" turned off) it looks for a
 * Node.js on the system that does.
 *
 * Plain JavaScript needs no code signing, no per-CPU binaries and no execute bits, so this builds on any OS.
 * The bundle is not signed: `mcpb sign` 2.1.2 produces files Desktop refuses to install (mcpb#278).
 */
import { $ } from "bun";
import { VERSION } from "../src/config.ts";
import { log } from "../src/log.ts";
import { createServer, PROMPTS } from "../src/server.ts";
import { PRIVACY_URL } from "../src/setup.ts";

const ROOT = join(import.meta.dir, "..");
const DIST = join(ROOT, "dist");
const REPO = "https://github.com/213123243ertdfgret63/whoop-mcp";

/** Claude Desktop replaces this with the folder it unpacked the extension into. */
// biome-ignore lint/suspicious/noTemplateCurlyInString: an mcpb placeholder, not a template literal
export const DIRNAME = "${__dirname}";

/** Desktop's built-in Node was 24.22 (Electron 44) when this was set; the code needs Node 22 or later. */
export const NODE_RUNTIME = ">=22.0.0";

const ENTRY = "server/index.mjs";

const LONG_DESCRIPTION = `Gives Claude read-only access to your own WHOOP data: recovery, HRV, resting heart rate, sleep, strain, steps and workouts. Ask things like "how am I today?", "how was my week?" or "am I overdoing it?".

**Setup:** after installing, ask Claude to "connect WHOOP". A page opens in your browser that walks you through creating a free WHOOP developer app, then asks you to approve access. Your credentials and tokens stay on this computer.

Logs: ~/Library/Logs/whoop-mcp/whoop-mcp.log.

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

function manifest(tools: { name: string; description: string }[]) {
  const server = {
    type: "node",
    entry_point: ENTRY,
    mcp_config: {
      command: "node",
      args: [`${DIRNAME}/${ENTRY}`],
      // biome-ignore lint/suspicious/noTemplateCurlyInString: an mcpb placeholder, not a template literal
      env: { WHOOP_MCP_INSTALL_SKILLS: "${user_config.claude_code_commands}" },
    },
  };
  return {
    manifest_version: "0.3",
    name: "whoop-mcp",
    // Shown in Claude Desktop. "unofficial" so it isn't taken for WHOOP's own product; `name` stays whoop-mcp,
    // because changing it gives the extension a new ID and installs it next to the old one.
    display_name: "WHOOP (unofficial)",
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
    // Read by skills.ts: adds /whoop-connect, /whoop-disconnect and /whoop-status to Claude Code's / menu.
    user_config: {
      claude_code_commands: {
        type: "boolean",
        title: "Add /whoop- commands to Claude Code",
        description:
          "Adds /whoop-connect, /whoop-disconnect and /whoop-status to the / menu in Claude Code, including Desktop's Code tab, as skills in ~/.claude/skills. Turning it off removes them the next time the extension starts. Uninstalling doesn't remove them: delete the whoop-* folders in ~/.claude/skills.",
        default: true,
        required: false,
      },
    },
    tools,
    tools_generated: false,
    // The connect, disconnect and status shortcuts (MCP prompts), with the same text the server returns for them.
    prompts: PROMPTS.map(({ name, description, text }) => ({ name, description, text })),
    prompts_generated: false,
    keywords: ["whoop", "fitness", "recovery", "sleep", "training", "health"],
    privacy_policies: [PRIVACY_URL],
    compatibility: { platforms: ["darwin"], runtimes: { node: NODE_RUNTIME } },
  };
}

/** One ESM file for Node, dependencies included. Not minified, so stack traces in the log stay readable. */
async function bundle(outfile: string): Promise<void> {
  await $`bun build ${join(ROOT, "src/index.ts")} --target=node --format=esm --outfile ${outfile}`.quiet();
}

async function build(tools: { name: string; description: string }[]): Promise<string> {
  const stage = join(DIST, "mcpb", "macos");
  await rm(stage, { recursive: true, force: true });
  await mkdir(join(stage, "server"), { recursive: true });
  await cp(join(ROOT, "assets/icon.png"), join(stage, "icon.png"));
  await bundle(join(stage, ENTRY));

  await Bun.write(join(stage, "manifest.json"), `${JSON.stringify(manifest(tools), null, 2)}\n`);
  const mcpbCli = join(ROOT, "node_modules/.bin/mcpb");
  await $`${mcpbCli} validate ${join(stage, "manifest.json")}`.quiet();
  const out = join(DIST, "whoop-mcp-macos.mcpb");
  await rm(out, { force: true });
  await $`${mcpbCli} pack ${stage} ${out}`.quiet();
  await rm(stage, { recursive: true, force: true });
  return out;
}

if (import.meta.main) {
  if (process.argv.length > 2) {
    console.error("Usage: bun run build:mcpb (builds the macOS bundle)");
    process.exit(2);
  }
  // Building starts a server in-process to list the tools; keep its routine log lines out of the output.
  log.configure({ ...process.env, WHOOP_MCP_LOG_FILE: "off", WHOOP_MCP_LOG_LEVEL: "warn" });
  const tools = await toolList();
  const out = await build(tools);
  console.error(`Built ${out} (${(Bun.file(out).size / 1e6).toFixed(1)} MB)`);
}

export { manifest };
