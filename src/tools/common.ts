import { NotLoggedInError, WhoopApiError } from "../whoop/client.ts";

export const READ_ONLY = { readOnlyHint: true, idempotentHint: true, openWorldHint: true } as const;
export const DISCLAIMER = "Not medical advice.";

export function errorResult(err: unknown) {
  const message =
    err instanceof NotLoggedInError || err instanceof WhoopApiError || err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

export function jsonResult<T extends Record<string, unknown>>(data: T, summary: string) {
  return {
    content: [{ type: "text" as const, text: `${summary}\n\n${JSON.stringify(data, null, 2)}` }],
    structuredContent: data,
  };
}
