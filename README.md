# whoop-mcp

An [MCP](https://modelcontextprotocol.io) server that gives Claude your [WHOOP](https://www.whoop.com) data: recovery, sleep, strain, workouts and profile. It uses WHOOP's official Developer API (v2) through your own free WHOOP developer app, reads data only, and runs locally on your computer.

> Status: early. The tools so far are `whoop_status`, `whoop_login` and `whoop_profile`. See [RESEARCH.md](RESEARCH.md) for the plan.

Not affiliated with or endorsed by WHOOP. Nothing it returns is medical advice.

## Install

On macOS or Linux, run:

```bash
curl -fsSL https://raw.githubusercontent.com/213123243ertdfgret63/whoop-mcp/main/install.sh | sh
```

The script:

1. Downloads the `whoop-mcp` binary for your platform from the [latest release](https://github.com/213123243ertdfgret63/whoop-mcp/releases/latest) and checks it against the release's `SHA256SUMS`. No Bun or Node is needed.
2. Installs it to `~/.whoop-mcp/bin/whoop-mcp`.
3. Adds a `whoop` MCP server to **Claude Code** (via `claude mcp add --scope user`, also used by the desktop app's Code tab) and to **Claude Desktop** (`claude_desktop_config.json`), whichever you have. Your other settings and servers are left as they are.

If the Claude desktop app is running, the installer asks **"Restart Claude now? [y/N]"**. The app rewrites its config when it quits, so it has to restart to keep the new entry:

- **Yes:** Claude quits (confirm if it asks), whoop is added once Claude has closed, and Claude reopens. If Claude doesn't quit, nothing is changed and the installer says what to run instead.
- **No:** quit Claude yourself (Cmd+Q), run `~/.whoop-mcp/bin/whoop-mcp claude add`, and reopen it.

In Claude Code, start a new session to pick up the server. `WHOOP_MCP_RESTART_CLAUDE=yes` or `=no` answers the question ahead of time. The uninstaller asks the same question.

Options, as environment variables before `sh`:

- `WHOOP_MCP_VERSION=0.1.0` installs a specific release.
- `WHOOP_MCP_INSTALL_DIR=…` installs somewhere else.
- `WHOOP_MCP_NO_CLAUDE=1` installs only the binary.

On Windows, download `whoop-mcp-windows-x64.exe` from the [latest release](https://github.com/213123243ertdfgret63/whoop-mcp/releases/latest) and run `whoop-mcp-windows-x64.exe claude add`.

## Connect your WHOOP account

Ask Claude to **"connect WHOOP"**. It calls the `whoop_login` tool, which opens a page in your browser:

1. **First time:** a setup page explains how to create a free app at the [WHOOP developer dashboard](https://developer-dashboard.whoop.com):
   - Set its redirect URI to `http://localhost:8787/callback`.
   - Turn on the read scopes.

   It then asks for the app's Client ID and Client Secret. It checks them with WHOOP (if WHOOP can't be reached, it saves them anyway) and saves them to your system keychain.
2. **Then:** it continues to WHOOP's consent screen. Approve access, tell Claude you're done, and it confirms with `whoop_status`.

After that, `whoop_login` goes straight to WHOOP's consent screen. If WHOOP shows an error (for example about the redirect URI or an unknown client), ask Claude to "set up WHOOP again" to enter different credentials. That calls `whoop_login` with `reconfigure: true`.

- The setup page runs only on your computer (`localhost`), behind a one-time link, and refuses requests from other websites.
- Tokens are stored in `~/.config/whoop-mcp/tokens.json` (owner-only). The app credentials are stored in your system keychain (service `whoop-mcp`), or in a private file next to the tokens when there's no keychain.
- If you prefer the terminal: `~/.whoop-mcp/bin/whoop-mcp setup`.

## Update

Run the install command again. It replaces the binary in place, so Claude's configuration stays valid. Then restart Claude, because MCP servers are started once and keep running the old version. Your saved login is kept.

The first time a new binary reads the saved credentials, macOS may ask you to allow keychain access.

To see which version you have:

- run `~/.whoop-mcp/bin/whoop-mcp --version`
- check the `server_version` field in `whoop_status`

Changes are listed in [CHANGELOG.md](CHANGELOG.md).

## Uninstall

```bash
curl -fsSL https://raw.githubusercontent.com/213123243ertdfgret63/whoop-mcp/main/uninstall.sh | sh
```

It removes `whoop` from Claude Code and Claude Desktop, deletes the saved WHOOP tokens and app credentials, and deletes `~/.whoop-mcp`. To keep the saved login for a later reinstall, run `… | sh -s -- --keep-data` instead.

You can also revoke the app's access, or delete the app, in the [WHOOP developer dashboard](https://developer-dashboard.whoop.com).

## Tools

| Tool            | What it does                                                                                                                  |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `whoop_status`  | Connection state: app credentials, login progress, granted scopes, token expiry and server version. Makes no WHOOP API calls. |
| `whoop_login`   | Connects your account in the browser (setup page first if needed). `reconfigure: true` re-enters the app credentials.         |
| `whoop_profile` | Your name, height, weight and max heart rate.                                                                                 |

## Run from source

```bash
git clone https://github.com/213123243ertdfgret63/whoop-mcp.git && cd whoop-mcp
bun install                   # Bun 1.4+; also generates the API types
bun src/index.ts claude add   # registers `bun …/src/index.ts` with Claude Code and Claude Desktop
```

`bun src/index.ts claude remove` unregisters it.

- **Credentials:** `WHOOP_CLIENT_ID` and `WHOOP_CLIENT_SECRET` env vars (see `.env.example`) take precedence over saved credentials, but only when both are set.
- **Updating:** `git pull && bun install`. `main` can be ahead of the last release. To run exactly a released version, check out its tag, for example `git checkout v0.1.0`.

### Cutting a release

```bash
bun run release patch --dry-run   # preview the version bump and changelog
bun run release patch --push      # or minor / major / x.y.z
```

From a clean `main` that's in sync with `origin`, this does the following:

1. Runs lint, typecheck and tests.
2. Bumps `package.json`.
3. Adds the commits since the last tag to `CHANGELOG.md`.
4. Commits and tags `vX.Y.Z`, rolling both back if anything fails.

`--push` pushes `main` and the tag together, so either both land or neither does.

Pushing the tag runs `.github/workflows/release.yml`. It checks that the tag matches `package.json` and is on `main`, reruns the checks, and cross-compiles binaries for macOS, Linux and Windows. It then publishes a GitHub release with checksums and the changelog notes. That release is what `install.sh` downloads.

## Development

| Command                                                 | What it does                                                                                                                 |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `bun test`                                              | Test suite, including stdio smoke tests for both MCP protocol versions and end-to-end tests of `install.sh` / `uninstall.sh` |
| `bun run typecheck`                                     | `tsc --noEmit`                                                                                                               |
| `bun run lint` / `bun run format`                       | Runs Biome's checks / runs them and applies fixes                                                                            |
| `bun run inspect`                                       | Opens MCP Inspector against the server                                                                                       |
| `bun run spec:update`                                   | Refreshes `openapi/whoop.yaml` from WHOOP's published spec (review with `git diff openapi/`)                                 |
| `bun run gen:types`                                     | Generates `src/whoop/openapi.d.ts` from `openapi/whoop.yaml`; runs automatically on `bun install`                            |
| `bun run release <patch\|minor\|major>`                 | Cuts a release (see [Cutting a release](#cutting-a-release))                                                                 |
| `bun run build`                                         | Builds a single-file binary at `dist/whoop-mcp`                                                                              |
| `bun scripts/m0-probe.ts <public\|login\|refresh\|api>` | The M0 verification probes (see `docs/verification.md`)                                                                      |
- **CI** (`.github/workflows/ci.yml`) runs lint, typecheck, tests and a compiled-binary smoke test on Ubuntu for every push to `main` and every pull request. Trigger it manually to include macOS. The Bun version comes from `.bun-version`.
- **Pre-commit hook:** a Husky hook runs Biome on staged files and applies formatting and safe fixes. Lint errors it can't fix block the commit.
