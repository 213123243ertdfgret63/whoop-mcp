#!/usr/bin/env bun
/**
 * Search and read Bun's official docs via https://bun.com/llms.txt.
 *
 *   bun .claude/skills/bun/scripts/bun-docs.ts search <terms...>   # rank llms.txt entries
 *   bun .claude/skills/bun/scripts/bun-docs.ts get <url|docs path>  # print a page as markdown
 *   bun .claude/skills/bun/scripts/bun-docs.ts grep <regex>         # search the full docs text (llms-full.txt)
 *
 * The index and full text are cached for 24h in ~/.cache/bun-skill.
 */
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const CACHE_DIR = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "bun-skill");
const TTL_MS = 24 * 60 * 60 * 1000;

async function cachedText(name: string, url: string): Promise<string> {
  const f = Bun.file(join(CACHE_DIR, name));
  if ((await f.exists()) && Date.now() - f.lastModified < TTL_MS) return f.text();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  const text = await res.text();
  await mkdir(CACHE_DIR, { recursive: true });
  await Bun.write(f, text);
  return text;
}

interface Entry {
  title: string;
  url: string;
  description: string;
}

async function index(): Promise<Entry[]> {
  const text = await cachedText("llms.txt", "https://bun.com/llms.txt");
  return [...text.matchAll(/^- \[([^\]]+)\]\(([^)]+)\)(?::\s*(.*))?$/gm)].map((m) => ({
    title: m[1]!,
    url: m[2]!,
    description: m[3] ?? "",
  }));
}

async function search(terms: string[]): Promise<void> {
  const words = terms.join(" ").toLowerCase().split(/\s+/).filter(Boolean);
  const scored = (await index())
    .map((e) => {
      const title = e.title.toLowerCase();
      const hay = `${title} ${e.url.toLowerCase()} ${e.description.toLowerCase()}`;
      const score = words.reduce((s, w) => s + (title.includes(w) ? 3 : 0) + (hay.includes(w) ? 1 : 0), 0);
      return { e, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);
  if (scored.length === 0) {
    console.log("No matches in llms.txt. Try `grep` over the full docs, or different terms.");
    return;
  }
  for (const { e } of scored) console.log(`- ${e.title}: ${e.url}${e.description ? `\n    ${e.description}` : ""}`);
}

async function get(target: string): Promise<void> {
  let url = target.startsWith("http") ? target : `https://bun.com/docs/${target.replace(/^\/?(docs\/)?/, "")}`;
  // Every docs page and blog post is served as raw markdown at the same path + ".md".
  if (!url.endsWith(".md") && !url.endsWith(".txt")) url += ".md";
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  console.log(await res.text());
}

async function grep(pattern: string): Promise<void> {
  const text = await cachedText("llms-full.txt", "https://bun.com/llms-full.txt");
  const re = new RegExp(pattern, "i");
  // llms-full.txt is the concatenated docs; track the most recent page heading so hits have context.
  let page = "";
  let hits = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("# ")) page = line.slice(2);
    if (re.test(line)) {
      console.log(`[${page}] ${line.trim().slice(0, 240)}`);
      if (++hits >= 60) {
        console.log("…truncated at 60 hits; narrow the pattern.");
        break;
      }
    }
  }
  if (hits === 0) console.log("No matches.");
}

const [cmd, ...args] = Bun.argv.slice(2);
switch (cmd) {
  case "search":
    await search(args);
    break;
  case "get":
    if (!args[0]) throw new Error("usage: get <url|docs path>");
    await get(args[0]);
    break;
  case "grep":
    if (!args[0]) throw new Error("usage: grep <regex>");
    await grep(args.join(" "));
    break;
  default:
    console.error("usage: bun-docs.ts <search <terms...> | get <url|path> | grep <regex>>");
    process.exit(2);
}
