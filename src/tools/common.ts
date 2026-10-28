import type { LoginStatus } from "../auth/background-login.ts";
import { errorFields, log } from "../log.ts";
import { NotLoggedInError } from "../whoop/client.ts";

export const READ_ONLY = { readOnlyHint: true, idempotentHint: true, openWorldHint: true } as const;
export const DISCLAIMER = "Not medical advice.";

export function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

export function jsonResult<T extends Record<string, unknown>>(data: T, summary: string) {
  return {
    // Compact JSON: indentation adds about half again to every result, and structuredContent carries the object.
    content: [{ type: "text" as const, text: `${summary}\n\n${JSON.stringify(data)}` }],
    structuredContent: data,
  };
}

/** What a tool needs from the login flow to start one by itself. */
export interface AutoLogin {
  startIfIdle(): Promise<LoginStatus | null>;
}

/** How long whoop_login should be asked to wait per call; under Claude's roughly 60s tool-call limit. */
export const LOGIN_WAIT_SECONDS = 40;

/**
 * The result for a tool that found no WHOOP login: it starts one (opening the browser), so the user only ever
 * asks their question, and tells Claude to wait for it with whoop_login and then retry. Falls back to the plain
 * error when no login could be started (e.g. one failed a moment ago).
 */
export async function notConnectedResult(err: NotLoggedInError, loginFlow?: AutoLogin) {
  if (!loginFlow) return errorResult(err);
  let status: LoginStatus | null;
  try {
    status = await loginFlow.startIfIdle();
  } catch (startErr) {
    log.warn("could not start a WHOOP login on demand", errorFields(startErr));
    return errorResult(err);
  }
  if (status?.state !== "pending") return errorResult(err);
  const what = status.kind === "setup" ? "a WHOOP setup page" : "WHOOP's approval page";
  const say =
    status.kind === "setup"
      ? "I've opened a page in your browser to connect WHOOP (about 5 minutes the first time); I'll carry on when you're done."
      : "I've opened WHOOP in your browser; approve access there and I'll carry on.";
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: `WHOOP isn't connected, so ${what} is open in the user's browser (if it didn't open, the user can visit ${status.authorizeUrl}). Tell the user in one sentence, e.g. "${say}" Then call whoop_login with wait_seconds=${LOGIN_WAIT_SECONDS}, keep calling it while it says pending, and call this tool again once it reports connected. Don't ask the user to say when they're done.`,
      },
    ],
  };
}

/** errorResult, except a missing login starts one (see notConnectedResult). */
export function toolError(err: unknown, loginFlow?: AutoLogin) {
  return err instanceof NotLoggedInError ? notConnectedResult(err, loginFlow) : errorResult(err);
}
