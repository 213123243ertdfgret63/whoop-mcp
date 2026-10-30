import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { errorFields, log } from "./log.ts";
import { PROMPTS } from "./server.ts";

/**
 * Claude Code skills for the shortcuts, so /whoop-connect, /whoop-disconnect and /whoop-status show up in the /
 * menu of every Claude Code session, including Claude Desktop's Code tab. An extension can't add commands any
 * other way: the .mcpb manifest only carries tools and MCP prompts, and Desktop's chat lists those under + rather
 * than in its / menu.
 *
 * The Desktop extension sets WHOOP_MCP_INSTALL_SKILLS from its "Claude Code commands" setting; the server writes
 * the skills when it starts with it on, and removes them when it's off. Run any other way (the CLI, a hand-made
 * config) the variable is unset and nothing is written. Desktop has no uninstall hook, so uninstalling the
 * extension leaves the skills behind; they tell the user so when the tools are missing.
 *
 * Only skill folders carrying MARKER are ever changed or removed: a skill of the user's own with the same name is
 * left alone.
 */

export const MARKER = "<!-- Installed by the WHOOP (unofficial) Claude Desktop extension (whoop-mcp). -->";

export interface Skill {
  name: string;
  content: string;
}

const MISSING_TOOLS =
  "If there is no whoop_ tool in this session, the WHOOP (unofficial) extension isn't running here: tell the user to check it's installed and turned on under Claude Desktop's Settings → Extensions, then start a new session. Don't try anything else.";

export function skills(): Skill[] {
  return PROMPTS.map((p) => ({
    name: p.name,
    content: `---
name: ${p.name}
description: ${p.description}
disable-model-invocation: true
---

${MARKER}

${p.text}

The tool comes from the WHOOP (unofficial) extension; in this session its name may carry a prefix, such as mcp__WHOOP__unofficial___${p.tool}. ${MISSING_TOOLS}
`,
  }));
}

/** Where Claude Code looks for personal skills. */
export function skillsDir(env = process.env): string {
  return join(env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude"), "skills");
}

/** undefined: not run as the Desktop extension, leave skills alone. An unexpanded placeholder counts as the default (on). */
export function installSetting(env = process.env): boolean | undefined {
  const value = env.WHOOP_MCP_INSTALL_SKILLS?.trim();
  if (!value) return undefined;
  return value.toLowerCase() !== "false";
}

export type SkillChange = "installed" | "updated" | "unchanged" | "removed" | "not ours" | "absent" | "failed";

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** The temporary file install() writes before renaming it into place; a crash can leave one behind. */
const TEMP_FILE = /^\.SKILL\.md\.\d+\.tmp$/;

/**
 * "absent" when the folder doesn't exist; true when it's ours (SKILL.md carries MARKER, or there's no SKILL.md and
 * nothing but our temporary files); false otherwise. Throws when the folder or SKILL.md can't be read, so
 * syncSkills reports "failed" and touches nothing.
 */
async function ours(folder: string): Promise<boolean | "absent"> {
  let entries: string[];
  try {
    entries = await readdir(folder);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw err;
  }
  const text = await readText(join(folder, "SKILL.md"));
  if (text === null) return entries.every((e) => TEMP_FILE.test(e));
  return text.includes(MARKER);
}

async function install(root: string, skill: Skill): Promise<SkillChange> {
  const folder = join(root, skill.name);
  const owner = await ours(folder);
  if (owner === false) return "not ours";
  const file = join(folder, "SKILL.md");
  if (owner === true && (await readText(file)) === skill.content) return "unchanged";
  await mkdir(folder, { recursive: true });
  // Written whole and renamed into place, so Claude Code never reads half a file.
  const temp = join(folder, `.SKILL.md.${process.pid}.tmp`);
  try {
    await writeFile(temp, skill.content);
    await chmod(temp, 0o644); // whatever the umask: it's documentation, not a secret
    await rename(temp, file);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
  // Leftovers of a start that was stopped mid-write.
  for (const e of await readdir(folder)) if (TEMP_FILE.test(e)) await rm(join(folder, e), { force: true });
  return owner === "absent" ? "installed" : "updated";
}

async function uninstall(root: string, skill: Skill): Promise<SkillChange> {
  const folder = join(root, skill.name);
  const owner = await ours(folder);
  if (owner === "absent") return "absent";
  if (owner === false) return "not ours";
  await rm(folder, { recursive: true, force: true });
  return "removed";
}

/**
 * Brings the skills in line with the setting. Never throws: a failure is logged and reported, and the server
 * carries on, since the tools work without the skills.
 */
export async function syncSkills(env = process.env): Promise<Record<string, SkillChange> | null> {
  const setting = installSetting(env);
  if (setting === undefined) return null;
  const root = skillsDir(env);
  const result: Record<string, SkillChange> = {};
  for (const skill of skills()) {
    try {
      result[skill.name] = setting ? await install(root, skill) : await uninstall(root, skill);
    } catch (err) {
      result[skill.name] = "failed";
      log.warn("couldn't update a Claude Code skill", { skill: skill.name, ...errorFields(err) });
    }
  }
  const changed = Object.values(result).some((c) => c !== "unchanged" && c !== "absent");
  if (changed) log.info("Claude Code skills", { dir: root, ...result });
  return result;
}
