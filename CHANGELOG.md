# Changelog

## v0.6.0 (2026-10-29)

- Delete the saved WHOOP app credentials on disconnect (c9350ef)
- Add Connect WHOOP and Disconnect WHOOP prompts (b7d2809)

## v0.5.0 (2026-10-28)

- Show the extension as "WHOOP (unofficial)" in Claude Desktop (3ef4659)
- Fix review findings in disconnect and the permission check (ee11e99)
- Add whoop_disconnect and refuse logins missing permissions (4af7981)

## v0.4.0 (2026-10-28)

- Fix review findings in the new connect flow (69a92b5)
- Connect WHOOP with minimal input: Claude waits, the page does the rest (5ebfaa4)
- Fix audit findings and remove leftovers from before the extension (8040780)

## v0.3.0 (2026-10-28)

- **Breaking:** whoop-mcp now installs only as a Claude Desktop extension (`.mcpb`). `install.sh`, `uninstall.sh`, `whoop-mcp claude add/remove` and Claude Code support are gone. Remove a pre-0.3 `whoop` server first (see the README's Install section).
- Ship as a Claude Desktop extension and log to a file (58e29df)
- Explain what the server can do in the README (04348bb)

## v0.2.1 (2026-10-28)

- Fix dead logins, whoop_today gaps and oversized output (v0.2.1 fixes) (9fed2ae)

## v0.2.0 (2026-10-27)

- Add WHOOP data tools for coaching (7e3a183)
- Explain every WHOOP app field on the setup page (98046a7)
- Make the fake Claude process visible to ps on Linux in installer tests (8aa0eaa)
- Offer to restart Claude Desktop from the installer and uninstaller (e8af76c)
- Warn when the Claude desktop app is running during install (0e2c2d4)
- Add roadmap note on a remote mode for claude.ai web and mobile (5496fd6)

## v0.1.0 (2026-10-27)

- Switch to MCP-only: one-line install/uninstall and browser setup (62cc751)
- Package as a Claude Code plugin with in-client browser login (50a0e9e)
- Add versioning, release script and GitHub Actions CI/release workflows (d49678a)
- Add setup wizard with keychain credential storage and public-client probe (bd1854f)
- Expand test suite to 146 tests and fix the bugs it found (482f345)
- Add bun version skill, Biome + Husky, and vendored OpenAPI spec (86c7e3f)
- Scaffold WHOOP MCP server and M0 verification spike (9b312b7)
