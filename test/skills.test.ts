import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROMPTS } from "../src/server.ts";
import { installSetting, MARKER, skills, skillsDir, syncSkills } from "../src/skills.ts";

let configDir: string;
let root: string;
const env = (setting: string | undefined) => ({ CLAUDE_CONFIG_DIR: configDir, WHOOP_MCP_INSTALL_SKILLS: setting });
const NAMES = ["whoop-connect", "whoop-disconnect", "whoop-status"];

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "whoop-skills-"));
  root = join(configDir, "skills");
});
afterEach(async () => {
  await chmod(root, 0o755).catch(() => {});
  await rm(configDir, { recursive: true, force: true });
});

const skillText = (name: string) => readFile(join(root, name, "SKILL.md"), "utf8");

describe("skills", () => {
  test("one per prompt, named after it, user-invoked only, with the prompt's text and our marker", () => {
    const list = skills();
    expect(list.map((s) => s.name)).toEqual(NAMES);
    for (const [i, s] of list.entries()) {
      const p = PROMPTS[i];
      if (!p) throw new Error("missing prompt");
      expect(s.content.startsWith(`---\nname: ${p.name}\ndescription: ${p.description}\n`)).toBe(true);
      expect(s.content).toContain("disable-model-invocation: true\n---\n");
      expect(s.content).toContain(MARKER);
      expect(s.content).toContain(p.text);
      // Names the tool, and says what to do when the extension isn't loaded in the session.
      expect(s.content).toContain(p.tool);
      expect(s.content).toContain("Settings → Extensions");
    }
  });

  test("the setting: unset means leave alone, false means remove, anything else (an unexpanded placeholder too) means install", () => {
    expect(installSetting({})).toBeUndefined();
    expect(installSetting({ WHOOP_MCP_INSTALL_SKILLS: " " })).toBeUndefined();
    expect(installSetting({ WHOOP_MCP_INSTALL_SKILLS: "false" })).toBe(false);
    expect(installSetting({ WHOOP_MCP_INSTALL_SKILLS: "FALSE" })).toBe(false);
    expect(installSetting({ WHOOP_MCP_INSTALL_SKILLS: "true" })).toBe(true);
    expect(installSetting({ WHOOP_MCP_INSTALL_SKILLS: ["$", "{user_config.claude_code_commands}"].join("") })).toBe(
      true,
    );
  });

  test("skills go to CLAUDE_CONFIG_DIR/skills, else ~/.claude/skills", () => {
    expect(skillsDir({ CLAUDE_CONFIG_DIR: "/x" })).toBe("/x/skills");
    expect(skillsDir({})).toMatch(/\/\.claude\/skills$/);
  });
});

describe("syncSkills", () => {
  test("without the setting (not run as the extension) writes nothing", async () => {
    expect(await syncSkills(env(undefined))).toBeNull();
    expect(await readdir(configDir)).toEqual([]);
  });

  test("installs the three skills, then leaves them unchanged, then updates a stale one", async () => {
    expect(await syncSkills(env("true"))).toEqual({
      "whoop-connect": "installed",
      "whoop-disconnect": "installed",
      "whoop-status": "installed",
    });
    expect((await readdir(root)).sort()).toEqual(NAMES);
    for (const s of skills()) {
      expect(await skillText(s.name)).toBe(s.content);
      expect((await stat(join(root, s.name, "SKILL.md"))).mode & 0o777).toBe(0o644);
    }
    const before = (await stat(join(root, "whoop-status", "SKILL.md"))).mtimeMs;
    expect(Object.values((await syncSkills(env("true"))) ?? {})).toEqual(["unchanged", "unchanged", "unchanged"]);
    expect((await stat(join(root, "whoop-status", "SKILL.md"))).mtimeMs).toBe(before);

    // An older version's text, as after an extension update.
    await writeFile(join(root, "whoop-status", "SKILL.md"), `---\nname: whoop-status\n---\n${MARKER}\nold\n`);
    expect((await syncSkills(env("true")))?.["whoop-status"]).toBe("updated");
    expect(await skillText("whoop-status")).toBe(skills()[2]?.content ?? "");
    // No temp files left behind.
    for (const n of NAMES) expect(await readdir(join(root, n))).toEqual(["SKILL.md"]);
  });

  test("never touches a skill of the user's own with the same name, installing or removing", async () => {
    const mine = "---\nname: whoop-status\ndescription: my own\n---\nmine\n";
    await mkdir(join(root, "whoop-status"), { recursive: true });
    await writeFile(join(root, "whoop-status", "SKILL.md"), mine);
    // A folder without SKILL.md but with other files isn't ours either.
    await mkdir(join(root, "whoop-connect"), { recursive: true });
    await writeFile(join(root, "whoop-connect", "notes.txt"), "keep");

    const installed = await syncSkills(env("true"));
    expect(installed).toMatchObject({ "whoop-status": "not ours", "whoop-connect": "not ours" });
    expect(installed?.["whoop-disconnect"]).toBe("installed");
    expect(await skillText("whoop-status")).toBe(mine);

    const removed = await syncSkills(env("false"));
    expect(removed).toEqual({
      "whoop-connect": "not ours",
      "whoop-disconnect": "removed",
      "whoop-status": "not ours",
    });
    expect(await skillText("whoop-status")).toBe(mine);
    expect(await readFile(join(root, "whoop-connect", "notes.txt"), "utf8")).toBe("keep");
  });

  test("a temp file left by a start stopped mid-write doesn't make the folder someone else's", async () => {
    await mkdir(join(root, "whoop-status"), { recursive: true });
    await writeFile(join(root, "whoop-status", ".SKILL.md.123.tmp"), "half");
    expect((await syncSkills(env("true")))?.["whoop-status"]).toBe("updated");
    expect(await readdir(join(root, "whoop-status"))).toEqual(["SKILL.md"]);
    await writeFile(join(root, "whoop-connect", ".SKILL.md.456.tmp"), "half");
    await rm(join(root, "whoop-connect", "SKILL.md"));
    expect((await syncSkills(env("false")))?.["whoop-connect"]).toBe("removed");
  });

  test("the file is readable by everyone whatever the umask", async () => {
    const old = process.umask(0o077);
    try {
      await syncSkills(env("true"));
    } finally {
      process.umask(old);
    }
    expect((await stat(join(root, "whoop-status", "SKILL.md"))).mode & 0o777).toBe(0o644);
  });

  test("turning the setting off removes ours, and an empty folder counts as ours", async () => {
    await syncSkills(env("true"));
    await rm(join(root, "whoop-connect", "SKILL.md"));
    expect(await syncSkills(env("false"))).toEqual({
      "whoop-connect": "removed",
      "whoop-disconnect": "removed",
      "whoop-status": "removed",
    });
    expect(await readdir(root)).toEqual([]);
    expect(Object.values((await syncSkills(env("false"))) ?? {})).toEqual(["absent", "absent", "absent"]);
  });

  test("a folder it can't write is reported as failed, not thrown", async () => {
    if (process.getuid?.() === 0) return; // root ignores permissions
    await mkdir(root, { recursive: true });
    await chmod(root, 0o555);
    expect(Object.values((await syncSkills(env("true"))) ?? {})).toEqual(["failed", "failed", "failed"]);
  });
});
