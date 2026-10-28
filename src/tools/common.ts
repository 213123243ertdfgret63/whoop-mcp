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
