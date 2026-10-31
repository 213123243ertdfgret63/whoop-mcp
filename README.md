# whoop-mcp

A [Claude Desktop](https://claude.ai/download) extension that gives Claude your [WHOOP](https://www.whoop.com) data: recovery, sleep, strain, workouts and profile. It uses WHOOP's official Developer API (v2) through your own free WHOOP developer app, reads data only, and runs locally on your computer as an [MCP](https://modelcontextprotocol.io) server.

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
- **Run on your phone or on claude.ai.** It runs inside Claude Desktop on your computer, so it works only there, while the app is open.

## Install

Claude Desktop on macOS (Apple Silicon or Intel). Only macOS is supported. Nothing else to install: Desktop runs the extension on its own built-in Node.js.

1. Download **`whoop-mcp-macos.mcpb`** from the [latest release](https://github.com/213123243ertdfgret63/whoop-mcp/releases/latest).
2. Double-click it. Claude Desktop opens an install dialog listing the tools; click **Install**.
   You can also drag the file onto **Settings → Extensions** in Claude Desktop.
3. Start a new chat and ask Claude to **"connect WHOOP"** (see below).

The extension needs no settings: the WHOOP app credentials are entered on a setup page the first time you connect.

If you used a version before 0.3 (installed with `install.sh`), remove it first, or its old `whoop` server runs next to the extension and duplicates the tools:

1. Quit Claude Desktop (Cmd+Q). It rewrites its config file when it quits, so edit the file only while it's closed.
2. Delete the `whoop` entry under `mcpServers` in `~/Library/Application Support/Claude/claude_desktop_config.json`.
3. Delete `~/.whoop-mcp`. If you also used it in Claude Code, run `claude mcp remove whoop --scope user`.

Your WHOOP login and app credentials are kept and work with the extension.

## Connect your WHOOP account

Just ask Claude something about your WHOOP data, such as "how did I sleep?" (or say "connect WHOOP"). If WHOOP isn't connected yet, whoop-mcp opens a page in your browser, and Claude waits and carries on with your question once you're done. You don't need to tell Claude you've finished.

1. **First time (about 5 minutes):** the page walks you through creating a free app at the [WHOOP developer dashboard](https://developer-dashboard.whoop.com). **Open WHOOP in a new tab** opens the dashboard, and the page lists every value in a table with Copy buttons:

   | Field          | Value                                                                          |
   | -------------- | ------------------------------------------------------------------------------ |
   | Name           | anything, for example `whoop-mcp`                                              |
   | Logo           | leave empty                                                                    |
   | Contacts       | your own email address                                                         |
   | Privacy policy | `https://github.com/213123243ertdfgret63/whoop-mcp#connect-your-whoop-account` |
   | Redirect URLs  | `http://localhost:8787/callback` (exactly)                                     |
   | Scopes         | tick every box (six)                                                           |
   | Webhooks       | leave empty                                                                    |

   WHOOP may first ask you to create a Team; name it anything. Then copy the app's **Client ID** and **Client Secret** and press ⌘V anywhere on the page: each goes into the right box. They're checked with WHOOP and saved to your system keychain automatically.

2. **Then:** the page sends you on to WHOOP to approve access, and follows along until the connection is done.

Why your own app: WHOOP's terms don't allow open-source tools to share one app, so each person makes their own; only you use it.

Later, when the login expires, the page goes straight to WHOOP's approval screen. If WHOOP shows an error (for example about the redirect URL), the page explains it and offers **Try again** once you've fixed the app, or **Use different credentials**. To switch to another app, ask Claude to "set up WHOOP again" (`whoop_login` with `reconfigure: true`).

- whoop-mcp needs every permission. If you untick one on WHOOP's page (or your app doesn't have one ticked under Scopes), it doesn't connect: it revokes that partial login and the page tells you what to fix.
- Shortcuts: in Claude Code, including Claude Desktop's Code tab, type `/whoop-connect`, `/whoop-disconnect` or `/whoop-status`. In Desktop's chat, click **+** → **Add from WHOOP (unofficial)** → **Connect WHOOP**, **Disconnect WHOOP** or **WHOOP status**, then send the message (chat's `/` menu doesn't list extension shortcuts). See [Shortcuts](#shortcuts).
- To disconnect, ask Claude to "disconnect WHOOP" or use the **Disconnect WHOOP** shortcut. It revokes whoop-mcp's access at WHOOP and deletes the saved login and the app's Client ID and Secret from your keychain. Connecting again starts with the setup page, where you paste the Client ID and Secret from the WHOOP developer dashboard again (the app itself stays there). Say "but keep the app" to keep them.
- The setup page runs only on your computer (`localhost`), behind a one-time link, and refuses requests from other websites.
- Tokens are stored in `~/.config/whoop-mcp/tokens.json` (owner-only). The app credentials are stored in your system keychain (service `whoop-mcp`), or in a private file next to the tokens when there's no keychain.

## Update

Download the new `.mcpb` from the [latest release](https://github.com/213123243ertdfgret63/whoop-mcp/releases/latest) and install it the same way. Claude Desktop replaces the old version; your WHOOP login and app credentials are kept, because they live outside the extension. Extensions installed from a file don't update themselves.

Coming from v0.7 or earlier: the first time the new version reads the saved app credentials, macOS asks whether `security` may use the `whoop-mcp` keychain item. Click **Always Allow**. (Versions before v0.8 saved the item with their own program, which macOS treats as a different app; from v0.8 the item is saved through Apple's `security` tool, so updates no longer ask.)

To see which version you have, look for **WHOOP (unofficial)** under **Settings → Extensions**, or ask Claude for `whoop_status` (`server_version`). Changes are listed in [CHANGELOG.md](CHANGELOG.md).

## Logs

The server keeps its own log of what it did: start-up, each tool call (name, arguments, duration, outcome), each WHOOP request (path, status, duration), token refreshes and login steps. It never logs tokens, secrets or your WHOOP data.

The log is at `~/Library/Logs/whoop-mcp/whoop-mcp.log` (also visible in the Console app).

It rotates at 5 MB and keeps three old files. `whoop_status` reports the path. Warnings and errors also appear in Claude Desktop's own log (`~/Library/Logs/Claude/mcp-server-WHOOP (unofficial).log`). For more detail, set `WHOOP_MCP_LOG_LEVEL=debug` (or `warn`, `error`; `WHOOP_MCP_LOG_FILE=off` turns the file off) when running from source.

## Uninstall

1. Ask Claude to "disconnect WHOOP" first: that revokes access at WHOOP and deletes the saved login and app credentials. Then, in Claude Desktop, open **Settings → Extensions**, choose **WHOOP (unofficial)** and click **Uninstall**.
2. Uninstalling doesn't remove the Claude Code shortcuts (Desktop doesn't tell the extension). To also delete them, your saved WHOOP login, app credentials and logs:

   ```bash
   rm -rf ~/.claude/skills/whoop-connect ~/.claude/skills/whoop-disconnect ~/.claude/skills/whoop-status
   rm -rf ~/.config/whoop-mcp ~/Library/Logs/whoop-mcp
   security delete-generic-password -s whoop-mcp
   ```

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
| `whoop_disconnect`      | Disconnects your WHOOP account: revokes access at WHOOP and deletes the saved login and app credentials. `keep_app: true` keeps the app credentials.                                    |
| `whoop_login`           | Connects your account in the browser (setup page first if needed). `reconfigure: true` re-enters the app credentials.                                                                   |

### Shortcuts

| Claude Code `/` menu | Desktop chat (**+** → **Add from WHOOP (unofficial)**) | Calls              |
| -------------------- | ------------------------------------------------------ | ------------------ |
| `/whoop-connect`     | **Connect WHOOP**                                      | `whoop_login`      |
| `/whoop-disconnect`  | **Disconnect WHOOP**                                   | `whoop_disconnect` |
| `/whoop-status`      | **WHOOP status**                                       | `whoop_status`     |

Each asks Claude to call the matching tool, so you see the call as usual. In chat they're MCP prompts. For Claude Code the extension writes them as skills to `~/.claude/skills/whoop-connect`, `whoop-disconnect` and `whoop-status` when it starts (new Code sessions pick them up). It only changes folders it wrote itself, marked inside `SKILL.md`, so a skill of your own with the same name is left alone. To stop it, turn off **Add /whoop- commands to Claude Code** in the extension's settings (**Settings → Extensions → WHOOP (unofficial)**): the next start removes them. If they're still there, or after uninstalling, delete them by hand (see [Uninstall](#uninstall)).

Dates are your local dates, and a WHOOP day runs from sleep to sleep, not midnight to midnight. Results include a `data_quality` section that says which days are missing, still being scored or calibrating. Ranges are limited to 90 days, and `raw: true` (the original WHOOP records) to 7. Nothing here is medical advice.

## Run from source

Everything the project does, in enough detail to rebuild it, is in [docs/FUNCTIONALITY.md](docs/FUNCTIONALITY.md).

```bash
git clone https://github.com/213123243ertdfgret63/whoop-mcp.git && cd whoop-mcp
bun install            # Bun 1.4+; also generates the API types
bun run build:mcpb     # builds dist/whoop-mcp-macos.mcpb
```

Install `dist/whoop-mcp-macos.mcpb` as above. To run the code straight from the checkout instead, add a server to `~/Library/Application Support/Claude/claude_desktop_config.json` (give it a different name, because an entry there overrides an extension with the same name) and restart Claude Desktop:

```json
{
  "mcpServers": {
    "whoop-dev": {
      "command": "/absolute/path/to/bun",
      "args": ["/absolute/path/to/whoop-mcp/src/index.ts"]
    }
  }
}
```

- **Credentials:** `WHOOP_CLIENT_ID` and `WHOOP_CLIENT_SECRET` env vars (see `.env.example`) take precedence over saved credentials, but only when both are set.
- **Terminal commands:** `bun src/index.ts setup | login | status | logout` do the same as the tools, from a terminal.
- **No browser:** `WHOOP_MCP_NO_BROWSER=1` makes the server announce the setup and login pages without opening them (the tests use it).
- **Updating:** `git pull && bun install`. `main` can be ahead of the last release. To run exactly a released version, check out its tag, for example `git checkout v0.2.1`.

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

Pushing the tag runs `.github/workflows/release.yml` on an Ubuntu runner. It checks that the tag matches `package.json` and is on `main`, reruns the checks, and builds the extension bundle with `bun run build:mcpb`. It then checks that the bundle starts on Node 24, and publishes a GitHub release with the bundle, checksums and the changelog notes.

### How the bundles are built

`scripts/build-mcpb.ts` bundles the server into one JavaScript file with `bun build --target=node` and packs it with the pinned `@anthropic-ai/mcpb` CLI:

- The bundle is `manifest.json`, `icon.png` and `server/index.mjs` (about 1 MB unpacked). The manifest's server type is `node`, run as `node ${__dirname}/server/index.mjs`, and `compatibility.runtimes.node` is `>=22.0.0`. Claude Desktop then runs it on its built-in Node.js (24.22 in Desktop 4.4212, as an Electron utility process), so users need no Node of their own. If **Use built-in Node.js for MCP** is turned off, Desktop uses a matching Node on the system.
- The tool list in the manifest comes from the server itself, so the install dialog can't drift from the code.
- There are no binaries, so nothing is code-signed or per-CPU, and it builds on any OS.
- They're not signed: `mcpb sign` 2.1.2 makes bundles Claude Desktop refuses to install ([mcpb#278](https://github.com/modelcontextprotocol/mcpb/issues/278)).

## Development

| Command                                 | What it does                                                                                                               |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `bun test` / `bun run test:node`        | Test suite (stdio smoke tests for both MCP protocol versions, on Bun and on the Node bundle) / the loopback server on Node |
| `bun run typecheck`                     | `tsc --noEmit`                                                                                                             |
| `bun run lint` / `bun run format`       | Runs Biome's checks / runs them and applies fixes                                                                          |
| `bun run inspect`                       | Opens MCP Inspector against the server                                                                                     |
| `bun run spec:update`                   | Refreshes `openapi/whoop.yaml` from WHOOP's published spec (review with `git diff openapi/`)                               |
| `bun run gen:types`                     | Generates `src/whoop/openapi.d.ts` from `openapi/whoop.yaml`; runs automatically on `bun install`                          |
| `bun run release <patch\|minor\|major>` | Cuts a release (see [Cutting a release](#cutting-a-release))                                                               |
| `bun run build`                         | Bundles the server for Node at `dist/whoop-mcp.mjs` (`node dist/whoop-mcp.mjs status`)                                     |
| `bun run build:mcpb`                    | Builds the Claude Desktop extension bundle in `dist/` (see [How the bundles are built](#how-the-bundles-are-built))        |
- **CI** (`.github/workflows/ci.yml`) runs lint, typecheck, the tests (on Bun, plus `bun run test:node` for the loopback server on Node 24), and the extension build, whose bundle it then starts on Node 24, on Ubuntu for every push to `main` and every pull request. Trigger it manually to include macOS. The Bun version comes from `.bun-version`.
- **Pre-commit hook:** a Husky hook runs Biome on staged files and applies formatting and safe fixes. Lint errors it can't fix block the commit.
