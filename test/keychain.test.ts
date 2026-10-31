import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeOutput, deleteItem, getItem, KeychainError, setItem } from "../src/auth/keychain.ts";

// A fake `security` (WHOOP_MCP_SECURITY) that keeps its "keychain" in a file and logs each call's arguments and
// stdin, so the tests can check exactly what would reach Apple's tool, and that the secret never is an argument.
let dir: string;
let saved: string | undefined;
const item = { service: "whoop-mcp", account: "client-credentials" };
const calls = async () =>
  (await readFile(join(dir, "calls"), "utf8").catch(() => ""))
    .split("\n---\n")
    .filter(Boolean)
    .map((c) => JSON.parse(c) as { args: string[]; stdin: string });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "whoop-keychain-test-"));
  saved = process.env.WHOOP_MCP_SECURITY;
  const fake = join(dir, "security");
  await writeFile(
    fake,
    `#!/usr/bin/env bun
const fs = require("node:fs");
const dir = ${JSON.stringify(dir)};
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(dir + "/calls", JSON.stringify({ args, stdin }) + "\\n---\\n");
const store = dir + "/item";
if (fs.existsSync(dir + "/fail")) { console.error("SecKeychainSearchCopyNext: denied"); process.exit(51); }
const has = fs.existsSync(store);
switch (args[0]) {
  case "find-generic-password":
    if (!has) process.exit(44);
    {
      // Like the real tool: a value with any byte outside printable ASCII comes out as bare hex.
      const raw = fs.readFileSync(store);
      const printable = raw.every((b) => b >= 0x20 && b <= 0x7e);
      process.stdout.write((printable ? raw.toString("utf8") : raw.toString("hex")) + "\\n");
    }
    process.exit(0);
  case "delete-generic-password":
    if (!has) process.exit(44);
    fs.rmSync(store);
    process.exit(0);
  case "-i": {
    const m = /^add-generic-password -s "whoop-mcp" -a "client-credentials" -X ([0-9a-f]+)\\n$/.exec(stdin);
    if (!m) process.exit(2);
    if (has) process.exit(45);
    fs.writeFileSync(store, Buffer.from(m[1], "hex").toString("utf8"));
    process.exit(0);
  }
}
process.exit(1);
`,
  );
  await chmod(fake, 0o755);
  process.env.WHOOP_MCP_SECURITY = fake;
});

afterEach(async () => {
  if (saved === undefined) delete process.env.WHOOP_MCP_SECURITY;
  else process.env.WHOOP_MCP_SECURITY = saved;
  await rm(dir, { recursive: true, force: true });
});

describe("keychain (through the security tool)", () => {
  test("an absent item reads as null and deletes as false", async () => {
    expect(await getItem(item)).toBeNull();
    expect(await deleteItem(item)).toBe(false);
  });

  test("saves, reads back exactly, replaces and deletes", async () => {
    const value = JSON.stringify({ clientId: "id", clientSecret: 'se"cr et\\ünï' });
    await setItem(item, value);
    expect(await getItem(item)).toBe(value);
    // Saving again replaces the item: delete first, since an item another program saved can't be updated.
    await setItem(item, "second");
    expect(await getItem(item)).toBe("second");
    expect(await deleteItem(item)).toBe(true);
    expect(await getItem(item)).toBeNull();
  });

  test("the secret goes through stdin in hex, never as an argument", async () => {
    await setItem(item, "s3cret-value");
    const all = await calls();
    for (const c of all) expect(c.args.join(" ")).not.toContain("s3cret-value");
    const add = all.find((c) => c.args[0] === "-i");
    expect(add?.args).toEqual(["-i"]);
    expect(add?.stdin).toContain(Buffer.from("s3cret-value").toString("hex"));
    expect(add?.stdin).not.toContain("s3cret-value");
    expect(all.map((c) => c.args[0])).toEqual(["delete-generic-password", "-i"]);
    expect(all[0]?.args).toEqual(["delete-generic-password", "-s", "whoop-mcp", "-a", "client-credentials"]);
  });

  test("hex output is decoded only when it can't be a printable value", () => {
    // What the real tool printed for {"a":"ünï"} (checked on a throwaway item).
    expect(decodeOutput("7b2261223a22c3bc6ec3af227d")).toBe('{"a":"ünï"}');
    // Printable values are printed as they are, even when they look like hex.
    expect(decodeOutput("cafe")).toBe("cafe");
    expect(decodeOutput('{"clientId":"x"}')).toBe('{"clientId":"x"}');
  });

  test("a refusal (locked keychain, Deny) is an error, not a missing item", async () => {
    await writeFile(join(dir, "fail"), "");
    const read = await getItem(item).catch((e: unknown) => e);
    expect(read).toBeInstanceOf(KeychainError);
    expect((read as KeychainError).exitCode).toBe(51);
    expect((read as Error).message).toContain("denied");
    expect(await deleteItem(item).catch((e: unknown) => e)).toBeInstanceOf(KeychainError);
    expect(await setItem(item, "x").catch((e: unknown) => e)).toBeInstanceOf(KeychainError);
  });

  test("a missing security tool is an error", async () => {
    process.env.WHOOP_MCP_SECURITY = join(dir, "nope");
    expect(await getItem(item).catch((e: unknown) => (e as NodeJS.ErrnoException).code)).toBe("ENOENT");
  });
});
