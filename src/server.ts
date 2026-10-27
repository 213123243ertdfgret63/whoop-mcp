import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { BackgroundLogin } from "./auth/background-login.ts";
import { resolveClientCredentials } from "./auth/credentials.ts";
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

/** Where the WHOOP app credentials come from, or "missing" (never throws). */
async function credentialSource(): Promise<"env" | "keychain" | "file" | "missing"> {
  try {
    return (await resolveClientCredentials()).source;
  } catch {
    return "missing";
  }
}

export function createServer(client = new WhoopClient(), loginFlow = new BackgroundLogin()): McpServer {
  const server = new McpServer({ name: "whoop-mcp", version: VERSION }, { capabilities: { tools: {} } });

  server.registerTool(
    "whoop_status",
    {
      title: "WHOOP connection status",
      description:
        "Check whether the WHOOP account is connected: app credentials, login state (including a browser login started with whoop_login), granted scopes and token expiry. Makes no WHOOP API calls. Use this first if other whoop_ tools fail.",
      outputSchema: z.object({
        logged_in: z.boolean(),
        app_credentials: z.enum(["env", "keychain", "file", "missing"]),
        login: z.object({
          state: z.enum(["idle", "pending", "succeeded", "failed"]),
          kind: z.enum(["setup", "login"]).optional(),
          authorize_url: z.string().optional(),
          error: z.string().optional(),
        }),
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
      const login = loginFlow.status;
      const app_credentials = await credentialSource();
      const data = {
        logged_in: tokens !== null,
        app_credentials,
        login: {
          state: login.state,
          ...(login.state === "pending" ? { kind: login.kind, authorize_url: login.authorizeUrl } : {}),
          ...(login.state === "failed" ? { error: login.error } : {}),
        },
        token_file: tokenPath(),
        scopes,
        missing_scopes: tokens ? SCOPES.filter((s) => !scopes.includes(s)) : [...SCOPES],
        access_token_expires_in_s: tokens ? Math.round((tokens.expires_at - Date.now()) / 1000) : null,
        has_refresh_token: Boolean(tokens?.refresh_token),
        server_version: VERSION,
      };
      const summary =
        login.state === "pending"
          ? login.kind === "setup"
            ? `Waiting for the user to finish the setup page in the browser (enter the WHOOP app's Client ID and Secret, then approve access): ${login.authorizeUrl}`
            : `Waiting for the user to approve access in the browser: ${login.authorizeUrl}`
          : data.logged_in
            ? app_credentials === "missing"
              ? "Logged in, but the WHOOP app credentials are gone, so the next token refresh will fail. Call whoop_login with reconfigure: true to enter them again."
              : "WHOOP is connected."
            : login.state === "failed"
              ? `The last login failed (${login.error}). Call whoop_login to try again, or with reconfigure: true to enter different WHOOP app credentials.`
              : app_credentials === "missing"
                ? "No WHOOP app credentials yet: call whoop_login, which opens a setup page in the browser to enter them (or run `whoop-mcp setup` in a terminal, or set WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET)."
                : "Not logged in: call whoop_login to sign in with the browser (or run `whoop-mcp login` in a terminal).";
      return jsonResult(data, summary);
    },
  );

  server.registerTool(
    "whoop_login",
    {
      title: "Log in to WHOOP",
      description:
        "Connect the user's WHOOP account in the browser. Opens a page and returns its URL immediately (always show the URL to the user in case the browser didn't open). If no WHOOP app credentials are configured yet, the page is a local setup form that collects the app's Client ID and Secret (with instructions for creating the app) and then continues to WHOOP; otherwise it goes straight to WHOOP's consent page. The rest happens in the browser, so after the user says they're done, call whoop_status to confirm. Use reconfigure: true when the saved app credentials are wrong (WHOOP showed an error such as an invalid client or redirect URI, or the user wants another app): it cancels any pending login and opens the setup page.",
      inputSchema: z.object({
        reconfigure: z
          .boolean()
          .default(false)
          .describe("Open the setup page to enter different WHOOP app credentials, even if some are saved."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ reconfigure }) => {
      try {
        const { authorizeUrl, alreadyPending, kind } = await loginFlow.start({ reconfigure });
        const lead =
          kind === "setup"
            ? `${alreadyPending ? "The WHOOP setup page is already open" : "Opened a WHOOP setup page in the browser"}. It explains how to create a free WHOOP developer app, asks for its Client ID and Client Secret, and then continues to WHOOP to approve access.`
            : alreadyPending
              ? "A WHOOP login is already waiting for approval."
              : "Opened the WHOOP consent page in the browser.";
        return {
          content: [
            {
              type: "text" as const,
              text: `${lead} If the browser didn't open, visit:\n\n${authorizeUrl}\n\nWhen the user has finished in the browser, call whoop_status to confirm.`,
            },
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
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
