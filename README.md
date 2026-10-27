# whoop-mcp

An MCP server for the [WHOOP Developer API](https://developer.whoop.com) (v2), built on Bun. It reads data only, runs locally over stdio, and works with your own WHOOP developer app.

> Status: **M0 spike.** The tools so far are `whoop_status` and `whoop_profile`. See [RESEARCH.md](RESEARCH.md) for the plan and [docs/verification.md](docs/verification.md) for what has been confirmed.

Not affiliated with or endorsed by WHOOP. Nothing it returns is medical advice.

## Setup

1. Install [Bun](https://bun.sh) 1.4 or later, then run `bun install`.
2. Create a WHOOP developer app at <https://developer-dashboard.whoop.com>:
   - Set the redirect URI to `http://localhost:8787/callback`.
   - Turn on these scopes: `read:profile`, `read:body_measurement`, `read:cycles`, `read:recovery`, `read:sleep`, `read:workout`. The `offline` scope is requested automatically.
3. Copy `.env.example` to `.env` and fill in `WHOOP_CLIENT_ID` and `WHOOP_CLIENT_SECRET`.
4. Run `bun run login` to authorize in your browser. Tokens are saved to `~/.config/whoop-mcp/tokens.json` with mode 0600.

## Use with Claude Code

```bash
claude mcp add whoop -- bun run /absolute/path/to/whoop/src/index.ts
```

For Claude Desktop, add the following to `claude_desktop_config.json`. Use absolute paths, because GUI apps may not inherit your shell's PATH:

```json
{
  "mcpServers": {
    "whoop": {
      "command": "/opt/homebrew/bin/bun",
      "args": ["run", "/absolute/path/to/whoop/src/index.ts"],
      "env": { "WHOOP_CLIENT_ID": "…", "WHOOP_CLIENT_SECRET": "…" }
    }
  }
}
```

## Development

| Command | What it does |
|---|---|
| `bun test` | Stdio smoke tests covering both MCP protocol eras (2026-07-28 and 2025-11-25) |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run inspect` | Opens MCP Inspector against the server |
| `bun run gen:types` | Regenerates `src/whoop/openapi.d.ts` from WHOOP's OpenAPI spec |
| `bun run build` | Builds a single-file binary at `dist/whoop-mcp` |
| `bun scripts/m0-probe.ts <public\|login\|refresh\|api>` | The M0 verification probes (see `docs/verification.md`) |
