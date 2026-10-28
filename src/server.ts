import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { BackgroundLogin, type LoginStatus } from "./auth/background-login.ts";
import { deleteStoredCredentials, resolveClientCredentials } from "./auth/credentials.ts";
import { deleteTokens, readTokens, tokenPath, withTokenLock } from "./auth/store.ts";
import { SCOPES, VERSION } from "./config.ts";
import { errorFields, log } from "./log.ts";
import { DISCLAIMER, errorResult, jsonResult, LOGIN_WAIT_SECONDS, READ_ONLY, toolError } from "./tools/common.ts";
import { registerDataTools } from "./tools/data-tools.ts";
import { WhoopClient } from "./whoop/client.ts";

const INSTRUCTIONS = `WHOOP data for the user's own account: recovery, HRV, resting heart rate, sleep, strain, steps and workouts.
Useful for planning and reviewing the user's training:
- "How am I today?", readiness, whether to train hard: whoop_today.
- Weekly check-ins and patterns: whoop_daily_summaries, whoop_compare_periods.
- Programming, deloads, overreaching: whoop_training_load (acute:chronic strain), whoop_trends, whoop_baselines.
- Sleep: whoop_sleep. Training history: whoop_workouts. What drives what: whoop_correlate.
Judge numbers against the user's own baselines (whoop_baselines, or vs_last_30_days in whoop_today) rather than population norms, and say when data is missing, pending or calibrating. A baseline needs 7+ days (baseline_days); with fewer, say it is still forming. Dates before data_quality.first_data_date have no WHOOP data at all (usually the account is newer than the range), so don't read them as missed wear or rest days. Dates are the user's local dates; a WHOOP day runs from sleep to sleep, not midnight to midnight.
WHOOP heart-rate zones are % of heart-rate reserve (resting HR + pct x (max HR - resting HR)), not % of max HR.
Present suggestions as options for the user to choose. This is not medical advice: suggest a professional for symptoms, injuries or anything clinical.
If a tool says WHOOP isn't connected, it has already opened the connection page: tell the user in one sentence, call whoop_login with wait_seconds until it reports connected, then carry on with their request. Never ask the user to say when they're done.`;

/**
 * Logs every tool call: name, arguments, duration and the final outcome. It wraps the SDK's own tools/call
 * handler, so calls rejected for bad arguments or an output-schema mismatch are logged too. Never the result,
 * which is WHOOP data; arguments are only dates, ranges, metric names and flags.
 */
function instrumentTools(server: McpServer): void {
  const low = server.server;
  const setRequestHandler = low.setRequestHandler.bind(low) as (method: string, handler: unknown) => void;
  (low as { setRequestHandler: unknown }).setRequestHandler = (method: string, handler: unknown) => {
    if (method !== "tools/call" || typeof handler !== "function") return setRequestHandler(method, handler);
    return setRequestHandler(
      method,
      async (request: { params: { name: string; arguments?: unknown } }, ctx: unknown) => {
        const started = performance.now();
        const { name, arguments: args } = request.params;
        const ms = () => Math.round(performance.now() - started);
        try {
          const result = (await handler(request, ctx)) as { isError?: boolean; content?: { text?: string }[] };
          if (result?.isError) {
            log.warn(`tool ${name} error`, { ms: ms(), args, error: result.content?.[0]?.text?.slice(0, 300) });
          } else {
            log.info(`tool ${name} ok`, { ms: ms(), args });
          }
          return result;
        } catch (err) {
          log.error(`tool ${name} failed`, { ms: ms(), args, ...errorFields(err) });
          throw err;
        }
      },
    );
  };
}

/**
 * Whether saved tokens look usable: all scopes, refreshable, not known to be dead in this process, and the app
 * credentials a refresh needs are still there.
 */
async function isConnected(client: WhoopClient): Promise<boolean> {
  const tokens = await readTokens();
  if (!tokens) return false;
  if ((await credentialSource()) === "missing") return false;
  if (client.authProblem?.(tokens).session_expired) return false;
  const scopes = tokens.scope?.split(/\s+/) ?? [];
  if (SCOPES.some((s) => !scopes.includes(s))) return false;
  return Boolean(tokens.refresh_token) || tokens.expires_at > Date.now();
}

function textResult(text: string, data: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], structuredContent: data };
}

const connectedResult = () =>
  textResult("WHOOP is connected. Carry on with the user's request now (call the WHOOP tool you need).", {
    state: "connected",
  });

/** What whoop_login tells Claude: a script for the next step, not prose to show the user. */
function loginResult(
  status: LoginStatus,
  ctx: { first: boolean; kind: "setup" | "login"; url: string; seenProblems: number },
) {
  const again = `call whoop_login again right away with wait_seconds=${LOGIN_WAIT_SECONDS} (no reconfigure)`;
  switch (status.state) {
    case "succeeded":
      return textResult(
        "WHOOP is connected. Carry on with the user's original request now (call the WHOOP tool again); don't ask them anything first.",
        { state: "connected", scope: status.scope },
      );
    case "failed": {
      const credentials = /client|credential|redirect/i.test(status.error);
      return textResult(
        `The WHOOP connection failed: ${status.error.slice(0, 300)} Tell the user in one sentence. ${credentials ? "If the app's details look wrong, call whoop_login with reconfigure: true to enter them again." : "Then call whoop_login to try again if they want."}`,
        { state: "failed", error: status.error },
      );
    }
    case "idle":
      return textResult("The WHOOP connection was cancelled.", { state: "idle" });
    case "pending": {
      const minutes = Math.floor((Date.now() - status.startedAt) / 60_000);
      const data = {
        state: "pending",
        kind: status.kind,
        url: ctx.url,
        ...(status.progress ? { progress: status.progress } : {}),
        ...(status.problem ? { problem: status.problem } : {}),
      };
      if (status.problem && (status.problemSeq ?? 0) > ctx.seenProblems) {
        return textResult(
          `The WHOOP page in the user's browser is showing a problem: "${status.problem.slice(0, 300)}" The page offers Try again. Tell the user that in one or two sentences, then ${again}.`,
          data,
        );
      }
      if (ctx.first) {
        const say =
          ctx.kind === "setup"
            ? "I've opened a page in your browser to connect WHOOP; it takes about 5 minutes the first time, and I'll carry on when you're done."
            : "I've opened WHOOP in your browser; approve access there and I'll carry on.";
        return textResult(
          `Opened ${ctx.kind === "setup" ? "a WHOOP setup page" : "WHOOP's approval page"} in the user's browser (if it didn't open, they can visit ${ctx.url}). Tell the user in one sentence, e.g. "${say}" Don't repeat the page's steps. Then ${again}, and keep calling it while it says pending.`,
          data,
        );
      }
      const step =
        status.progress === "form" || status.progress === undefined
          ? ctx.kind === "setup"
            ? "creating the WHOOP app"
            : "approving access"
          : status.progress === "verifying"
            ? "checking the app's codes"
            : "approving access in WHOOP";
      if (minutes >= 15) {
        return textResult(
          `The user has been on the WHOOP page for ${minutes} minutes. Stop calling whoop_login for now and ask them whether they're still connecting WHOOP or need help; call it again when they reply. The page stays open a while longer.`,
          data,
        );
      }
      return textResult(
        `Still waiting for the user (${minutes} min, ${status.problem ? "the page is showing them a problem to fix" : step}). ${again[0]!.toUpperCase()}${again.slice(1)}. Say nothing to the user meanwhile.`,
        data,
      );
    }
  }
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
  // No `capabilities: { tools: {} }` here: that makes the SDK install its tools/call handler in the constructor,
  // before instrumentTools can wrap it. The first registerTool declares the capability instead.
  const server = new McpServer({ name: "whoop-mcp", version: VERSION }, { instructions: INSTRUCTIONS });
  server.server.oninitialized = () => {
    const c = server.server.getClientVersion();
    // Capabilities decide whether richer UI (MCP Apps cards, URL elicitation) would work in this client.
    log.info("client connected", {
      client: c?.name,
      client_version: c?.version,
      capabilities: server.server.getClientCapabilities(),
    });
  };
  instrumentTools(server);

  server.registerTool(
    "whoop_status",
    {
      title: "WHOOP connection status",
      description:
        "Check whether the WHOOP account is connected: app credentials, login state (including a browser login started with whoop_login), granted scopes, token expiry and where the server's log file is. Makes no WHOOP API calls. Use this first if other whoop_ tools fail.",
      outputSchema: z.object({
        logged_in: z.boolean(),
        session_expired: z.boolean(),
        last_error: z.string().nullable(),
        app_credentials: z.enum(["env", "keychain", "file", "missing"]),
        login: z.object({
          state: z.enum(["idle", "pending", "succeeded", "failed"]),
          kind: z.enum(["setup", "login"]).optional(),
          authorize_url: z.string().optional(),
          error: z.string().optional(),
        }),
        token_file: z.string(),
        log_file: z.string().nullable(),
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
      // Optional call: tests pass a stub client without it.
      const { session_expired, last_error } = client.authProblem?.(tokens) ?? {
        session_expired: false,
        last_error: null,
      };
      const data = {
        logged_in: tokens !== null && !session_expired,
        session_expired,
        last_error,
        app_credentials,
        login: {
          state: login.state,
          ...(login.state === "pending" ? { kind: login.kind, authorize_url: login.authorizeUrl } : {}),
          ...(login.state === "failed" ? { error: login.error } : {}),
        },
        token_file: tokenPath(),
        log_file: log.settings().file,
        scopes,
        missing_scopes: tokens ? SCOPES.filter((s) => !scopes.includes(s)) : [...SCOPES],
        access_token_expires_in_s: tokens ? Math.round((tokens.expires_at - Date.now()) / 1000) : null,
        has_refresh_token: Boolean(tokens?.refresh_token),
        server_version: VERSION,
      };
      const summary =
        login.state === "pending"
          ? login.kind === "setup"
            ? `Waiting for the user to finish the setup page in the browser (${login.authorizeUrl}). Call whoop_login with wait_seconds to wait for it.`
            : `Waiting for the user to approve access in the browser (${login.authorizeUrl}). Call whoop_login with wait_seconds to wait for it.`
          : session_expired
            ? "The WHOOP session has expired or was revoked. Call whoop_login to reconnect."
            : data.logged_in
              ? app_credentials === "missing"
                ? "Logged in, but the WHOOP app credentials are gone, so the next token refresh will fail. Call whoop_login with reconfigure: true to enter them again."
                : data.last_error
                  ? `Logged in, but the last token refresh failed: ${data.last_error}`
                  : data.missing_scopes.length
                    ? `Connected, but without ${data.missing_scopes.join(", ")}, so some tools will fail. Call whoop_login and approve every permission.`
                    : "WHOOP is connected."
              : login.state === "failed"
                ? `The last login failed (${login.error}). Call whoop_login to try again, or with reconfigure: true to enter different WHOOP app credentials.`
                : app_credentials === "missing"
                  ? "No WHOOP app credentials yet: call whoop_login, which opens a setup page in the browser to enter them."
                  : "Not logged in: call whoop_login to sign in with the browser.";
      return jsonResult(data, summary);
    },
  );

  server.registerTool(
    "whoop_login",
    {
      title: "Connect WHOOP",
      description:
        "Connect the user's WHOOP account: opens a setup or approval page in their browser and waits for them to finish. Returns at once if WHOOP is already connected. While the result says pending, call it again with wait_seconds (it never reopens the page); never ask the user to tell you when they're done. The first time, the page walks the user through creating a free WHOOP developer app and pasting its Client ID and Secret. Use reconfigure: true only when the saved app is wrong (WHOOP rejected the client or the redirect URL) or the user wants a different app.",
      inputSchema: z.object({
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(45)
          .default(LOGIN_WAIT_SECONDS)
          .describe("Wait up to this many seconds for the user to finish in the browser before returning."),
        reconfigure: z
          .boolean()
          .default(false)
          .describe("Open the setup page to enter different WHOOP app credentials, even if some are saved."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ wait_seconds, reconfigure }, ctx) => {
      try {
        if (!reconfigure && loginFlow.status.state !== "pending" && (await isConnected(client))) {
          return connectedResult();
        }
        const before = loginFlow.status;
        const { authorizeUrl, kind } = await loginFlow.start({ reconfigure });
        // Problems already passed on to Claude aren't repeated on every call.
        const seenProblems = before.state === "pending" ? (before.problemSeq ?? 0) : 0;
        const status = await loginFlow.waitForChange(wait_seconds * 1000, ctx?.mcpReq?.signal);
        return loginResult(status, { first: before.state !== "pending", kind, url: authorizeUrl, seenProblems });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "whoop_disconnect",
    {
      title: "Disconnect WHOOP",
      description:
        "Disconnect the user's WHOOP account: revokes whoop-mcp's access at WHOOP and deletes the saved login on this computer. Only when the user asks to disconnect, log out or remove WHOOP access. With forget_app, also deletes the saved WHOOP app Client ID and Secret, so connecting again starts with the setup page. Asking about WHOOP data afterwards opens the connection page again.",
      inputSchema: z.object({
        forget_app: z
          .boolean()
          .default(false)
          .describe("Also delete the saved WHOOP app credentials (Client ID and Secret)."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ forget_app }) => {
      try {
        await loginFlow.cancel();
        // (Optional calls: tests pass a stub client.) A refresh mid-flight must save before the delete.
        await client.drain?.();
        const hadLogin = (await readTokens()) !== null;
        const revoked = hadLogin ? ((await client.revokeAccess?.()) ?? "failed") : "not_logged_in";
        await withTokenLock(deleteTokens);
        const forgot = forget_app ? await deleteStoredCredentials() : false;
        log.info("disconnected from WHOOP", { had_login: hadLogin, revoked, forget_app });
        const parts = [
          !hadLogin
            ? "WHOOP wasn't connected."
            : revoked === "revoked"
              ? "Disconnected from WHOOP: access was revoked at WHOOP and the saved login deleted."
              : "Deleted the saved WHOOP login, but couldn't revoke access at WHOOP (it may already have ended). The user can also remove the app's access in the WHOOP developer dashboard.",
          forget_app
            ? forgot
              ? "The saved WHOOP app credentials were deleted too."
              : "No saved app credentials to delete."
            : "",
        ];
        return textResult(parts.filter(Boolean).join(" "), {
          disconnected: true,
          revoked_at_whoop: revoked === "revoked",
          app_credentials_deleted: forgot,
        });
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
        return toolError(err, loginFlow);
      }
    },
  );

  registerDataTools(server, client, loginFlow);
  return server;
}
