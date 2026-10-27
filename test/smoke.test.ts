import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const ENTRY = join(import.meta.dir, "..", "src", "index.ts");

let home: string;
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "whoop-mcp-test-"));
});
afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

type ClientOptions = ConstructorParameters<typeof Client>[1];

async function connect(command: string[], options?: ClientOptions) {
  const transport = new StdioClientTransport({
    command: command[0]!,
    args: command.slice(1),
    env: { PATH: process.env.PATH ?? "", WHOOP_MCP_HOME: home },
    stderr: "pipe",
  });
  const client = new Client({ name: "smoke-test", version: "0.0.0" }, options);
  await client.connect(transport);
  return client;
}

const text = (result: { content?: unknown }) =>
  ((result.content as { type: string; text?: string }[] | undefined) ?? []).map((c) => c.text ?? "").join("\n");

// The v2 client defaults to legacy negotiation, so the modern era has to be pinned explicitly.
const eras: [label: string, options: ClientOptions, expectedVersion: string][] = [
  ["modern (2026-07-28 server/discover)", { versionNegotiation: { mode: { pin: "2026-07-28" } } }, "2026-07-28"],
  ["legacy (2025-11-25 initialize)", { supportedProtocolVersions: ["2025-11-25"] }, "2025-11-25"],
];

const negotiated = (client: Client) =>
  (client as unknown as { _negotiatedProtocolVersion?: string })._negotiatedProtocolVersion;

for (const [label, options, expectedVersion] of eras) {
  describe(`stdio server, ${label}`, () => {
    test("lists the tools; everything except whoop_login is read-only", async () => {
      const client = await connect([process.execPath, "run", ENTRY], options);
      try {
        expect(negotiated(client)).toBe(expectedVersion);
        const { tools } = await client.listTools();
        expect(tools.map((t) => t.name).sort()).toEqual(["whoop_login", "whoop_profile", "whoop_status"]);
        for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(t.name !== "whoop_login");
      } finally {
        await client.close();
      }
    });

    test("whoop_status reports not logged in, whoop_profile returns an actionable error", async () => {
      await rm(join(home, "tokens.json"), { force: true });
      const client = await connect([process.execPath, "run", ENTRY], options);
      try {
        const status = await client.callTool({ name: "whoop_status", arguments: {} });
        expect(status.isError).toBeFalsy();
        expect((status.structuredContent as { logged_in: boolean }).logged_in).toBe(false);

        const profile = await client.callTool({ name: "whoop_profile", arguments: {} });
        expect(profile.isError).toBe(true);
        expect(text(profile)).toContain("whoop-mcp login");
      } finally {
        await client.close();
      }
    });
  });
}

test("whoop_status reads a stored token file", async () => {
  await writeFile(
    join(home, "tokens.json"),
    JSON.stringify({
      access_token: "a",
      refresh_token: "r",
      token_type: "bearer",
      scope: "offline read:profile",
      expires_at: Date.now() + 3600_000,
      obtained_at: Date.now(),
    }),
  );
  const client = await connect([process.execPath, "run", ENTRY]);
  try {
    const status = await client.callTool({ name: "whoop_status", arguments: {} });
    const data = status.structuredContent as {
      logged_in: boolean;
      missing_scopes: string[];
      has_refresh_token: boolean;
    };
    expect(data.logged_in).toBe(true);
    expect(data.has_refresh_token).toBe(true);
    expect(data.missing_scopes).toContain("read:sleep");
  } finally {
    await client.close();
  }
});

// Set WHOOP_MCP_BINARY=dist/whoop-mcp (after `bun run build`) to smoke-test the compiled binary too.
const binary = process.env.WHOOP_MCP_BINARY;
test.skipIf(!binary)("compiled binary serves stdio", async () => {
  const client = await connect([binary!]);
  try {
    const { tools } = await client.listTools();
    expect(tools.length).toBe(3);
  } finally {
    await client.close();
  }
});
