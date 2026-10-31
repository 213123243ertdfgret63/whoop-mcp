# whoop-mcp rewrite plan

A plan for rebuilding whoop-mcp one feature at a time. Every current feature and every new idea has an ID, my recommendation, and a cost. You choose what stays: fill in the **Your pick** column in the [decision sheet](#decision-sheet) at the end (keep / change / cut / later), and the build order follows from what's left.

Written 2026-10-31 from [FUNCTIONALITY.md](FUNCTIONALITY.md) (what exists today, in full detail) and fresh research into the WHOOP API, other WHOOP and health-data MCP servers, the MCP spec and Claude's extension platform. Four independent reviewers then checked the draft against the code, FUNCTIONALITY.md and the sources, and a second pass tried to refute each finding; the 39 that held are folded in. Sources are at the [end](#sources). Anything marked _unverified_ needs checking before we build on it.

Cost: **S** is under a day, **M** a few days, **L** a week or more.

## Contents

1. [What the research changed](#1-what-the-research-changed)
2. [Foundations: decide these first](#2-foundations-decide-these-first)
3. [Current features, in build order](#3-current-features-in-build-order)
4. [Known quirks to decide](#4-known-quirks-to-decide)
5. [New feature ideas](#5-new-feature-ideas)
6. [Not doing, and why](#6-not-doing-and-why)
7. [How the rebuild runs](#7-how-the-rebuild-runs)
8. [Open questions to verify](#8-open-questions-to-verify)
9. [Decision sheet](#decision-sheet)
10. [Sources](#sources)

## 1. What the research changed

The short version, so the rest makes sense:

- **We already use nearly the whole public WHOOP API.** All six read scopes, 11 of the 12 GET endpoints (all but the v1→v2 activity-ID mapping, which only matters for migrating from v1), plus revoke. The only unused feature is **webhooks**, and WHOOP has to POST to them over HTTPS from the internet, so a local extension can't receive them. Everything people ask for that's missing (journal, stress, VO2 max, Healthspan, hypnogram, live heart rate) is app-only or needs WHOOP's private API. So the rewrite can't add new _data_; it can add better _analysis, presentation and setup_.
- **WHOOP's API terms limit storage.** §4.2.2 forbids databases or "permanent copies" of WHOOP Data and caches kept longer than the cache headers allow, unless "expressly authorized by the WHOOP Data owner or by applicable law" (the terms don't define the owner). §4.2.3 forbids training models on it; §7.1 requires deleting cached or stored content when access ends. We read this conservatively, which rules out the local-SQLite-history design several other WHOOP servers use. A short in-memory cache is _likely_ fine, within whatever cache headers WHOOP sends (not checked yet).
- **Two term items are still open in today's code.** §2.4 asks for encryption at rest, and `tokens.json` is plaintext (0600); §4.2.1 asks for explicit opt-in before data reaches third parties, and the model provider arguably is one. Both are decisions now: L11 and L12.
- **The extension directory no longer takes `.mcpb` files.** Anthropic now lists local servers only inside **plugins**, and a plugin's local MCP server is ignored in Claude Desktop's chat (it loads in Claude Code and Cowork). So for Desktop chat, sideloading the `.mcpb` stays the way to install. (Directory listing was never a goal, but it decides how skills should ship.)
- **Plugins are the official way to ship skills.** A plugin installed on the claude.ai account (Customize > Plugins) loads its skills in chat, Cowork and Claude Code; one installed from Claude Code's CLI stays on that machine. Either could replace the server writing files into `~/.claude/skills`.
- **MCP Apps render in Claude Desktop, from local stdio servers too.** A tool can return an interactive `ui://` page (charts, a dashboard) shown inline in the chat. Claude Code doesn't render them, so text output must stay complete.
- **The MCP spec moved on, and we're already there.** Revision 2026-07-28 is stateless (no `initialize`, a new `server/discover`), deprecates sampling, roots and protocol logging, replaces server-initiated requests (elicitation, sampling, roots) with multi-round-trip results, and recommends a fixed tool order. Our SDK (`@modelcontextprotocol/server` 2.4.0) and server already serve both 2026-07-28 and 2025-11-25, and the smoke test checks both. What Desktop negotiates is the open part.
- **Claude requires `readOnlyHint` and `destructiveHint` on every tool.** Today's read-only tools set only `readOnlyHint`; that's a fix (S1). Anthropic's connector docs also give about 150,000 characters per result and a 240 s timeout in chat, documented for remote connectors (whether they bind local `.mcpb` servers is _unverified_). Claude Code warns at 10k tokens, caps at 25k by default, and saves any text result over 50,000 characters to a file.
- **Anthropic's tool-design advice favours fewer, workflow-level tools** with a concise/detailed switch over many thin ones. We have 14. Honest finding after review: merging only saves one or two tools here (F4); the concise/detailed switch (D11) is the bigger win.
- **Other WHOOP servers' best ideas:** a local chart dashboard, prompt templates (weekly review, sleep analysis), baselines with anomaly flags, a demo mode with synthetic data, an "aggregate only" privacy mode, and importing WHOOP's own CSV export for journal data and long history.
- **The Node port opened Windows.** The browser opener and log path already handle win32; the manifest's platform list, the keychain and some macOS wording are what's left (F3d).

## 2. Foundations: decide these first

These shape everything else. Each has a recommendation; the features in section 3 assume it.

### F1. Where it runs: local extension (recommended) or remote server

|                            | Local `.mcpb` (today)                             | Remote connector                                                                           |
| -------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Works in                   | Claude Desktop chat, Claude Code (manually added) | claude.ai web, mobile, Desktop, Cowork, Claude Code                                        |
| Health data passes through | the user's own computer                           | a server you host                                                                          |
| You run                    | nothing                                           | a public HTTPS service holding every user's WHOOP tokens, with a privacy policy and upkeep |
| Webhooks                   | not reachable                                     | possible                                                                                   |
| Login                      | loopback setup page                               | Claude's connector OAuth, with WHOOP behind it                                             |

**Recommend: stay local.** It's a personal-data tool, each user has their own WHOOP app anyway, and hosting other people's health tokens is real liability (and WHOOP's terms on third parties, §3.1.3 and §4.2.1, would need re-reading). Keep remote as a later option; [roadmap.md](roadmap.md) already sketches it.

### F2. Dev toolchain: Node-only (recommended) or keep Bun for development

The shipped code runs on Node, but we develop and test on Bun. That mismatch already bit us: Bun's `node:http` differs from Node's, so the loopback server needs a separate Node test suite, and the type stripping differs (the `KeychainError` parameter property).

**Recommend: Node 24 for everything.** TypeScript checked by `tsc` (run with Node's type stripping or bundled by esbuild/tsdown), tests on `node:test` or Vitest. One runtime, so a passing test means it works in Desktop.

What has to move off Bun: 20 `bun:test` files (`spyOn`, plus 14 `Bun.serve` fakes that become `node:http`, `Bun.spawn`, `Bun.sleep`, `Bun.file`); the test preload (from `bunfig.toml` to `node --import` or Vitest `setupFiles`); `scripts/build-mcpb.ts` (Bun shell, `Bun.write`, `bun build`), `release.ts` (Bun shell, `Bun.argv`), `update-spec.ts` (`Bun.YAML`, needs a `yaml` dependency); the `bunx` scripts (`gen:types`, `inspect`); `.bun-version` and setup-bun in both workflows; the `whoop-reset` script and its `bun src/index.ts logout` call. The `.claude/skills/bun` project skill and `test/bun-skill.test.ts` lose their purpose (P10). **Cost: M–L.**

### F3. Packaging

- **F3a.** `.mcpb` with `server.type: "node"`, built-in Node, ~0.2 MB (today). **Keep.**
- **F3b.** Manifest gaps: light and dark `icons`, and a minimum `compatibility.claude_desktop`. `privacy_policies` is already set, but it points at a README section; write a real `PRIVACY.md` (what goes to WHOOP, what the model sees, what's stored: the tokens file and app credentials) and point to that. **S. Recommend.**
- **F3c.** Sign the bundle with `mcpb sign`. **Blocked:** Desktop refuses bundles signed by mcpb 2.1.2 (mcpb#278), which is why they're unsigned today. **Later**, once that's fixed.
- **F3d.** Windows build. Same bundle; `compatibility.platforms` (hard-coded to `darwin` today) gains `win32`; credentials use the 0600 file store (`WHOOP_MCP_CREDENTIAL_STORE=file` already exists) or Windows Credential Manager later; check the existing `explorer` opener with URLs that carry a query string; reword the macOS-only text ("Keychain Access" messages, the log path in the long description). **M. Optional**, only if you want Windows users.
- **F3e. An npm package, alongside or instead of the `.mcpb`.** This is how most other WHOOP servers ship, for example izqui/whoop-mcp: the user adds `"command": "npx", "args": ["-y", "whoop-mcp"]` to `claude_desktop_config.json`, or runs `claude mcp add whoop -- npx -y <package>` in Claude Code. That one takes a pasted `WHOOP_ACCESS_TOKEN`, which expires within about an hour and is never refreshed, so it isn't a model for login. Ours wouldn't change there: login already runs in chat through `whoop_login` and the setup page, and the keychain items belong to `/usr/bin/security` whatever launches the server, so the same code works from `npx`.

  |                            | (a) `.mcpb` only (today)                            | (b) `.mcpb` + npm                     | (c) npm only                                                              |
  | -------------------------- | --------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------- |
  | Desktop chat               | Double-click install, built-in Node, install dialog | Same                                  | Edit the config JSON by hand; needs the user's own Node on Desktop's PATH |
  | Claude Code, other clients | Point at the unpacked bundle by hand                | One `claude mcp add` line             | Same                                                                      |
  | Updates                    | User downloads each release                         | Bundle as today; npm pinned or latest | `npx -y` with no version fetches the latest on every launch               |
  | Release work               | Build, (later) sign, upload the bundle              | Both                                  | `npm publish` only; no manifest, icons, F3b or F3c                        |
  | Risks                      | mcpb#278 blocks signing                             | Two channels to keep in step          | Supply chain: an npm account takeover reaches every user on next launch   |

  Notes for (b) and (c): the name `whoop-mcp` is taken on npm (izqui's package), so it needs a scoped name; publish from GitHub Actions with npm trusted publishing and provenance, and document a pinned version (`npx -y <package>@1.2.3`) rather than latest; the `bin` entry runs `serve`. Needs F2 (Node-only) first, since the package is the same `server/index.mjs`. **S once F2 is done. Recommend (b):** the `.mcpb` stays the easy path for Desktop chat, and npm gives Claude Code users a one-line install. Pick (c) if you'd rather drop bundle and signing work and accept a config-file install in Desktop.

### F4. Shape of the tool surface

Today: 14 tools, 10 data tools plus `whoop_status`, `whoop_login`, `whoop_disconnect` and `whoop_profile`.

- **F4a. Keep all 14** as they are. Lowest risk; descriptions are tuned and tested.
- **F4b. Merge `whoop_trends` and `whoop_baselines` into `whoop_metric`** (recommended): 13 tools. They overlap (both are "one metric's stats over a window"), and one call that returns both the trend and where a date sits in the personal range is what Claude usually wants.
- **F4c. F4b plus fold `whoop_profile` into `whoop_status`:** 12 tools.

Cutting `whoop_get_record` was in the draft; review showed it's the only way to see an original WHOOP record older than 7 days (`raw` is capped at 7), so it stays (D10).

### F5. How skills and slash commands ship

- **F5a.** Server writes `/whoop-connect`, `/whoop-disconnect`, `/whoop-status` into `~/.claude/skills` on start (today, with a toggle in the extension settings, on by default). Works, but it's the server editing the user's config, and it needs marker, ownership and cleanup logic, plus the reset script's removal step.
- **F5b.** MCP prompts only. Desktop shows them under **+**; Claude Code lists them as `/<server>:<prompt> (MCP)`, e.g. `/whoop:whoop-status`, when the server is added there.
- **F5c.** A plugin (a marketplace repo) carrying the skills, installed separately. Skills that sync across surfaces when installed on the account and don't need the server running, but a second thing to install.

**Recommend F5b, with F5c later if you want skills outside Desktop.** Dropping F5a removes `src/skills.ts`, its toggle (`claude_code_commands`), `WHOOP_MCP_INSTALL_SKILLS`, the `CLAUDE_CONFIG_DIR` handling, its tests and part of the reset skill. It needs a migration step for existing installs (P2).

## 3. Current features, in build order

Each feature lists what it does today (one line; FUNCTIONALITY.md has the full spec), my recommendation, and the cost to rebuild. The order is the order I'd build them in: each step leaves a working, testable server.

### Step 0: Toolchain and safety rails

Built first, because every later step ports tests, and step 3's tests touch the keychain and the login port.

| ID  | Feature           | Today                                                                                                                                                                                                                       | Recommend                                                                                                                         | Cost |
| --- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---- |
| P6  | Test safety rails | A preload forces the file credential store, swaps `security` for a script that refuses everything (`WHOOP_MCP_SECURITY`), and clears `WHOOP_CLIENT_ID`/`SECRET` so no test binds 8787; keychain tests use a fake `security` | **Keep, and port first.** No test from steps 1–3 lands before it. Non-negotiable: the suite once overwrote the real keychain item | S    |
| P7  | CI                | Lint, typecheck, unit tests, Node tests, build the bundle and run it (Ubuntu, Node 24)                                                                                                                                      | **Keep**, set up here                                                                                                             | S    |
| P8  | Pre-commit hook   | Biome check on staged files                                                                                                                                                                                                 | **Keep**                                                                                                                          | S    |
| F2  | Toolchain         | Bun for dev, Node at runtime                                                                                                                                                                                                | Per F2                                                                                                                            | M–L  |

### Step 1: Skeleton

| ID  | Feature               | Today                                                                                                                                                                                                                                                                                                                                                                   | Recommend                                                                                                                                                                                                                                                                                                                                                                        | Cost |
| --- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| S1  | MCP server over stdio | Official SDK, serves revisions 2026-07-28 (`server/discover`) and 2025-11-25 (`initialize`), smoke-tested                                                                                                                                                                                                                                                               | **Keep**, fixed tool order. **Change:** every tool declares `readOnlyHint` and `destructiveHint` explicitly (the shared read-only set lacks `destructiveHint` today), with a test over all tools                                                                                                                                                                                 | S    |
| S2  | Server instructions   | A paragraph telling Claude how WHOOP days work, to start with `whoop_today`, not to give medical advice                                                                                                                                                                                                                                                                 | **Keep**, rewrite for the final tool list                                                                                                                                                                                                                                                                                                                                        | S    |
| S3  | Logging               | Per-platform log file (`~/Library/Logs/whoop-mcp/` on macOS), rotated at 5 MiB × 3; one line per tool call with timing; a `redact()` pass as last defence so tokens, secrets and health values never land; a `client connected` line with the client's capabilities                                                                                                     | **Keep**                                                                                                                                                                                                                                                                                                                                                                         | S    |
| S4  | Graceful shutdown     | On stdin close, SIGTERM, SIGINT or SIGHUP (replacing Desktop's built-in handlers), waits up to 1.5 s (under Desktop's 2 s gap before it kills) for an in-flight token refresh to save and the login page to close, then exits                                                                                                                                           | **Keep** (it protects single-use refresh tokens)                                                                                                                                                                                                                                                                                                                                 | S    |
| S5  | Process id files      | `<config>/run/<pid>` so the reset skill can find and stop the server                                                                                                                                                                                                                                                                                                    | **Keep only if** the reset skill (P5) stays                                                                                                                                                                                                                                                                                                                                      | S    |
| S6  | CLI                   | `serve`, `setup`, `login`, `status`, `logout [--keep-app]` (plus the old `--forget-app` alias), `version`, `help`                                                                                                                                                                                                                                                       | **Change:** keep `serve`, `status`, `logout --keep-app` (the reset skill uses it), `version`, `help`; drop `setup`, `login` and their prompt code (`runSetup`, secret entry via `stty`); drop the `--forget-app` alias. Move `openUrl` and `verifyCredentials` into `auth/`, since the browser flow uses them. Claude Code users get the same browser flow through `whoop_login` | S    |
| S7  | Environment variables | `WHOOP_CLIENT_ID`/`SECRET` (override stored credentials), `WHOOP_REDIRECT_URI` (the only way off port 8787), `WHOOP_MCP_HOME` and `XDG_CONFIG_HOME` (config dir), `WHOOP_MCP_CREDENTIAL_STORE=file`, `WHOOP_MCP_SECURITY`, `WHOOP_MCP_NO_BROWSER`, `WHOOP_MCP_LOG_LEVEL`/`LOG_FILE`/`LOG_STDERR_LEVEL`, `WHOOP_MCP_INSTALL_SKILLS`, `CLAUDE_CONFIG_DIR`; `.env.example` | **Keep all**, except the last two if P2 is cut. Tests depend on `WHOOP_REDIRECT_URI`, `WHOOP_MCP_HOME`, `WHOOP_MCP_CREDENTIAL_STORE` and `WHOOP_MCP_SECURITY`                                                                                                                                                                                                                    | S    |

### Step 2: WHOOP API client

| ID  | Feature          | Today                                                                                                                                                                                                                                                                                                       | Recommend                                                                                                             | Cost |
| --- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---- |
| A1  | Typed client     | Types generated from WHOOP's vendored OpenAPI spec (`openapi/whoop.yaml`, `spec:update`)                                                                                                                                                                                                                    | **Keep**                                                                                                              | S    |
| A2  | Request handling | 20 s per-request timeout (25 s when waiting on a refresh); one retry after a 401 (re-read the tokens file, else refresh); up to 2 retries on 429, waiting `Retry-After` or `X-RateLimit-Reset` (capped at 30 s, 2 s default); **no** retry on 5xx or network errors; errors carry status, path and trace id | **Keep. Decide:** add one retry for 502/503/504 and network errors (the calls are all idempotent GETs)                | M    |
| A3  | Token refresh    | Refresh before expiry; one refresh at a time (WHOOP refresh tokens are single-use, so two parallel refreshes would log the user out)                                                                                                                                                                        | **Keep.** The most important correctness rule in the project                                                          | M    |
| A4  | Pagination       | `listAll` over `nextToken`, 25 per page                                                                                                                                                                                                                                                                     | **Keep**                                                                                                              | S    |
| A5  | Live-API quirks  | `percent_recorded` is 0–1, not 0–100; `step_count` exists on cycles though undocumented. No User-Agent is set (Node sends its default); WHOOP's Cloudflare refuses some generic agents, but Node's hasn't been checked                                                                                      | **Keep** the two fixes with their tests. **Add** an explicit `whoop-mcp/<version>` User-Agent, test it, check it live | S    |
| A6  | Revoke           | `DELETE /v2/user/access` on disconnect and on a partial grant                                                                                                                                                                                                                                               | **Keep**                                                                                                              | S    |

### Step 3: Login and credentials

| ID  | Feature                         | Today                                                                                                                                                                                                                                                                                                                         | Recommend                                                                                                                                                                                                                                                                                                                           | Cost |
| --- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| L1  | Bring-your-own WHOOP app        | Each user creates a WHOOP developer app; no shared credentials (WHOOP's terms, §3.2.1, keep them out of open-source projects)                                                                                                                                                                                                 | **Keep** (required)                                                                                                                                                                                                                                                                                                                 | —    |
| L2  | Browser setup page              | One-time link on `localhost:8787/setup`: walks through creating the WHOOP app, takes the Client ID and Secret, verifies them with WHOOP, runs consent on the same server, shows "connected". One-time token, Host/Origin checks, rate-limited verify (10/min), 20 min idle and 60 min hard timeouts, a no-JavaScript fallback | **Keep.** The best part of the UX. **Change:** split the 890-line module (page HTML apart from the state machine), behaviour unchanged, old tests ported first                                                                                                                                                                      | L    |
| L3  | Consent-only login              | When credentials exist but tokens don't, opens WHOOP's approval page directly                                                                                                                                                                                                                                                 | **Keep**                                                                                                                                                                                                                                                                                                                            | S    |
| L4  | Background login                | Login runs in the background so tool calls return at once; Claude polls it with `whoop_login`                                                                                                                                                                                                                                 | **Keep**                                                                                                                                                                                                                                                                                                                            | M    |
| L5  | Auto-connect from any tool      | A data tool called while disconnected opens the setup or approval page and tells Claude what to say                                                                                                                                                                                                                           | **Keep**                                                                                                                                                                                                                                                                                                                            | S    |
| L6  | All-scopes-or-nothing           | A partial grant is revoked and refused with a clear message                                                                                                                                                                                                                                                                   | **Keep**                                                                                                                                                                                                                                                                                                                            | S    |
| L7  | App credentials in the keychain | Through `/usr/bin/security` (stable owner across versions), 0600 file fallback, env vars override                                                                                                                                                                                                                             | **Keep.** _Alternative:_ the manifest's `user_config` with `sensitive: true`, stored by Desktop. Drops our keychain code but loses the setup page's paste step and the `reconfigure` path, and whether Desktop uses the keychain is _unverified_. I'd keep ours                                                                     | M    |
| L8  | Tokens file                     | `~/.config/whoop-mcp/tokens.json`, 0600, plaintext                                                                                                                                                                                                                                                                            | **Keep**, subject to L11                                                                                                                                                                                                                                                                                                            | S    |
| L9  | Callback server details         | Binds both 127.0.0.1 and ::1 for `localhost`, exclusive bind, refuses if either half of the port is taken, checks `state`                                                                                                                                                                                                     | **Keep** (security)                                                                                                                                                                                                                                                                                                                 | S    |
| L10 | URL-mode elicitation for login  | — (new)                                                                                                                                                                                                                                                                                                                       | **Later, Claude Code only.** Claude Code asks the user before opening the URL (v2.1.287+, or a 2026-07-28 connection). On 2026-07-28 elicitation is an `input_required` result and a client retry, not a server request, so L4's wait has to be designed around a retry. Desktop chat support is _unverified_; the setup page stays | S–M  |
| L11 | Tokens at rest                  | Plaintext 0600 file; WHOOP ToU §2.4 asks for encryption at rest (flagged open in the code)                                                                                                                                                                                                                                    | **Decide:** (a) move the tokens into the keychain next to the app credentials, (b) encrypt the file with a key kept in the keychain, or (c) keep it and record why. I'd pick (b): one small keychain item, the file format otherwise unchanged, file store as fallback                                                              | M    |
| L12 | Data-sharing notice             | Not built (planned in the original research for ToU §4.2.1)                                                                                                                                                                                                                                                                   | **Add:** one line on the setup page, before consent, saying WHOOP data will be sent to the AI model the user chats with, and a checkbox to agree                                                                                                                                                                                    | S    |

### Step 4: Connection tools

| ID  | Feature            | Today                                                                                                                                                                                                                                                      | Recommend                                                                                                                                  | Cost |
| --- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| C1  | `whoop_status`     | Connected or not, credential source, token expiry, what to do next                                                                                                                                                                                         | **Keep**                                                                                                                                   | S    |
| C2  | `whoop_login`      | Starts or waits on the login. `wait_seconds` 0–45 (default 40, sized for an assumed 60 s call limit); `reconfigure` forces the setup page (the only fix for rejected or wrong app credentials); after 15 minutes of polling Claude stops and asks the user | **Keep. Re-measure** `wait_seconds` against Desktop's real limit (240 s if the connector figure applies; then 0–120 would cut the polling) | S    |
| C3  | `whoop_disconnect` | Revokes at WHOOP, deletes tokens; `keep_app` (default false) keeps the app credentials                                                                                                                                                                     | **Keep**, default unchanged (deleting is the v0.6.0 choice, so a reconnect starts clean)                                                   | S    |
| C4  | `whoop_profile`    | Name, height, weight, max HR; email only with `include_email`                                                                                                                                                                                              | **Keep** (or fold into status, F4c)                                                                                                        | S    |

### Step 5: Day model and shared data rules

The core of the analysis. Everything in step 6 sits on it.

| ID  | Feature              | Today                                                                                                                                                                                                                                          | Recommend                                                                             | Cost |
| --- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---- |
| M1  | WHOOP-day assembly   | Joins cycle, recovery, sleep and workouts into one row per WHOOP day (sleep to sleep, not midnight to midnight), with the still-running day marked `in_progress`                                                                               | **Keep.** The hardest logic; port its tests first                                     | M    |
| M2  | Local dates          | Ranges and "today" use the computer's clock; sleeps dated by their end, workouts by their start                                                                                                                                                | **Keep**                                                                              | S    |
| M3  | Range rules          | `start_date`/`end_date`/`days`, max 90 days, no future dates; every fetch adds 2 days each side; the baseline tools (today, baselines, training_load) fetch 7 extra days so a still-running day keeps its history                              | **Keep**                                                                              | S    |
| M4  | 20 metrics           | recovery, HRV, RHR, SpO2, skin temp, sleep (hours, needed, deep, REM, performance, efficiency, consistency), respiratory rate, disturbances, strain, kcal, avg HR, steps, workout minutes and count                                            | **Keep**; candidates to add in N20                                                    | S    |
| M5  | Partial-day handling | Day-total metrics drop the running day so it doesn't read as a low day                                                                                                                                                                         | **Keep**                                                                              | S    |
| M6  | `data_quality` block | Missing days, truncation, first data date, so Claude says when history is thin                                                                                                                                                                 | **Keep**                                                                              | S    |
| M7  | Statistics           | Mean, median, SD, percentiles, slope per week, rolling 7-day mean, z-score, Pearson and Spearman                                                                                                                                               | **Keep**                                                                              | S    |
| M8  | `raw` option         | Original WHOOP records alongside, limited to 7 days                                                                                                                                                                                            | **Keep**                                                                              | S    |
| M9  | Result contract      | Data tools and profile: a summary line plus compact JSON in the text, the same object in `structuredContent`, and "Not medical advice."; connection tools: a sentence plus `structuredContent`. Only `whoop_status` declares an `outputSchema` | **Keep. Add** `outputSchema` to the remaining tools (harmless; helps Apps and agents) | S    |
| M10 | Zone legend          | Descriptions explain WHOOP zones are % of heart-rate reserve, not % of max HR                                                                                                                                                                  | **Keep** (Claude gets it wrong otherwise)                                             | —    |

### Step 6: Data tools

<a id="data-tools"></a>

| ID    | Tool                               | What it answers                                                                                                                                                                                          | Recommend                                                                                                                                                                                                                                                                    | Cost |
| ----- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| D1    | `whoop_today`                      | "How am I today?": sleep, recovery, strain, workouts, each vs the last 30 days; any past `date`                                                                                                          | **Keep** (N3's flags join it later if picked)                                                                                                                                                                                                                                | M    |
| D2    | `whoop_daily_summaries`            | One row per day over a range, with averages                                                                                                                                                              | **Keep**, name unchanged (a rename breaks users' saved prompts and tool permissions for little gain)                                                                                                                                                                         | S    |
| D3    | `whoop_sleep`                      | Every sleep: times, stages, need breakdown; `include_naps`                                                                                                                                               | **Keep**                                                                                                                                                                                                                                                                     | S    |
| D4    | `whoop_workouts`                   | Every workout: sport, HR, zones, distance; totals per sport; `sport` filter                                                                                                                              | **Keep**                                                                                                                                                                                                                                                                     | S    |
| D5+D6 | `whoop_trends` + `whoop_baselines` | Trends: one `metric` over a range ending at `end_date`, with stats, slope and a rolling series. Baselines: a `metrics` list, the N days before a `date`, and where that date falls (z-score, percentile) | **Merge (F4b)** into `whoop_metric { metrics: 1+ metrics, end_date, days 7–90 (default 30) }`: per metric, the stats, slope and series over the window, and where `end_date` sits in it. One default metric set (recovery, HRV, RHR, sleep hours, sleep performance, strain) | S    |
| D7    | `whoop_compare_periods`            | Two ranges side by side, change A→B                                                                                                                                                                      | **Keep**                                                                                                                                                                                                                                                                     | S    |
| D8    | `whoop_training_load`              | Acute:chronic strain ratio, sleep shortfall, recovery, zone minutes; always ends today                                                                                                                   | **Keep**; consider an optional end date                                                                                                                                                                                                                                      | S    |
| D9    | `whoop_correlate`                  | Pearson/Spearman between two metrics, `lag_days` 0–3 (strain vs next-day recovery is the popular one)                                                                                                    | **Keep**                                                                                                                                                                                                                                                                     | S    |
| D10   | `whoop_get_record`                 | One record by ID, shaped and raw                                                                                                                                                                         | **Keep**: the only raw access past 7 days, and the `raw` limit's error message points to it                                                                                                                                                                                  | S    |
| D11   | `detail` switch                    | — (new)                                                                                                                                                                                                  | **Add** `detail: "concise" \| "full"` to the range tools, so a 90-day call doesn't flood the context; keep concise results well under Claude Code's 50,000-character file threshold                                                                                          | S    |

### Step 7: Prompts and skills

| ID  | Feature                              | Today                                                          | Recommend                                                                                                                                                                                                               | Cost |
| --- | ------------------------------------ | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| P1  | 3 MCP prompts                        | `whoop-connect`, `whoop-disconnect`, `whoop-status`            | **Keep**, and add the analysis prompts in N5                                                                                                                                                                            | S    |
| P2  | Skills written to `~/.claude/skills` | Same three as Claude Code slash commands, toggle on by default | **Cut** per F5, **with a migration:** v1.x removes the three folders on start when their `SKILL.md` carries our marker (the existing ownership check), then the cleanup goes in a later release; noted in the changelog | S    |

### Step 8: Packaging, release, tooling

| ID  | Feature                 | Today                                                                                                 | Recommend                                              | Cost |
| --- | ----------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ---- |
| P3  | `build-mcpb`            | Builds manifest + icon + `server/index.mjs`, checks it runs                                           | **Keep**, plus F3b                                     | S    |
| P4  | Release flow            | `bun run release x.y.z --push` tags; GitHub Actions builds and publishes the `.mcpb` and `SHA256SUMS` | **Keep**                                               | S    |
| P5  | `whoop-reset` dev skill | Stops the server, deletes keychain items, tokens, logs, skills and the extension, to test a first run | **Keep**, simpler once P2 and the CLI's setup/login go | S    |
| P9  | MCP Inspector script    | `inspect`                                                                                             | **Keep** (free)                                        | —    |
| P10 | `bun` project skill     | Bun version check and docs search for development                                                     | **Cut** under F2                                       | —    |

## 4. Known quirks to decide

FUNCTIONALITY.md records behaviours that are probably accidents. A rewrite either keeps them on purpose or fixes them on purpose. Each is small (S).

| ID  | Quirk today                                                                                                        | Recommend                                                                                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| K1  | The 401 retry path skips the guard against reusing a refresh token already known to be dead                        | Fix: add the guard                                                                                                                                                                                                                        |
| K2  | Tokens without a `scope` count as complete at login but not in `isConnected`                                       | Decide. (a) Keep as is. (b) Treat a missing scope as complete everywhere, which reconnects some older logins silently. (c) Treat it as incomplete everywhere, which forces those users to log in once more. I lean (c), as the safer rule |
| K3  | The OAuth error explainer always says `localhost:8787/callback`, even with `WHOOP_REDIRECT_URI` set                | Fix: use the real URI                                                                                                                                                                                                                     |
| K4  | The consent-only login server has no Host/Origin check (the setup page does)                                       | Fix: add it                                                                                                                                                                                                                               |
| K5  | The authorize URL, with its `state`, is written to the log                                                         | Fix: log without it                                                                                                                                                                                                                       |
| K6  | Setup saves the app credentials before consent, so after a cancelled consent the next attempt skips the setup page | Decide: save only after consent succeeds (I'd do this)                                                                                                                                                                                    |
| K7  | The setup page pre-fills the Client ID only after a successful run                                                 | Decide: pre-fill after failed attempts too (I'd do this)                                                                                                                                                                                  |
| K8  | A malformed timezone offset is silently treated as UTC                                                             | Fix: parse strictly, log a warning                                                                                                                                                                                                        |
| K9  | `whoop_sleep`'s fetch window drops sleeps at UTC offsets of +12 or more (New Zealand, part of the Pacific)         | Fix: widen the window to +14                                                                                                                                                                                                              |

## 5. New feature ideas

From the research and the review. Each has what it is, why it's worth it, the catch, and a recommendation.

### High value

**N1. Charts in the chat (MCP App).** `whoop_today` and the range tools return a `ui://` page alongside the text: a dashboard for today, line charts with the personal band for trends, a calendar heatmap for recovery. Renders inline in Claude Desktop, including from a local server. _Catch:_ Claude Code doesn't render it (text stays complete); the page is a sandboxed bundle we have to build and keep small; how Desktop sizes it needs testing. _Cost:_ L. **Recommend: yes, after the core is rebuilt.** The most visible upgrade available; one other WHOOP server's chart dashboard is its headline feature.

**N2. Short-lived in-memory cache.** Keep fetched records in memory for minutes, as WHOOP's cache headers allow (§4.2.2), so "how's my week" followed by "and my sleep?" doesn't refetch the same 7 days. Never on disk; cleared on disconnect. If the API sends `no-store` or no cache headers, limit it to deduplicating requests within one tool call. _Cost:_ S. **Recommend: yes.** Faster answers, fewer requests against the 100/min limit.

**N3. Anomaly flags.** `whoop_today` marks values outside the user's normal band (HRV below their 10th percentile, RHR 5+ bpm above baseline, respiratory rate or skin temperature up) as `flags: [...]`, so Claude leads with what's unusual. Built on M7, added to D1. _Cost:_ S. **Recommend: yes.**

**N4. Sleep debt and bedtime.** A `whoop_sleep_plan` tool (or a section in `whoop_today`): running sleep debt over 7 days, an estimate of tonight's need (WHOOP's baseline from the latest scored sleep, plus current debt and today's strain; labelled an estimate, since WHOOP only gives the figure once tonight's sleep is scored), and a suggested bedtime from the user's usual wake time (recent sleep end times). _Cost:_ S. **Recommend: yes.**

**N5. Analysis prompts.** Ready-made prompts under **+**: _Weekly review_, _Sleep coach_, _Should I train today?_, _Training block check_ (before vs after), _What changed?_ (digging into anomalies). Each is a few lines of text that call the right tools. _Cost:_ S. **Recommend: yes.** Cheap, and makes the tools discoverable.

### Worth considering

**N6. Long history (up to a year).** Lift the 90-day cap for weekly or monthly aggregates (`whoop_metric` with `bucket: "week"`): 365 days is about 50 requests, within the rate limit but slow (tens of seconds). _Catch:_ the call time limit and context size; needs N2 and progress notifications. _Cost:_ M. **Recommend: later.**

**N7. Import WHOOP's own data export.** The app can email a CSV export: full history plus the **journal**, which the API doesn't have. A tool reads the file the user picks and answers "does alcohol hurt my recovery?". _Catch:_ whether this sits inside WHOOP's terms is _unverified_; the data comes from the user, who is arguably the "WHOOP Data owner" in §4.2's carve-out, but it's still WHOOP data at rest. The export format can change. _Cost:_ M. **Recommend: later, after checking the terms.** Journal correlations are the most requested missing feature.

**N8. Demo mode.** A built-in synthetic WHOOP account (`WHOOP_MCP_DEMO=1` or a setting): every tool works with fake but realistic data. Useful for screenshots, trying it before creating a WHOOP app, and as test fixtures. _Cost:_ M. **Recommend: maybe**; worthwhile if others will use it.

**N16. Local planning store.** The README promises it as "the next release": goals, injuries, a weekly training plan and daily check-ins, entered by the user and kept in a local file. It holds no WHOOP API data, so §4.2.2 doesn't apply. Tools read and update it, and the data tools can report progress against goals (this absorbs the old "goals" idea). _Catch:_ the server gains write tools (`destructiveHint`), and the README promise has to be kept or withdrawn. _Cost:_ M. **Recommend: decide**; if not doing it, fix the README.

**N17. Weekday and weekend patterns.** `whoop_metric` with `group_by: "weekday"`: "am I worse on Mondays?", "does my sleep slip at weekends?". Claude can group daily rows itself today, but a server-side summary is smaller and exact. _Cost:_ S. **Recommend: maybe.**

**N18. Travel and timezone shifts.** Every record carries its timezone offset, so trips can be detected: "how did the trip affect my sleep?", "how long until my HRV recovered?". A tool lists offset changes and compares before, during and after. _Cost:_ S–M. **Recommend: maybe.**

**N19. Multi-day illness signal.** Several readings moving together over 2–3 days (skin temperature and respiratory rate up, RHR up, HRV down) are a stronger signal than one day's flag. An extension of N3. _Catch:_ it edges towards medical advice (§3.1.11), so the wording must stay "your readings are unusual", never "you may be ill". _Cost:_ S. **Recommend: maybe, carefully.**

**N20. Zone minutes, bedtime and wake time as metrics.** Add `zone2_minutes` (and other zones), `bedtime` and `wake_time` (clock minutes, averaged correctly across midnight) to M4's metrics, so trends, comparisons and correlations can use them ("does a late bedtime hurt my recovery?"). _Cost:_ S. **Recommend: yes**; cheap, and it unlocks good questions.

**N10. Personal records per sport.** Longest run, highest strain, best average HR at a given distance, over the available history. _Cost:_ S (with N6). **Recommend: later.**

**N11. Privacy mode.** A setting that returns only aggregates (no per-day values, no profile), for people wary of sending detail to the model. _Cost:_ S. **Recommend: maybe.**

**N12. Daily brief.** A skill or scheduled task that writes a morning summary. Claude's scheduled tasks can run a prompt each morning; we'd only supply the prompt (N5). _Cost:_ S. **Recommend: after N5.**

### Low value or blocked

**N13. Webhooks.** Instant updates when a recovery or sleep lands. WHOOP must reach an HTTPS endpoint from the internet, so only with remote mode (F1) or a user-run tunnel. **Skip** while local.

**N14. CSV export of API data.** Writing the user's API data to a file is a "permanent copy" under §4.2.2 (unless the owner carve-out covers it, which we'd rather not lean on). **Skip.**

**N15. Multi-user.** Several WHOOP accounts in one install. Remote-only in practice. **Skip.**

## 6. Not doing, and why

- **WHOOP's private API** (journal, stress, VO2 max, live HR through the iOS app's endpoints). Against WHOOP's terms, breaks without notice, and users worry about account bans. The most feature-rich competitor does it; we shouldn't.
- **A local database of API data.** §4.2.2 and §7.1. In-memory cache only (N2).
- **Training or fine-tuning models on WHOOP data.** §4.2.3.
- **Medical advice.** §3.1.11; keep the disclaimer and the instructions' wording.
- **MCP sampling, roots, protocol logging, resource subscriptions.** Deprecated or unsupported in Claude.
- **MCP tasks (long-running calls).** An extension in beta, Claude Code only, and WHOOP calls are quick. Reconsider with N6.

## 7. How the rebuild runs

- **Where:** a `rewrite` branch in this repo, merged when it reaches parity with the features you keep. `main` stays releasable meanwhile.
- **Order:** section 3, steps 0 through 8, with section 4's fixes done in the step that owns the code; then the N features you pick, in the order listed. Each step is one PR with tests and leaves a server Desktop can load.
- **Tests first, from the old suite.** The current 389 tests encode most of the hard-won behaviour (WHOOP days, refresh races, the scope rule, the setup page's security checks). The safety rails (P6) come first; then each module's tests are ported before the module is rewritten. Tests for cut features go.
- **FUNCTIONALITY.md stays the spec**, updated each step.
- **Release** as v1.0.0 once parity is reached:
  - Upgrading users keep their tokens file and keychain item (same names), so no re-login (unless K2 (c) or L11 changes that; say so in the notes).
  - The manifest's `name` (`whoop-mcp`) and author name (`whoop-mcp contributors`) never change: Desktop derives the extension ID from them, and a change installs a second copy beside the old one. `display_name` stays "WHOOP (unofficial)".
  - The changelog lists every renamed, merged or removed tool and prompt (D5+D6, P2), so users can update saved prompts and re-approve tools.
- **Verify in real Claude Desktop** at the end of steps 3, 6 and N1, not only in tests (the Node port still hasn't been). Read the log's `client connected` line there: it answers several of section 8's questions.

Rough size if you take every "Keep" and "yes": steps 0–8 about 3 weeks of focused work (F2 is a big part of step 0), N1 about a week, N2–N5 and N20 a few days together.

## 8. Open questions to verify

- Which MCP revision does Claude Desktop negotiate with a local extension, and which capabilities does it declare (elicitation form or URL mode, MCP Apps)? The log's `client connected` line answers this from a real install. (L10, N1.)
- Do the connector limits (about 150,000 characters, 240 s) apply to local `.mcpb` servers in Desktop? (C2's `wait_seconds`, D11, N6.)
- Does Claude Desktop store `sensitive` `user_config` values in the macOS keychain? (L7's alternative.)
- How does Desktop use `outputSchema` and `structuredContent`? (M9.)
- Is mcpb#278 fixed, and does Desktop then verify signatures? (F3c.)
- What cache headers does the WHOOP API send? (N2.)
- WHOOP's terms on reading the user's own export, and what "WHOOP Data owner" means in §4.2. (N7, N14.)
- Does WHOOP's Cloudflare accept Node's default User-Agent and a `whoop-mcp/<version>` one? (A5.)
- MCP App sizing and behaviour in Desktop: test with a stub before committing to N1.
- Does Claude Desktop find a Homebrew `npx` (`/opt/homebrew/bin`) when launching a config-file server, or does the config need the absolute path? (F3e.)

## Decision sheet

Fill in **Your pick**: keep, change, cut, later (or a note). Blank means "go with the recommendation". Anything in section 3 marked plain **Keep** carries over unless you list it here.

| ID      | Item                                                                                          | Recommend                          | Your pick |
| ------- | --------------------------------------------------------------------------------------------- | ---------------------------------- | --------- |
| F1      | Local extension vs remote server                                                              | Local                              |           |
| F2      | Node-only toolchain (drop Bun for dev)                                                        | Yes                                |           |
| F3b     | Manifest: icons, min Desktop version, real privacy page                                       | Yes                                |           |
| F3c     | Sign the bundle                                                                               | Later (blocked by mcpb#278)        |           |
| F3d     | Windows build                                                                                 | Optional                           |           |
| F3e     | Distribution: `.mcpb` only (a), `.mcpb` + npm (b), npm only (c)                               | b                                  |           |
| F4      | Tools: keep 14 (a), merge trends+baselines to 13 (b), also fold profile into status to 12 (c) | b                                  |           |
| F5      | Skills: write files (a), prompts only (b), plugin (c)                                         | b, then c                          |           |
| S1      | Explicit `destructiveHint` on every tool                                                      | Yes                                |           |
| S5      | Pid files for the reset skill                                                                 | Keep with P5                       |           |
| S6      | CLI: drop `setup`, `login`, `--forget-app`                                                    | Drop                               |           |
| S7      | Environment variables                                                                         | Keep (minus skills ones if P2 cut) |           |
| A2      | Retry once on 502/503/504 and network errors                                                  | Add                                |           |
| A5      | Explicit User-Agent                                                                           | Add                                |           |
| L2      | Browser setup page                                                                            | Keep, split the module             |           |
| L7      | Own keychain code vs Desktop `sensitive` config                                               | Own                                |           |
| L10     | URL-mode elicitation (Claude Code)                                                            | Later                              |           |
| L11     | Tokens at rest: keychain (a), encrypted file (b), as is (c)                                   | b                                  |           |
| L12     | Data-sharing notice on the setup page                                                         | Add                                |           |
| C2      | Re-measure `wait_seconds` cap                                                                 | Yes                                |           |
| C3      | Disconnect deletes app credentials by default                                                 | Keep                               |           |
| C4      | `whoop_profile` separate or in status                                                         | Separate                           |           |
| D2      | Keep the name `whoop_daily_summaries`                                                         | Keep                               |           |
| D5+D6   | Merge into `whoop_metric` (signature in step 6)                                               | Merge                              |           |
| D8      | Optional end date for training load                                                           | Maybe                              |           |
| D10     | `whoop_get_record`                                                                            | Keep                               |           |
| D11     | `detail` concise/full switch                                                                  | Add                                |           |
| M9      | `outputSchema` on every tool                                                                  | Add                                |           |
| P2      | Skills in `~/.claude/skills`                                                                  | Cut, with one-time cleanup         |           |
| P5      | `whoop-reset` dev skill                                                                       | Keep                               |           |
| P10     | `bun` project skill                                                                           | Cut with F2                        |           |
| K1      | Dead-token guard on the 401 path                                                              | Fix                                |           |
| K2      | Scope-less tokens: as is (a), complete (b), incomplete (c)                                    | c                                  |           |
| K3–K5   | Real redirect URI in errors; Host/Origin on consent server; no `state` in logs                | Fix                                |           |
| K6      | Save app credentials only after consent                                                       | Yes                                |           |
| K7      | Pre-fill Client ID after failed attempts                                                      | Yes                                |           |
| K8–K9   | Strict offset parsing; sleep window to +14                                                    | Fix                                |           |
| N1      | Charts in the chat (MCP App)                                                                  | Yes, after core                    |           |
| N2      | In-memory cache                                                                               | Yes                                |           |
| N3      | Anomaly flags in today                                                                        | Yes                                |           |
| N4      | Sleep debt and bedtime                                                                        | Yes                                |           |
| N5      | Analysis prompts                                                                              | Yes                                |           |
| N6      | Up to a year of history, bucketed                                                             | Later                              |           |
| N7      | Import WHOOP's export (journal)                                                               | Later, check terms                 |           |
| N8      | Demo mode                                                                                     | Maybe                              |           |
| N10     | Personal records                                                                              | Later                              |           |
| N11     | Privacy mode                                                                                  | Maybe                              |           |
| N12     | Daily brief                                                                                   | After N5                           |           |
| N16     | Local planning store (README promise)                                                         | Decide                             |           |
| N17     | Weekday/weekend patterns                                                                      | Maybe                              |           |
| N18     | Travel and timezone shifts                                                                    | Maybe                              |           |
| N19     | Multi-day illness signal                                                                      | Maybe, carefully                   |           |
| N20     | Zone minutes, bedtime, wake time as metrics                                                   | Yes                                |           |
| N13–N15 | Webhooks, CSV export, multi-user                                                              | Skip                               |           |

## Sources

WHOOP:
- API reference: https://developer.whoop.com/api
- Webhooks: https://developer.whoop.com/docs/developing/webhooks
- Rate limits: https://developer.whoop.com/docs/developing/rate-limiting
- API terms of use: https://developer.whoop.com/api-terms-of-use/
- What WHOOP launched in 2025 (app-only features): https://www.whoop.com/gu/fr/thelocker/everything-whoop-launched-in-2025/
- Export and journal data: https://www.community.whoop.com/t/health-history-for-oxygen-sats/13113, https://www.gneta.app/blog/export-whoop-data-guide

Other WHOOP and health MCP servers:
- https://github.com/shashankswe2020-ux/whoop-mcp (charts dashboard, prompts, aggregate mode)
- https://github.com/thebriangao/totem (private API; projection layer, confirm-before-write)
- https://github.com/davidmosiah/whoop-mcp (baseline deltas, privacy audit)
- https://github.com/yuridivonis/whoop-mcp-server (stores nothing, per the terms)
- https://github.com/nchemb/whoop-mcp, https://github.com/ericporres/whoop-my-ai
- https://glama.ai/mcp/servers/izqui/whoop-mcp and npm `whoop-mcp` 0.1.2 (npx install, pasted access token, no refresh; GitHub repo since deleted)
- https://registry.modelcontextprotocol.io
- https://github.com/vnglst/garmin-mcp-server, https://glama.ai/mcp/servers/@the-momentum/apple-health-mcp-server

MCP and Claude:
- Spec changelogs: https://modelcontextprotocol.io/specification/2025-11-25/changelog, https://modelcontextprotocol.io/specification/2026-07-28/changelog
- mcpb manifest and CLI: https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md, https://github.com/modelcontextprotocol/mcpb/blob/main/CLI.md
- Building connectors, limits, annotations: https://claude.com/docs/connectors/building/index.md, https://claude.com/docs/connectors/building/mcp.md
- `.mcpb` and the directory: https://claude.com/docs/connectors/building/mcpb.md
- MCP Apps: https://claude.com/docs/connectors/building/mcp-apps/getting-started.md
- Plugins: https://claude.com/docs/plugins/overview.md, https://claude.com/docs/plugins/platform-support.md
- Claude Code MCP support (prompts, elicitation, output limits): https://code.claude.com/docs/en/mcp
- Writing tools for agents: https://www.anthropic.com/engineering/writing-tools-for-agents
