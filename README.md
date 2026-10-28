# whoop-mcp

An [MCP](https://modelcontextprotocol.io) server that gives Claude your [WHOOP](https://www.whoop.com) data: recovery, sleep, strain, workouts and profile. It uses WHOOP's official Developer API (v2) through your own free WHOOP developer app, reads data only, and runs locally on your computer.

Not affiliated with or endorsed by WHOOP. Nothing it returns is medical advice.

## What it can do

Once it's connected, you talk to Claude normally and it fetches whatever WHOOP data the question needs. You don't call tools yourself.

**Daily check-in**

- "How am I today? Should I train hard or keep it easy?"
  Claude gets last night's sleep, this morning's recovery (green, yellow or red), the day's strain, steps and calories so far, and today's workouts, and compares each number with your own last 30 days.
- After midnight, or after a night without the strap, it shows the WHOOP day that's still running rather than an empty day.
- While WHOOP is still learning you (the first few weeks), it says the recovery score is provisional. When there's too little history for a fair comparison, it says that too.

**Weekly review**

- "How was my week?" "Compare this week with last week." "Did my sleep get better this month?"
- You get a row per day for up to 90 days, with averages, and side-by-side comparisons of any two periods with the change between them.

**Sleep**

- "Why am I tired?" "Is my bedtime consistent?" "How much deep sleep am I getting?"
- Every sleep and nap: bed and wake times, light, deep and REM sleep, time awake, disturbances, how much sleep WHOOP thinks you needed and why, efficiency and consistency.

**Training and load**

- "Am I overdoing it?" "Is it time for an easier week?"
- Acute (7-day) vs. chronic (28-day) strain and their ratio, average recovery, nightly sleep shortfall, and minutes in each heart-rate zone.
- Every workout with duration, strain, heart rate, calories, distance and zone minutes, filterable by sport (e.g. walking).
- Zones are explained the way WHOOP defines them, as % of heart-rate reserve, so Claude doesn't turn them into the wrong bpm targets.

**Patterns**

- "Is my HRV trending down?" "What's normal for me?" "Does a hard day hurt my next night's sleep?"
- Trends with a weekly slope and a 7-day rolling average, your personal normal range for each metric, and correlations between two metrics, including a day apart (e.g. strain vs. next-day recovery).

**Honest about the data**

- Every answer comes with a `data_quality` section. It lists:
  - days with no data;
  - scores still being processed, or that WHOOP couldn't score;
  - whether you're still calibrating;
  - which empty days are simply from before your account existed, so Claude doesn't mistake them for days you didn't wear the strap.

### What it can't do (yet)

- **Remember anything between chats.** It has no goals, injuries, training plan or daily log of its own. You can keep these in a Claude Project or a notes file for now. A local planning store (goals, weekly plan, daily check-ins) is the next release.
- **Write to WHOOP.** It reads data only. WHOOP's API has no Journal, Stress Monitor, Strength Trainer sets or live heart rate, so Claude can't see those.
- **Give medical advice.** It's a planning and logging aid. For symptoms, injuries or anything clinical, see a professional.
- **Run on its own schedule, or on your phone.** It runs on your computer while Claude is open there. You can schedule a morning check-in with Claude Desktop's scheduled tasks, but your computer has to be awake.

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

1. **First time:** a setup page walks you through creating a free app at the [WHOOP developer dashboard](https://developer-dashboard.whoop.com). It tells you what to put in each field of WHOOP's form:

   | Field          | Value                                                                          |
   | -------------- | ------------------------------------------------------------------------------ |
   | Name           | anything, for example `whoop-mcp`                                              |
   | Logo           | leave empty                                                                    |
   | Contacts       | your own email address                                                         |
   | Privacy policy | `https://github.com/213123243ertdfgret63/whoop-mcp#connect-your-whoop-account` |
   | Redirect URLs  | `http://localhost:8787/callback` (exactly)                                     |
   | Scopes         | tick all six                                                                   |
   | Webhooks       | leave empty                                                                    |

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

Ask Claude things like "how am I today, should I train hard?", "how was my week?", "am I overreaching?" or "does late training hurt my sleep?". It picks the tools itself.

| Tool                    | What it does                                                                                                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `whoop_today`           | One day's snapshot: last night's sleep, the morning's recovery (with its green, yellow or red zone), strain, kcal and steps so far, workouts, and each key number vs. the last 30 days. |
| `whoop_daily_summaries` | One row per day over a range (up to 90 days): recovery, HRV, resting HR, sleep, strain, kcal, steps and workouts, plus averages.                                                        |
| `whoop_sleep`           | Every sleep and nap in a range: bed and wake times, stages, disturbances, sleep needed and why, performance, efficiency, consistency.                                                   |
| `whoop_workouts`        | Every workout in a range, optionally for one sport: duration, strain, heart rate, kcal, distance, minutes per heart-rate zone, plus totals per sport.                                   |
| `whoop_trends`          | How one metric moved over N days: statistics, slope per week, 7-day rolling average, and where the latest value sits.                                                                   |
| `whoop_baselines`       | Your personal normal range per metric, and how a given day compares (z-score, percentile).                                                                                              |
| `whoop_compare_periods` | Averages for two date ranges side by side, with the change (e.g. this week vs. last week).                                                                                              |
| `whoop_training_load`   | Acute (7-day) vs. chronic (28-day) strain and their ratio, average nightly sleep shortfall, average recovery and minutes per heart-rate zone.                                           |
| `whoop_correlate`       | Correlation between two metrics, optionally a few days apart (e.g. strain vs. next-day recovery).                                                                                       |
| `whoop_get_record`      | One cycle, sleep, workout or recovery by ID, with the raw WHOOP record.                                                                                                                 |
| `whoop_profile`         | Your name, height, weight and max heart rate.                                                                                                                                           |
| `whoop_status`          | Connection state: app credentials, login progress, granted scopes, token expiry and server version. Makes no WHOOP API calls.                                                           |
| `whoop_login`           | Connects your account in the browser (setup page first if needed). `reconfigure: true` re-enters the app credentials.                                                                   |

Dates are your local dates, and a WHOOP day runs from sleep to sleep, not midnight to midnight. Results include a `data_quality` section that says which days are missing, still being scored or calibrating. Ranges are limited to 90 days, and `raw: true` (the original WHOOP records) to 7. Nothing here is medical advice.

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
