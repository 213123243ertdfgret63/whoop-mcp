# whoop-mcp

An MCP server for the [WHOOP Developer API](https://developer.whoop.com) (v2), built on Bun. It reads data only, runs locally over stdio, and works with your own WHOOP developer app.

> Status: **M0 spike.** The tools so far are `whoop_status` and `whoop_profile`. See [RESEARCH.md](RESEARCH.md) for the plan and [docs/verification.md](docs/verification.md) for what has been confirmed.

Not affiliated with or endorsed by WHOOP. Nothing it returns is medical advice.

## Install as a Claude Code plugin

Needs [Bun](https://bun.sh) 1.4+ on your PATH and read access to this (private) repo through your git credentials (for example `gh auth login` followed by `gh auth setup-git`). In Claude Code:

```text
/plugin marketplace add 213123243ertdfgret63/whoop-mcp
/plugin install whoop@whoop-mcp
```

Or in one step on Claude Code 2.1.275 or later:

```text
/plugin install whoop --marketplace 213123243ertdfgret63/whoop-mcp
```

The install dialog asks for your WHOOP app's **Client ID** and **Client Secret** (the secret goes to your system keychain). If you don't have an app yet, create one at <https://developer-dashboard.whoop.com> with the redirect URI `http://localhost:8787/callback` and the read scopes. Then ask Claude to "set up WHOOP", or run `/whoop:setup`: it checks the configuration and calls the `whoop_login` tool, which opens WHOOP in your browser to approve access. No terminal needed.

- Change credentials later with `/plugin configure whoop@whoop-mcp`, then `/reload-plugins`.
- Tokens live in Claude Code's data folder for the plugin, so they survive updates and are deleted when you uninstall it.
- **Updates:** plugin users get a new version when a release bumps it. Run `/plugin marketplace update whoop-mcp` (or turn on auto-update for the marketplace under `/plugin` → Marketplaces), then `/reload-plugins`.

## Setup (from source)

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

## Versions and updating

The server logs `vX.Y.Z starting` to the client's MCP log, and the `whoop_status` tool reports `server_version`, so you can see which build a client is actually running. To print it yourself, run `bun run /path/to/whoop/src/index.ts --version` (from source) or `./whoop-mcp-<platform> --version` (binary). Changes are listed in [CHANGELOG.md](CHANGELOG.md).

To see the latest release (the repo is private, so this uses your `gh` login):

```bash
gh release view --repo 213123243ertdfgret63/whoop-mcp --json tagName,publishedAt
```

After updating, restart the MCP client (quit and reopen Claude Desktop, or `/mcp` → reconnect in Claude Code): stdio servers are started once and keep running the old code.

**From source.** Pull and reinstall; `bun install` also regenerates the API types:

```bash
git pull && bun install
```

`main` can be ahead of the last release, and the version shown only changes when a release is cut. To run exactly a released version instead, check out its tag: `git fetch --tags && git checkout v0.1.0 && bun install`.

**Prebuilt binary.** Download your platform's binary and the checksums from the latest [GitHub release](../../releases/latest), or with `gh`:

```bash
gh release download --repo 213123243ertdfgret63/whoop-mcp -p 'whoop-mcp-darwin-arm64' -p SHA256SUMS
shasum -a 256 -c SHA256SUMS --ignore-missing
chmod +x whoop-mcp-darwin-arm64
xattr -d com.apple.quarantine whoop-mcp-darwin-arm64 2>/dev/null || true  # only set on browser downloads
```

Downloads aren't executable until you `chmod +x` them, and the macOS binaries aren't notarized, hence the `xattr` line. Replace the old file, or point the client at the binary:

```json
{
  "mcpServers": {
    "whoop": { "command": "/absolute/path/to/whoop-mcp-darwin-arm64" }
  }
}
```

The first time a new binary reads the saved credentials, macOS may ask to allow Keychain access. Saved credentials and tokens live outside the install, so they survive updates.

### Cutting a release

```bash
bun run release patch --dry-run   # preview the version bump and changelog
bun run release patch --push      # or minor / major / x.y.z
```

From a clean `main` that's in sync with `origin`, this runs lint, typecheck and tests, bumps `package.json`, prepends `CHANGELOG.md` with the commits since the last tag, then commits and tags `vX.Y.Z` (rolling both back if anything fails). `--push` pushes `main` and the tag atomically. Pushing the tag runs `.github/workflows/release.yml`, which checks the tag matches `package.json` and is on `main`, reruns the checks, cross-compiles binaries for macOS, Linux and Windows, and publishes a GitHub release with checksums and the changelog notes.

## Development

| Command                                                 | What it does                                                                                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `bun test`                                              | Test suite (includes stdio smoke tests covering both MCP protocol eras)                                                              |
| `bun run typecheck`                                     | `tsc --noEmit`                                                                                                                       |
| `bun run lint` / `bun run format`                       | Biome check / Biome check with fixes applied                                                                                         |
| `bun run inspect`                                       | Opens MCP Inspector against the server                                                                                               |
| `bun run spec:update`                                   | Refreshes `openapi/whoop.yaml` from WHOOP's published spec (review with `git diff openapi/`)                                         |
| `bun run gen:types`                                     | Generates `src/whoop/openapi.d.ts` from `openapi/whoop.yaml`; runs automatically on `bun install`                                    |
| `bun run release <patch\|minor\|major>`                 | Cuts a release (see [Cutting a release](#cutting-a-release))                                                                         |
| `bun run build:plugin`                                  | Rebuilds the plugin bundle `plugin/server/whoop-mcp.js` (the pre-commit hook does this when `src/` changes; CI fails if it is stale) |
| `bun run build`                                         | Builds a single-file binary at `dist/whoop-mcp`                                                                                      |
| `bun scripts/m0-probe.ts <public\|login\|refresh\|api>` | The M0 verification probes (see `docs/verification.md`)                                                                              |

CI (`.github/workflows/ci.yml`) runs lint, typecheck, tests and a compiled-binary smoke test on Ubuntu and macOS for every push to `main` and every pull request. The Bun version comes from `.bun-version`.

A Husky pre-commit hook runs Biome on staged files, applying formatting and safe fixes; lint errors it can't fix block the commit.
