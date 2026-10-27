// stdout belongs to the MCP stdio transport; everything human-readable goes to stderr.
export function log(...args: unknown[]): void {
  console.error("[whoop-mcp]", ...args);
}
