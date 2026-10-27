# whoop-mcp

An MCP server for the [WHOOP Developer API](https://developer.whoop.com) (v2), built on Bun. It reads data only, runs locally over stdio, and works with your own WHOOP developer app.

> Status: **M0 spike.** The tools so far are `whoop_status` and `whoop_profile`. See [RESEARCH.md](RESEARCH.md) for the plan and [docs/verification.md](docs/verification.md) for what has been confirmed.

Not affiliated with or endorsed by WHOOP. Nothing it returns is medical advice.

## Setup

1. Install [Bun](https://bun.sh) 1.4 or later, then run `bun install`.
2. Run `bun run setup`. The wizard:
   - opens the [WHOOP developer dashboard](https://developer-dashboard.whoop.com) and tells you what to set: redirect URI `http://localhost:8787/callback` and the read scopes
   - asks for the app's Client ID and Client Secret once (the secret isn't echoed), checks them with WHOOP, and saves them to your system keychain (falling back to a private 0600 file when there's no keychain)
   - opens WHOOP in your browser so you can approve access; tokens are saved to `~/.config/whoop-mcp/tokens.json` (0600)

Later, `bun run login` signs in again with the saved app, `bun run status` shows what's configured, and `bun src/index.ts logout --forget-app` removes everything. `WHOOP_CLIENT_ID` / `WHOOP_CLIENT_SECRET` env vars (see `.env.example`) still override the saved credentials.

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
      "args": ["run", "/absolute/path/to/whoop/src/index.ts"]
    }
  }
}
```

## Development

| Command                                                 | What it does                                                                                      |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `bun test`                                              | Test suite (includes stdio smoke tests covering both MCP protocol eras)                           |
| `bun run typecheck`                                     | `tsc --noEmit`                                                                                    |
| `bun run lint` / `bun run format`                       | Biome check / Biome check with fixes applied                                                      |
| `bun run inspect`                                       | Opens MCP Inspector against the server                                                            |
| `bun run spec:update`                                   | Refreshes `openapi/whoop.yaml` from WHOOP's published spec (review with `git diff openapi/`)      |
| `bun run gen:types`                                     | Generates `src/whoop/openapi.d.ts` from `openapi/whoop.yaml`; runs automatically on `bun install` |
| `bun run build`                                         | Builds a single-file binary at `dist/whoop-mcp`                                                   |
| `bun scripts/m0-probe.ts <public\|login\|refresh\|api>` | The M0 verification probes (see `docs/verification.md`)                                           |

A Husky pre-commit hook runs Biome on staged files, applying formatting and safe fixes; lint errors it can't fix block the commit.
