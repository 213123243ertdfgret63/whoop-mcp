import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { readTokens, tokenPath } from "./auth/store.ts";
import { SCOPES, VERSION } from "./config.ts";
import { NotLoggedInError, WhoopApiError, WhoopClient } from "./whoop/client.ts";

const READ_ONLY = { readOnlyHint: true, idempotentHint: true, openWorldHint: true } as const;
const DISCLAIMER = "Not medical advice.";

function errorResult(err: unknown) {
  const message =
    err instanceof NotLoggedInError || err instanceof WhoopApiError || err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

function jsonResult<T extends Record<string, unknown>>(data: T, summary: string) {
  return {
    content: [{ type: "text" as const, text: `${summary}\n\n${JSON.stringify(data, null, 2)}` }],
    structuredContent: data,
  };
}

export function createServer(client = new WhoopClient()): McpServer {
  const server = new McpServer({ name: "whoop-mcp", version: VERSION }, { capabilities: { tools: {} } });

  server.registerTool(
    "whoop_status",
    {
      title: "WHOOP connection status",
      description:
        "Check whether the WHOOP account is connected: login state, granted scopes and token expiry. Makes no WHOOP API calls. Use this first if other whoop_ tools fail.",
      outputSchema: z.object({
        logged_in: z.boolean(),
        token_file: z.string(),
        scopes: z.array(z.string()),
        missing_scopes: z.array(z.string()),
        access_token_expires_in_s: z.number().nullable(),
        has_refresh_token: z.boolean(),
        server_version: z.string(),
      }),
      annotations: { ...READ_ONLY, openWorldHint: false },
    },
    async () => {
      const tokens = await readTokens();
      const scopes = tokens?.scope?.split(/\s+/).filter(Boolean) ?? [];
      const data = {
        logged_in: tokens !== null,
        token_file: tokenPath(),
        scopes,
        missing_scopes: tokens ? SCOPES.filter((s) => !scopes.includes(s)) : [...SCOPES],
        access_token_expires_in_s: tokens ? Math.round((tokens.expires_at - Date.now()) / 1000) : null,
        has_refresh_token: Boolean(tokens?.refresh_token),
        server_version: VERSION,
      };
      return jsonResult(
        data,
        data.logged_in ? "WHOOP is connected." : "Not logged in: run `whoop-mcp login` in a terminal.",
      );
    },
  );

  server.registerTool(
    "whoop_profile",
    {
      title: "WHOOP profile",
      description: "Get the WHOOP member's name and body measurements (height, weight, max heart rate).",
      inputSchema: z.object({
        include_email: z.boolean().default(false).describe("Include the account email address."),
      }),
      annotations: READ_ONLY,
    },
    async ({ include_email }) => {
      try {
        const [profile, body] = await Promise.all([
          client.get<{ user_id: number; email: string; first_name: string; last_name: string }>(
            "/v2/user/profile/basic",
          ),
          client.get<{ height_meter: number; weight_kilogram: number; max_heart_rate: number }>(
            "/v2/user/measurement/body",
          ),
        ]);
        const data = {
          name: `${profile.first_name} ${profile.last_name}`.trim(),
          ...(include_email ? { email: profile.email } : {}),
          height_cm: Math.round(body.height_meter * 1000) / 10,
          weight_kg: Math.round(body.weight_kilogram * 10) / 10,
          max_heart_rate_bpm: body.max_heart_rate,
          note: DISCLAIMER,
        };
        return jsonResult(data, `Profile for ${data.name}.`);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  return server;
}
