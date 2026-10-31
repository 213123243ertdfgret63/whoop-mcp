# whoop-mcp: full functionality reference

What whoop-mcp v0.7.0 does, in enough detail to migrate or rebuild it from scratch: every tool and parameter, the login and credential rules, the runtime, packaging and release, and the reasons behind the non-obvious choices. It was written from the code, tests and git history on 2026-10-31, then checked against the code by two separate reviewers. The README is the user guide; this is the builder's reference.

When code and this document disagree, the code wins. Each part names its source files.

## At a glance

- **What it is:** a local MCP server for the WHOOP Developer API v2, written in TypeScript for Bun and compiled to a single binary. It's shipped only as a macOS Claude Desktop extension (`.mcpb`, shown as "WHOOP (unofficial)", extension ID `local.mcpb.whoop-mcp-contributors.whoop-mcp`). It is read-only and unofficial.
- **Tools (14):**
  - data: `whoop_today`, `whoop_daily_summaries`, `whoop_sleep`, `whoop_workouts`, `whoop_trends`, `whoop_baselines`, `whoop_compare_periods`, `whoop_training_load`, `whoop_correlate`, `whoop_get_record`, `whoop_profile`;
  - connection: `whoop_status`, `whoop_login`, `whoop_disconnect`.
- **Prompts (3):** `whoop-connect`, `whoop-disconnect`, `whoop-status`. Desktop chat lists them under **+**. The extension also writes them as Claude Code skills in `~/.claude/skills`.
- **Login:** each user brings their own WHOOP developer app (WHOOP's terms forbid a shared one). A one-time local setup page on `localhost:8787` collects the app's Client ID and Secret, then runs WHOOP's OAuth consent. The credentials are kept in the macOS keychain, and the tokens in `~/.config/whoop-mcp/tokens.json` (owner-only).
- **Logs:** `~/Library/Logs/whoop-mcp/whoop-mcp.log`. Tokens, secrets and WHOOP health data are never logged.
- **Release:** `bun run release <x.y.z> --push` tags a version. GitHub Actions, on a macOS runner, then builds `whoop-mcp-macos.mcpb` (arm64 and x64, ad-hoc signed, minimum macOS 13) and publishes it with `SHA256SUMS`.

Parts below:

1. [MCP data tools and analytics](#mcp-data-tools-and-analytics)
2. [WHOOP API client, OAuth token lifecycle and OpenAPI spec](#whoop-api-client-oauth-token-lifecycle-and-openapi-spec)
3. [Login and credentials](#login-and-credentials)
4. [Server runtime, CLI, logging, prompts and skills](#server-runtime-cli-logging-prompts-and-skills)
5. [Packaging, release, CI and dev tooling](#packaging-release-ci-and-dev-tooling)


## MCP data tools and analytics

Sources: `src/tools/data-tools.ts`, `src/tools/common.ts`, `src/whoop/data.ts`, `src/whoop/analytics.ts`, `src/server.ts` (instructions, `whoop_profile`, tool-call logging), `test/data.test.ts`, `test/server.test.ts`, git history (`7e3a183`, `9fed2ae`, `8040780`, `5ebfaa4`).

### Tool inventory

The test `tools/list` expects exactly these 14 tools. The connection tools (`whoop_status`, `whoop_login`, `whoop_disconnect`) and the prompts are covered in another section.

| Tool                                                | Title                       | Defined in    |
| --------------------------------------------------- | --------------------------- | ------------- |
| `whoop_today`                                       | Today on WHOOP              | data-tools.ts |
| `whoop_daily_summaries`                             | Daily WHOOP summaries       | data-tools.ts |
| `whoop_sleep`                                       | WHOOP sleep detail          | data-tools.ts |
| `whoop_workouts`                                    | WHOOP workouts              | data-tools.ts |
| `whoop_trends`                                      | WHOOP trends                | data-tools.ts |
| `whoop_baselines`                                   | WHOOP personal baselines    | data-tools.ts |
| `whoop_compare_periods`                             | Compare two WHOOP periods   | data-tools.ts |
| `whoop_training_load`                               | WHOOP training load         | data-tools.ts |
| `whoop_correlate`                                   | Correlate two WHOOP metrics | data-tools.ts |
| `whoop_get_record`                                  | Get one WHOOP record        | data-tools.ts |
| `whoop_profile`                                     | WHOOP profile               | server.ts     |
| `whoop_status` / `whoop_login` / `whoop_disconnect` | (connection)                | server.ts     |

**Annotations.** Every data tool and `whoop_profile` uses `READ_ONLY = { readOnlyHint: true, idempotentHint: true, openWorldHint: true }`. `whoop_status` uses the same set but with `openWorldHint: false`. `whoop_login` has `readOnlyHint: false` and `destructiveHint: false`. `whoop_disconnect` has `destructiveHint: true`. All 14 tools have `idempotentHint: true`.

**No `outputSchema` on the data tools.** Only `whoop_status` declares one.

### Shared result and error contract (`src/tools/common.ts`)

- **Success** (`jsonResult(data, summary)`):
  - `content` is `[{type:"text", text: summary + "\n\n" + JSON.stringify(data)}]`. The JSON is compact, with no indentation, because indentation "adds about half again to every result" and `structuredContent` already carries the object. A test checks that the text has no `\n  "`.
  - `structuredContent` is `data`.
- **Disclaimer.** Every data-tool result gets `disclaimer: "Not medical advice."` merged in last. `whoop_profile` carries it as `note: "Not medical advice."` instead.
- **Error wrapper.** Each data tool's handler is wrapped in try/catch, and any thrown error goes to `toolError(err, loginFlow)`:
  - `NotLoggedInError`, or `ConfigError` (missing app credentials), calls `notConnectedResult`. That calls `loginFlow.startIfIdle()`.
    - If the returned state is `pending`, the result is `isError: true` with a script for Claude: "WHOOP isn't connected, so {a WHOOP setup page | WHOOP's approval page} is open in the user's browser (if it didn't open, the user can visit {authorizeUrl}). Tell the user in one sentence, e.g. "{say}" Then call whoop_login with wait_seconds=40, keep calling it while it says pending, and call this tool again once it reports connected. Don't ask the user to say when they're done."
    - `say` for setup: "I've opened a page in your browser to connect WHOOP (about 5 minutes the first time); I'll carry on when you're done."
    - `say` for login: "I've opened WHOOP in your browser; approve access there and I'll carry on."
    - If no flow is passed, `startIfIdle` throws (a warning is logged), or the state is not pending (for example a login failed a moment ago), the result is the plain error message. The test "doesn't reopen the page when a login failed a moment ago" covers this.
  - Any other error becomes `{ isError: true, content: [{type:"text", text: err.message}] }`. A `WhoopApiError` message includes the status, path and trace id.
- **Wait constant.** `LOGIN_WAIT_SECONDS = 40`, kept under Claude's roughly 60s tool-call limit.
- **Bad arguments.** The SDK's zod validation rejects them as an error result, and the server keeps serving. Example: `start_date: "yesterday"` is rejected and logged as a WARN.
- **`InputError`** (exported class) carries the user-actionable validation messages below. These are raised before any WHOOP request is made; tests assert `stub.calls` is `[]`.

### Shared input rules (`data-tools.ts`)

**Constants:**

| Constant               | Value | Purpose                                                                                              |
| ---------------------- | ----- | ---------------------------------------------------------------------------------------------------- |
| `MAX_DAYS`             | 90    | Maximum range length                                                                                 |
| `ROLLBACK_MARGIN_DAYS` | 7     | Extra history fetched so a WHOOP day that started a few dates back still has its full history window |
| `MAX_RAW_DAYS`         | 7     | Maximum range when `raw: true`                                                                       |

**`rangeShape(defaultDays)`**, used by daily_summaries, sleep, workouts and trends:

| Param        | Type                                  | Default       | Notes                                                                    |
| ------------ | ------------------------------------- | ------------- | ------------------------------------------------------------------------ |
| `start_date` | `z.iso.date()` (YYYY-MM-DD), optional | —             | "First day, YYYY-MM-DD (local date)."                                    |
| `end_date`   | `z.iso.date()`, optional              | today (local) | "Last day … Defaults to today."                                          |
| `days`       | int, 1..90, optional                  | `defaultDays` | Used only when `start_date` is absent. Range is `[end - (days-1), end]`. |

**`resolveRange` checks, in order:**
1. `notInFuture(end_date)`: "end_date ({d}) is in the future; today is {today}." WHOOP has no future data, and asking anyway would quietly return today's data under another date.
2. `from > to`: "start_date ({from}) must be on or before end_date ({to})."
3. More than 90 days inclusive: "The range is {n} days; the maximum is 90."

**`raw` param.** Boolean, default `false`: "Also return the original WHOOP records. Large: only for ranges of up to 7 days." If set on a range of more than 7 days, the call fails with: "raw is limited to 7 days (this range is {n}); narrow the range, or use whoop_get_record for one record." This applies to `whoop_daily_summaries`, `whoop_sleep` and `whoop_workouts`; `whoop_today` also accepts `raw`. Exactly 7 days is allowed.

**Local "today".** `todayLocal()` uses the computer's local clock: "Today's date on this computer, which is where the user is."

**`ZONE_LEGEND`** is appended to the descriptions of `whoop_workouts` and `whoop_training_load`, and a test asserts both contain "heart-rate reserve". Verbatim: "WHOOP heart-rate zones are % of heart-rate reserve: bpm = resting HR + pct x (max HR - resting HR); z0 under 50%, z1 50-60%, z2 60-70%, z3 70-80%, z4 80-90%, z5 90-100%. Do not convert them with % of max HR." Without it, Claude would assume % of max HR.

**`METRIC_HELP`** is the string `name = label; name = label; …` built over all metrics, and is embedded in the descriptions of trends, baselines, compare_periods and correlate.

### Metrics (`src/whoop/analytics.ts` `METRICS`)

`metric` is `z.enum` over these 20 names, in this order:

| Metric            | DayRow field          | Label                                 | Partial (day-total) metric? |
| ----------------- | --------------------- | ------------------------------------- | --------------------------- |
| recovery          | recovery_pct          | recovery %                            |                             |
| hrv               | hrv_ms                | HRV (ms, RMSSD)                       |                             |
| rhr               | resting_hr_bpm        | resting heart rate (bpm)              |                             |
| spo2              | spo2_pct              | blood oxygen %                        |                             |
| skin_temp         | skin_temp_c           | skin temperature (°C)                 |                             |
| sleep_hours       | sleep_h               | hours asleep                          |                             |
| sleep_needed      | sleep_needed_h        | hours of sleep needed                 |                             |
| deep_sleep        | deep_sleep_h          | hours of deep (slow-wave) sleep       |                             |
| rem_sleep         | rem_sleep_h           | hours of REM sleep                    |                             |
| sleep_performance | sleep_performance_pct | sleep performance %                   |                             |
| sleep_efficiency  | sleep_efficiency_pct  | sleep efficiency %                    |                             |
| sleep_consistency | sleep_consistency_pct | sleep consistency %                   |                             |
| respiratory_rate  | respiratory_rate      | respiratory rate (breaths/min)        |                             |
| disturbances      | disturbances          | sleep disturbances                    |                             |
| strain            | strain                | day strain (0-21)                     | yes                         |
| kcal              | kcal                  | energy (kcal)                         | yes                         |
| avg_hr            | avg_hr_bpm            | average heart rate over the day (bpm) | yes                         |
| steps             | steps                 | steps                                 | yes                         |
| workout_minutes   | workout_min           | workout minutes                       | yes                         |
| workouts          | workouts              | number of workouts                    | yes                         |
- **`complete(rows, metric)`** drops `in_progress` rows for the partial metrics (`PARTIAL_METRICS`). A day still running would otherwise read as an unusually low day.
- **`value(row, metric)`** returns the field if it is a number, otherwise `null`.

### Fetching and day assembly (`src/whoop/data.ts`)

**API paths:**

| Name         | Path                        |
| ------------ | --------------------------- |
| `cycles`     | `/v2/cycle`                 |
| `recoveries` | `/v2/recovery`              |
| `sleeps`     | `/v2/activity/sleep`        |
| `workouts`   | `/v2/activity/workout`      |
| profile      | `/v2/user/profile/basic`    |
| body         | `/v2/user/measurement/body` |

Record by id: `/v2/cycle/{id}`, `/v2/activity/sleep/{id}`, `/v2/activity/workout/{id}`, `/v2/cycle/{id}/recovery`, `/v2/cycle/{id}/sleep`.

**`listAll(client, path, start, end?)`**
- Query params: `limit=25` (WHOOP's maximum), `start` (ISO), `end` (ISO, omitted if undefined), `nextToken`. Undefined query values are dropped by the client.
- Follows `next_token` for at most 40 pages (`MAX_PAGES`, so at most 1000 records).
- Returns `{records, truncated}`, where `truncated` is true when the page cap was hit.

**`fetchDays(client, from, to, {workouts?})`**
- Window: `start = (from - 2 days)T00:00Z`; `end = min((to + 2 days)T00:00Z, now + 24h)`. The 2-day margin is there because cycles start the evening before and time zones shift the boundaries.
- Fetches cycles, recoveries, sleeps and workouts in parallel. Workouts are skipped (empty, not truncated) only when `include.workouts === false`.
- `truncated` is the OR of all four.
- **`first_data_date` detection:** "Leading days without data are either before the account existed or a wear gap."
  - Conditions: not truncated, AND the first day with a cycle is not index 0, AND no fetched cycle has `cycleDate < from`. A cycle in the fetch margin proves older data exists, so then there is no extra request.
  - If they hold, one extra request is made: `GET /v2/cycle {limit:1, end: firstCycle.start}`. The API lists newest first, so a single record tells the two cases apart.
  - If that returns no record whose id differs from `firstCycle.id`, then `first_data_date` is the first cycle's date.
  - There is no extra request when the window starts with data.

**`cycleDate(cycle)`** is the local date (via `timezone_offset`) of `start + 12h`, meaning the day you woke up into, because cycles start at sleep onset, often the previous evening. Tests:
- `23:30Z` on 10-26 maps to 10-27.
- `00:05Z` on 10-27 maps to 10-27.
- `21:30Z` on 10-26 at `+02:00` maps to 10-27.

**Date helpers:**
- `offsetMinutes` parses `+hh:mm`, `-hh:mm`, `+hhmm`, or anything else (including `Z`) as 0.
- `localDate(iso, off)` returns YYYY-MM-DD.
- `localTime` returns `"YYYY-MM-DD HH:MM"`, or null when there is no input.
- `addDays`, `dateRange` (inclusive) and `daysBetween` work on UTC midnight.

**`assembleDays`** produces one `Day {date, cycle?, recovery?, sleep?, naps[], workouts[]}` per date in `[from, to]`. Dates with no data are kept as empty days.
- Cycles are sorted by start. Each goes to the day `cycleDate(cycle)`; if two land on one date, the later wins.
- `recovery` is the recovery with `cycle_id === cycle.id`.
- `sleep` is the sleep matching `recovery.sleep_id` if there is one, otherwise the first non-nap sleep with that `cycle_id`.
- `naps` are the sleeps with that `cycle_id` and `nap: true`.
- Each workout goes to the last cycle with `start <= t < end`, or `end` open. Failing that, it goes to the local date of the workout's start. Workouts are sorted by start within a day.

**`currentDayIndex(days)`** finds the WHOOP day still running.
- If the last date has a cycle (or there are no days), the result is the last index; it is `-1` when `days` is empty.
- Otherwise the result is the index of the last day whose cycle is open (no `end`). Failing that, it is the last index.
- Only an open cycle counts, so stale data after a wear gap is never shown as today.

### Shaped output objects

Rounding:
- `round(n, digits=1)`: null, undefined or NaN become `null`.
- `hours(ms)`: 2 decimals.
- `minutes(ms)`: 0 decimals.
- `kcal(kJ)`: `kJ / 4.184`, 0 decimals.

**`shapeRecovery`** (`null` if absent):

| Field            | Source           | Rounding |
| ---------------- | ---------------- | -------- |
| `score_state`    |                  |          |
| `recovery_pct`   | recovery_score   | 0 dp     |
| `hrv_ms`         | hrv_rmssd_milli  | 1 dp     |
| `resting_hr_bpm` |                  | 0 dp     |
| `spo2_pct`       |                  | 1 dp     |
| `skin_temp_c`    |                  | 1 dp     |
| `calibrating`    | user_calibrating | `??null` |

**`shapeSleep`** (`null` if absent):

| Field                                                                        | Notes                                                                                                      |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `score_state`, `nap`                                                         |                                                                                                            |
| `start`, `end`                                                               | Local `YYYY-MM-DD HH:MM`                                                                                   |
| `in_bed_h`, `awake_h`, `light_h`, `deep_h` (slow-wave), `rem_h`, `no_data_h` | 2 dp                                                                                                       |
| `asleep_h`                                                                   | light + deep + REM, 2 dp                                                                                   |
| `sleep_cycles`, `disturbances`                                               |                                                                                                            |
| `needed_h`                                                                   | baseline + sleep debt + recent strain + recent nap (`need_from_recent_nap_milli`, added as WHOOP gives it) |
| `needed_breakdown_h`                                                         | `{baseline, sleep_debt, recent_strain, recent_naps}`, or null                                              |
| `performance_pct`, `efficiency_pct`, `consistency_pct`                       | 0 dp                                                                                                       |
| `respiratory_rate`                                                           | 1 dp                                                                                                       |

**`shapeCycle`** (`null` if absent):

| Field                               | Notes                  |
| ----------------------------------- | ---------------------- |
| `score_state`                       |                        |
| `start`, `end`                      | Local                  |
| `in_progress`                       | `!end`                 |
| `strain`                            | 1 dp                   |
| `kcal`                              |                        |
| `avg_hr_bpm`, `max_hr_bpm`, `steps` | `step_count`; `??null` |

**`shapeWorkout`:**

| Field                      | Notes                                                                 |
| -------------------------- | --------------------------------------------------------------------- |
| `sport`                    | sport_name                                                            |
| `score_state`              |                                                                       |
| `start`, `end`             | Local                                                                 |
| `duration_min`             | end − start                                                           |
| `strain`                   | 1 dp                                                                  |
| `avg_hr_bpm`, `max_hr_bpm` |                                                                       |
| `kcal`                     |                                                                       |
| `distance_km`              | meters / 1000, 2 dp; a missing distance stays **null, not 0**         |
| `altitude_gain_m`          | 0 dp                                                                  |
| `percent_recorded`         | ×100, 0 dp                                                            |
| `zone_minutes`             | `{z0..z5}` minutes from `zone_zero_milli`..`zone_five_milli`, or null |

**`dayRow(day)`** is one flat row per day:
- Recovery fields: `recovery_pct`, `hrv_ms`, `resting_hr_bpm`, `spo2_pct`, `skin_temp_c`.
- Sleep fields: `sleep_h` (asleep), `sleep_needed_h`, `deep_sleep_h`, `rem_sleep_h`, `sleep_performance_pct`, `sleep_efficiency_pct`, `sleep_consistency_pct`, `respiratory_rate`, `disturbances`.
- `nap_h`: sum of nap asleep time.
- Cycle fields: `strain`, `kcal`, `avg_hr_bpm`, `steps`.
- `workouts` (count) and `workout_min` (sum of durations).
- `in_progress`: the cycle exists and has no end. False when there is no cycle.
- **Untracked rule:** a day with no cycle AND no workouts gets `nap_h`, `workouts` and `workout_min` = `null`, not 0. Its counts are unknown, not zero.

### `data_quality` (`dataQuality(days, truncated, firstData?)`)

| Field                                       | Meaning                                                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `days`                                      | Number of days                                                                                               |
| `days_with_recovery`                        | Recovery `score_state === "SCORED"`                                                                          |
| `days_missing_data`                         | Dates with no cycle, excluding dates before `firstData` and dates after the last open cycle                  |
| `first_data_date`, `days_before_first_data` | Only when some dates precede `firstData`                                                                     |
| `in_open_cycle`                             | Dates after the last open cycle that have no cycle: covered by it (no sleep detected since), not missed wear |
| `score_states`                              | Counts keyed `{cycle                                                                                         | recovery | sleep}_{state lowercased}`, e.g. `recovery_pending_score` |
| `calibrating`                               | Any day's recovery has `user_calibrating`                                                                    |
| `truncated`                                 | When the page cap was hit: "Hit the page limit; the oldest records in the range may be missing."             |

**Test fixture.** Open cycle labelled 10-26; range 10-22..10-27; `firstData = 10-25`. Expected: `days_before_first_data = 3`, `in_open_cycle = ["2026-10-27"]`, `days_missing_data = []`. Without `firstData`, `days_missing_data = [10-22, 10-23, 10-24]`.

### Statistics (`analytics.ts`)

- **Rounding.** `r2` rounds to 2 decimals.
- **`stats(values)`** returns `{n:0}` when empty. Otherwise `{n, mean, median, sd, min, max, p10, p90}`:
  - `sd` is the sample SD (n−1); it is 0 when n = 1.
  - Quantiles use linear interpolation at `(n-1)*q`.
- **`slopePerWeek(points [i, value])`** is the least-squares slope × 7. It is null when n < 3 or the x variance is 0. Points use the series index `i`, not calendar gaps.
- **`percentileOf(values, v)`** is `round(100 × count(x ≤ v) / n)`, or 0 when empty.
- **`mean(values)`** ignores non-numbers. It returns null when empty, otherwise `r2`.
- **`trend(rows, metric)`:**
  - Applies `complete()` first.
  - Returns `{metric, description, ...stats, slope_per_week, latest: {date, value, percentile} | null, missing_days: [dates with null], series: [{date, value, avg_7d}]}`.
  - `avg_7d` is the mean of the non-null values among the current and previous 6 series points, or null.
- **`baseline(history, today, metric)`:**
  - Uses `complete(history)` values.
  - If `today.in_progress` and the metric is partial, it returns stats plus `today: null`, `today_so_far: value`, `z_score: null`, `today_percentile: null`, `note: "Day in progress; whole-day totals are not comparable yet."`
  - Otherwise `enough = n >= 7`:
    - `z_score = r2((t - mean)/sd)` only when enough, t is non-null and sd ≠ 0.
    - `today_percentile` only when enough.
    - When not enough: `note: "Fewer than 7 days of data; not enough for a baseline."`
  - Recovery on an in-progress day is still compared, because it is final in the morning.
- **`compare(a, b, metric)`** returns:
  - `{metric, description, period_a_mean, period_b_mean, change = r2(mb - ma), change_pct = r2((mb-ma)/|ma| × 100), n_a, n_b}`.
  - `change_pct` is null when `ma = 0`.
  - `n_*` counts non-null values after `complete()`.
- **`correlate(rows, x, y, lag)`:**
  - Pairs `rows[i]`'s x with `rows[i+lag]`'s y. Rows are consecutive days, so a row offset is a day offset.
  - Applies `complete()` per value and skips nulls.
  - `pearson_r` is null when n < 3 or there is zero variance.
  - `spearman_rho` is the Pearson of average ranks (ties share the mean rank).
  - `strength` from |r|: under 0.1 is "none", under 0.3 is "weak", under 0.5 is "moderate", otherwise "strong". Null when r is null.
  - `note`: "Few data points, so treat this as a hint. " when n < 14, followed by "Correlation is not causation."
  - Returns `{x:{metric,description}, y:{metric,description,lag_days}, n, pearson_r, spearman_rho, strength, note}`.
  - Test: 10 rows give n = 9 at lag 1, and r = rho = −1.
- **`trainingLoad(rows)`:**
  - `done` = the non-in-progress rows.
  - `acute_strain_7d` = mean of the last 7 non-null strains. `chronic_strain_28d` = mean of the last 28.
  - `acute_chronic_ratio = r2(acute/chronic)` only if the chronic window has at least 21 non-null strain days (`MIN_CHRONIC_DAYS`). Otherwise null, plus `note: "The ratio needs at least 21 of the last 28 days with strain data."`
  - `ratio_band`:
    - below 0.8: "below usual (lighter than your recent norm: a planned deload, illness/rest, or less training)"
    - 0.8 to 1.3 inclusive: "usual range"
    - above 1.3: "above usual (ramping up)"
  - `days_with_strain: {acute, chronic}`.
  - `sleep_shortfall_7d_avg_h` = mean over the last 7 rows (including in-progress) of `sleep_needed_h - sleep_h`.
    - It is an **average, never a sum**: WHOOP's "sleep needed" already carries debt, so summing would count it twice.
    - The old field `sleep_debt_7d_h` must not exist; a test checks this.
  - `sleep_shortfall_note` (fixed text): "Average nightly gap between sleep needed and sleep got. Sleep needed already includes carried-over debt, so these gaps don't add up to a total."
  - `recovery_7d_avg` = mean `recovery_pct` over the last 7 rows.
  - Test: 21 days at strain 10 followed by 7 at 15 gives acute 15, chronic 11.25, ratio 1.33, band "above usual (ramping up)".

### whoop_today

**Description (verbatim):** "Start here for 'how am I today?', training readiness or 'should I train hard?'. One snapshot for a day: last night's sleep (stages, sleep needed vs. got), the morning's recovery (score, HRV, resting HR, SpO2, skin temp), the day's strain, calories and steps so far (in_progress while the day is still running), the day's workouts, and how each key number compares with the previous 30 days. A WHOOP day runs from sleep to sleep, not midnight to midnight: after midnight, or after a night without the strap, the day still running is shown and current_cycle_date says which. Comparisons need 7+ days of history (baseline_days); with fewer, describe today's values and say the baseline is still forming. Recovery is green at 67-100%, yellow at 34-66% and red at 0-33%; while WHOOP is calibrating (the first weeks) treat the score as provisional."

**Inputs:**

| Param  | Type                                                                                   | Default |
| ------ | -------------------------------------------------------------------------------------- | ------- |
| `date` | iso date, optional; refused if in the future ("date (…) is in the future; today is …") | today   |
| `raw`  | boolean                                                                                | false   |

The 7-day raw limit does not apply here; it is a single day.

**Computation:**
- Fetch `fetchDays(requested − 37, requested)` (30 + rollback margin). `today = days[currentDayIndex]`. If none: `InputError "No data for {requested}."`
- History is up to 30 days before that index.
- `vs_last_30_days` covers `recovery, hrv, rhr, sleep_hours, sleep_performance, respiratory_rate`, plus `strain` only when not in progress.
  - Each entry is `{metric, today, baseline_avg (mean only when baseline n ≥ 7, else null), baseline_days (n), z_score}`.
  - `baseline_avg` and `baseline_days` replaced the old `avg_30d` in `9fed2ae`.
- Zone from `recovery_pct`: 67 or more is green, 34 or more is yellow, otherwise red. Null when there is no score.
- `rolled = today.date !== requested && cycle exists`.
- `no_sleep_since`: when the open cycle started more than 30h ago, this is the local start time.

**Output:**

| Field                | Notes                                                                                                                                                                                                 |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `date`               | Requested date                                                                                                                                                                                        |
| `current_cycle_date` | Only when rolled                                                                                                                                                                                      |
| `recovery`           | `shapeRecovery` + `zone`, or null. If calibrating, also `zone_note`: "WHOOP is still calibrating to this person, so the score and zone are provisional; don't cut habitual activity because of them." |
| `sleep`, `naps[]`    | `shapeSleep`                                                                                                                                                                                          |
| `day`                | `shapeCycle`                                                                                                                                                                                          |
| `workouts[]`         | `shapeWorkout`                                                                                                                                                                                        |
| `vs_last_30_days[]`  | See above                                                                                                                                                                                             |
| `baseline_window`    | `{from, to, days_with_data (history days with a cycle), first_data_date ?? null, calibrating_days}`                                                                                                   |
| `data_quality`       | `dataQuality([today], truncated)`; no firstData is passed                                                                                                                                             |
| `no_sleep_since`     | Optional                                                                                                                                                                                              |
| `raw`                | `{date, cycle, recovery, sleep, naps, workouts}`, when `raw` is set                                                                                                                                   |
| `disclaimer`         |                                                                                                                                                                                                       |

**Summary text:**
- With a cycle: `{lead}WHOOP for {today.date}: {recoveryText}, strain {strain|n/a}{" so far" if in_progress}, {n} workout(s).{noSleep}`
  - `lead` (when rolled): "The WHOOP day that started {local time} is still running (it rolls over after the next sleep), so this shows {date}. "
  - `noSleep`: " No sleep has been detected since {time}; the strap may have been off overnight."
- Without a cycle: "No WHOOP cycle for {requested} yet."
- `localTimeOf` falls back to "an unknown time".

**`recoveryText`** (so Claude never waits for a score that will not come):

| Case                   | Text                                                                        |
| ---------------------- | --------------------------------------------------------------------------- |
| No recovery            | "no recovery recorded for last night"                                       |
| `PENDING_SCORE`        | "recovery still being scored"                                               |
| `UNSCORABLE`           | "WHOOP could not score recovery (not enough data, e.g. strap off or loose)" |
| Scored                 | "recovery {pct\|n/a}%{ (zone)}"                                             |
| Scored and calibrating | Scored text plus ", provisional because WHOOP is still calibrating"         |

Tests: an unscorable recovery must not say "not scored yet"; a strap-off night shows "still running", "no recovery recorded" and "strap may have been off", and keeps the open cycle's workouts.

### whoop_daily_summaries

**Description (verbatim):** "One row per day over a date range (default the last 7 days, max 90): recovery, HRV, resting HR, SpO2, skin temp, hours asleep vs. needed, deep and REM sleep, sleep performance/efficiency/consistency, respiratory rate, day strain, kcal, steps, workout count and minutes. Plus averages over the range. Use it for 'how was my week', weekly check-ins and spotting patterns. Days with no WHOOP data have null values; the current day is in_progress."

**Inputs:** `rangeShape(7)` + `raw`.

**Output:**
- `{from, to, days: DayRow[], averages, data_quality: dataQuality(days, truncated, first_data_date), raw?: rawDays}`.
- `averages` (each the mean over `complete()` rows): `recovery_pct`, `hrv_ms`, `resting_hr_bpm`, `sleep_h`, `sleep_performance_pct`, `strain`, `kcal`, `steps`, `workout_min`.

**Summary:** "{n} day(s) of WHOOP data from {from} to {to}."

### whoop_sleep

**Description (verbatim):** "Every sleep in a date range (default last 7 days, max 90), newest last: bed and wake times, hours in bed / asleep / awake, light, deep (slow-wave) and REM hours, sleep cycles, disturbances, sleep needed with its breakdown (baseline, debt, recent strain, naps), performance, efficiency, consistency and respiratory rate. Use it for sleep coaching: bedtime consistency, sleep debt, deep/REM balance."

**Inputs:** `rangeShape(7)`, `include_naps` (boolean, default true, "Include naps."), `raw`.

**Computation:**
- Calls `listAll(sleeps)` directly over `(from−1)T12:00Z` to `(to+1)T12:00Z`.
- A sleep's date is the **local date of its end**. Sleeps are filtered to `[from, to]` (and naps dropped if excluded), then sorted by start ascending.

**Output:**
- `{from, to, sleeps: [{date, ...shapeSleep}], averages, truncated?, raw?}`.
- `averages` cover non-nap sleeps with non-null `asleep_h`: `asleep_h`, `needed_h`, `deep_h`, `rem_h`, `performance_pct`, `efficiency_pct`.
- `truncated?`: "Hit the page limit; the oldest sleeps may be missing."
- `raw?` is the unshaped records.
- No `data_quality`.

**Summary:** "{n} sleep(s) from {from} to {to}."

### whoop_workouts

**Description:** "Every workout in a date range (default last 7 days, max 90): sport, local start/end, duration, strain, average and max HR, kcal, distance, altitude gain, minutes in each heart-rate zone (z0-z5), percent recorded. Plus totals per sport and minutes per zone. Optional sport filter (matches WHOOP's sport name, e.g. running, walking, weightlifting). " followed by ZONE_LEGEND.

**Inputs:** `rangeShape(7)`, `sport` (string, optional, "Only this sport (case-insensitive substring of the sport name)."), `raw`.

**Computation:**
- Calls `listAll(workouts)` over `(from−1)T00:00Z` to `(to+2)T00:00Z`.
- A workout's date is the **local date of its start**. This tool does not assign workouts to cycles.
- Filtered by date and a case-insensitive substring match on `sport_name`, then sorted by start.

**Output:**
- `{from, to, workouts[], totals_by_sport, zone_minutes_total: {z0..z5}, truncated?, raw?}`.
- `totals_by_sport` is keyed by sport: `{count, minutes, strain_avg (mean), kcal}`.
- `truncated?`: "Hit the page limit; the oldest workouts may be missing."

**Summary:** "{n} workout(s) from {from} to {to}{ matching "{sport}"}."

Tests: `sport: "walk"` gives `walking: {count 1, minutes 60}`; `sport: "rowing"` gives `workouts: []`.

### whoop_trends

**Description:** "How one metric moved over the last N days (default 30, max 90): mean, median, SD, min/max, p10/p90, slope per week, the latest value and its percentile, missing days, and a daily series with a 7-day rolling average. Metrics: {METRIC_HELP}."

**Inputs:** `metric` (required), `rangeShape(30)`.

**Computation:**
- `fetchDays`, fetching workouts only if the metric is `workouts` or `workout_minutes`.
- Rows are cut after `currentDayIndex`: dates after a still-running WHOOP day belong to it and are not missing.
- Then `trend()`.

**Output:** `{from, to, ...trend, data_quality}`.

**Summary:** "{label} from {from} to {to}: mean {mean|n/a}, slope {slope|n/a} per week."

### whoop_baselines

**Description:** "Your personal normal range per metric from the N days before a date (default 30, max 90): mean, SD, p10/median/p90, and that date's value with a z-score and percentile. Use it to judge whether today is unusual for this person rather than against population norms. Metrics default to recovery, hrv, rhr, sleep_hours, sleep_performance, respiratory_rate, strain. Available: {METRIC_HELP}."

**Inputs:**

| Param     | Type                              | Default                                                                                                               |
| --------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `date`    | iso date, optional, not in future | today                                                                                                                 |
| `days`    | int **7..90**                     | 30 ("Days of history before date.")                                                                                   |
| `metrics` | array of metric, optional         | recovery, hrv, rhr, sleep_hours, sleep_performance, respiratory_rate, strain (an empty array also means the defaults) |

**Computation:**
- Fetch `(date − (n+7))..date`. `idx = currentDayIndex`. History is the n rows before idx.

**Output:**
- `{date, current_cycle_date?, in_progress, history: {from, to}, baselines: baseline(...)[], data_quality}`.
  - `current_cycle_date` appears when the current day's date differs from the requested one.
  - `history` defaults to `day−n` and `day−1` when empty.
  - `data_quality` is computed over `days[idx−n .. idx]`.

**Summary:** "Baselines over {k} day(s) before {day}{ ({first} to {last})}."

Test: with an open cycle 36h old, `current_cycle_date` is set, `in_progress` is true, and strain gives `today: null, today_so_far: 10, z_score: null`.

### whoop_compare_periods

**Description:** "Side-by-side averages for two date ranges (each up to 90 days), with absolute and % change from A to B and the sample count per period. E.g. this week vs last week, or before vs after a training block. Metrics default to recovery, hrv, rhr, sleep_hours, sleep_performance, strain, steps, workout_minutes. Available: {METRIC_HELP}."

**Inputs:**
- `period_a` ("The earlier / reference period.") and `period_b` ("The period to compare against A."). Each is `{start_date, end_date}`, both required iso dates.
- Each period goes through `resolveRange` (not in the future, ordered, at most 90 days).
- `metrics`: optional, with the defaults listed above.

**Computation:** two `fetchDays` calls in parallel, then `compare()` per metric.

**Output:** `{period_a: {from, to}, period_b: {from, to}, comparison[], data_quality: {period_a, period_b}}`.

**Summary:** "Compared {a.from}..{a.to} with {b.from}..{b.to}."

### whoop_training_load

**Description:** "Training load for programming and deload decisions: daily strain over the last N days (default 28, max 90), acute (7-day) vs chronic (28-day) average strain and their ratio (about 0.8-1.3 is the usual band; well above it means load is ramping up fast), the average nightly sleep shortfall over the last 7 days (needed minus asleep), the 7-day average recovery, and workout minutes per heart-rate zone over the last 7 days. Read ratio_band together with recovery_7d_avg: a low ratio with low recovery is usually an appropriate deload, not a reason to add load. " followed by ZONE_LEGEND.

**Inputs:** `days`, int 7..90, default 28 ("Days of daily strain to return."). The end date is always today; there is no date input.

**Computation:**
- Fetch `today − (max(n, 28) + 7)` to today, so there are 28 completed days plus the current one even when the WHOOP day still running started days ago.
- Cut after `currentDayIndex`.
- `zone_minutes_7d` sums the workout zones of the last 7 days.

**Output:** `{...trainingLoad, zone_minutes_7d, daily: last n of {date, strain, recovery_pct, sleep_h, workout_min, in_progress}, data_quality over last max(n, 28) days}`.

**Summary:** "Training load up to {last day date}."

Test: when yesterday's cycle is still open, `days_with_strain` is `{acute: 7, chronic: 28}` and the last daily date is yesterday.

### whoop_correlate

**Description:** "Correlation between two metrics over the last N days (default 60, max 90), optionally lagged: x on one day vs y lag_days later (e.g. strain vs next-day recovery with lag_days 1, or workout_minutes vs sleep_performance). Returns Pearson r, Spearman rho, n and a strength label. Correlation is not causation. Metrics: {METRIC_HELP}."

**Inputs:**

| Param      | Type                                                | Default  |
| ---------- | --------------------------------------------------- | -------- |
| `x`        | metric ("The first metric (on day d).")             | required |
| `y`        | metric ("The second metric (on day d + lag_days).") | required |
| `lag_days` | int 0..3                                            | 0        |
| `days`     | int 7..90                                           | 60       |

**Computation:** window `today−(n−1)..today`. No rollback margin and no `currentDayIndex` cut; partial metrics drop the in-progress row via `complete()`.

**Output:** `{from, to, ...correlate, data_quality}`.

**Summary:** "{x} vs {y}{ {lag} day(s) later}: r = {r|n/a} (n = {n})."

### whoop_get_record

**Description:** "Escape hatch: one record by ID, both shaped and as WHOOP returned it. Types: cycle (numeric cycle ID), sleep (UUID), workout (UUID), recovery_for_cycle and sleep_for_cycle (numeric cycle ID). IDs come from the raw output of the other tools."

**Inputs:**
- `type`: enum `cycle | sleep | workout | recovery_for_cycle | sleep_for_cycle`.
- `id`: string, min length 1 ("The record ID.").
- The id is `encodeURIComponent`-escaped into the path.

**Output:** `{type, shaped, raw}`, where `shaped` uses the matching shape function.

**Summary:** "Cycle {id}." / "Sleep {id}." / "Workout {id}." / "Recovery for cycle {id}." / "Sleep for cycle {id}."

### whoop_profile (`src/server.ts`)

**Description:** "Get the WHOOP member's name and body measurements (height, weight, max heart rate)."

**Input:** `include_email`, boolean, default false ("Include the account email address.").

**Computation:** fetches profile/basic and measurement/body in parallel.

**Output:**
- `name`: `"{first} {last}"`, trimmed.
- `email`: only when `include_email` is true.
- `height_cm`: `round(height_meter × 1000)/10`, i.e. to the nearest mm.
- `weight_kg`: 1 dp.
- `max_heart_rate_bpm`.
- `note: "Not medical advice."`

**Summary:** "Profile for {name}."

**Errors:** go through `toolError`, so a missing login auto-starts one.

### Server instructions (`src/server.ts` `INSTRUCTIONS`, verbatim)

```
WHOOP data for the user's own account: recovery, HRV, resting heart rate, sleep, strain, steps and workouts.
Useful for planning and reviewing the user's training:
- "How am I today?", readiness, whether to train hard: whoop_today.
- Weekly check-ins and patterns: whoop_daily_summaries, whoop_compare_periods.
- Programming, deloads, overreaching: whoop_training_load (acute:chronic strain), whoop_trends, whoop_baselines.
- Sleep: whoop_sleep. Training history: whoop_workouts. What drives what: whoop_correlate.
Judge numbers against the user's own baselines (whoop_baselines, or vs_last_30_days in whoop_today) rather than population norms, and say when data is missing, pending or calibrating. A baseline needs 7+ days (baseline_days); with fewer, say it is still forming. Dates before data_quality.first_data_date have no WHOOP data at all (usually the account is newer than the range), so don't read them as missed wear or rest days. Dates are the user's local dates; a WHOOP day runs from sleep to sleep, not midnight to midnight.
WHOOP heart-rate zones are % of heart-rate reserve (resting HR + pct x (max HR - resting HR)), not % of max HR.
Present suggestions as options for the user to choose. This is not medical advice: suggest a professional for symptoms, injuries or anything clinical.
If a tool says WHOOP isn't connected, it has already opened the connection page: tell the user in one sentence, call whoop_login with wait_seconds until it reports connected, then carry on with their request. Never ask the user to say when they're done.
```

Server identity: `{ name: "whoop-mcp", version: VERSION }`.

### Tool-call logging (`src/server.ts` `instrumentTools`)

- **How it hooks in.** It wraps the SDK's `tools/call` handler, so calls rejected by argument validation are logged too.
  - For this to work, `capabilities: { tools: {} }` must **not** be passed to the McpServer constructor. Passing it installs the handler before the wrapper can intercept it.
- **Log lines:**
  - Success: `INFO tool {name} ok ms=… args=…`.
  - Error result: `WARN tool {name} error ms args error=<first 300 chars>`.
  - Throw: `ERROR tool {name} failed`.
- **What is logged.** Arguments only (dates, ranges, metric names, flags). Results are never logged, because they are WHOOP data; a test asserts the profile name never appears in the log.
- **WHOOP requests** time out after 20s (`REQUEST_TIMEOUT_MS` in `src/whoop/client.ts`).

### Behaviour rules to preserve (from tests and commits)

- Missing data is `null`, never 0: distance, untracked-day counts, unscored fields.
- The in-progress day is excluded from statistics for whole-day totals. Recovery and sleep metrics on that day still count.
- After midnight or a strap-off night, show the open cycle's day (`current_cycle_date`), not an empty date, and never present stale data after a wear gap as today.
- Future dates are refused (`"in the future"`) with no API calls. A reversed range errors with `"must be on or before end_date"`.
- Pending, unscorable and calibrating states are worded explicitly. Calibrating recovery is called provisional.
- Days before `first_data_date` and days inside an open cycle are not "missing".
- The sleep shortfall is an average, not a sum.
- Raw output is capped at 7 days.
- Compact JSON in the text block.
- Every data result carries `disclaimer`.

### Corrections and additions

Found when this part was checked against the code. Where they differ from the text above, these are right.

**Data-tool error contract (corrections)** (src/tools/common.ts, src/whoop/client.ts, src/server.ts)

`toolError(err, loginFlow)` maps errors like this:

| Error                                                                                                                                                                                                             | Auto-starts a login?                                  | Text Claude gets                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NotLoggedInError`, including its subclass `SessionExpiredError`                                                                                                                                                  | Yes, via `startIfIdle()`                              | When a flow is pending: the "WHOOP isn't connected…" script. Otherwise `err.message` (`SessionExpiredError` has its own message)                                                          |
| `ConfigError` (no app credentials when a refresh needs them)                                                                                                                                                      | Yes, via `notConnectedResult(new NotLoggedInError())` | When a flow is pending: the script. Otherwise **always** `"Not logged in to WHOOP. Call the whoop_login tool first."`. The ConfigError message is never shown                             |
| `CredentialsRejectedError` (refresh returned `invalid_client`/`unauthorized_client`)                                                                                                                              | **No**                                                | Plain `isError` text: `WHOOP rejected the app credentials (<code>). Call whoop_login with reconfigure: true …`. No page opens; Claude has to call `whoop_login {reconfigure:true}` itself |
| `OAuthHttpError` other than `invalid_grant` (e.g. a 5xx at the token endpoint), `"WHOOP is slow to renew the login; try again in a moment."` (the 25 s refresh wait), request timeout, `WhoopApiError`, fs errors | No                                                    | Plain `err.message`                                                                                                                                                                       |
- The fallback (no flow pending) applies in three cases: the 60 s cooldown after a failed login, `startIfIdle()` throwing (logged as warn `could not start a WHOOP login on demand`), or the flow not being `pending` after start.
- Trap: after a `CredentialsRejectedError`, or any non-`invalid_grant` refresh failure, `authFailure.expired` is `false`. `isConnected()` then still returns true if the tokens and credentials exist, so `whoop_login` **without** `reconfigure` answers "WHOOP is connected…" right away. `whoop_status` shows it as `logged_in: true` plus `last_error` ("Logged in, but the last token refresh failed: …").

**`isConnected` and `missing_scopes` when the token has no `scope`** (src/server.ts, src/config.ts)
- `isConnected` runs `tokens.scope?.split(/\s+/) ?? []`. With no `scope` that gives `[]`, every `SCOPES` entry counts as missing, and the result is **not connected**. `whoop_login` therefore starts a flow instead of returning `connected`.
- `whoop_status` reports `missing_scopes` as all 7 scopes for such tokens, and its summary says "Connected, but without …" (`logged_in` stays true).
- The login and setup paths use `missingScopes(undefined) === []`, so an absent scope counts as **complete** and the login is accepted and saved.
- Keep these semantics as they are; unifying them changes behaviour (the scope-less token is saved, then reported as not connected).

**URLs handed to Claude** (src/auth/browser-setup.ts, src/auth/background-login.ts, src/server.ts, src/tools/common.ts)
- For `kind: "login"`, `LoginStatus.authorizeUrl` is WHOOP's authorize URL, which contains `state` and `client_id`.
- For `kind: "setup"` it is the **local one-time setup link** `http://<redirect.host>/setup?t=<32-byte token>`. `redirect.host` includes the port, e.g. `localhost:8787`.
- That token-bearing link reaches the model on purpose, so the user can open it if the browser didn't. It appears in:
  - the `whoop_login` `url` field and its "if it didn't open, they can visit …" text;
  - `whoop_status` `login.authorize_url` and its summary;
  - the `notConnectedResult` text.
- Exposing it to the model is by design. Anyone holding the token can drive the setup page until the flow ends.

**`whoop_disconnect` revoke condition (reconciled)** (src/server.ts, test/server.test.ts)
1. `await loginFlow.cancel()`.
2. `await client.drain?.()`.
3. `hadLogin = (await readTokens()) !== null`.
4. `revoked = hadLogin ? ((await client.revokeAccess?.()) ?? "failed") : "not_logged_in"`. With no token file nothing goes to the network (test: "with nothing connected it says so and calls nothing"). A client without `revokeAccess` gives `"failed"`.
5. Then `withTokenLock(deleteTokens)`, then credentials are deleted unless `keep_app`.

**`whoop_sleep` / `whoop_workouts` window consequences** (src/tools/data-tools.ts, src/whoop/data.ts, docs/whoop-api-notes.md)
- `listAll` passes `start`/`end`. WHOOP filters collections on the record's **start** time, in `[start, end)`.
- `whoop_sleep` fetches starts in `[(from−1)T12:00Z, (to+1)T12:00Z)`, then keeps sleeps whose **local end date** (`localDate(s.end, s.timezone_offset)`) is in `[from, to]`. With `include_naps:false` it drops `nap`. Results are sorted by start.
  - Low end: a sleep is missed if it started before `(from−1)T12:00Z`. For UTC to roughly UTC+10 users this is harmless. At offsets of about +12 or more (e.g. NZ summer), a main sleep that ends early on local `from` can start before 12:00Z the previous day and is silently dropped. This is a latent edge case.
  - High end: a sleep ending on local `to` ends by `(to+1)T00:00 local`, which is at most `(to+1)T12:00Z` for offsets ≥ −12h, so it always started inside the window. Safe.
- `whoop_workouts` fetches starts in `[(from−1)T00:00Z, (to+2)T00:00Z)` and keeps workouts whose **local start date** is in `[from, to]`. That is safe for all offsets from −12 to +14.
- `totals_by_sport[sport]`:
  - `count`;
  - `minutes`: Σ of per-workout `duration_min`, already rounded to whole minutes, not re-rounded;
  - `kcal`: Σ of per-workout `kcal`, already rounded to integers; nulls count as 0;
  - `strain_avg`: `mean()` of per-workout `strain` (1 dp each), rounded to 2 dp, `null` when there are none.
- `zone_minutes_total` is a plain sum of the per-workout zone minutes.

**`whoop_trends` scope vs `data_quality`; tools that never cut** (src/tools/data-tools.ts, src/whoop/data.ts, src/whoop/analytics.ts)
- `whoop_trends`: `trend()` runs on `days.slice(0, currentDayIndex(days)+1)`. `data_quality` is `dataQuality(days, …)` over **all** fetched days in `[from, to]`, uncut.
  - Dates after a still-open cycle therefore appear in `data_quality.in_open_cycle`. `dataQuality` excludes them from `days_missing_data` (the field is `days_missing_data`, not `missing_days`).
  - They are also absent from the trend's own series and missing count.
- `whoop_trends` fetches with `{ workouts: metric === "workouts" || metric === "workout_minutes" }`. For other metrics no workouts are fetched. `dayRow`'s `tracked = Boolean(day.cycle) || day.workouts.length > 0`, so in trends a day with only workouts and no cycle reads as untracked: its count fields (`workouts`, `workout_min`, `nap_h`) are null. That doesn't matter for the non-workout metrics trends was asked about.
- `whoop_daily_summaries`, `whoop_compare_periods` and `whoop_correlate` never cut at `currentDayIndex`. Their rows include the dates after an open cycle, with null values.
  - The open cycle's own date is `in_progress`, and `complete()` drops it only for `PARTIAL_METRICS`.
  - Averages ignore the nulls via `mean()`.
- `whoop_correlate`: `rows[i + lag]` pairs by row position, and rows are consecutive calendar dates, so position = date offset. The null rows after an open cycle **don't misalign** pairs. They only drop every pair whose x-day or y-day falls on them, which lowers `n`.

**`whoop_training_load` acute/chronic windows (correction)** (src/whoop/analytics.ts `trainingLoad`, src/tools/data-tools.ts)
- The tool first cuts rows at `currentDayIndex`. `trainingLoad` then drops rows with `in_progress` to get `done`.
- `acute = mean(strains of done.slice(-7))` and `chronic = mean(strains of done.slice(-28))`. The windows are the last 7/28 **completed calendar rows**; null strains are removed only after slicing. Missing days shrink the sample and are **not** replaced by older days.
- `days_with_strain.{acute, chronic}` = count of non-null strains inside those fixed windows.
- The ratio needs `days_with_strain.chronic >= MIN_CHRONIC_DAYS (21)` and a truthy chronic. Otherwise `acute_chronic_ratio: null` plus `note: "The ratio needs at least 21 of the last 28 days with strain data."`. The ratio is rounded to 2 dp.
- `sleep_shortfall_7d_avg_h` and `recovery_7d_avg` use `rows.slice(-7)` of the cut rows, **including** the in-progress row.


## WHOOP API client, OAuth token lifecycle and OpenAPI spec

Sources: `src/whoop/client.ts`, `src/config.ts`, `src/auth/oauth.ts`, `src/auth/store.ts`, `src/whoop/data.ts` (callers), `openapi/whoop.yaml`, `scripts/update-spec.ts`, `src/whoop/openapi.d.ts`, `docs/whoop-api-notes.md`, `test/client.test.ts`, `test/spec.test.ts`, `package.json`, git log (commits 9fed2ae, 8040780, 69a92b5, 4af7981, 7e3a183).

### Constants and configuration (`src/config.ts`)

| Name                   | Value                                                                                          | Notes                                                                                        |
| ---------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `WHOOP.apiBase`        | `https://api.prod.whoop.com/developer`                                                         | Every API path is appended to this, e.g. `/v2/cycle` becomes `.../developer/v2/cycle`        |
| `WHOOP.authorizeUrl`   | `https://api.prod.whoop.com/oauth/oauth2/auth`                                                 | OAuth issuer is `https://api.prod.whoop.com/oauth/`                                          |
| `WHOOP.tokenUrl`       | `https://api.prod.whoop.com/oauth/oauth2/token`                                                |                                                                                              |
| `WHOOP.openapiUrl`     | `https://api.prod.whoop.com/developer/doc/openapi.json`                                        | Used only by `scripts/update-spec.ts`                                                        |
| `DEFAULT_REDIRECT_URI` | `http://localhost:8787/callback`                                                               | Confirmed to work as a WHOOP dashboard app redirect                                          |
| `VERSION`              | `package.json` `version`                                                                       | Single source of truth. It is inlined into compiled binaries, and `bun run release` bumps it |
| `SCOPES`               | `offline read:profile read:body_measurement read:cycles read:recovery read:sleep read:workout` | `offline` is the scope that returns a refresh token                                          |

Env vars:

| Var                                      | Effect                                                                                                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WHOOP_CLIENT_ID`, `WHOOP_CLIENT_SECRET` | App credentials for development. They are trimmed, and a blank value counts as unset (`envValue`). Both must be set or neither is used. Env wins over the keychain and the file |
| `WHOOP_REDIRECT_URI`                     | Overrides the redirect URI, including for stored (keychain/file) credentials                                                                                                    |
| `WHOOP_MCP_HOME`                         | Config dir override. It is used exactly as given                                                                                                                                |
| `XDG_CONFIG_HOME`                        | Without `WHOOP_MCP_HOME`, the config dir is `$XDG_CONFIG_HOME/whoop-mcp`. The fallback is `~/.config/whoop-mcp`                                                                 |
- Each user brings their own WHOOP developer app. Developer credentials are never shipped in source (ToU §3.2.1).
- `ConfigError` is thrown by `resolveClientCredentials` when env, keychain and file are all empty. Its message: "No WHOOP app credentials found. Use the whoop_login tool: it opens a setup page in the browser."

### Scopes and missing-scope handling

- `missingScopes(granted)` takes the token response's space-separated `scope` and returns the entries of `SCOPES` it lacks. If `scope` is `undefined`, it returns `[]`, because an absent scope can't be checked and so counts as complete.
- `missingScopesMessage(missing)` returns this exact text: `WHOOP didn't grant every permission whoop-mcp needs (missing: a, b), so it didn't connect. Approve all of them on WHOOP's page; if one isn't offered, tick it under Scopes in your WHOOP app. Then try again.`
- The policy is "all permissions or no connection". WHOOP's consent page lets users untick scopes, and an app may not have every scope enabled. A partial grant would leave tools failing one by one later.
  - On a partial grant after the code exchange, the partial access token is revoked at WHOOP (`DELETE /v2/user/access`) and nothing is saved.
  - `MissingScopesError` (in `oauth.ts`, with `.missing`) is thrown by the consent-only login.
  - The browser setup page stays in the `authorizing` phase, shows the message and offers Try again. The used approval is cleared.
- The authorize URL sends `scope` as `SCOPES.join(" ")`. The refresh request sends `scope=offline`.
- `whoop_status`/`isConnected` (in `server.ts`) also treat stored tokens whose `scope` lacks any of `SCOPES` as not connected.

### Endpoints used

| Method | Path                                                                     | Caller / purpose                                                                          |
| ------ | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| GET    | `/v2/user/profile/basic`                                                 | Profile: `user_id`, `email`, `first_name`, `last_name`                                    |
| GET    | `/v2/user/measurement/body`                                              | `height_meter`, `weight_kilogram`, `max_heart_rate`                                       |
| GET    | `/v2/cycle`                                                              | Collection (paged)                                                                        |
| GET    | `/v2/recovery`                                                           | Collection (paged)                                                                        |
| GET    | `/v2/activity/sleep`                                                     | Collection (paged)                                                                        |
| GET    | `/v2/activity/workout`                                                   | Collection (paged)                                                                        |
| GET    | `/v2/cycle/{id}`, `/v2/activity/sleep/{id}`, `/v2/activity/workout/{id}` | `whoop_get_record`. The id goes through `encodeURIComponent`                              |
| GET    | `/v2/cycle/{id}/recovery`, `/v2/cycle/{id}/sleep`                        | `whoop_get_record` (`recovery_for_cycle`, `sleep_for_cycle`)                              |
| DELETE | `/v2/user/access`                                                        | Revokes this app's access at WHOOP. It ends the login at WHOOP, not only on this computer |
| POST   | token URL                                                                | `authorization_code` and `refresh_token` grants                                           |

Not used: PKCE, HTTP Basic or public-client (`none`) auth, `openid`/id tokens, webhooks, and v1 or Trusted Partner endpoints. The discovery document advertises `client_secret_post`, `client_secret_basic`, `private_key_jwt` and `none`, and has no `code_challenge_methods_supported`.

### Pagination (`listAll` in `src/whoop/data.ts`)

- Query: `limit=25` (WHOOP's maximum), `start` and `end` as ISO strings (`end` is optional), and `nextToken` (camelCase in the request).
- Response: `{ records?: T[], next_token?: string | null }`. Pagination follows `next_token` until it is null or absent.
- `start`/`end` filter on the record's start time, so the range is effectively [start, end). Results come back newest first.
- The cap is `MAX_PAGES = 40`, which is 1000 records. When the cap is hit, the result has `truncated: true`, and tools then add `truncated: "Hit the page limit; the oldest records in the range may be missing."`
- `fetchDays` asks for a 2-day margin on each side, with `end` clamped to now + 1 day. It fetches the four collections in parallel (workouts are skipped when `include.workouts === false`).
- A first-data probe sends `GET /v2/cycle?limit=1&end=<firstCycle.start>`. Because results are newest first, a single other record means older data exists.
- `client.get` drops `undefined` query values. Every other value goes through `String(v)`.

### `WhoopClient` (`src/whoop/client.ts`)

Constructor: `new WhoopClient(creds?: () => ClientCredentials | Promise<ClientCredentials>)`. The default is `(await resolveClientCredentials()).creds`, resolved lazily at refresh time, not at construction. There is one `WhoopClient` per process so that refreshes stay single-flight (commit 9fed2ae). `index.ts` creates a separate one for CLI logout.

Timing constants:

| Constant                           | Value  | Why                                                                                |
| ---------------------------------- | ------ | ---------------------------------------------------------------------------------- |
| `REFRESH_SKEW_MS`                  | 60 000 | Refresh when the token expires within 60s                                          |
| `REQUEST_TIMEOUT_MS`               | 20 000 | `AbortSignal.timeout` per API request. Claude gives up on a tool call at about 60s |
| `REFRESH_WAIT_MS`                  | 25 000 | How long a caller waits for a refresh. The refresh itself is never aborted         |
| `MAX_RATE_LIMIT_RETRIES`           | 2      | Up to 3 sends in total for a 429                                                   |
| `MAX_RETRY_DELAY_MS`               | 30 000 | Cap on the 429 wait                                                                |
| revoke timeout (`oauth.ts`)        | 10 000 |                                                                                    |
| code exchange timeout (`oauth.ts`) | 20 000 | Refresh requests have no timeout                                                   |
| `SHUTDOWN_GRACE_MS` (`index.ts`)   | 1 500  | Shutdown waits up to this long for `drain()`                                       |

#### `get<T>(path, query?)`: the full algorithm

1. Build the URL as `apiBase + path` plus the defined query params.
2. Get tokens with `validTokens()`:
   - With no token file, throw `NotLoggedInError`. No network call is made.
   - If this process remembers that the stored `refresh_token` is dead (`authFailure.expired`), throw `SessionExpiredError` without posting to WHOOP.
   - If `expires_at - 60s > now`, use the tokens as they are. Otherwise call `refreshed(tokens)`.
3. `send` the request with headers `Authorization: Bearer <access>` and `Accept: application/json`, and a 20s timeout.
4. On a 401, handle it once:
   - Log "access token rejected, re-reading the token file" and re-read the token file.
   - If the file is gone, throw `NotLoggedInError`. A logout elsewhere must not be resurrected; this was a regression bug covered by a test.
   - If the access token on disk differs (another process rotated it), retry with it and don't refresh.
   - Otherwise refresh once (`refreshed(latest)`) and retry.
   - A second 401 becomes a `WhoopApiError(401)`. There is no loop: the test expects 2 API calls and 1 token call.
5. While the status is 429 and attempts < 2: log a warning with `wait_ms` and `attempt`, `Bun.sleep(retryDelayMs(res))`, and resend with the same token.
6. Read the body as text. If `!res.ok`, throw `WhoopApiError(status, path, text, x-whoop-trace-id)`. Otherwise return `JSON.parse(text)`.

`retryDelayMs(res)` (exported):
- Reads `Retry-After`, falling back to `X-RateLimit-Reset`, as seconds (fractions allowed).
- Finite and > 0 gives `min(s*1000, 30000)`. Anything else gives 2000.
- Tested cases: 5 → 5000, reset 12 → 12000, 600 → 30000, none → 2000.

`send` behaviour:
- If fetch throws a `TimeoutError`, `send` throws `Error("WHOOP didn't answer in time (<pathname>); try again in a moment.")`. Other fetch errors are rethrown as they are. Both cases are logged as "whoop request failed" with `ms`.
- Each response is logged as `whoop request` at info if ok, otherwise warn. The fields are:
  - `path` (the pathname)
  - `status`
  - `ms`
  - `trace` (`x-whoop-trace-id`)
  - `query` (the search string, only at debug level)
  - on a 429, `rate_limit`: every `x-ratelimit-*` header, lowercased
- The response body is never logged (it is WHOOP data), and neither is the token. A test asserts that `access-1` never appears in the log output.

User agent: no explicit `User-Agent` is set, so requests carry Bun's default. Cloudflare in front of WHOOP refuses some generic user agents (e.g. Python's) with a 403. Keep the runtime default, or set a non-generic UA, if you migrate to another HTTP stack.

#### Token refresh

- `refreshed(tokens)` races `refresh(tokens)` against a 25s timer. If the timer wins, it rejects with `Error("WHOOP is slow to renew the login; try again in a moment.")`. The underlying request keeps running and saves its result.
  - Why: WHOOP may already have spent the old refresh token, so its reply must still be persisted (commit 69a92b5).
- `refresh(tokens)` is single-flight within the process. It returns the in-flight `this.refreshing` promise if one exists, and clears it in `finally`.
  - Tested: two concurrent `get`s that both need a refresh make exactly one token request, and both use the new token.
  - On success, `authFailure = null`, logged as "token refresh done" with `ms`.
  - On failure, it sets `authFailure = { refreshToken: tokens.refresh_token, message: err.message, expired: err instanceof SessionExpiredError }` and rethrows.
  - A failure is not cached, so the next call tries a new refresh. Tested: the second attempt succeeds and 2 token calls are made.
- `doRefresh(tokens)`:
  1. With no `refresh_token`, throw `NotLoggedInError` with no network call.
  2. Call `refreshTokens(creds, refresh_token)`. It POSTs form-urlencoded data with `grant_type=refresh_token`, `refresh_token`, `scope=offline`, `client_id` and `client_secret` (`client_secret_post` is the only method used). Header: `Accept: application/json`.
  3. On an `OAuthHttpError`, parse the JSON body's `error` field:
     - `invalid_client` or `unauthorized_client`: throw `CredentialsRejectedError(code)`. Tokens are kept.
     - Any other code except `invalid_grant` (e.g. a 500): rethrow the `OAuthHttpError`. Tokens are untouched and no API call is made.
     - `invalid_grant`: re-read the file.
       - If the file is gone, throw `NotLoggedInError`.
       - If the `refresh_token` on disk differs, another process (a second Claude window) already rotated it, so use the stored tokens.
       - Otherwise throw `SessionExpiredError`. The file is deliberately left alone, because writing a marker could clobber tokens another process is saving. Each process instead remembers the dead token in `authFailure`.
  4. On success, `next = toStored(resp, tokens)`. Then, inside `withTokenLock`, re-read the file:
     - If the file is gone (logout during the refresh), log a warning, discard the new tokens and throw `NotLoggedInError`.
     - If the `refresh_token` on disk differs (re-login during the refresh), keep and return the on-disk login.
     - Otherwise `writeTokens(next)` and return it. The tokens are persisted before use because the old refresh token is now dead.
- Refresh-token rotation: WHOOP refresh tokens are single-use. A successful refresh invalidates the old refresh token and existing access tokens.
- `toStored(resp, previous, now)` builds:
  - `{access_token, refresh_token: resp.refresh_token ?? previous.refresh_token, token_type, scope: resp.scope ?? previous.scope, expires_at: now + expires_in*1000, obtained_at: now}`
  - The old refresh token is kept only when the response omits a new one. This case is tested.
- There is no cross-process lock. Two processes refreshing at once rely on the re-reads above. `withTokenLock` is a per-process promise chain that serialises a login save against a refresh's check-then-write.

#### Token store (`src/auth/store.ts`)

- The file is `<configDir>/tokens.json`. The file is mode 0600 and the dir is 0700. The JSON shape is `StoredTokens {access_token, refresh_token?, token_type, scope?, expires_at (epoch ms), obtained_at (epoch ms)}`.
- Writes are atomic: write to a unique temp file `<path>.<pid>.<uuid>.tmp`, chmod 0600, then rename. A lost write means a lost single-use refresh token.
- A file that is unreadable, not JSON, or has no string `access_token` counts as logged out (`null`) and is logged as a warning, so `whoop_login` can fix it.
- Encrypting the file at rest is still open (ToU §2.4). App credentials go to the keychain, not this file.

#### `revokeAccess(): Promise<"revoked" | "failed" | "not_logged_in">`

- It gets a valid token through `validTokens()`, refreshing if needed.
  - A `NotLoggedInError` (including `SessionExpiredError`) returns `"not_logged_in"`.
  - Any other error returns `"failed"`.
- It then calls `oauth.revokeAccess(access)`: `DELETE /v2/user/access` with a Bearer token and a 10s timeout. It returns `res.ok`, logs the status, and never throws. A 204 gives `"revoked"`. A 500 or a network error gives `"failed"`.
- It is used by `whoop_disconnect` and CLI logout.

#### `drain(): Promise<void>`

- Awaits any in-flight refresh, including its disk write, and ignores its errors.
- Shutdown (stdin end/close, or a signal) runs once (idempotent): `Promise.allSettled([loginFlow.cancel(), client.drain()])`, then exit 0, with a hard exit after 1.5s. A second trigger joins the first instead of cutting it short.
- `whoop_disconnect` also lets an in-flight refresh save before it deletes the tokens.

#### `authProblem(tokens): { session_expired: boolean; last_error: string | null }`

- It reports the last refresh failure in this process, but only when `authFailure.refreshToken === tokens.refresh_token`.
- A new login stores a different refresh token, which clears the problem automatically. A successful refresh also clears it.
- If there are no tokens or no failure, it returns `{false, null}`.
- `whoop_status` uses it:
  - `logged_in = tokens !== null && !session_expired`
  - `session_expired` and `last_error` are passed through
  - `isConnected` returns false when `session_expired`
  - `authProblem` is optional on the client interface, because tests stub it

### Error classes

| Class                             | Extends            | `name`                     | Message / fields                                                                                                                                                                                                               |
| --------------------------------- | ------------------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NotLoggedInError`                | `Error`            | `NotLoggedInError`         | "Not logged in to WHOOP. Call the whoop_login tool first."                                                                                                                                                                     |
| `SessionExpiredError`             | `NotLoggedInError` | `SessionExpiredError`      | "The WHOOP session has expired or was revoked. Call whoop_login to reconnect." (`instanceof NotLoggedInError` is true)                                                                                                         |
| `CredentialsRejectedError`        | `Error`            | `CredentialsRejectedError` | "WHOOP rejected the app credentials (`<code>`). Call whoop_login with reconfigure: true to enter the Client ID and Secret again."                                                                                              |
| `WhoopApiError`                   | `Error`            | `WhoopApiError`            | Fields: `status`, `path` (as passed, e.g. `/v2/recovery`, without the base or query), `body` (full), `traceId?` (`x-whoop-trace-id`). Message: `WHOOP API <status> on <path>[ (trace <id>)]: <body.slice(0,300)>`              |
| `OAuthHttpError` (`oauth.ts`)     | `Error`            | `OAuthHttpError`           | Fields: `status`, `body`. Message: `WHOOP token endpoint returned <status>: <body.slice(0,300)>`                                                                                                                               |
| `MissingScopesError` (`oauth.ts`) | `Error`            | `MissingScopesError`       | Field: `missing`. Message: `missingScopesMessage(missing)`                                                                                                                                                                     |
| timeout errors                    | `Error`            | —                          | API: "WHOOP didn't answer in time (`<pathname>`); try again in a moment." Token exchange: "WHOOP didn't answer the token request in time; try again." Refresh wait: "WHOOP is slow to renew the login; try again in a moment." |

### API facts the code depends on (`docs/whoop-api-notes.md`, checked live 2026-10-27/28)

- A 32-character `state` is accepted (WHOOP's docs mention 8 as a minimum). `randomState()` makes 32 characters from base64url random bytes.
- `percent_recorded` is a 0–1 fraction in the live API, while the spec says 0–100. `shapeWorkout()` multiplies it by 100.
- `step_count` is present on cycles (`shapeCycle()`).

### OpenAPI spec and type generation

- `openapi/whoop.yaml` is the vendored spec and the source of truth for types. Its header comment names the source URL and the number of partner paths removed (currently 9).
  - Non-partner paths kept: `/v1/activity-mapping/{activityV1Id}`, `/v2/activity/sleep`, `/v2/activity/workout`, `/v2/cycle` (with id and sub-routes), `/v2/recovery`, `/v2/user/access`, `/v2/user/measurement/body`, `/v2/user/profile/basic`.
- `bun run spec:update` runs `scripts/update-spec.ts`:
  1. Fetch `WHOOP.openapiUrl`, and throw on a non-ok response.
  2. Delete every path containing `/partner/` (Trusted Partner endpoints).
  3. Canonicalise: sort keys only inside the name-keyed maps `paths`, `schemas`, `properties` and `responses`. Structural keys stay in spec order. Why: WHOOP serves some maps in varying order between requests, and sorting keeps `git diff openapi/` meaningful.
  4. Write YAML with `Bun.YAML.stringify(…, null, 2)` plus the header.
  5. Run `bunx biome format --write` on it, as the pre-commit hook does, so an unchanged upstream spec produces no diff. Throw if formatting fails.
  6. Log the path counts to stderr.
  7. Review upstream changes with `git diff openapi/`.
- `bun run gen:types` runs `bunx openapi-typescript@7.13.0 openapi/whoop.yaml -o src/whoop/openapi.d.ts`. It also runs on `prepare` (`husky && bun run gen:types`), so it runs on install. The generated file is marked "do not edit".
- Type usage (`src/whoop/data.ts`): `Cycle = components["schemas"]["Cycle"]`, `Recovery = …["Recovery"]`, `Sleep = …["Sleep"]`, `Workout = …["WorkoutV2"]`, `ScoreState = Cycle["score_state"]`. `client.get<T>` is generic and does no runtime validation.
- Contract tests (`test/spec.test.ts`):
  - The spec has paths and no `/partner/` path.
  - Each consumer path exists as a GET: `/v2/cycle`, `/v2/cycle/{cycleId}`, `/v2/recovery`, `/v2/activity/sleep`, `/v2/activity/workout`, `/v2/user/profile/basic`, `/v2/user/measurement/body`.
  - Every quoted or template-literal `"/v2/..."` string in `src/**/*.ts` (excluding `.d.ts`) must match a spec path that has a GET. `${…}` becomes a placeholder that matches `{param}` segments.
    - A guard test checks that the scan finds `/v2/user/profile/basic`, so a broken regex can't pass silently.
    - This is why `DELETE /v2/user/access` is built as `` `${WHOOP.apiBase}/v2/user/access` ``: the regex needs a quote directly before `/v2/`, so that string is never scanned and never needs a GET.
  - `openapi.d.ts` exists, declares every consumer path and every path the code calls, and contains no `/partner/`.

### Test-encoded behaviours to preserve (`test/client.test.ts`)

- With no tokens, nothing is sent to the network and the error mentions `whoop_login`.
- The Bearer header is set and the URL pathname is `/developer/v2/...`. `undefined` query params are omitted.
- With more than 60s of validity left, there is no refresh. Within 60s, the client refreshes and the new tokens are on disk before the API call is made.
- `invalid_grant` gives `SessionExpiredError`, the file stays byte-identical, `authProblem` reports `{session_expired: true, last_error: message}`, and the next call fails fast with no token request.
- A failed refresh (500) is reported as `{session_expired: false, last_error: "...500..."}` until a later refresh succeeds.
- A logout during the refresh gives `NotLoggedInError` and the file stays deleted. A re-login during the refresh means the re-login's tokens are used and kept.
- `drain()` resolves only after the gated refresh has written `refresh-2`.
- 401 handling:
  - If another process rotated the token, the client retries with it and makes no refresh.
  - If the store still holds the rejected token, the client makes 1 refresh and retries.
  - A deleted file gives `NotLoggedInError` with no refresh.
- Two 429 retries (`Retry-After` or `X-RateLimit-Reset` honoured), then `WhoopApiError` after 3 calls.
- A request that never answers ends with "didn't answer in time" instead of hanging.

### Corrections and additions

Found when this part was checked against the code. Where they differ from the text above, these are right.

**401 retry bypasses the dead-refresh-token guard** (src/whoop/client.ts)
- `get()` runs `validTokens()` first. That throws `SessionExpiredError` when `authFailure.expired` holds for the stored `refresh_token`, so a dead refresh token is never posted.
- On a 401, `get()` re-reads the file. If the file is gone it throws `NotLoggedInError`. If the access token differs it uses the new one. Otherwise it calls `this.refreshed(latest)` **directly**, without going through `validTokens()`.
- So a refresh token marked dead (e.g. by a concurrent call that failed between this call's `validTokens()` and its 401) can be posted once more on the 401 path. Mirror this only if parity matters; otherwise add the guard there on purpose.

**`sleepNeededMs` sign (correction)** (src/whoop/data.ts)
- Code: `baseline_milli + need_from_sleep_debt_milli + need_from_recent_strain_milli + need_from_recent_nap_milli`, a plain sum of all four terms exactly as WHOOP returns them.
- The doc comment says "… − recent naps". It's correct only because WHOOP reports the nap credit as a negative or offsetting value.
- **Don't negate the nap term**: a "fix" to subtraction would double-count naps. `whoop_sleep`'s `needed_breakdown.recent_naps` is that raw value in hours, sign included.

**`offsetMinutes` strictness (data-correctness risk)** (src/whoop/data.ts)
- Regex: `^([+-])(\d{2}):?(\d{2})$`. Exactly two hour digits and two minute digits, colon optional.
- `Z`, `+5:30`, `+05`, `+0530 ` (with trailing space), an empty value or `undefined` all give `0` (UTC) **silently**.
- Every local date and time (`localDate`, `localTime`, `cycleDate`, sleep and workout date filtering) then shifts. A malformed or short offset puts records on the wrong day.

**WHOOP rate limits and app caps** (docs/archive/RESEARCH.md, src/whoop/client.ts, src/whoop/data.ts)
- WHOOP's default limits are **100 requests/min and 10,000/day**. Both apply, and going over either returns 429.
- Headers: `X-RateLimit-Limit` uses a multi-window format (`100, 100;window=60, 10000;window=86400`) and needs a real parser, not `parseInt`. Also `X-RateLimit-Remaining` and `X-RateLimit-Reset` (in seconds).
- The current code doesn't parse the limit. It only logs `x-ratelimit-*` on a 429, and `retryDelayMs` uses `Retry-After` or `X-RateLimit-Reset`.
- Limit increases: Dashboard → Open Request → "Rate limit increase".
- Budget: `listAll` pages at `limit` 25 (WHOOP's max), up to `MAX_PAGES = 40` per collection, so up to 1,000 records.
  - `fetchDays` runs 4 collections in parallel (cycles, recoveries, sleeps, workouts), plus at most one `limit:1` cycles probe for `first_data_date`.
  - A 90-day range is about 4 pages per collection, roughly 15–17 requests.
  - `whoop_compare_periods` runs two `fetchDays` in parallel, so up to about 34 requests at once. That is well under 100/min for one call, but a few chained calls can come close.
  - Each request gets at most 2 rate-limit retries; a delay is capped at 30 s and defaults to 2 s.
- Unapproved apps are capped: approval is needed beyond 10 users. It is manual and can take months. It needs a privacy policy and a contact email, at least 50% of the current tier's limit connected (from Build onward), and testing with at least one member. This cap, together with ToU §3.2.1 (no developer credentials in source), is why each user brings their own WHOOP app.


## Login and credentials

Sources: `src/auth/oauth.ts`, `src/auth/login.ts`, `src/auth/background-login.ts`, `src/auth/browser-setup.ts`, `src/auth/credentials.ts`, `src/auth/store.ts`, `src/auth/page-style.ts`, `src/setup.ts`, `src/config.ts`, `src/server.ts`, `src/tools/common.ts`, `src/whoop/client.ts`, `src/index.ts`, `src/cli/terminal.ts`, `docs/whoop-api-notes.md`, `test/{oauth,login,background-login,browser-setup,credentials,store,setup}.test.ts`, `test/preload.ts`

### Model in brief

- Each user creates **their own WHOOP developer app**. WHOOP's terms (ToU §3.2.1) don't let open-source tools ship developer credentials, so no client id or secret exists in source.
- There are two credential layers:
  1. **App credentials** (Client ID and Secret, plus redirect URI). They go to the OS keychain, with a 0600 file as fallback.
  2. **User tokens** (access and refresh). They go to a 0600 `tokens.json`.
- Everything is driven from inside the MCP server (the `whoop_login` tool), so a Claude Desktop user never needs a terminal. A CLI (`setup`, `login`, `status`, `logout`) exists for development.

### OAuth details

Sources: `src/auth/oauth.ts`, `src/config.ts`, `docs/whoop-api-notes.md`

| Item                        | Value                                                                                                                                                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authorize URL               | `https://api.prod.whoop.com/oauth/oauth2/auth`                                                                                                                                                                    |
| Token URL                   | `https://api.prod.whoop.com/oauth/oauth2/token`                                                                                                                                                                   |
| API base                    | `https://api.prod.whoop.com/developer`                                                                                                                                                                            |
| Revoke                      | `DELETE {apiBase}/v2/user/access` with a Bearer token and `Accept: application/json`, 10 s timeout. Returns `res.ok` and never throws. It ends the grant **at WHOOP**, not only locally.                          |
| Grant                       | Authorization code, `response_type=code`                                                                                                                                                                          |
| Authorize params            | `response_type`, `client_id`, `redirect_uri`, `scope` (space-joined), `state`. The secret is never in the URL (tested).                                                                                           |
| Scopes (`SCOPES`, in order) | `offline read:profile read:body_measurement read:cycles read:recovery read:sleep read:workout`. `offline` is what yields a refresh token.                                                                         |
| `state`                     | `randomToken(32)` (32 random bytes, base64url) sliced to **32 chars**. WHOOP's docs say a minimum of 8.                                                                                                           |
| PKCE                        | **Not used**. The WHOOP discovery doc lists no `code_challenge_methods_supported`. Public-client (`none`) auth, HTTP Basic, `openid`/id_token and webhooks are also unused; an early probe code path was removed. |
| Client auth                 | `client_secret_post`: `client_id` and `client_secret` go in the form body, with no Authorization header (tested).                                                                                                 |
| Token POST                  | `Content-Type: application/x-www-form-urlencoded`, `Accept: application/json`                                                                                                                                     |
| Code exchange               | `grant_type=authorization_code, code, redirect_uri`. 20 s timeout (`EXCHANGE_TIMEOUT_MS`). On timeout it throws "WHOOP didn't answer the token request in time; try again."                                       |
| Refresh                     | `grant_type=refresh_token, refresh_token, scope=offline`. **No timeout, never aborted**: WHOOP may already have spent the single-use refresh token, so its reply must still be saved.                             |
| Errors                      | A non-2xx reply throws `OAuthHttpError(status, body)`. The message is `WHOOP token endpoint returned {status}: {body[0..300]}` and the full body stays on the error.                                              |
| Default redirect            | `http://localhost:8787/callback`, overridable with `WHOOP_REDIRECT_URI`                                                                                                                                           |

Other rules:

- **Refresh tokens are single-use.** A successful refresh invalidates the old refresh token and the old access tokens. Persist the result **before** using it.
- `toStored(resp, previous, now)` builds the stored tokens:
  - `expires_at = now + expires_in*1000`, and `obtained_at = now`.
  - `refresh_token` and `scope` fall back to the previous values when the reply omits them.
- **All scopes or nothing.** `missingScopes(granted)` returns the `SCOPES` entries absent from the space-separated `scope`. When `scope` is `undefined` the reply can't be checked, so it counts as complete.
- On a partial grant, the new access token is **revoked at WHOOP**, nothing is saved, and `MissingScopesError` is thrown with this exact text: `WHOOP didn't grant every permission whoop-mcp needs (missing: {list}), so it didn't connect. Approve all of them on WHOOP's page; if one isn't offered, tick it under Scopes in your WHOOP app. Then try again.`
  - Why: a partial grant would leave tools failing one by one later.

### Token file

Sources: `src/auth/store.ts`, `src/config.ts`, `test/store.test.ts`

- **Config directory:** `$WHOOP_MCP_HOME` if set. Otherwise `$XDG_CONFIG_HOME/whoop-mcp`, where an empty `XDG_CONFIG_HOME` counts as unset. Otherwise `~/.config/whoop-mcp`. The directory is created with mode `0700`.
- **Token path:** `{configDir}/tokens.json`. The JSON is pretty-printed with 2-space indentation.

`StoredTokens` fields:

| Field           | Type    | Notes                                                |
| --------------- | ------- | ---------------------------------------------------- |
| `access_token`  | string  | required; its presence is how a file counts as valid |
| `refresh_token` | string? |                                                      |
| `token_type`    | string  |                                                      |
| `scope`         | string? | space-separated                                      |
| `expires_at`    | number  | epoch ms                                             |
| `obtained_at`   | number  | epoch ms                                             |
- **Atomic write:** write to `{path}.{pid}.{randomUUID}.tmp` with mode 0600, `chmod 0600`, then `rename`.
  - The temp name is unique per write, so two writes in one process never share a temp file.
  - A pre-existing world-readable file ends up 0600.
  - No temp files are left behind.
  - Why: a half-written file would lose a single-use refresh token.
- **Unreadable files:** a corrupt file, or JSON without a string `access_token`, is treated as logged out (`null`). A warning is logged and the next login replaces it.
- `deleteTokens` runs `rm -f`. It is safe when the file or the directory is missing.
- `withTokenLock(fn)` is an in-process promise-chain mutex. Login saves, refresh writes and disconnect deletes all go through it. It does **not** cover other processes; refresh handles those by re-reading the file (see below).
- The tokens file is **not encrypted** at rest. A comment notes this is still open (ToU §2.4).

### App credentials storage

Sources: `src/auth/credentials.ts`, `src/config.ts`, `test/credentials.test.ts`, `test/preload.ts`, commit 3c3a066

- `ClientCredentials` is `{ clientId, clientSecret, redirectUri }`.
- **Resolution order** (`resolveClientCredentials`):
  1. **Env:** `WHOOP_CLIENT_ID` **and** `WHOOP_CLIENT_SECRET`, both trimmed and non-blank. A lone ID does not shadow the stored credentials. `redirectUri` is `WHOOP_REDIRECT_URI` or the default. Source is `env`.
  2. **Stored:** keychain first, then the file. `WHOOP_REDIRECT_URI` still overrides the stored `redirectUri`.
  3. **Neither:** throw `ConfigError("No WHOOP app credentials found. Use the whoop_login tool: it opens a setup page in the browser.")`.
- `CredentialSource` is `"env" | "keychain" | "file"`.

**Keychain**

- Uses `Bun.secrets` with `{ service: "whoop-mcp", name: "client-credentials" }`.
- The value is `JSON.stringify(creds)`, including `redirectUri`.
- `WHOOP_MCP_CREDENTIAL_STORE=file` disables the keychain entirely, and the code then never touches it. Use it for tests and headless Linux. The test preload always sets it, because disconnect deletes credentials and keychain prompts hung the tests.

**File fallback**

- Path is `{configDir}/client.json`, written with the same atomic 0600 write.

**Parsing**

- An unparseable value is treated as absent (with a warning), so `whoop_login` falls back to the setup page.
- A value missing `clientId` or `clientSecret` is treated as absent.
- A missing `redirectUri` is filled with the default (for older entries).

**Read (`readStoredCredentials`)**

- If the keychain is enabled, try `Bun.secrets.get`. Any throw (for example, no secret service) falls through to the file.
- When both stores hold credentials, the keychain wins.

**Save (`saveCredentials`)** returns where the credentials went:

1. With the keychain enabled: `Bun.secrets.set`, then `rm -f client.json` so no plaintext copy remains. Returns `"keychain"`.
2. If the set throws: try `deleteKeychainItem()`, ignoring any throw. If an item was removed, try `set` again; if that succeeds, return `"keychain"`.
   - Why: an older keychain entry would win over the file on the next read. This is usually an item an earlier build saved and this build can't overwrite. Once it's deleted, the new item belongs to this build.
3. Otherwise write the file and return `"file"`.

**The macOS `-25244` fallback (`deleteKeychainItem`)**

- Every whoop-mcp build is a different ad-hoc-signed program. On macOS only the program that saved an item may change or delete it. After an upgrade, `Bun.secrets` therefore fails with `errSecInvalidOwnerEdit`, which shows up as `-25244` in the error message (matched with `/-25244\b/`).
- **Only** on darwin and **only** for that error, it runs:
  `/usr/bin/security delete-generic-password -s whoop-mcp -a client-credentials`
  with stdin, stdout and stderr ignored and a 10 s timeout.
- Exit codes:
  - `0`: deleted, returns `true`.
  - `44` (errSecItemNotFound): returns `false`; the item is already gone.
  - Anything else: log a warning with `security_exit` and rethrow the original error.
- Other keychain errors (locked keychain, the user clicked Deny) **do not** fall back; they stay failures.

**Delete (`deleteStoredCredentials`)** returns `"deleted" | "none" | "failed"`:

- With the keychain enabled, first check whether an item exists with `get`.
  - If `get` throws on darwin or win32, presence is `"unknown"` and the delete is tried anyway, because those platforms always have a keychain and a denied or locked read may hide an item.
  - If `get` throws elsewhere, presence is `false` (no keychain service).
- If present or unknown, call `deleteKeychainItem()`:
  - `true` gives `deleted`.
  - `false` gives `none` when presence was unknown, otherwise `failed`.
  - A throw gives `failed`.
- Then, if `client.json` exists, remove it. If the result was still `none`, it becomes `deleted`.
- `failed` means the keychain holds credentials but refused to delete them. The caller must not claim they are gone.

### Local callback server basics

Sources: `src/auth/login.ts`, `test/login.test.ts`

- **`parseRedirect`:** the redirect must be `http:` with host `localhost`, `127.0.0.1` or `[::1]`. Anything else throws `Redirect URI must be http on localhost/127.0.0.1 for local login (got …)` **before anything listens**.
- **`listenLocal`:**
  - Port is the redirect port, or 80 if the URI has none (portless URIs are supported).
  - For `localhost` it binds **both** `127.0.0.1` and `::1`. It first probes IPv6 loopback by binding `::1` on port 0. For a literal IP host it binds only that address.
  - If any bind fails, it stops the servers already started and throws `PortInUseError`: `Port {port} is already in use[ (on {host})], so WHOOP can't redirect back here. Another WHOOP login (e.g. in a second Claude window) or another program is using it; finish or close that and try again.`
  - Why both addresses: the browser may resolve either one, and a half-bound port would let another program on the other address receive the setup link or the OAuth code.
  - `stop()` is graceful, so the response that settled the flow still gets flushed.
- **`PAGE_HEADERS`** (on every HTML page):
  - `Content-Type: text/html; charset=utf-8`
  - `Cache-Control: no-store`
  - `Referrer-Policy: same-origin`. Not `no-referrer`, because under that policy browsers send `Origin: null` on same-origin form POSTs, which the CSRF check must refuse.
  - `X-Frame-Options: DENY`
  - `X-Content-Type-Options: nosniff`
  - A per-response CSP (below).
- **`page(title, body, status=200, tone)`:**
  - Everything is HTML-escaped (`Bun.escapeHTML`), because `body` can carry attacker-controlled `error_description` (a reflected-XSS fix).
  - Tone `ok` prefixes the heading with "✓ ". Tones `ok` and `err` set a class on the `<h1>`.
- **`parseCallback(url, state)`** checks **state first**:
  - `params.state !== state` gives `wrong-state`. Any web page can navigate here, so such a request must neither end the login nor get its text into the status.
  - Otherwise `error` gives `error`, then a missing `code` gives `no-code`, otherwise `code`.
- **`wrongStatePage`:** HTTP 400, title "Not this login".
  - Body: "This WHOOP approval came from an earlier try, so it can't be used." followed by advice. The default advice is "Approve in the WHOOP tab Claude opened most recently. If it's gone, ask Claude for the WHOOP connection link again."
  - It logs only `has_code` and `has_error`, never the values.
  - It changes nothing.

`explainOAuthError(error, description)` maps WHOOP errors to one line. It checks, in this order, against the lower-cased "error + description":

| Match                                 | Message                                                                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| contains `redirect`                   | `WHOOP refused the redirect URL. In your WHOOP app, Redirect URLs must contain exactly http://localhost:8787/callback (no trailing slash).` |
| `invalid_client` or contains `client` | `WHOOP didn't recognise the app. Check the Client ID and Secret, or create the app again.`                                                  |
| `access_denied`                       | `Access wasn't approved on WHOOP's page.`                                                                                                   |
| `invalid_scope` or contains `scope`   | `WHOOP refused the permissions. In your WHOOP app, tick every box under Scopes.`                                                            |
| otherwise                             | `WHOOP returned an error: {error}[ ({description[0..200]})].`                                                                               |

### Consent-only login (`login()`, credentials already exist)

Sources: `src/auth/login.ts`, `test/login.test.ts`

1. Parse the redirect, generate a state, build the authorize URL, and listen.
   - The callback path handles the request.
   - Any other path returns `404 Not found` and does not settle the login.
2. Log the URL, call `onAuthorizeUrl`, and open the browser unless `openBrowser:false`.
   - The opener is `open` on darwin, `explorer` on win32, `xdg-open` otherwise.
   - Opening is best effort. On failure it logs only the origin and path, because the setup URL's query carries a one-time token.
3. Callback outcomes:
   - **wrong-state:** 400 page; the login continues.
   - **error:** reject with `Authorization failed: {error}[ — {desc}]`. Page: "WHOOP didn't connect", 200, err tone, with the `explainOAuthError` text.
   - **no-code:** reject with "Callback had no authorization code." Page: "No authorization code was returned."
   - **code:** resolve. Page: "Approved" / "Claude is finishing the connection; you can close this tab and go back to Claude." It doesn't claim success, because the exchange comes after.
   - The promise settles via `setTimeout(…, 50)` so the page is written before a caller can exit.
4. Timeout defaults to 5 min in the function. `BackgroundLogin` passes **10 min**. On timeout: "Timed out waiting for the WHOOP login callback." An abort signal gives "WHOOP login was cancelled." and frees the port.
5. Exchange the code, then run the scope check (revoke and throw `MissingScopesError` on a partial grant).
6. The `finally` block clears the timer and **always stops the server**, which frees the port.

### BackgroundLogin (the state machine behind `whoop_login`)

Sources: `src/auth/background-login.ts`, `test/background-login.test.ts`

`LoginStatus` states:

| state       | fields                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| `idle`      | (none)                                                                                                                    |
| `pending`   | `kind: "setup"\|"login"`, `authorizeUrl`, `startedAt`, `progress?: SetupPhase`, `problem?: string`, `problemSeq?: number` |
| `succeeded` | `at`, `scope?`                                                                                                            |
| `failed`    | `at`, `error`                                                                                                             |

Defaults:

| Setting                    | Value                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------- |
| `openBrowser`              | `WHOOP_MCP_NO_BROWSER !== "1"`. When it is `"1"`, pages are announced but not opened (tests, headless). |
| Consent-only login timeout | 10 min                                                                                                  |
| Setup page idle limit      | 20 min                                                                                                  |
| Setup page hard limit      | 60 min                                                                                                  |
| Redirect URI               | `WHOOP_REDIRECT_URI` or the default                                                                     |
| Save                       | `withTokenLock(writeTokens(toStored(tokens)))`                                                          |

Rules:

- **One flow at a time**, because flows share the port.
  - `start()` while pending returns `{authorizeUrl, alreadyPending:true, kind}`.
  - Concurrent `start()` calls share the same in-progress `starting` promise.
- **`start({reconfigure:true})`** cancels any pending flow first, then forces the setup page even when credentials exist.
- **`begin()`:**
  - Increments `generation` and aborts the previous controller. Even a finished setup page in its grace period holds the port, so it must be closed.
  - Unless the setup is forced, resolves the credentials. A `ConfigError` means "no credentials", which selects `kind=setup`. Other errors propagate, and `start()` throws.
  - If the flow was cancelled or replaced while reading the credentials (generation changed), it does not start. It returns the current pending flow, or throws "The WHOOP login was cancelled."
  - Once the URL is announced, status becomes `pending`. `start()` resolves as soon as the URL exists, before the user approves.
  - A failure before any URL exists (for example the port is taken) makes `start()` reject.
- **Setup kind:**
  - `persist` saves the tokens inside the setup flow (before the page says "connected"), and `savedBySetup` prevents a double save.
  - On success, `lastClientId` is remembered to pre-fill the next setup page. The secret is never remembered.
  - For the login kind, the tokens are saved after the flow resolves.
- **Outcome:**
  - Success gives `succeeded` with `scope`.
  - An error gives `failed` with `error.message`. This includes a failed save, which counts as a failed login.
  - A superseded flow (older generation) never overwrites the status. It logs "login cancelled" at info level instead.
- **`onPhase(progress, problem)`** from the setup page:
  - Ignored when the flow isn't current, isn't pending, or the phase is `done` or `failed` (the flow outcome reports those, not a "problem").
  - `problemSeq` increments only when a non-empty `problem` differs from the previous one.
- **`waitForChange(ms, signal)`:**
  - Resolves immediately when not pending, `ms <= 0`, or the signal is aborted.
  - Otherwise resolves on the first of: leaving `pending`, `problemSeq` increasing, the timeout, or the abort.
- **`cancel()`:** increments `generation` (so the aborted flow won't report "failed"), aborts the controller, sets status to `idle` if it was pending, and **waits for the in-flight flow** so the port is free.
- **`startIfIdle()`** is used by data tools that hit "not logged in":
  - Returns the current status if one is pending.
  - Returns `null` if the last attempt failed less than **60 s** ago (`AUTO_START_COOLDOWN_MS`), so the browser doesn't reopen in a loop.
  - Otherwise calls `start()` (never with reconfigure) and returns the status if pending, else `null`.
- **`forgetApp()`** clears `lastClientId`. It is called after app credentials are deleted.

### Browser setup page (port 8787, first run or reconfigure)

Sources: `src/auth/browser-setup.ts`, `src/auth/page-style.ts`, `src/setup.ts`, `test/browser-setup.test.ts`, commits in v0.4.0–v0.6.2

**Purpose:** do the whole first run in the browser. The page explains how to create the WHOOP app, collects the ID and Secret (paste anywhere), verifies them with WHOOP, saves them, continues to WHOOP consent, receives the callback on the **same** server, and shows the outcome up to "connected". The user never has to report back to Claude.

**Constants**

| Constant                  | Value                                                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `SETUP_PATH`              | `/setup`                                                                                                             |
| `MAX_BODY_BYTES`          | 8 KiB                                                                                                                |
| `CREATE_URL`              | `https://developer-dashboard.whoop.com/apps/create`                                                                  |
| `DASHBOARD_URL`           | `https://developer-dashboard.whoop.com`                                                                              |
| `PRIVACY_URL`             | `https://github.com/213123243ertdfgret63/whoop-mcp#connect-your-whoop-account` (WHOOP's form requires a privacy URL) |
| `VERIFY_LIMIT_PER_MINUTE` | 10                                                                                                                   |
| Idle timeout              | 20 min                                                                                                               |
| Hard timeout              | 60 min                                                                                                               |
| Grace after end           | 60 s                                                                                                                 |

**One-time link:** `http://{redirect.host}/setup?t={token}`. The token is `randomToken(32)` (base64url). Token comparisons use `timingSafeEqual` with a length check.

**Phases (`SetupPhase`):** `form` → `verifying` → `authorizing` → `exchanging` → `done`, or `failed`.

**Request guards, applied in this order**

1. **Host check (DNS rebinding):** `Host` must be one of `localhost:{port}`, `127.0.0.1:{port}`, `[::1]:{port}` (bare hostnames when the redirect URI has no port, since browsers omit the default port). Otherwise `421 Misdirected request`.
2. The callback path is handled next (see below).
3. `GET /setup/status`
   - Requires the token, from the `X-Setup-Token` header or `?t=`. Otherwise JSON `403 {"error":"forbidden"}`.
   - Returns `{phase, problem?, client_id_saved: bool}`. It **never** includes the secret, the tokens or the OAuth state.
   - It does **not** count as activity, so a polling tab doesn't keep an abandoned setup alive.
4. `GET /setup/done?t=` (the no-JavaScript "Check whether it worked" target)
   - Wrong token: the expired page.
   - `done`: "WHOOP connected" page.
   - `failed`: "WHOOP didn't connect" plus the problem.
   - `authorizing` with a problem: the callback problem page.
   - Otherwise: the finishing page.
5. **After the flow ends (`closing`)**, every other path returns `410` "Finished" / "This setup has finished. Check the chat in Claude." During the grace period, only status, done and the callback are answered.
6. `GET /setup/authorize?t=` ("Try again")
   - Wrong token: expired page.
   - Not yet submitted: 303 to `/setup?t=`.
   - Phase `exchanging` or `done`: finishing page.
   - Otherwise touch, then:
     - If `authorizing` with an existing authorization and **no problem**, 303 to the **same** authorize URL. An approval still being completed in another window stays valid.
     - Otherwise create a new state and authorization, and 303 to it. A new state is made only after WHOOP refused one.
7. `POST /setup/verify` (JSON, used by the page script). Any other method gives `405`.
   - `Origin` must be in the allowed set (`http://` + allowed host); otherwise `403 cross-site request refused`.
   - `Content-Type` must start with `application/json`; otherwise `415`.
   - Token required in the header; otherwise `403`.
   - Touch.
   - Body over 8 KiB: `413`. Bad JSON: `400`.
   - Body is `{client_id, client_secret}`, both trimmed. An empty secret reuses `keptSecret`.
   - Replies: `{ok:true, authorize_url, warning?}`, or `{ok:false, field, message}` with the outcome's status.
   - A JSON content type plus a custom header force a CORS preflight, which this server never answers, so other sites can't call this endpoint.
8. Any other path except `/setup`: `404`.
9. `GET /setup`: token required (otherwise expired), touch, render the page.
10. Methods other than GET and POST on `/setup`: `405` with `Allow: GET, POST`.
11. `POST /setup` (the no-JavaScript form, `application/x-www-form-urlencoded`)
    - **CSRF:** `Origin` must be present and allowed. Missing, `null` or foreign origins get `403` "Forbidden" / "Cross-site request refused."
    - `Content-Length` over 8 KiB, or a text body over 8 KiB, gives `413`. Bun's `maxRequestBodySize` is also 8 KiB, and its error is mapped to `413` even for streamed bodies without a Content-Length (tested).
    - Form `token` must match; otherwise the expired page (403).
    - Touch.
    - `action=reset` ("Use different credentials"): if `authorizing`, drop the authorization (its state is no longer accepted) and set phase to `form`. Re-render the page. Reset needs the same token and origin as any other post (tested).
    - Otherwise submit. Success gives a 303 to the WHOOP authorize URL. Failure gives: 409 "Already in progress", 410 "This page has closed", 429 "Too many tries", or a re-rendered form (400) with a field error, keeping the Client ID.

- Unexpected handler errors return `500` "Something went wrong" / "Unexpected error; check the whoop-mcp log."
- The **expired page** is `403` "Link expired" / "This setup link isn't valid any more. Ask Claude to connect WHOOP again."
- Once the server has stopped (after cancel or the end of the grace period), connections are refused.

**`submit(clientId, clientSecret)`** is shared by the JSON and form paths and is idempotent:

- If the flow has ended: `410` "This page has closed. Ask Claude to connect WHOOP again."
- If a check is in flight:
  - Same ID and secret: return the same outcome promise (covers double clicks and two tabs).
  - Different values: `409` "Still checking the previous values; try again in a moment."
- Phase `exchanging` or `done`: `409` "WHOOP is already connecting; check Claude."
- Phase `authorizing` with the same submitted credentials: `{ok, authorizeUrl}` using the same URL. A double submit gets the same redirect.
- Missing values: `400` "Paste both the Client ID and the Client Secret." with field `both`, `client_id` or `client_secret`. WHOOP is not contacted.
- Rate limit: a sliding 60 s window, at most 10 checks, shared by both paths. Over the limit: `429` "Too many tries; wait a minute."
- Otherwise:
  1. Set `lastClientId`.
  2. **Drop any pending authorization**, so a late callback for the old one is refused.
  3. Set phase `verifying` and run `verifyCredentials`.
  4. If ended meanwhile: 410, save nothing.
  5. If the check returns `false`: keep the secret **in memory only** (`keptSecret`), set phase `form`, and return `400` with field `both`: "WHOOP didn't accept this Client ID and Secret. Copy both again from your app's page."
  6. If the check returns `"unknown"`: log a warning, attach warning "Couldn't check them with WHOOP right now; continuing anyway.", and continue.
  7. Save the credentials. If ended during the save: 410. If the save throws: keep the secret, set `form`, return `500` "Couldn't save them: {msg}".
  8. Clear `keptSecret`, create the authorization (new state), set phase `authorizing`, and return the URL.

**Callback on the redirect path (setup kind)**

- No authorization pending:
  - With a problem recorded: `409` "Already handled" / "This WHOOP approval was already handled. Use the setup tab to try again."
  - Otherwise: `409` "Not ready" / "Finish the setup page first."
  - Neither page has token-bearing links, because the request's state can't be checked.
- Wrong state: `wrongStatePage` (400). It changes nothing, and the real callback can still complete afterwards.
- While closing: the finishing page.
- Touch.
- A `code` while phase is `exchanging` or `done`: the finishing page only. A reload must not exchange the single-use code twice.
- A `code` otherwise: set phase `exchanging`, run `finish(code)` in the background, and return the finishing page.
- An error or no-code: **keep the flow alive**. Set phase `authorizing` with the problem (the `explainOAuthError` text, or "WHOOP sent no authorization code."), log a warning, and return the callback problem page.

**`finish(code)`**

1. Exchange the code with the submitted credentials.
   - If the flow ended during the exchange (for example a disconnect), **revoke the new token** and save nothing.
   - If the exchange throws: phase `failed` with "WHOOP approved access, but finishing the connection failed. Ask Claude to try again.", then reject.
2. **Partial scopes:** revoke, set `authorization = null` (that approval is used up, so a reload of the callback does nothing), touch, and set phase `authorizing` with `missingScopesMessage`. The flow stays open for Try again.
3. Run `persist(tokens)` **before** "done". If it fails: `failed` with "WHOOP approved access, but saving the login failed. Ask Claude to try again." A failed save is never shown as success.
4. Set phase `done` and resolve.

**Timers**

- `touch()` resets the idle timer, except in phases `done`, `failed` and `authorizing`.
  - Entering `authorizing` clears the idle timer, because the user is on WHOOP's sign-in and 2FA pages, which this server can't see.
  - The 60 min hard timeout still ends an abandoned approval.
  - Idle end: "The WHOOP setup page wasn't used for a while, so it closed."
  - Hard end: "Timed out waiting for WHOOP setup to finish in the browser."
- **Abort signal:** ends the flow with "WHOOP setup was cancelled." and stops the server **immediately**, including during the grace period, so the next login gets the port at once.
- **Finally block:**
  - If the phase is not `done` or `failed`, set `failed` with the error message.
  - **Wait for any in-flight submit and any finishing exchange.** Whoever cancelled (for example `whoop_disconnect`) can then be sure no credentials or login appear afterwards.
  - Set `closing = true`.
  - If aborted, stop now. Otherwise stop after `graceMs` (60 s, with an unref'd timer), so the tab can show how it ended.

**Page content (`setupPage`)**

- `<title>` is "Connect WHOOP"; the heading is "Connect WHOOP to Claude".
- Intro text: about 5 minutes the first time; WHOOP's terms don't let open-source tools share one app, so you make your own.
- Progress list: `1 · Create app`, `2 · Paste codes`, `3 · Approve`, with `aria-current="step"` on the current one and `.done` on earlier ones.
- **Section 1:**
  - "Open WHOOP in a new tab" button linking to `CREATE_URL` with `target="_blank" rel="noopener"`. There is no `window.open` and no popup, so there's no reverse tabnabbing, and approval happens in the setup tab itself.
  - A hint for existing apps: add the Redirect URL and skip to step 2.
  - A callout: WHOOP may ask you to create a **Team**; name it anything.
  - The field table (`<table class="fields">`, rows `<th scope="row">`):

| Field          | What to enter                                                                                                                           |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Name           | `whoop-mcp` (Copy button)                                                                                                               |
| Logo           | leave empty                                                                                                                             |
| Contacts       | your email address                                                                                                                      |
| Privacy Policy | `PRIVACY_URL` (Copy button)                                                                                                             |
| Redirect URLs  | the redirect URI (Copy button), note "exactly this"                                                                                     |
| Scopes         | "tick every box (6): read:profile, read:body_measurement, read:cycles, read:recovery, read:sleep, read:workout" (`offline` is excluded) |
| Webhooks       | leave empty                                                                                                                             |
- Copy buttons:
  - Use `navigator.clipboard.writeText`, falling back to selecting the `<code>` text.
  - Show "Copied ✓" for 2 s and add a ✓ to the row.
  - Move focus to the next Copy button.
  - Are draggable, setting `text/plain` on drag.
- **Section 2:**
  - A form posting to `/setup` with `autocomplete=off` and `novalidate`, a hidden `token`, a `client_id` input pre-filled from `lastClientId`, and a password-type `client_secret` input.
  - When a secret is kept, the placeholder reads `Kept (ends …{last4}); leave empty to reuse`.
  - A Show/Hide toggle with `aria-pressed`, hidden when JavaScript is off.
  - Per-field messages with `aria-invalid`, and a `#status` element with `role=status aria-live=polite`.
  - "Save and continue" button, and a Cancel button that is hidden until needed.
  - Footer: "Checked with WHOOP, then stored in your system keychain on this computer. Nothing is sent anywhere else."
  - The paste-key label shows `⌘V` on Mac or iOS, otherwise `Ctrl+V`.
- **Section 3:**
  - Text: "WHOOP asks you to approve access…"
  - A help block, hidden unless there is a problem. Its default text is "Did WHOOP show an error? Usually the Redirect URL isn't exactly the one above, or not every Scope is ticked."
  - "Try again" links to `/setup/authorize?t=`. "Use different credentials" is a POST form with `action=reset`.
- An error render returns HTTP 400. Submitted values are HTML-escaped, and the secret is never echoed (tested).
- The page works **without JavaScript** as a plain form.

**Page script behaviour**

- **Paste anywhere:** a document `paste` listener calls `preventDefault` and `distribute(text, target)`:
  1. A labelled text such as `client id … client secret …` (regex) fills both boxes.
  2. Exactly two whitespace-separated parts fill both boxes. If the second part is a UUID and the first isn't, they are swapped.
  3. A single UUID goes to Client ID. WHOOP client IDs are UUIDs.
  4. A single value of 40 or more characters goes to Secret.
  5. Otherwise the value goes into the focused input, else into an empty Client ID, else into Secret.
  - After any of these: set step 2, hide the paste hint, and schedule a verify in 300 ms.
  - A `beforepaste` listener calls `preventDefault`, which WebKit/Safari needs to offer paste on non-editable content.
- **Auto-verify:**
  - Typing in either box schedules a verify after 600 ms, but only when both boxes are non-empty.
  - If a check is already running, it re-schedules in 400 ms.
  - If the values changed while a check was in flight, it re-checks the new values.
  - Editing after a successful check discards the authorize URL and cancels the auto-go.
  - Focus moves to the bad field **only on an explicit Save**. Moving focus during automatic checks would capture the next paste.
- **Success:** shows "[warning ]Saved. Opening WHOOP to approve access…", reveals Cancel, and navigates to the authorize URL after 1.5 s. Cancel pauses with "Paused. Press Save and continue when you're ready."
- **Submit:**
  - If already verified, go now.
  - If a field is missing (the secret counts as present when one is kept): "Paste this one from your WHOOP app."
  - Otherwise run an explicit verify.
- **Fetch failure:** "Couldn't reach this page's server. Is Claude still open?"
- **Paste hint:** after the window blurs and refocuses (the user is back from WHOOP's tab) with a box still empty, show the hint.
- **Polling:**
  - Runs when the phase is `authorizing` or `exchanging`: set step 3 and poll `/setup/status` every 2 s for up to 30 min.
  - `done`: "✓ WHOOP is connected. Claude is continuing in the chat; you can close this tab."
  - `failed`: the problem text, or "The connection failed. Ask Claude to try again."
  - A problem: show the help block with that text.
  - After 90 s with no change: show the help block anyway.
  - A fetch error: "This page's server has closed. Check the chat in Claude."
- **bfcache:** a `pageshow` handler calls `location.reload()` when `e.persisted` is true. Coming back from WHOOP with the Back button could otherwise restore a page holding an approval link the server has since replaced.

**Finishing page** (title "Connecting WHOOP", served at the callback)

- Shows "Finishing…" / "WHOOP approved access. Connecting…" and polls status every 1 s, up to 30 times.
  - `done`: "✓ WHOOP connected" / "Claude is continuing in the chat. You can close this tab." If `window.opener` exists, it calls `window.close()` after 1.5 s.
  - `failed`: "WHOOP didn't connect" plus the problem.
  - `authorizing` with a problem (for example a partial grant): show the problem and reveal "Try again" (`/setup/authorize?t=`) and "Back to setup" (`/setup?t=`).
  - Exhausted: "Check the chat in Claude to see whether it worked."
- A `<noscript>` link goes to `/setup/done?t=`.

**Callback problem page:** "WHOOP didn't connect" plus the problem, then "Fix it in the WHOOP developer dashboard if needed, then:" with Try again and Back to setup.

**Page style and CSP** (all local pages)

- One palette with WCAG AA contrast in light and dark mode, `color-scheme: light dark`, visible `:focus-visible` outlines, and `prefers-reduced-motion` respected.
- Text only: no WHOOP logo or brand marks, since this is unofficial.
- A fresh 16-byte base64 nonce per response, used for the inline `<style>` and `<script>`.
- CSP:
  `default-src 'none'; style-src 'nonce-X'; script-src 'nonce-X'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'`
  - There is deliberately **no `form-action`**: Chrome applies it to every redirect after the POST, which blocked WHOOP's consent redirects.
- Values embedded in scripts are serialized as JSON with `<` escaped to `\u003c`.

### Credential verification (`verifyCredentials`)

Sources: `src/setup.ts`, `test/setup.test.ts`

- Checks credentials without a browser. It POSTs to the token URL with `grant_type=refresh_token`, `refresh_token=whoop-mcp-setup-check`, `client_id` and `client_secret`, with a 15 s timeout.

| Result                                                                    | Meaning                                                                                        |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `error = invalid_client`                                                  | `{ok:false}` "WHOOP rejected the client ID or secret."                                         |
| `error` is `invalid_grant`, `unsupported_grant_type` or `invalid_request` | `{ok:true}`: the client authenticated, and only the fake grant was refused                     |
| Network error                                                             | `{ok:"unknown"}` "could not reach WHOOP (…)"                                                   |
| Anything else (5xx, firewall 403, 429, HTML or non-JSON body)             | `{ok:"unknown"}` "WHOOP returned {status}[ ({error})]". It says nothing about the credentials. |

### MCP tools

Sources: `src/server.ts`, `src/tools/common.ts`

**`whoop_login`** ("Connect WHOOP")

- Annotations: `readOnlyHint:false, destructiveHint:false, idempotentHint:true, openWorldHint:true`.
- Description rules: it never reopens the page; call it again with `wait_seconds` while the result says pending; never ask the user to say when they're done; use `reconfigure` only for a wrong app or a different app.

| Param          | Type | Default                   | Limits                                                   |
| -------------- | ---- | ------------------------- | -------------------------------------------------------- |
| `wait_seconds` | int  | 40 (`LOGIN_WAIT_SECONDS`) | 0–45. Stays under Claude's roughly 60 s tool-call limit. |
| `reconfigure`  | bool | false                     | Opens the setup page even if credentials are saved       |
- Logic:
  1. If not reconfiguring, nothing is pending, and `isConnected()` is true, return at once: "WHOOP is connected. Carry on with the user's request now (call the WHOOP tool you need)." with `{state:"connected"}`.
     - `isConnected()` requires all of: tokens exist; app credentials are resolvable (not missing); this process doesn't know the session expired; every scope is present; and there is a refresh token or the access token hasn't expired.
  2. Otherwise `start({reconfigure})`, then `waitForChange(wait_seconds*1000, request abort signal)`.
  3. `seenProblems` is the previous `problemSeq`, so a problem is passed on to Claude only once.
- Results are scripts for Claude, not prose for the user. Each has `structuredContent`:

| Status                  | Text (gist)                                                                                                                                                                                                                                                                                                                                | structured                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| succeeded               | "WHOOP is connected. Carry on with the user's original request now (call the WHOOP tool again); don't ask them anything first."                                                                                                                                                                                                            | `{state:"connected", scope}`                        |
| failed                  | "The WHOOP connection failed: {error[0..300]} Tell the user in one sentence." If the error matches `/client\|credential\|redirect/i`, it adds the reconfigure hint; otherwise "call whoop_login to try again if they want".                                                                                                                | `{state:"failed", error}`                           |
| idle                    | "The WHOOP connection was cancelled."                                                                                                                                                                                                                                                                                                      | `{state:"idle"}`                                    |
| pending, new problem    | `The WHOOP page … is showing a problem: "{problem}" The page offers Try again. Tell the user …, then call whoop_login again right away with wait_seconds=40 (no reconfigure).`                                                                                                                                                             | `{state:"pending", kind, url, progress?, problem?}` |
| pending, first call     | "Opened {a WHOOP setup page \| WHOOP's approval page} … (if it didn't open, they can visit {url}). Tell the user in one sentence, e.g. "{say}" Don't repeat the page's steps. Then … keep calling it while it says pending."                                                                                                               | same                                                |
| pending, 15 min or more | "The user has been on the WHOOP page for {n} minutes. Stop calling whoop_login for now and ask them whether they're still connecting…"                                                                                                                                                                                                     | same                                                |
| pending, otherwise      | "Still waiting for the user ({n} min, {step}). Call whoop_login again right away … Say nothing to the user meanwhile." The step is "creating the WHOOP app" or "approving access" (form or undefined), "checking the app's codes" (verifying), "approving access in WHOOP" (other phases), or "the page is showing them a problem to fix". | same                                                |
- Suggested sentences:
  - Setup kind: "I've opened a page in your browser to connect WHOOP; it takes about 5 minutes the first time, and I'll carry on when you're done."
  - Login kind: "I've opened WHOOP in your browser; approve access there and I'll carry on."
- Thrown errors (for example a port in use) become an `isError` text result.

**Auto-start from data tools** (`toolError` / `notConnectedResult`)

- Triggered by `NotLoggedInError` (including `SessionExpiredError`) and by `ConfigError` (missing app credentials, which then opens the setup page).
- The tool calls `startIfIdle()`.
  - If a flow is pending, it returns `isError` text: "WHOOP isn't connected, so {what} is open in the user's browser (if it didn't open … {url}). Tell the user in one sentence, e.g. "{say}" Then call whoop_login with wait_seconds=40, keep calling it while it says pending, and call this tool again once it reports connected. Don't ask the user to say when they're done."
  - Otherwise (cooldown, or the start failed) it returns the plain error.
- The server instructions repeat this rule.

**`whoop_status`** ("WHOOP connection status")

- Annotations: read-only, idempotent, `openWorldHint:false`. It makes **no WHOOP API calls**.
- `outputSchema`:

| Field                       | Type                                     | Meaning                                                                |
| --------------------------- | ---------------------------------------- | ---------------------------------------------------------------------- |
| `logged_in`                 | bool                                     | tokens exist and the session is not expired                            |
| `session_expired`           | bool                                     | this process saw `invalid_grant` for the **current** refresh token     |
| `last_error`                | string or null                           | the last refresh failure, tied to that refresh token                   |
| `app_credentials`           | `env\|keychain\|file\|missing`           |                                                                        |
| `login`                     | `{state, kind?, authorize_url?, error?}` | `kind` and `authorize_url` only when pending; `error` only when failed |
| `token_file`                | string                                   | path                                                                   |
| `log_file`                  | string or null                           |                                                                        |
| `scopes`                    | string[]                                 | granted                                                                |
| `missing_scopes`            | string[]                                 | all `SCOPES` when there are no tokens                                  |
| `access_token_expires_in_s` | number or null                           | rounded                                                                |
| `has_refresh_token`         | bool                                     |                                                                        |
| `server_version`            | string                                   |                                                                        |
- The summary takes the first match, in this order:
  1. Pending, setup kind: "Waiting for the user to finish the setup page in the browser ({url}). Call whoop_login with wait_seconds to wait for it."
  2. Pending, login kind: "…approve access in the browser…"
  3. Expired: "The WHOOP session has expired or was revoked. Call whoop_login to reconnect."
  4. Logged in, but credentials missing: "…the next token refresh will fail. Call whoop_login with reconfigure: true…"
  5. Logged in with `last_error`: "Logged in, but the last token refresh failed: …"
  6. Logged in with missing scopes: "Connected, but without …, so some tools will fail. Call whoop_login and approve every permission."
  7. "WHOOP is connected."
  8. Last login failed: "The last login failed ({error}). Call whoop_login to try again, or with reconfigure: true…"
  9. No credentials: "No WHOOP app credentials yet: call whoop_login, which opens a setup page…"
  10. Otherwise: "Not logged in: call whoop_login to sign in with the browser."
- The result text is `{summary}\n\n{compact JSON}`, with `structuredContent` set as well.

**`whoop_disconnect`** ("Disconnect WHOOP")

- Annotations: `destructiveHint:true, idempotentHint:true, openWorldHint:true`.
- Use it only when the user asks to disconnect, log out or remove access. It deletes the app credentials by default, because that became the default in v0.6.0.

| Param      | Type | Default | Meaning                                                                   |
| ---------- | ---- | ------- | ------------------------------------------------------------------------- |
| `keep_app` | bool | false   | Keep the saved Client ID and Secret, so reconnecting skips the setup page |
- Steps:
  1. `loginFlow.cancel()`. This also waits for setup-page submits or exchanges in flight, which then save nothing or revoke.
  2. `client.drain()`, so a refresh in flight saves before the delete.
  3. Record `hadLogin`, then `revoked = client.revokeAccess()`, which refreshes first if needed and returns `revoked`, `failed` or `not_logged_in`.
  4. `withTokenLock(deleteTokens)`.
  5. Unless `keep_app`: `deleteStoredCredentials()` and `forgetApp()`.
  6. Re-resolve the credential source. Env vars still win and can't be removed.
- Messages, joined in order:
  - No login: "WHOOP wasn't connected."
  - Revoked: "Disconnected from WHOOP: access was revoked at WHOOP and the saved login deleted."
  - Not revoked: "Deleted the saved WHOOP login, but couldn't revoke access at WHOOP (it may already have ended). The user can also remove the app's access in the WHOOP developer dashboard."
  - Kept, but nothing to keep: "There were no saved WHOOP app credentials to keep, so connecting again starts with the setup page."
  - Kept: "The WHOOP app credentials were kept, so reconnecting goes straight to WHOOP's approval page."
  - Delete failed: "The saved WHOOP app credentials couldn't be removed from the keychain; the user can delete the 'whoop-mcp' item in Keychain Access."
  - Env still set: "The WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET environment variables are still set, so connecting again uses them."
  - Deleted: "…deleted too, so connecting again starts with the setup page."
  - Nothing stored: "There were no saved app credentials to delete."
- Structured output: `{disconnected:true, revoked_at_whoop, app_credentials_deleted, app_credentials_delete_failed?}`.

**Prompts:** `whoop-connect`, `whoop-disconnect`, `whoop-status`. They take no arguments, have no side effects, and their text asks Claude to call the tool.

### Token refresh rules relevant to login

Sources: `src/whoop/client.ts`

- Refresh when `expires_at - 60 s <= now`.
- Refresh is single-flight within the process. A tool call stops waiting after 25 s ("WHOOP is slow to renew the login; try again in a moment.") while the refresh continues and saves.
- `invalid_client` or `unauthorized_client` throws `CredentialsRejectedError`: "WHOOP rejected the app credentials ({code}). Call whoop_login with reconfigure: true to enter the Client ID and Secret again."
- `invalid_grant`:
  - Re-read the file. If another process already rotated the token, use its tokens.
  - Otherwise throw `SessionExpiredError` and **remember the dead refresh token in memory**, so it is never posted again.
  - The file is left alone, because writing a marker could overwrite tokens another process is saving.
  - A new login stores a different refresh token, which automatically clears the failure.
- After a successful refresh, under the lock, re-read the file:
  - File gone (logged out meanwhile): discard the new tokens and throw `NotLoggedInError`.
  - A different refresh token (logged in again meanwhile): keep the new login.
  - Otherwise write, then use the tokens.
- A 401 re-reads the token file once. If the file is gone, throw `NotLoggedInError` and never revive the session from memory.
- Messages:
  - `NotLoggedInError`: "Not logged in to WHOOP. Call the whoop_login tool first."
  - `SessionExpiredError`: "The WHOOP session has expired or was revoked. Call whoop_login to reconnect."

### Process lifecycle

Sources: `src/index.ts`

- There is one `BackgroundLogin` and one `WhoopClient` per process.
- On stdin `end` or `close`, or on SIGTERM, SIGINT or SIGHUP, an idempotent shutdown runs `loginFlow.cancel()` and `client.drain()`, then exits.
  - Shutdown is capped at 1.5 s, under the 2 s Claude allows between EOF and SIGTERM.
  - This frees port 8787 and doesn't lose a refreshed token.

### CLI (development and terminal)

Sources: `src/index.ts`, `src/setup.ts`, `test/setup.test.ts`

| Command                                             | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `setup [--no-browser] [--no-login] [--skip-verify]` | Prints the same field instructions and opens `DASHBOARD_URL` unless `--no-browser`. Asks for the Client ID, then the secret through a **hidden** prompt; the secret is never printed. Allows at most 3 attempts; a blank answer counts as an attempt. After 3 it fails with "Gave up after 3 attempts; nothing was saved." Verifies unless skipped; "unknown" saves anyway. Prints where the credentials were saved. If credentials already exist, asks "Replace them? [y/N]" showing the source and the last 4 characters of the ID. Then runs the login unless `--no-login`. Honours `WHOOP_REDIRECT_URI`. |
| `login [--no-browser]`                              | Consent login with the resolved credentials. Without credentials: "No WHOOP app credentials yet: run `whoop-mcp setup` first." It **warns** about missing scopes, but `login()` itself already rejects a partial grant.                                                                                                                                                                                                                                                                                                                                                                                      |
| `status`                                            | Prints the credential source, the token expiry in minutes, refresh-token presence and the scopes. Exit code 1 when not logged in.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `logout [--keep-app]`                               | Revokes if logged in, deletes the tokens, and deletes the app credentials unless `--keep-app`. `--forget-app` is still accepted (legacy). Any other option exits with code 2 without deleting anything.                                                                                                                                                                                                                                                                                                                                                                                                      |

### Environment variables (auth area)

| Var                                      | Effect                                                                                                           |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `WHOOP_CLIENT_ID`, `WHOOP_CLIENT_SECRET` | Override stored app credentials, but only when both are set (trimmed)                                            |
| `WHOOP_REDIRECT_URI`                     | Overrides the redirect, including for stored credentials and the setup page. It must be http on a loopback host. |
| `WHOOP_MCP_HOME`                         | Config directory for `tokens.json` and `client.json`                                                             |
| `XDG_CONFIG_HOME`                        | Base for the default config directory; empty counts as unset                                                     |
| `WHOOP_MCP_CREDENTIAL_STORE=file`        | Never use the keychain                                                                                           |
| `WHOOP_MCP_NO_BROWSER=1`                 | Don't open pages; only announce them                                                                             |

### Logging and secrets

Sources: `src/log.ts`, `src/auth/*.ts`

- Never logged: tokens, secrets, authorization codes, OAuth states, or the setup token in URLs. A failed browser open logs only the origin and path.
- `redact()` is a last line of defence. It masks `Bearer …` and `access_token`, `refresh_token`, `id_token`, `client_secret`, `code`, `code_verifier` and `token` values.
- Login events are logged: started (kind, reconfigure), succeeded (scope), failed or cancelled, refused authorization (error code only), partial scopes (missing list), and revocation status.

### Corrections and additions

Found when this part was checked against the code. Where they differ from the text above, these are right.

**Token and credential store: read errors (correction)** (src/auth/store.ts, src/auth/credentials.ts, src/auth/background-login.ts, src/server.ts)
- `readPrivateText` returns `null` **only for `ENOENT`**. `EACCES`, `EISDIR` and every other read error are rethrown.
- `readTokens`: a missing file gives `null`. A file that reads but fails `JSON.parse`, or has no string `access_token`, gives `null` and logs the warning `ignoring an unreadable token file; a new login replaces it` (with `file`). A non-ENOENT read error **throws**:
  - from `WhoopClient.validTokens` (data tools return it as a plain error);
  - from `isConnected` (`whoop_login` returns `errorResult`);
  - from the `whoop_status` handler, which has no try/catch (the SDK turns it into a tool error);
  - from `whoop_disconnect` (`errorResult`).
- `client.json`: `readStoredCredentials` tries the keychain first. Keychain errors and unparseable keychain values are swallowed and it falls through to the file.
  - In the file, unparseable JSON gives `null` with the warning `ignoring unreadable stored WHOOP app credentials`.
  - A non-ENOENT read error **throws** from `readStoredCredentials` and `resolveClientCredentials`. This only happens when the keychain is disabled or holds nothing.
- That error is not a `ConfigError`, so:
  - `BackgroundLogin.begin` rethrows it and `whoop_login` fails with the fs message;
  - a refresh inside a data tool fails with the plain error and no page opens;
  - `credentialSource()` catches everything and reports `"missing"`, so `isConnected` is false and `whoop_status` shows `app_credentials: "missing"`.

**`explainOAuthError` hard-codes the redirect** (src/auth/login.ts)
- The "redirect" branch (when `error` or `description` contains "redirect") always says `… Redirect URLs must contain exactly http://localhost:8787/callback (no trailing slash).`
- It ignores `WHOOP_REDIRECT_URI` and the stored `redirectUri`, so with an override the advice is wrong.
- Both the consent-only callback and the setup callback page use this text.
- A rebuild should interpolate the real URI, or keep the bug knowingly.

**Consent-only login server has no Host/Origin guard** (src/auth/login.ts, src/auth/browser-setup.ts)
- `browserSetup`:
  - every request must carry an allowed `Host` (`localhost`, `127.0.0.1` or `[::1]`, plus `:port` when the redirect URI has one), otherwise `421 Misdirected request`;
  - POSTs need an allowed `Origin`;
  - the token is checked with constant-time compare.
- `login()` (kind=login) does **none** of that. It answers any `Host` on `redirect.pathname`, sends 404 `Not found` for every other path, and relies only on the `state` check (`parseCallback`: a wrong state gives the 400 "Not this login" page and leaves the flow running).
- Both servers bind the same loopback set through `listenLocal`. Record this asymmetry, or fix it deliberately.

**Logging of OAuth state (correction)** (src/auth/login.ts, src/log.ts)
- The consent-only `login()` logs `log.info("open this URL to authorize WHOOP access", { url: authorizeUrl })`. That URL contains `state` and `client_id`.
- `redact()` has patterns for `Bearer`, `access_token`, `refresh_token`, `id_token`, `client_secret`, `code`, `code_verifier` and `token`, and none for `state`.
- So the state is written to the log file, and to stderr at info level from CLI commands.
- The setup flow doesn't log its setup URL or its authorize URL. `/setup/status` never returns the state.
- Either document this, or stop logging the URL in the rewrite.

**Setup flow saves app credentials before consent** (src/auth/browser-setup.ts, src/auth/background-login.ts)
- `submit()`, after verification (`ok: true` or `"unknown"`), calls `save(creds)`. That writes to the keychain or `client.json` **before** the WHOOP approval step.
- Abandoning or failing the approval (timeout, cancel, refused scopes that are never fixed) leaves the app credentials saved.
- The next `whoop_login`, or a data-tool auto-start, then resolves credentials and opens `kind: "login"`, straight to WHOOP's consent, not the setup page.
- Fixing a wrong app then needs `whoop_login {reconfigure: true}`.
- Only a cancel that lands during verify or save prevents the save (submit returns 410 and saves nothing).

**Setup page `lastClientId` (and the BackgroundLogin comment)** (src/auth/browser-setup.ts, src/auth/background-login.ts)
- Inside one `browserSetup` run, `lastClientId` starts as `opts.clientId`.
  - `submit()` sets it once a submit passes the empty-field check and the rate limit.
  - The form-POST handler also sets it on **any** failed outcome (`if (clientId) lastClientId = clientId`), so the re-rendered form keeps the typed ID. The JSON `/setup/verify` path updates it only through `submit()`.
- Across flows, `BackgroundLogin.lastClientId` is set **only after a successful setup** (`.then(({creds}) => this.lastClientId = creds.clientId)`). `forgetApp()` clears it when `whoop_disconnect` deletes the app.
  - Its doc comment ("Pre-fills the setup page after a failed or replaced attempt") is wrong.
  - A failed setup's ID doesn't carry into the next flow. Because of the early save above, that next flow is usually `kind: "login"` anyway.
  - In practice the pre-fill shows only on `reconfigure: true` after a success.
- Choose one behaviour deliberately.
- `finish(code)` with no submitted credentials rejects with `WHOOP setup finished without credentials.` `browserSetup` throws the same message if the flow resolves without them.

**`/setup/verify` and other JSON error bodies** (src/auth/browser-setup.ts)

`/setup/verify` checks run in this order:

| Status              | Body                                                                 | When                                                 |
| ------------------- | -------------------------------------------------------------------- | ---------------------------------------------------- |
| 405                 | `{"error":"method not allowed"}`                                     | not POST                                             |
| 403                 | `{"error":"cross-site request refused"}`                             | `Origin` missing or not in the allowed set           |
| 415                 | `{"error":"JSON only"}`                                              | `Content-Type` doesn't start with `application/json` |
| 403                 | `{"error":"forbidden"}`                                              | bad or missing `X-Setup-Token` header / `?t=`        |
| 413                 | `{"error":"too large"}`                                              | body text longer than `MAX_BODY_BYTES`               |
| 400                 | `{"error":"bad JSON"}`                                               | `JSON.parse` failed                                  |
| 200 / submit status | `{ok:true, authorize_url, warning?}` or `{ok:false, field, message}` | `submit()` outcome (400/409/410/429/500)             |
- `/setup/status` with a bad token also returns 403 `{"error":"forbidden"}`.
- JSON responses carry `Content-Type: application/json`, `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`. They do **not** carry `Referrer-Policy`, `X-Frame-Options` or a CSP; HTML pages have all of them plus a per-response nonce CSP.
- Form-POST size failures (`Content-Length` or text over the limit, or Bun's `maxRequestBodySize`) return the HTML page `Too large` / `Request too large.` with status 413.
- Route order after the Host check:
  1. callback path;
  2. `/setup/status`;
  3. `/setup/done`;
  4. **`if (closing)`**: 410 page `Finished` / `This setup has finished. Check the chat in Claude.`;
  5. `/setup/authorize`, `/setup/verify`, `/setup`.
- So once the flow has ended, `/setup/verify` gets the 410 HTML page, not JSON.

**Keychain delete path** (src/auth/credentials.ts, .claude/skills/whoop-reset/scripts/whoop-reset.ts)
- `deleteKeychainItem()` calls `Bun.secrets.delete({service:"whoop-mcp", name:"client-credentials"})` first.
- Only when that throws an error whose message matches `-25244` (errSecInvalidOwnerEdit: the item belongs to another ad-hoc-signed build) **and** the platform is darwin does it spawn `/usr/bin/security delete-generic-password -s whoop-mcp -a client-credentials` (10 s timeout).
  - Exit 0 gives true, exit 44 (not found) gives false, any other exit logs a warn and rethrows the original error.
  - Any other error (locked keychain, a click on Deny) is rethrown and no fallback runs.
- The `/whoop-reset` skill instead runs `security delete-generic-password -s whoop-mcp` with **no account**, up to 20 times until it exits 44. That removes every item under the service, including ones older builds saved under other account names.
- `Bun.secrets` is experimental and needs a secret service on Linux, which is why the 0600 `client.json` fallback exists. `WHOOP_MCP_CREDENTIAL_STORE=file` forces the file store.

**WHOOP remembers consent** (.claude/skills/whoop-reset/SKILL.md, src/auth/browser-setup.ts, src/auth/login.ts)
- If the browser is still signed in to WHOOP and the app was approved before, re-authorizing can **skip the approval screen**. The callback then arrives almost at once.
- That is one reason for the `wrong-state` "Not this login" page (a stale tab's callback) and for `/setup/authorize` reusing the pending authorization: it redirects to the same URL and state unless WHOOP refused one, so an approval still being completed in another window stays valid.
- To test the full sign-in and consent flow, sign out at whoop.com or use a private window.

**WHOOP Terms of Use constraints that shape the design** (docs/archive/RESEARCH.md, docs/roadmap.md, src/log.ts, src/tools/common.ts)

| ToU §                  | Constraint                                                                                                                                               | Design consequence                                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| §4.2.3                 | No using WHOOP data to "create, develop, test, train, fine-tune or improve" AI/ML. Inference by an LLM is neither expressly banned nor expressly allowed | No conversation logging, no datasets, no real WHOOP data in tests or evals                                                    |
| §4.2.1                 | Exposure to third parties needs explicit user opt-in (an LLM provider is arguably a third party)                                                         | First-run consent notice planned in RESEARCH; any remote mode needs review                                                    |
| §4.2.2, §7.1           | No databases or permanent copies; delete data when access ends                                                                                           | No cache at all; response bodies and health data never logged; disconnect deletes tokens (and by default the app credentials) |
| §2.4                   | Encrypt at rest; report incidents within 48 h                                                                                                            | Credentials go to the keychain; the plaintext 0600 `tokens.json` is an open question                                          |
| §3.2.1                 | No developer credentials in source                                                                                                                       | Bring-your-own WHOOP app                                                                                                      |
| §3.1.2, §3.1.3         | No redistribution or marketing of data                                                                                                                   | Relevant for hosted or remote mode                                                                                            |
| §3.1.10, §3.1.11       | No medical-device use or medical advice                                                                                                                  | `DISCLAIMER = "Not medical advice."`, non-diagnostic wording, "suggest a professional" in the instructions                    |
| §5.1, §5.2             | No logos, no implied endorsement                                                                                                                         | Name "WHOOP (unofficial)"; local pages are text only                                                                          |
| §1.4, §3.1.12, §3.1.13 | Documented means only                                                                                                                                    | No private-API features                                                                                                       |
- The ToU took effect on 2026-10-06 and can change at any time (§9.1). Re-check it before each release.


## Server runtime, CLI, logging, prompts and skills

Sources: `src/index.ts`, `src/server.ts`, `src/skills.ts`, `src/log.ts`, `src/cli/terminal.ts`, `src/config.ts`, `src/tools/common.ts`, `scripts/build-mcpb.ts`, `test/smoke.test.ts`, `test/server.test.ts`, `test/log.test.ts`, `test/skills.test.ts`, `test/preload.ts`, `bunfig.toml`, `package.json`, git log.

### Build and entry point

- Entry is `src/index.ts` (shebang `#!/usr/bin/env bun`). The only runtime deps are `@modelcontextprotocol/server@2.4.0` and `zod@^4.2.0`. Tool schemas import `zod/v4`.
- `VERSION` comes from `package.json` `version` and is inlined into compiled binaries. `bun run release` bumps it.
- Binary build: `bun build src/index.ts --compile --minify --no-compile-autoload-dotenv --no-compile-autoload-bunfig --outfile dist/whoop-mcp`. The `.mcpb` build adds `--target=bun-<target>`. It ships arm64 and x64 binaries plus a `/bin/sh` launcher `server/launch.sh`.
- The `.mcpb` manifest (`scripts/build-mcpb.ts`):
  - `name: whoop-mcp` stays fixed, because changing it gives the extension a new ID and installs it next to the old one.
  - `display_name: "WHOOP (unofficial)"`.
  - `compatibility.platforms: ["darwin"]`.
  - `mcp_config.env = { WHOOP_MCP_INSTALL_SKILLS: "${user_config.claude_code_commands}" }`.
  - `prompts` is built from `PROMPTS` (name, description, text), with `prompts_generated: false` and `tools_generated: false`.
- `user_config.claude_code_commands`:
  - `type: boolean`, `default: true`, `required: false`, title "Add /whoop- commands to Claude Code".
  - Description: "Adds /whoop-connect, /whoop-disconnect and /whoop-status to the / menu in Claude Code, including Desktop's Code tab, as skills in ~/.claude/skills. Turning it off removes them the next time the extension starts. Uninstalling doesn't remove them: delete the whoop-* folders in ~/.claude/skills."

### CLI

Parsing: `command = argv[2] ?? "serve"`. The remaining args are checked by plain `includes(flag)`, so position does not matter. All human output goes to **stderr** (`console.error`). The single exception is `version`, which writes to stdout via `console.log`.

| Command                      | Flags                                                                                                                                                   | Behaviour                                                                                                                                                                                           | Exit code                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `serve` (default)            | none                                                                                                                                                    | Runs the MCP server over stdio (see the lifecycle below).                                                                                                                                           | 0 on a clean disconnect; 1 on an uncaught exception |
| `version`, `--version`, `-v` | none                                                                                                                                                    | Prints `VERSION` to stdout.                                                                                                                                                                         | 0                                                   |
| `setup`                      | `--no-browser` (print URLs instead of opening them), `--no-login` (only save the credentials), `--skip-verify` (don't check the credentials with WHOOP) | `runSetup(terminalIO(), {openBrowser, verify, login, redirectUri: WHOOP_REDIRECT_URI trimmed or undefined})`                                                                                        | 0, or 1 on error                                    |
| `login`                      | `--no-browser`                                                                                                                                          | Resolves the app credentials. A `ConfigError` becomes the error "No WHOOP app credentials yet: run \`whoop-mcp setup\` first." Then runs `loginAndSave(creds, print, {openBrowser})`.               | 0 or 1                                              |
| `status`                     | none                                                                                                                                                    | Prints the lines shown after this table.                                                                                                                                                            | 1 when not logged in, else 0                        |
| `logout`                     | `--keep-app`; `--forget-app` is still accepted as a no-op alias (it was the old opt-in; deleting is now the default)                                    | Any other arg prints `Unknown option <args joined ", ">. Usage: logout [--keep-app]` and deletes **nothing** (tests cover `keep-app`, `--keepapp` and `--keep_app`). Full sequence after the table. | 0, or **2** on an unknown option                    |
| `help`, `--help`, `-h`       | none                                                                                                                                                    | Prints USAGE.                                                                                                                                                                                       | 0                                                   |
| anything else                | none                                                                                                                                                    | Prints USAGE.                                                                                                                                                                                       | **2**                                               |

`status` output:
- `App credentials: environment variables|keychain|file`, or `not set up (run \`whoop-mcp setup\`)`.
- If there are no tokens: `Not logged in.`
- Otherwise: `Logged in. Access token expires in N min` (or `expired N min ago`)`; refresh token present|MISSING; scopes: <scope or (unknown)>`.

`logout` sequence:
1. If tokens exist, call `WhoopClient().revokeAccess()` and print "Revoked access at WHOOP." or "Couldn't revoke access at WHOOP; deleting the login anyway."
2. Call `deleteTokens()` and print `Deleted <tokenPath>.`
3. Unless `--keep-app` is given, call `deleteStoredCredentials()` and print one of:
   - "Deleted saved app credentials."
   - "Couldn't delete the app credentials from the keychain; remove the 'whoop-mcp' item in Keychain Access."
   - "No saved app credentials."

USAGE text (verbatim):
```
whoop-mcp v${VERSION}

Usage: whoop-mcp <command>

  serve                 Run the MCP server over stdio (default)
  setup                 Save your WHOOP app credentials, then log in with the browser
      --no-browser        Print URLs instead of opening them
      --no-login          Only save the credentials
      --skip-verify       Don't check the credentials with WHOOP before saving
  login [--no-browser]  Log in with the browser using the saved credentials
  status                Show credential and login state
  logout [--keep-app]   Revoke access and delete the saved login and app credentials
                        (--keep-app keeps the app credentials)
  version               Print the version
```

Top-level error handling: `main().catch` prints `err.message` (or the raw value) to stderr and calls `process.exit(1)`.

### Terminal IO (`src/cli/terminal.ts`)

- `PromptIO` has these members:
  - `print(text)`: writes to stderr.
  - `ask(question)`: writes the question to stderr, reads one line from `console[Symbol.asyncIterator]()` and trims it. EOF throws "Input ended before setup finished."
  - `askSecret(question)`: hides input with `stty -echo` (spawned with `stdin: "inherit"`), then writes a newline to stderr. `stty echo` is restored in a `finally` block. A temporary SIGINT handler restores echo and exits **130**. When stdin is not a TTY, or on win32 (no stty), it falls back to plain `ask` with the input visible.
  - `openUrl(url)`.
- `openUrl` uses `open` on darwin, `explorer` on win32 and `xdg-open` elsewhere, spawned with stdout and stderr ignored. It is best effort, because the URL is always printed as well. On a spawn failure it logs a warn "could not open a browser" with `url = origin + pathname` only. The query is left out because it carries a one-time token.

### Serve lifecycle (`src/index.ts`)

1. `log.configure({...process.env, WHOOP_MCP_LOG_STDERR_LEVEL: env value ?? "warn"})`. Claude Desktop already copies stderr into its own log, so stderr is kept to problems and the details go to our file.
2. Log info `starting` with `version`, `pid`, `platform` (`${platform}-${arch}`), `bun` (Bun.version), `log_level` and `log_file` (the path, or `"off"`).
3. Install process handlers:
   - `uncaughtException`: log error "uncaught exception" with `errorFields` plus `stack`, then `process.exit(1)`.
   - `unhandledRejection`: log error "unhandled rejection". The process does **not** exit.
   - `once("exit")`: log info `exited exit_code=<n>`.
4. Create **one** `BackgroundLogin` and **one** `WhoopClient` per process. They are shared by every protocol-era server instance so token refreshes stay single-flight. Call `serveStdio(() => createServer(client, loginFlow), { onerror: err => log.warn("transport error", errorFields(err)) })`. The SDK factory serves both the modern (`2026-07-28`, `server/discover`) and legacy (`2025-11-25`, `initialize`) protocol eras, and smoke tests cover both.
5. Run `void syncSkills()`, which never throws.
6. Shutdown is a single idempotent `stopper`:
   - Triggers: `stdin` `end` or `close` (reason `"stdin closed"`), and `SIGTERM`, `SIGINT` or `SIGHUP` (the reason is the signal name).
   - On the first trigger it logs info `client disconnected reason=<r>`. It arms an `unref`'d `setTimeout(exit(0), SHUTDOWN_GRACE_MS = 1500)` and runs `Promise.allSettled([loginFlow.cancel(), client.drain()])`, then `exit(0)`.
   - Later triggers are ignored. A SIGTERM during the wait joins the first shutdown instead of cutting it short.
   - Why 1500 ms: it stays under the roughly 2 s Claude gives between EOF and SIGTERM. A token refresh in flight must get to save, because WHOOP has already spent the old refresh token.
   - Why exit explicitly: the login page server (port 8787), timers or keep-alive sockets could otherwise keep the process alive after Claude is gone.

- The smoke test checks four things: exit code 0 within 5 s after stdin ends; the log contains `INFO  starting`, `tool whoop_status ok` and `client disconnected`; the file mode is 0600; stderr contains no `INFO` line.

### Logging (`src/log.ts`)

- Nothing is ever written to stdout, which belongs to the MCP stdio transport.
- Line format: `<ISO timestamp> <LEVEL padded to 5> <message> k=v k=v`, for example `2026-10-28T18:40:12.345Z INFO  whoop request path=/v2/cycle status=200 ms=41`.
  - Fields whose value is `undefined` are dropped.
  - A string matching `^[\w.:/@+?=&%~,#-]+$` is written bare; any other string is JSON-quoted.
  - An `Error` is written as its JSON-quoted message. Other values are `JSON.stringify`'d, falling back to `String()`.
  - Newlines (`\r?\n`) become a literal `\n`, so each event stays on one line.
  - The whole line passes through `redact`.
- Stderr copies are prefixed `[whoop-mcp] `.
- Levels: `debug` (10), `info` (20), `warn` (30), `error` (40). Unknown values fall back to the default.
- Default file location:
  - With `WHOOP_MCP_HOME` set: `$WHOOP_MCP_HOME/logs/whoop-mcp.log`.
  - darwin: `~/Library/Logs/whoop-mcp/whoop-mcp.log`.
  - win32: `%LOCALAPPDATA%` (or `~/AppData/Local`) + `\whoop-mcp\Logs\whoop-mcp.log`.
  - Otherwise: `$XDG_STATE_HOME` (or `~/.local/state`) + `/whoop-mcp/whoop-mcp.log`.
- `WHOOP_MCP_LOG_FILE` is trimmed. Any case of `off` disables the file; any other non-empty value is used as the path.
- Permissions: on the first write the directory is created (`mkdir -p`, mode 0700) and the file is appended with mode 0600 and then `chmod`'d to 0600.
- Rotation: the size is checked on the first write and then every 200 writes. At 5 MiB or more:
  1. Delete `.3`.
  2. Rename `.2` → `.3` and `.1` → `.2`, ignoring missing generations.
  3. Rename the current file → `.1`. If that fails because another process sharing the file rotated it first, appending recreates the file.
  - Three old generations are kept.
- Failure handling: if the file can't be written, file logging switches off for the process. One stderr line is printed: `could not write the log file <path>: <msg>`. After that `settings().file` returns null. Logging never throws.
- `log.configure(env)` re-reads all settings and resets the write counter and the failure flag. `log.settings()` returns `{level, file}`. `errorFields(err)` returns `{error: message, kind: name}`, plus `stack` only at debug level. A non-Error becomes `{error: String(err)}`.
- `redact` patterns (case-insensitive):
  - `Bearer <token>` becomes `Bearer [redacted]`.
  - The values of `access_token`, `refresh_token`, `id_token`, `client_secret`, `code`, `code_verifier` and `token` are redacted after `:` or `=`. Optional quotes, including escaped `\"` (JSON encoded twice), are allowed. A value stops at `"`, `\`, `&`, whitespace, `,` or `}`.
  - Word boundaries keep `exit_code=0` and `next_token=abc` unredacted.
- What is logged: startup and shutdown, every tool call, every WHOOP API request (path, status, duration, trace id), token refreshes, login steps, the prompts that are fetched, skill changes, and `client connected` with `client`, `client_version` and `capabilities`. Client capabilities are logged to see whether richer UI (MCP Apps, URL elicitation) would work.
- What is **never** logged: tokens, secrets, authorization codes, and WHOOP health data or response bodies, which WHOOP's terms don't allow us to keep. `redact` is the last line of defence for the first three.
- Claude Desktop's own copy of stderr is at `~/Library/Logs/Claude/mcp-server-WHOOP (unofficial).log`. It mixes in protocol traffic and Desktop truncates it.

### createServer and instrumentation (`src/server.ts`)

- `new McpServer({name: "whoop-mcp", version: VERSION}, {instructions: INSTRUCTIONS})`. **Do not** pass `capabilities: {tools: {}}`. It makes the SDK install its `tools/call` handler in the constructor, before `instrumentTools` can wrap it. The first `registerTool` declares the capability instead.
- `oninitialized` logs `client connected`.
- `instrumentTools` monkey-patches `server.server.setRequestHandler`. It wraps only the `tools/call` handler, so calls the SDK rejects for bad arguments or an output-schema mismatch are logged too. Logged outcomes:
  - OK: info `tool <name> ok ms=<n> args=<json>`.
  - `isError` result: warn `tool <name> error ms args error=<first 300 chars of content[0].text>`.
  - Throws: error `tool <name> failed ms args …errorFields`, then rethrows.
  - The result is never logged, because it is WHOOP data. The arguments are only dates, ranges, metric names and flags.
- Registration order: `whoop_status`, `whoop_login`, `whoop_disconnect`, `whoop_profile`, then `registerDataTools`, then `registerPrompts`.
- Helpers:
  - `jsonResult(data, summary)` returns text `summary + "\n\n" + compact JSON` plus `structuredContent`. Compact because indentation adds about half again to every result.
  - `errorResult(err)` returns `{isError: true, text: message}`.
  - `textResult(text, data)` returns plain text plus `structuredContent`.
  - `READ_ONLY = {readOnlyHint: true, idempotentHint: true, openWorldHint: true}`.
  - `DISCLAIMER = "Not medical advice."`.
  - `LOGIN_WAIT_SECONDS = 40`, which keeps each call under Claude's roughly 60 s tool-call limit.

#### INSTRUCTIONS (server instructions, verbatim)

```
WHOOP data for the user's own account: recovery, HRV, resting heart rate, sleep, strain, steps and workouts.
Useful for planning and reviewing the user's training:
- "How am I today?", readiness, whether to train hard: whoop_today.
- Weekly check-ins and patterns: whoop_daily_summaries, whoop_compare_periods.
- Programming, deloads, overreaching: whoop_training_load (acute:chronic strain), whoop_trends, whoop_baselines.
- Sleep: whoop_sleep. Training history: whoop_workouts. What drives what: whoop_correlate.
Judge numbers against the user's own baselines (whoop_baselines, or vs_last_30_days in whoop_today) rather than population norms, and say when data is missing, pending or calibrating. A baseline needs 7+ days (baseline_days); with fewer, say it is still forming. Dates before data_quality.first_data_date have no WHOOP data at all (usually the account is newer than the range), so don't read them as missed wear or rest days. Dates are the user's local dates; a WHOOP day runs from sleep to sleep, not midnight to midnight.
WHOOP heart-rate zones are % of heart-rate reserve (resting HR + pct x (max HR - resting HR)), not % of max HR.
Present suggestions as options for the user to choose. This is not medical advice: suggest a professional for symptoms, injuries or anything clinical.
If a tool says WHOOP isn't connected, it has already opened the connection page: tell the user in one sentence, call whoop_login with wait_seconds until it reports connected, then carry on with their request. Never ask the user to say when they're done.
```

#### `whoop_status`

- Title "WHOOP connection status".
- Annotations: `READ_ONLY` with `openWorldHint: false`. It makes no WHOOP API calls.
- Description: "Check whether the WHOOP account is connected: app credentials, login state (including a browser login started with whoop_login), granted scopes, token expiry and where the server's log file is. Makes no WHOOP API calls. Use this first if other whoop_ tools fail."
- No input. Output schema:

| Field                       | Type / meaning                                                                                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `logged_in`                 | bool: tokens exist and the session is not expired                                                                                                                 |
| `session_expired`           | bool, from `client.authProblem(tokens)`                                                                                                                           |
| `last_error`                | string or null: last refresh failure                                                                                                                              |
| `app_credentials`           | `env` \| `keychain` \| `file` \| `missing`                                                                                                                        |
| `login`                     | `{state: idle\|pending\|succeeded\|failed, kind?: setup\|login, authorize_url?, error?}`. `kind` and `authorize_url` only while pending; `error` only when failed |
| `token_file`                | `tokenPath()` (`<configDir>/tokens.json`)                                                                                                                         |
| `log_file`                  | string or null                                                                                                                                                    |
| `scopes`                    | granted scopes (split on whitespace)                                                                                                                              |
| `missing_scopes`            | `SCOPES` minus granted; all `SCOPES` when there are no tokens                                                                                                     |
| `access_token_expires_in_s` | number or null                                                                                                                                                    |
| `has_refresh_token`         | bool                                                                                                                                                              |
| `server_version`            | `VERSION`                                                                                                                                                         |
- The summary is the first match in this order:
  1. Pending setup: "Waiting for the user to finish the setup page in the browser (<url>). Call whoop_login with wait_seconds to wait for it."
  2. Pending login: "Waiting for the user to approve access in the browser (<url>). …"
  3. Session expired: "The WHOOP session has expired or was revoked. Call whoop_login to reconnect."
  4. Logged in, credentials missing: "Logged in, but the WHOOP app credentials are gone, so the next token refresh will fail. Call whoop_login with reconfigure: true to enter them again."
  5. Logged in, `last_error` set: "Logged in, but the last token refresh failed: <err>"
  6. Logged in, scopes missing: "Connected, but without <list>, so some tools will fail. Call whoop_login and approve every permission."
  7. Logged in, otherwise: "WHOOP is connected."
  8. Login failed: "The last login failed (<err>). Call whoop_login to try again, or with reconfigure: true to enter different WHOOP app credentials."
  9. No credentials: "No WHOOP app credentials yet: call whoop_login, which opens a setup page in the browser to enter them."
  10. Otherwise: "Not logged in: call whoop_login to sign in with the browser."
- Tokens never appear in the result (tested).

#### `whoop_login`

- Title "Connect WHOOP".
- Annotations: `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true`.
- Description: "Connect the user's WHOOP account: opens a setup or approval page in their browser and waits for them to finish. Returns at once if WHOOP is already connected. While the result says pending, call it again with wait_seconds (it never reopens the page); never ask the user to tell you when they're done. The first time, the page walks the user through creating a free WHOOP developer app and pasting its Client ID and Secret. Use reconfigure: true only when the saved app is wrong (WHOOP rejected the client or the redirect URL) or the user wants a different app."

| Param          | Type | Default | Limits / description                                                                         |
| -------------- | ---- | ------- | -------------------------------------------------------------------------------------------- |
| `wait_seconds` | int  | 40      | 0–45. "Wait up to this many seconds for the user to finish in the browser before returning." |
| `reconfigure`  | bool | false   | "Open the setup page to enter different WHOOP app credentials, even if some are saved."      |
- Logic:
  1. If not `reconfigure`, no login is pending and `isConnected`, return "WHOOP is connected. Carry on with the user's request now (call the WHOOP tool you need)." with `{state: "connected"}`.
  2. `isConnected` requires all of: tokens exist; app credentials are not missing; the session is not expired; every scope in `SCOPES` is granted; and either a refresh token exists or the access token has not expired.
  3. Otherwise call `loginFlow.start({reconfigure})`, then `waitForChange(wait_seconds*1000, request abort signal)`.
  4. `seenProblems` is the previous `problemSeq` when a login was already pending, so a problem is passed on once and not repeated on every call.
  5. Exceptions become `errorResult`.
- Result texts. `again` = "call whoop_login again right away with wait_seconds=40 (no reconfigure)".

| State                                      | Text                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | structuredContent             |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| succeeded                                  | "WHOOP is connected. Carry on with the user's original request now (call the WHOOP tool again); don't ask them anything first."                                                                                                                                                                                                                                                                                                                                                                                       | `{state: "connected", scope}` |
| failed                                     | "The WHOOP connection failed: <error, first 300 chars> Tell the user in one sentence." Then, if the error matches `/client\|credential\|redirect/i`: "If the app's details look wrong, call whoop_login with reconfigure: true to enter them again."; otherwise "Then call whoop_login to try again if they want."                                                                                                                                                                                                    | `{state: "failed", error}`    |
| idle                                       | "The WHOOP connection was cancelled."                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `{state: "idle"}`             |
| pending, new problem (`problemSeq > seen`) | "The WHOOP page in the user's browser is showing a problem: \"<problem, 300 chars>\" The page offers Try again. Tell the user that in one or two sentences, then <again>."                                                                                                                                                                                                                                                                                                                                            | pending data                  |
| pending, first call                        | "Opened a WHOOP setup page" (or "WHOOP's approval page") " in the user's browser (if it didn't open, they can visit <url>). Tell the user in one sentence, e.g. \"<say>\" Don't repeat the page's steps. Then <again>, and keep calling it while it says pending." `say` for setup: "I've opened a page in your browser to connect WHOOP; it takes about 5 minutes the first time, and I'll carry on when you're done." `say` for login: "I've opened WHOOP in your browser; approve access there and I'll carry on." | pending data                  |
| pending, 15 min or more                    | "The user has been on the WHOOP page for N minutes. Stop calling whoop_login for now and ask them whether they're still connecting WHOOP or need help; call it again when they reply. The page stays open a while longer."                                                                                                                                                                                                                                                                                            | pending data                  |
| pending, otherwise                         | "Still waiting for the user (N min, <step>). <Again, capitalised>. Say nothing to the user meanwhile."                                                                                                                                                                                                                                                                                                                                                                                                                | pending data                  |
- Pending data: `{state: "pending", kind, url, progress?, problem?}`.
- `step` values:
  - The page shows a problem: "the page is showing them a problem to fix".
  - Progress is `form` or undefined: "creating the WHOOP app" (setup) or "approving access" (login).
  - Progress is `verifying`: "checking the app's codes".
  - Anything else: "approving access in WHOOP".

#### `whoop_disconnect`

- Title "Disconnect WHOOP".
- Annotations: `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true`, `openWorldHint: true`.
- Description: "Disconnect the user's WHOOP account: revokes whoop-mcp's access at WHOOP and deletes the saved login on this computer. Only when the user asks to disconnect, log out or remove WHOOP access. Also deletes the saved WHOOP app Client ID and Secret, so connecting again starts with the setup page (the app still exists in the WHOOP developer dashboard; the user copies its Client ID and Secret again). Pass keep_app only when the user asks to keep the app details. Asking about WHOOP data afterwards opens the connection page again."
- Input: `keep_app`, bool, default false: "Keep the saved WHOOP app credentials (Client ID and Secret), so reconnecting skips the setup page."
- Order:
  1. `loginFlow.cancel()`.
  2. `client.drain()`, so a refresh in flight saves before the delete.
  3. If tokens exist, `revokeAccess()`. Otherwise the result is `not_logged_in`.
  4. `withTokenLock(deleteTokens)`.
  5. Unless `keep_app`, `deleteStoredCredentials()`, followed by `loginFlow.forgetApp()` (forgets the pre-filled Client ID).
  6. Re-resolve the credential source, because env vars still win.
  7. Log info `disconnected from WHOOP had_login revoked app_credentials`.
- Text is two sentences.
- First sentence:
  - "WHOOP wasn't connected."
  - "Disconnected from WHOOP: access was revoked at WHOOP and the saved login deleted."
  - "Deleted the saved WHOOP login, but couldn't revoke access at WHOOP (it may already have ended). The user can also remove the app's access in the WHOOP developer dashboard."
- Second sentence:
  - Kept, source missing: "There were no saved WHOOP app credentials to keep, so connecting again starts with the setup page."
  - Kept: "The WHOOP app credentials were kept, so reconnecting goes straight to WHOOP's approval page."
  - Delete failed: "The saved WHOOP app credentials couldn't be removed from the keychain; the user can delete the 'whoop-mcp' item in Keychain Access."
  - Source env: "The WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET environment variables are still set, so connecting again uses them."
  - Deleted: "The saved WHOOP app credentials were deleted too, so connecting again starts with the setup page."
  - Otherwise: "There were no saved app credentials to delete."
- structuredContent: `{disconnected: true, revoked_at_whoop, app_credentials_deleted, app_credentials_delete_failed?: true}`.

#### `whoop_profile`

- Title "WHOOP profile". Annotations: `READ_ONLY`.
- Description: "Get the WHOOP member's name and body measurements (height, weight, max heart rate)."
- Input: `include_email`, bool, default false: "Include the account email address."
- Calls in parallel: `GET /v2/user/profile/basic` and `GET /v2/user/measurement/body`.
- Output:
  - `name`: `first + " " + last`, trimmed.
  - `email?`: only when `include_email`.
  - `height_cm`: `round(m*1000)/10`, i.e. 1 decimal (millimetre).
  - `weight_kg`: 1 decimal.
  - `max_heart_rate_bpm`.
  - `note: "Not medical advice."`.
- Summary: `Profile for <name>.`
- Errors go through `toolError`. `NotLoggedInError` and `ConfigError` start a login on their own (`notConnectedResult`); anything else becomes `errorResult`.

### MCP prompts (`PROMPTS` in `src/server.ts`)

- No arguments. Claude Desktop asks for arguments in a form before attaching a prompt, so there are none.
- Getting a prompt has no side effects. It only asks Claude to call the tool, so the user still sees, and can stop, the tool call.
- Each returns one `user` text message and logs info `prompt <name>`.
- Desktop lists the prompts under + → "Add from WHOOP (unofficial)". Its / menu doesn't show them (as of 4.29).

| name               | title            | description                                                                   | tool             | text                                                                                                                                                                                                     |
| ------------------ | ---------------- | ----------------------------------------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `whoop-connect`    | Connect WHOOP    | Connect your WHOOP account in the browser.                                    | whoop_login      | Connect my WHOOP account: call whoop_login, and while it says pending keep calling it with wait_seconds as it tells you, until it reports connected or failed. Then tell me the outcome in one sentence. |
| `whoop-disconnect` | Disconnect WHOOP | Disconnect your WHOOP account and delete the saved login and app credentials. | whoop_disconnect | Disconnect my WHOOP account: call whoop_disconnect, then tell me the outcome in one sentence.                                                                                                            |
| `whoop-status`     | WHOOP status     | Check whether your WHOOP account is connected.                                | whoop_status     | Check my WHOOP connection: call whoop_status, then tell me in one sentence whether it's connected, and if it isn't, what to do next.                                                                     |

Tests require:
- each text contains its tool's name;
- the disconnect text does **not** mention `keep_app`;
- every prompt's tool exists on the server.

### Claude Code skills (`src/skills.ts`)

- Purpose: put `/whoop-connect`, `/whoop-disconnect` and `/whoop-status` into the / menu of Claude Code, including Desktop's Code tab. A `.mcpb` can only carry tools and prompts, so this is the only way to add commands there.
- Location: `$CLAUDE_CONFIG_DIR/skills` (trimmed), else `~/.claude/skills`. Each skill lives at `<root>/<name>/SKILL.md`.
- Setting: `WHOOP_MCP_INSTALL_SKILLS`, trimmed.
  - Unset or blank: `undefined`, meaning not run as the extension. Nothing is touched and `syncSkills` returns null.
  - `false` in any case: remove the skills.
  - Anything else, including an unexpanded `${user_config.claude_code_commands}` placeholder: install them (on by default).
- `MARKER = "<!-- Installed by the WHOOP (unofficial) Claude Desktop extension (whoop-mcp). -->"`.
- SKILL.md content, one file per prompt and in the same order:
```
---
name: <name>
description: <description>
disable-model-invocation: true
---

<MARKER>

<prompt text>

The tool comes from the WHOOP (unofficial) extension; in this session its name may carry a prefix, such as mcp__WHOOP__unofficial___<tool>. If there is no whoop_ tool in this session, the WHOOP (unofficial) extension isn't running here: tell the user to check it's installed and turned on under Claude Desktop's Settings → Extensions, then start a new session. Don't try anything else.
```

- Ownership rules. A folder is "ours" when:
  - its SKILL.md contains MARKER; or
  - it has no SKILL.md and contains only temp files matching `^\.SKILL\.md\.\d+\.tmp$`, which includes an empty folder.
- A folder that doesn't exist counts as `absent`. Anything else counts as not ours and is never changed or removed. This covers a user's own same-named skill and a folder holding other files.
- A read error (other than ENOENT) throws, the skill is reported as `failed`, and nothing is touched.
- Install:
  - Not ours: report `not ours`.
  - Ours with identical content: `unchanged`, and the mtime is preserved.
  - Otherwise:
    1. `mkdir -p`.
    2. Write `.SKILL.md.<pid>.tmp`.
    3. `chmod 0644`, whatever the umask: it's documentation, not a secret.
    4. Rename it into place, so Claude Code never reads half a file. If anything fails, the temp file is deleted.
    5. Delete any leftover temp files in the folder.
    6. Report `installed` (the folder was absent) or `updated`.
- Uninstall: `absent`; `not ours`; or `rm -rf` the folder and report `removed`.
- `syncSkills`:
  - Handles each skill independently and returns `Record<name, installed|updated|unchanged|removed|not ours|absent|failed>`.
  - A failure logs warn "couldn't update a Claude Code skill" with `skill` and `errorFields`.
  - It never throws, because the tools work without the skills.
  - It logs info `Claude Code skills dir=<root> <name>=<change>…` only when some result is neither `unchanged` nor `absent`.
- Desktop has no uninstall hook, so uninstalling leaves the skills behind. The skills' own text covers the case where the tools are missing.
- The repo-only developer skill `.claude/skills/whoop-reset` (not shipped) also removes these skills, in both `~/.claude` and `CLAUDE_CONFIG_DIR`.

### Environment variables (whole project)

| Var                                      | Used in                         | Meaning                                                                                                |
| ---------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `WHOOP_CLIENT_ID`, `WHOOP_CLIENT_SECRET` | `src/config.ts`                 | Dev app credentials. Both are needed. Trimmed; blank counts as unset. They win over keychain and file. |
| `WHOOP_REDIRECT_URI`                     | config, index, background-login | Default`http://localhost:8787/callback`.                                                               |
| `WHOOP_MCP_HOME`                         | config, log                     | Overrides the config dir (tokens.json, client.json) and puts logs at `$HOME/logs/whoop-mcp.log`.       |
| `XDG_CONFIG_HOME`                        | config                          | Config dir `$XDG_CONFIG_HOME/whoop-mcp`, else `~/.config/whoop-mcp`. Blank counts as unset.            |
| `XDG_STATE_HOME`, `LOCALAPPDATA`         | log                             | Default log dir on Linux and on Windows.                                                               |
| `WHOOP_MCP_LOG_LEVEL`                    | log                             | debug \| info (default) \| warn \| error.                                                              |
| `WHOOP_MCP_LOG_FILE`                     | log                             | A path, or `off`.                                                                                      |
| `WHOOP_MCP_LOG_STDERR_LEVEL`             | log, index                      | Lowest level copied to stderr. The default equals the file level; `serve` defaults it to `warn`.       |
| `WHOOP_MCP_CREDENTIAL_STORE`             | auth/credentials                | `file` forces the 0600 file store and skips the keychain (tests, headless Linux).                      |
| `WHOOP_MCP_NO_BROWSER`                   | auth/background-login           | `1`: pages are announced but not opened.                                                               |
| `WHOOP_MCP_INSTALL_SKILLS`               | skills                          | Set by the extension from `claude_code_commands`.                                                      |
| `CLAUDE_CONFIG_DIR`                      | skills                          | Root of the Claude Code skills dir.                                                                    |
| `WHOOP_MCP_BINARY`                       | test/smoke                      | Path of a compiled binary to smoke-test.                                                               |
| `CI`                                     | scripts/build-mcpb              | Makes build warnings fatal.                                                                            |

### Test harness rules (`test/preload.ts`, via `bunfig.toml` `[test] preload`)

The preload sets:
- `TZ=UTC`.
- `WHOOP_MCP_CREDENTIAL_STORE=file`, keeping the suite off the real keychain, where an access prompt once hung the stdio tests.
- `WHOOP_MCP_LOG_FILE ??= off`.
- `WHOOP_MCP_LOG_LEVEL=info`.

It deletes `WHOOP_MCP_LOG_STDERR_LEVEL`, `WHOOP_CLIENT_ID`, `WHOOP_CLIENT_SECRET` and `WHOOP_REDIRECT_URI`, so the tests don't take the real login path or bind port 8787. It also sets `WHOOP_MCP_NO_BROWSER=1`.

Stdio smoke tests add `WHOOP_MCP_HOME=<tmp>` and a free-port `WHOOP_REDIRECT_URI` on `127.0.0.1`. Every test is offline.

### Corrections and additions

Found when this part was checked against the code. Where they differ from the text above, these are right.

**`WHOOP_MCP_HOME` and the config directory (corrections)** (src/config.ts, src/log.ts, src/auth/store.ts, test/config.test.ts)
- `configDir()` uses `if (env.WHOOP_MCP_HOME) return env.WHOOP_MCP_HOME`, a truthiness check.
  - An **empty** value counts as unset and falls back to `$XDG_CONFIG_HOME/whoop-mcp` or `~/.config/whoop-mcp` (test: "treats an empty WHOOP_MCP_HOME as unset").
  - The value is **not trimmed**, so whitespace only is used as a path.
  - An empty `XDG_CONFIG_HOME` also counts as unset (`||`).
- `defaultLogFile()` uses the same truthiness check: `$WHOOP_MCP_HOME/logs/whoop-mcp.log`, else per platform (`~/Library/Logs/whoop-mcp/whoop-mcp.log` on darwin).
- `writePrivateJson(path)` always runs `mkdir(configDir(), {recursive: true, mode: 0o700})`, not `dirname(path)`.
  - The mode applies only when the directory is newly created; an existing directory's mode is never corrected.
  - Only the file is guaranteed 0600: a unique temp file is written with mode 0600, `chmod 0600`, then `rename`.
  - "Dir is 0700" is not a guarantee.

**CLI logging defaults** (src/index.ts, src/log.ts)
- Only `serve` calls `log.configure({...env, WHOOP_MCP_LOG_STDERR_LEVEL: env.WHOOP_MCP_LOG_STDERR_LEVEL ?? "warn"})`.
  - `??` passes an **empty** value through, and `levelFromEnv("")` falls back to the file level (default `info`), not `warn`.
- `setup`, `login`, `status` and `logout` keep the default stderr level, which equals the file level (`info`). They print `<ISO time> INFO  …` lines to stderr and append to the default log file. For example, `login` logs the authorize URL (see auth).

**CLI `setup` details** (src/setup.ts, src/index.ts)
- The redirect URI is `WHOOP_REDIRECT_URI?.trim() || undefined`, then `DEFAULT_REDIRECT_URI`. Flags: `--no-browser`, `--skip-verify`, `--no-login`.
- It checks **only stored credentials** (`readStoredCredentials`, keychain then file) and ignores `WHOOP_CLIENT_ID`/`WHOOP_CLIENT_SECRET`.
- With stored credentials it asks `WHOOP app credentials are already saved (<source>, client ID …<last 4>). Replace them? [y/N] `.
  - Anything except `y`/`yes` (case-insensitive) keeps the stored ID and secret but **replaces `redirectUri`** with the CLI's value. Nothing is re-saved and the instructions are skipped.
- Otherwise it prints the instructions:
  - `whoop-mcp connects to WHOOP through your own (free) WHOOP developer app.`
  - Steps: open `https://developer-dashboard.whoop.com`, Team "name it anything", Create App.
  - Field table: `Name: anything, for example whoop-mcp`; `Logo: leave empty`; `Contacts: your own email address`; `Privacy policy: <PRIVACY_URL>`; `Redirect URLs: <uri>   (exactly this)`; `Scopes: tick every box (<scopes without offline>)`; `Webhooks: leave empty`.
  - It opens the dashboard unless `--no-browser`.
- Up to 3 attempts of `Client ID: ` and `Client Secret (hidden): `.
  - A missing value prints `Both the Client ID and Client Secret are required.`
  - When verifying: `ok:false` prints `<reason> Check for extra characters and try again.`; `ok:true` prints `Credentials verified with WHOOP.`; `unknown` prints `Could not verify credentials: <reason>. Saving anyway.`
  - After 3 failures it throws `Gave up after 3 attempts; nothing was saved.`
- Save messages: `Saved to your system keychain (service: whoop-mcp).` or `Saved to a private file in your config folder (keychain unavailable or disabled).`
- `--no-login` prints ``Skipping login. Run `whoop-mcp login` when you're ready.``
- Otherwise it prints `\nOpening WHOOP to authorize access. If WHOOP shows a redirect_uri error, make sure the app's redirect URI is exactly <uri>.` and runs `loginAndSave`.
- `loginAndSave` (also used by `whoop-mcp login`):
  - calls `login()` and then `writeTokens(toStored(tokens))` **without `withTokenLock`**;
  - prints `Logged in. Tokens saved to <tokenPath>.`;
  - its own scope warning splits an absent `scope` as `[]`, so it prints `Warning: these scopes were not granted: <all 7>`. That is the only case where it fires, because `login()` already refused real partial grants.

**WHOOP_MCP_NO_BROWSER (history correction)** (src/auth/background-login.ts, test/preload.ts, README.md, git 8040780)
- Commit 8040780 says it removed `WHOOP_MCP_NO_BROWSER`, but the variable exists today: `defaults.openBrowser = process.env.WHOOP_MCP_NO_BROWSER !== "1"`.
- It is read **once at module load**, not per call.
- Only `BackgroundLogin` honours it, so it affects the MCP tools only. The CLI uses `--no-browser` instead.
- `test/preload.ts` sets it to `"1"`, and the README documents it.

**Smoke test and stdio factory** (test/smoke.test.ts, src/index.ts)
- `serveStdio(() => createServer(client, loginFlow), …)`: `createServer` is a **factory called per protocol-era instance**.
- `WhoopClient` and `BackgroundLogin` are created once, outside it. Otherwise each era instance would get its own refresh single-flight and its own login flow on port 8787.
- The smoke test pins the modern era explicitly with `{ versionNegotiation: { mode: { pin: "2026-07-28" } } }`, because the v2 client defaults to legacy negotiation. It also tests the legacy era.


## Packaging, release, CI and dev tooling

Sources: `package.json`, `.bun-version`, `bunfig.toml`, `biome.json`, `tsconfig.json`, `.gitignore`, `.env.example`, `.husky/pre-commit`, `scripts/build-mcpb.ts`, `scripts/release.ts`, `scripts/update-spec.ts`, `.github/workflows/{ci,bundle,release}.yml`, `test/{preload,mcpb,release,smoke,bun-skill,whoop-reset-skill}.test.ts`, `.claude/skills/{bun,whoop-reset}/**`, `src/skills.ts`, `src/server.ts` (PROMPTS), `src/config.ts`, `README.md`, `CHANGELOG.md`, `docs/roadmap.md`, git log.

### Toolchain and project config

| Item           | Value                                                                                                                                                                                                                                                                                                                                                                        |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime        | Bun, pinned by `.bun-version` = `1.4.4`. CI reads it through `setup-bun`'s `bun-version-file`. README says "Bun 1.4+".                                                                                                                                                                                                                                                       |
| Module type    | `"type": "module"`, `"private": true`, `name` `whoop-mcp`, `version` `0.7.0`                                                                                                                                                                                                                                                                                                 |
| Runtime deps   | `@modelcontextprotocol/server` `2.4.0` (exact), `zod` `^4.2.0`, plus `overrides.zod` `^4.2.0` so the SDK uses the same zod                                                                                                                                                                                                                                                   |
| Dev deps       | `@anthropic-ai/mcpb` `2.1.2` (exact; its CLI is called at `node_modules/.bin/mcpb`), `@biomejs/biome` `2.6.3`, `@modelcontextprotocol/client` `2.4.0`, `@types/bun` `^1.4.4`, `husky` `9.1.7`, `typescript` `^7.0.2`                                                                                                                                                         |
| Version source | `src/config.ts` imports `package.json` (`with { type: "json" }`) and exports `VERSION`. It is inlined into compiled binaries. `release` bumps only package.json.                                                                                                                                                                                                             |
| tsconfig       | `lib/target ESNext`, `module Preserve`, `moduleResolution bundler`, `moduleDetection force`, `allowImportingTsExtensions`, `resolveJsonModule`, `verbatimModuleSyntax`, `noEmit`, `strict`, `skipLibCheck`, `noUncheckedIndexedAccess`, `noFallthroughCasesInSwitch`, `noImplicitOverride`, `types: ["bun"]`. Includes `src`, `scripts`, `test`, `.claude/skills/*/scripts`. |
| Biome          | VCS-aware (git, respects ignore file). Ignores `dist`, `src/whoop/openapi.d.ts` and `**/SKILL.md`, because Biome's Markdown formatting broke SKILL.md front matter (commit 62cc751). Formatting: spaces, indent 2, line width 120, double quotes. Linter preset `recommended` with `style.noNonNullAssertion` off. `organizeImports` on.                                     |
| `.gitignore`   | `node_modules/`, `dist/`, `.env`, `.env.*` (except `!.env.example`), `docs/m0-results.json`, `*.log`, `.DS_Store`, `*.bun-build` (temp files `bun build --compile` can leave in the repo root; about 87 MB each), and `src/whoop/openapi.d.ts` (generated)                                                                                                                   |
| `.env.example` | `WHOOP_CLIENT_ID=`, `WHOOP_CLIENT_SECRET=`, `WHOOP_REDIRECT_URI=http://localhost:8787/callback` (must exactly match the app's registered redirect), optional `WHOOP_MCP_HOME` (default `~/.config/whoop-mcp`)                                                                                                                                                                |

### package.json scripts

| Script            | Command / effect                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start`           | `bun run src/index.ts` (stdio server; default command `serve`)                                                                                                                                                                                                                                                                                                                                     |
| `test`            | `bun test`                                                                                                                                                                                                                                                                                                                                                                                         |
| `typecheck`       | `tsc --noEmit`                                                                                                                                                                                                                                                                                                                                                                                     |
| `lint` / `format` | `biome check .` / `biome check --write .`                                                                                                                                                                                                                                                                                                                                                          |
| `spec:update`     | `scripts/update-spec.ts`. Fetches `https://api.prod.whoop.com/developer/doc/openapi.json`, drops every path containing `/partner/`, sorts only name-keyed maps (`paths`, `schemas`, `properties`, `responses`) because WHOOP returns them in varying order, writes `openapi/whoop.yaml` with a 2-line header comment, then runs `biome format --write` so an unchanged upstream spec gives no diff |
| `gen:types`       | `bunx openapi-typescript@7.13.0 openapi/whoop.yaml -o src/whoop/openapi.d.ts`                                                                                                                                                                                                                                                                                                                      |
| `inspect`         | `bunx @modelcontextprotocol/inspector bun run src/index.ts`                                                                                                                                                                                                                                                                                                                                        |
| `build`           | `bun build src/index.ts --compile --minify --no-compile-autoload-dotenv --no-compile-autoload-bunfig --outfile dist/whoop-mcp` (single binary for the host)                                                                                                                                                                                                                                        |
| `release`         | `bun run scripts/release.ts`                                                                                                                                                                                                                                                                                                                                                                       |
| `prepare`         | `husky && bun run gen:types`, so `bun install` installs hooks and generates the API types                                                                                                                                                                                                                                                                                                          |
| `build:mcpb`      | `bun run scripts/build-mcpb.ts`                                                                                                                                                                                                                                                                                                                                                                    |

Compile flags: `--no-compile-autoload-dotenv` and `--no-compile-autoload-bunfig` stop the shipped binary from picking up a `.env` or `bunfig.toml` in whatever cwd Desktop starts it in.

### Pre-commit hook (`.husky/pre-commit`)

`bunx biome check --write --staged --no-errors-on-unmatched && git update-index --again`
- Formats, lints and organizes imports on staged files. Lint errors it can't fix block the commit.
- Re-stages the files Biome changed. This stages the whole file, including unstaged hunks in it (the hook's own comment says so).
- CI and release set `HUSKY=0` so runners don't install hooks.

### Extension bundle build (`scripts/build-mcpb.ts`)

Usage: `bun run build:mcpb`, with no arguments; extra args print usage and exit 2. Output: `dist/whoop-mcp-macos.mcpb`, about 82 MB. It then prints `Built <path> (<n> MB)` to stderr.

Steps:
1. Refuses to run on `win32` (exit 1), because Windows zips carry no Unix file modes.
2. Sets logging to `WHOOP_MCP_LOG_FILE=off`, `WHOOP_MCP_LOG_LEVEL=warn` (the build starts a server in-process and its routine log lines would clutter the output).
3. **Tool list from the server itself:** runs `createServer()` with a `Client` over `InMemoryTransport.createLinkedPair()`, calls `listTools()`, and keeps `{name, description: summary(description)}`. This means the install dialog can't drift from the code.
   - `summary(desc, max=160)`: takes the first sentence. It splits on `. ` followed by a capital letter, but not after `e.g`, `i.e`, `vs` or `etc` (regex `(?<!\b(?:e\.g|i\.e|vs|etc))\.\s+(?=[A-Z])`). It adds a trailing `.` if missing. If the result is longer than `max`, it cuts at the last word boundary and appends `…`.
4. Staging dir `dist/mcpb/macos/` (removed first): copies `assets/icon.png` to `icon.png`. For each arch in `arm64`, `x64`:
   - compile: `bun build src/index.ts --compile --minify --no-compile-autoload-dotenv --no-compile-autoload-bunfig --target=bun-darwin-<arch> --outfile server/whoop-mcp-darwin-<arch>`, then `chmod 755`.
   - **ad-hoc sign** (darwin only): `codesign --force --sign - <bin>` then `codesign --verify`. Bun signs native builds ad hoc, but cross-compiled ones may not be signed, and Apple Silicon won't run unsigned code.
   - **minimum-macOS check** (darwin only): reads `minos N` from `otool -l`. If N > 13 (`MAX_MACOS_MINIMUM`), it throws when `CI` is set and only warns locally. Why: for the native target, `--compile` copies the running bun, and a Homebrew or self-built bun targets the host's macOS. Official bun releases target macOS 13, and release builds must not raise that minimum.
5. Writes `server/launch.sh` (mode 755), shown below.
6. Writes `manifest.json` (pretty-printed JSON plus a trailing newline), runs `mcpb validate`, then `mcpb pack <stage> <out>`.
7. **Exec-bit check:** `zipinfo <out>`. Each of `server/whoop-mcp-darwin-arm64`, `server/whoop-mcp-darwin-x64` and `server/launch.sh` must have `rwx` in columns 1–3 of its line, or the build throws. mcpb stores only the permission bits (`?rwx…`), and those are all Desktop reads. Desktop marks an extracted file executable only if its zip entry has the owner-exec bit (mcpb#294, #235).
8. Deletes the staging dir (about 300 MB).

Exports for tests: `DIRNAME`, `LAUNCH_SH`, `manifest`, `summary`.

`launch.sh` (exact behaviour):
```sh
#!/bin/sh
dir=$(cd "$(dirname "$0")" && pwd)
case "$(uname -m)" in
  arm64) bin="$dir/whoop-mcp-darwin-arm64" ;;
  *) bin="$dir/whoop-mcp-darwin-x64" ;;
esac
[ -x "$bin" ] || chmod 755 "$bin" 2>/dev/null
exec "$bin" "$@"
```

- One bundle carries both binaries because the manifest has no CPU-architecture field (mcpb#10).
- The script restores the exec bit for Desktop builds that drop it. Desktop starts it with `/bin/sh`, so the launcher's own exec bit can't block it either.

### Manifest (`manifest()` in build-mcpb.ts)

| Field                                                   | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Why                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest_version`                                      | `"0.3"`                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |                                                                                                                                                                                                                                                                                                       |
| `name`                                                  | `whoop-mcp`                                                                                                                                                                                                                                                                                                                                                                                                                                                              | **Must never change.** Desktop derives the extension ID `local.mcpb.whoop-mcp-contributors.whoop-mcp` from author plus name. A new name means a new ID, which installs next to the old extension and loses its settings. Tested.                                                                      |
| `display_name`                                          | `WHOOP (unofficial)`                                                                                                                                                                                                                                                                                                                                                                                                                                                     | So it isn't taken for WHOOP's own product (v0.5.0). Desktop's log file is therefore `~/Library/Logs/Claude/mcp-server-WHOOP (unofficial).log`.                                                                                                                                                        |
| `version`                                               | `VERSION`                                                                                                                                                                                                                                                                                                                                                                                                                                                                |                                                                                                                                                                                                                                                                                                       |
| `description`                                           | `Your WHOOP recovery, sleep, strain and workouts in Claude (read-only, unofficial).`                                                                                                                                                                                                                                                                                                                                                                                     | The test requires it to contain "unofficial".                                                                                                                                                                                                                                                         |
| `long_description`                                      | Markdown: read-only access to recovery, HRV, resting heart rate, sleep, strain, steps, workouts; example asks ("how am I today?", "how was my week?", "am I overdoing it?"); **Setup:** ask Claude to "connect WHOOP", a browser page walks through creating a free WHOOP developer app and approving access; credentials and tokens stay on this computer; Logs: `~/Library/Logs/whoop-mcp/whoop-mcp.log`; not affiliated with or endorsed by WHOOP; not medical advice |                                                                                                                                                                                                                                                                                                       |
| `author`                                                | `{name: "whoop-mcp contributors", url: REPO}`                                                                                                                                                                                                                                                                                                                                                                                                                            | Part of the extension ID                                                                                                                                                                                                                                                                              |
| `repository` / `homepage` / `documentation` / `support` | `{type:"git", url: REPO+".git"}` / REPO / `REPO#readme` / `REPO/issues`                                                                                                                                                                                                                                                                                                                                                                                                  | REPO = `https://github.com/213123243ertdfgret63/whoop-mcp`                                                                                                                                                                                                                                            |
| `icon`                                                  | `icon.png` (from `assets/icon.png`)                                                                                                                                                                                                                                                                                                                                                                                                                                      |                                                                                                                                                                                                                                                                                                       |
| `server`                                                | `{type:"binary", entry_point:"server/launch.sh", mcp_config:{command:"/bin/sh", args:["${__dirname}/server/launch.sh"], env:{WHOOP_MCP_INSTALL_SKILLS:"${user_config.claude_code_commands}"}}}`                                                                                                                                                                                                                                                                          | Desktop substitutes `${__dirname}` with the unpack folder. Running via `/bin/sh` survives a dropped exec bit.                                                                                                                                                                                         |
| `user_config`                                           | Exactly one key, `claude_code_commands`: `type: boolean`, `title: "Add /whoop- commands to Claude Code"`, `default: true`, `required: false`, plus a description (adds the three skills to `~/.claude/skills`; off removes them on next start; uninstall doesn't remove them)                                                                                                                                                                                            | Settings don't reliably reach the server (mcpb#297), so credentials are **not** collected here; the setup page collects them. The server treats an unexpanded `${…}` value as on (`installSetting`: unset or empty means undefined/leave alone; anything except case-insensitive `false` means true). |
| `tools`                                                 | From the live server; `tools_generated: false`                                                                                                                                                                                                                                                                                                                                                                                                                           |                                                                                                                                                                                                                                                                                                       |
| `prompts`                                               | `PROMPTS.map({name, description, text})` (no `tool` key); `prompts_generated: false`                                                                                                                                                                                                                                                                                                                                                                                     | Same text the server returns for the prompts                                                                                                                                                                                                                                                          |
| `keywords`                                              | `whoop, fitness, recovery, sleep, training, health`                                                                                                                                                                                                                                                                                                                                                                                                                      |                                                                                                                                                                                                                                                                                                       |
| `privacy_policies`                                      | `[PRIVACY_URL]` = `https://github.com/213123243ertdfgret63/whoop-mcp#connect-your-whoop-account`                                                                                                                                                                                                                                                                                                                                                                         | Exactly 1 entry                                                                                                                                                                                                                                                                                       |
| `compatibility`                                         | `{platforms: ["darwin"]}`                                                                                                                                                                                                                                                                                                                                                                                                                                                | Windows was dropped in v0.6.1 (untested)                                                                                                                                                                                                                                                              |

Prompts (from `src/server.ts`; no arguments, because Desktop shows an argument form before attaching a prompt):

| name               | title            | description                                                                   | text                                                                                                                                                                                                       |
| ------------------ | ---------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `whoop-connect`    | Connect WHOOP    | Connect your WHOOP account in the browser.                                    | `Connect my WHOOP account: call whoop_login, and while it says pending keep calling it with wait_seconds as it tells you, until it reports connected or failed. Then tell me the outcome in one sentence.` |
| `whoop-disconnect` | Disconnect WHOOP | Disconnect your WHOOP account and delete the saved login and app credentials. | `Disconnect my WHOOP account: call whoop_disconnect, then tell me the outcome in one sentence.`                                                                                                            |
| `whoop-status`     | WHOOP status     | Check whether your WHOOP account is connected.                                | `Check my WHOOP connection: call whoop_status, then tell me in one sentence whether it's connected, and if it isn't, what to do next.`                                                                     |

**Not signed:** `mcpb sign` 2.1.2 produces bundles that Desktop refuses to install (mcpb#278).

### Release flow (`scripts/release.ts`)

Usage: `bun run release <patch|minor|major|x.y.z> [--push] [--dry-run]`. All output goes to stderr. Any error prints a description (a Bun `ShellError` includes the failing command's stderr) and exits 1.

Guards, in order. Each throws, with the message substring the tests check:
1. Branch must be `main` ("Releases are cut from main (on X).").
2. `git status --porcelain` must be empty ("Working tree is not clean.").
3. `git fetch --quiet origin main`, then HEAD must equal `origin/main` ("main is not in sync with origin/main; pull or push first.").
4. Next version (`nextVersion`):
   - patch, minor and major bump like npm (minor resets patch; major resets both).
   - An explicit version may have a leading `v` and must be strictly greater, compared numerically (1.10.0 > 1.9.9).
   - Errors: current version not plain `x.y.z` gives `…is not plain x.y.z semver`; an unknown bump gives `Expected patch, minor, major or x.y.z, got "…"`; a version that isn't higher gives `New version X must be greater than Y`.
5. Tag `vX.Y.Z` must not exist locally ("Tag … already exists.") and must not exist on origin, checked with `git ls-remote --tags origin refs/tags/<tag>` ("already exists on origin"). Why: `git fetch origin main` only follows tags in main's history.

Changelog:
- Last tag: `git describe --tags --abbrev=0 --match "v*"`. The pattern is interpolated so Bun's shell doesn't glob it. The range is `<lastTag>..HEAD`, or `HEAD` when there is no tag.
- Commits come from `git log --format=%h%x09%s`.
- `changelogSection(version, date, commits)` gives `## vX.Y.Z (YYYY-MM-DD)\n\n- subject (hash)…\n`. It drops subjects matching `^Release v\d`. With no commits it writes `- No changes recorded`. It escapes leading `N.`, `#` and `- `/`* `/`+ ` so a subject can't become a heading or nested list. The date is UTC ISO.
- `prependChangelog(existing|null, section)`: keeps one `# Changelog` header and puts newer sections above older ones.
- `releaseNotes(changelog, version)`: finds `## vX.Y.Z ` (trailing space, so `0.1.1` doesn't match `0.1.10`) up to the next `\n## v`, strips the heading and trims. Returns null if the version is absent.
- `setPackageVersion(text, v)`: a regex rewrite of only the `"version"` field, keeping every other byte. Throws `No "version" field found in package.json`.

Run:
- Prints `Releasing <cur> → <new> (<n> commit(s) since <tag|the start>)` and the section.
- `--dry-run` stops there ("Dry run: nothing written.").
- Otherwise it runs `bun run lint`, `bun run typecheck` and `bun test`, then writes CHANGELOG.md and package.json and runs `bunx biome format --write CHANGELOG.md package.json`. Why: the pre-commit hook may be disabled, and the tagged commit must pass `biome ci` in the release workflow.
- It then runs `git add` on both files, `git commit -m "Release vX.Y.Z"` and `git tag -a vX.Y.Z -m "Release vX.Y.Z"`.
- **Rollback:** any failure in the write/commit/tag block runs `git tag -d` and `git reset --hard <startHead>`, then throws `Release aborted and rolled back to <sha7>: …`.
- `--push` runs `git push --quiet --atomic origin main vX.Y.Z`, so main and the tag both land or neither does (no release from a tag that isn't on main). If the push fails, the local commit and tag are kept and the message suggests `git tag -d <tag> && git reset --hard origin/main`, or retrying the push. Without `--push` it prints `Push when ready:  git push --atomic origin main <tag>`.

### GitHub Actions

All workflows use `actions/checkout@v7`, `oven-sh/setup-bun@v2` with `bun-version-file: .bun-version`, `bun install --frozen-lockfile` and `HUSKY: "0"`.

**`ci.yml`**
- Triggers: push to `main`, `pull_request`, `workflow_dispatch`. Permissions: `contents: read`.
- Concurrency group `ci-${{ github.ref }}`. `cancel-in-progress` only for pull requests: superseded PR runs are cancelled, and every push to main keeps its own result.
- Matrix: `ubuntu-latest` only, plus `macos-latest` on `workflow_dispatch`. Why: macOS runners are scarce, can queue until cancelled, and cost 10x minutes on private repos. `fail-fast: false`, timeout 20 min.
- Steps:
  1. install (also runs `gen:types`)
  2. `bunx biome ci .` (Linux only)
  3. `bun run typecheck`
  4. `bun test`
  5. `bun run build`
  6. `bun test test/smoke.test.ts -t "compiled binary"` with `WHOOP_MCP_BINARY=dist/whoop-mcp`
  7. `bun run build:mcpb` (validates the manifest and the exec bits; on Linux, signing and the minos check are skipped)

**`bundle.yml`**
- Runs the macOS-only parts of the build (codesign, minos check, running both binaries) that Ubuntu CI can't.
- Triggers: push to `main` touching `scripts/build-mcpb.ts`, `package.json`, `bun.lock`, `.bun-version`, `src/index.ts` or `.github/workflows/bundle.yml`; also `workflow_dispatch`. Path filters keep macOS cost down, and a broken build shows up before a tag is pushed rather than as a failed release.
- Job: `macos-latest`, 20 min, `CI=true` (so the minos check is fatal).
- Runs `build:mcpb`, unzips to `dist/check`, and checks `/bin/sh dist/check/server/launch.sh --version` equals the package.json version. If Rosetta is available (`arch -x86_64 /usr/bin/true`), it runs the same check under `arch -x86_64`; otherwise it emits `::warning::Rosetta isn't installed on this runner; the x64 binary was not run`.

**`release.yml`**
- Trigger: push of tags `v*`. Permissions: `contents: write`. Concurrency group `release-${{ github.ref }}`. Job on `macos-latest` (ad-hoc signing plus Unix-mode zips), 30 min.
- Checkout uses `fetch-depth: 0` (needed for the ancestry check) and `persist-credentials: false`, so the write token isn't left in `.git/config` for build scripts or tests to read. `gh` gets the token through `GH_TOKEN` only in the publish step.
- Steps:
  1. Tag equals `v` + package.json version, else `::error::Tag … does not match package.json version …`.
  2. `git merge-base --is-ancestor $GITHUB_SHA origin/main`, else `::error::… isn't on main; refusing to release it`.
  3. `biome ci .`, typecheck, test.
  4. `build:mcpb`. Unzip, check `launch.sh --version` equals `${GITHUB_REF_NAME#v}`, run the x64 binary under Rosetta when available (else warn), then `(cd dist && shasum -a 256 whoop-mcp-*.mcpb > SHA256SUMS)`.
  5. `bun -e` imports `releaseNotes` from `scripts/release.ts` and writes `dist/NOTES.md`. It fails if CHANGELOG has no section for the version.
  6. Publish. If the release already exists (a re-run), it runs `gh release upload --clobber` for the assets plus `gh release edit --notes-file … --draft=false`. Otherwise it runs `gh release create <tag> --title <tag> --notes-file dist/NOTES.md --verify-tag dist/whoop-mcp-*.mcpb dist/SHA256SUMS`.
- Release assets: `whoop-mcp-macos.mcpb` and `SHA256SUMS`.

### Test conventions

- `bunfig.toml`: `[test] preload = ["./test/preload.ts"]`. The preload sets:
  - `TZ=UTC` (date tests assume UTC)
  - `WHOOP_MCP_CREDENTIAL_STORE=file` (never the real keychain, since disconnect deletes credentials; keychain tests mock `Bun.secrets`)
  - `WHOOP_MCP_LOG_FILE ??= "off"`
  - `WHOOP_MCP_LOG_LEVEL=info`
  - deletes `WHOOP_MCP_LOG_STDERR_LEVEL`, `WHOOP_CLIENT_ID`, `WHOOP_CLIENT_SECRET` and `WHOOP_REDIRECT_URI`, so shell credentials can't trigger the real login path and bind port 8787
  - `WHOOP_MCP_NO_BROWSER=1`
- All tests are offline and isolated in `mkdtemp` dirs that are removed afterwards. Subprocess tests pass a minimal env (`PATH`, `WHOOP_MCP_HOME`, file store, no browser).
- **`mcpb.test.ts`** checks:
  - the exact `server` object and `platforms: ["darwin"]`;
  - `DIRNAME === "${__dirname}"`, with placeholders built via `["$","{…}"].join("")` to dodge lint;
  - version, tools, a single privacy policy, `user_config` keys exactly `["claude_code_commands"]` (boolean, default true, required false), "unofficial" in the description, `name` `whoop-mcp` and display name `WHOOP (unofficial)`;
  - prompt names in order, no `tool` key, texts equal to PROMPTS, `prompts_generated` false;
  - `launch.sh` (darwin only) runs a stand-in binary saved with mode 0600 and restores its owner-exec bit;
  - `summary` behaviour.
- **`release.test.ts`**: unit tests for the pure functions, plus guard tests. The guard tests create a bare `remote.git` and a `repo` with a copy of `release.ts` inside it (the script resolves the repo from its own location), use per-command `.cwd()` rather than `$.cwd()` (which is process-global), and run with `--dry-run`. They cover: dry run writes nothing; refuses a dirty tree, a non-main branch, unpushed commits, an existing local tag, and a tag only on origin on a side commit; lists only commits since the last tag.
- **`smoke.test.ts`**: a real stdio subprocess (`bun run src/index.ts`) through `StdioClientTransport`, run for both protocol eras:
  - modern `2026-07-28` (`versionNegotiation.mode.pin`; the v2 client defaults to legacy, so modern must be pinned);
  - legacy `2025-11-25` (`supportedProtocolVersions`).
  - It asserts the negotiated version, that tools include `whoop_today` and `whoop_status`, and that `readOnlyHint` is true for every tool except `whoop_login` and `whoop_disconnect`. It also checks `whoop_status` reports `logged_in:false`, and that `whoop_profile` returns `isError` mentioning `whoop_login`. A token file gives `logged_in`, `has_refresh_token`, and `missing_scopes` containing `read:sleep`.
  - `WHOOP_REDIRECT_URI` is set to a free 127.0.0.1 port.
  - "compiled binary serves stdio" runs only when `WHOOP_MCP_BINARY` is set.
  - Serve-mode test: raw JSON-RPC `initialize`, `notifications/initialized` and `tools/call whoop_status`, then close stdin. Expects exit 0 within 5 s, and a log at `<home>/logs/whoop-mcp.log` (mode 0600) containing `INFO  starting`, `tool whoop_status ok` and `client disconnected`, with no `INFO` on stderr.
  - `logout` CLI: deletes the app credentials by default and prints "Deleted saved app credentials."; `--keep-app` keeps them; `--forget-app` is accepted as a legacy alias; `keep-app`, `--keepapp` and `--keep_app` exit 2 without deleting ("Unknown option --keep_app").
- **`bun-skill.test.ts`**: runs the bun skill scripts with a temp `HOME`, `XDG_CACHE_HOME` seeded with fresh cache files, a fake `bun` shim on PATH (answers `--version` and `--revision`), and `HTTP(S)_PROXY=http://127.0.0.1:9` so any stray fetch fails fast. Covers every status, pin rule, install-method upgrade command, and docs search/grep/usage (exit 2).
- **`whoop-reset-skill.test.ts`**: runs the reset script with a temp `HOME` and `TMPDIR`, a fake `security` that keeps a counter file, `WHOOP_RESET_DESKTOP_RUNNING`, `WHOOP_RESET_NO_WAITER=1`, `--no-revoke --json` and `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0`. Every test first does a dry run and asserts all reported paths are under the temp HOME. A dry run must leave a full snapshot of HOME (contents and modes) unchanged.
- Others (`spec.test.ts`, etc.) are covered in other sections.

### Project skills (`.claude/skills/`)

**`bun`** (model-invocable; SKILL.md describes when to use it)
- `scripts/bun-version-check.ts [--cwd <dir>] [--json] [--refresh]`:
  - Detects the installed bun via `Bun.which("bun")` with `--version` and `--revision`, falling back to `Bun.version`.
  - Install method comes from the path: homebrew/cellar/linuxbrew, `/.bun/bin/` (install-script), mise, asdf, proto, npm/node_modules, scoop, unknown. Upgrade commands: homebrew `brew upgrade bun` (not `bun upgrade`), install-script `bun upgrade`, mise `mise use -g bun@latest`, and so on.
  - Releases come from the GitHub API (`oven-sh/bun/releases?per_page=30`, non-draft, non-prerelease, `bun-v` tags), falling back to `registry.npmjs.org/bun/latest`. Each release summary is the `description:` front matter of `https://bun.com/blog/bun-v<ver>.md`. Network results are cached 6 h in `$XDG_CACHE_HOME|~/.cache/bun-skill/*.json`.
  - Status is `outdated`, `current`, `ahead` (newer than latest, or a canary build) or `unknown`. It shows up to 8 missed releases.
  - Pins it reads: `engines.bun`, `packageManager bun@`, `@types/bun`/`bun-types` (with the version actually installed), `.bun-version`, `.tool-versions`, `mise.toml`/`.mise.toml`, Dockerfile/dockerfile/Containerfile `FROM oven/bun:` (deduplicated by realpath for case-insensitive filesystems), and workflow `setup-bun` `bun-version`, or `bun-version-file` resolved from the file, or "no bun-version → latest".
  - Issues it reports: a pin requires a newer bun than installed; types minor version differs from the runtime; an exact pin is older than latest; an unversioned CI or container pin while the local bun is outdated.
- `scripts/bun-docs.ts search <terms> | get <url|docs path> | grep <regex>`:
  - Reads `https://bun.com/llms.txt` and `llms-full.txt`, cached 24 h.
  - search scores title matches 3 and other text matches 1, top 12.
  - get appends `.md` to the URL.
  - grep is case-insensitive, prefixes each hit with its page heading and stops at 60 hits.
  - Usage errors exit 2.

**`whoop-reset`** (`disable-model-invocation: true`; runs only via `/whoop-reset`)
- Script: `bun .claude/skills/whoop-reset/scripts/whoop-reset.ts`. A dry run by default; `--yes` applies. Other options: `--no-revoke`, `--include-downloads` and `--json`, plus the internal `--finish-extension`, which implies apply. An unknown option exits 2 before doing anything. Exit code is 1 if any item failed.
- Constants:
  - extension ID `local.mcpb.whoop-mcp-contributors.whoop-mcp`
  - keychain service `whoop-mcp`
  - `security` not-found exit code 44
  - `SKILL_MARKER` must equal `MARKER` in `src/skills.ts`: `<!-- Installed by the WHOOP (unofficial) Claude Desktop extension (whoop-mcp). -->`
- Test hooks (env vars): `WHOOP_RESET_SECURITY` (default `/usr/bin/security`), `WHOOP_RESET_DESKTOP_CHECK` (a shell command; default `/bin/ps -axo comm= | grep -q '/Claude\.app/Contents/MacOS/Claude$'`, because `pgrep` can't see Desktop's main process from inside a Claude session), `WHOOP_RESET_DESKTOP_RUNNING` (`1`/`0` forces the answer), `WHOOP_RESET_NO_WAITER=1`.
- Order of work:
  1. Kill processes whose command contains `<extensionDir>/server/`.
  2. Revoke: for each config dir that has `tokens.json` (unless `--no-revoke`), run `bun <repo>/src/index.ts logout --keep-app` with `WHOOP_MCP_HOME=<dir>`, `WHOOP_MCP_LOG_FILE=off` and a 60 s timeout (a keychain prompt nobody answers mustn't hang it). Output "Revoked access at WHOOP." means removed; "Couldn't revoke" or a nonzero exit means failed, with a dashboard hint.
  3. Keychain: if `find-generic-password -s whoop-mcp` succeeds, loop up to 20 times on `delete-generic-password -s whoop-mcp` until exit 44. This deletes items saved by older builds too. Each call has a 15 s timeout.
  4. Delete config dirs:
     - always `~/.config/whoop-mcp`, because Desktop starts the extension without the shell's variables;
     - `$XDG_CONFIG_HOME/whoop-mcp`;
     - `WHOOP_MCP_HOME` **only if its basename is `whoop-mcp`**, otherwise reported as `skipped`. A stray value such as `.` or `$HOME` must never be wiped.
  5. Delete logs and caches: `~/Library/Logs/whoop-mcp`; `~/Library/Logs/Claude/mcp-server-*whoop*.log` (case-insensitive); `~/Library/Caches/claude-cli-nodejs/*/mcp-logs-*whoop*`; `~/.claude/plugins/cache/whoop-mcp`.
  6. Skills `whoop-connect`, `whoop-disconnect` and `whoop-status` in `~/.claude/skills` and `$CLAUDE_CONFIG_DIR/skills` (both, since Desktop started from the Dock may not see the shell's `CLAUDE_CONFIG_DIR`). A folder is removed only if its SKILL.md contains the marker, or if it has no SKILL.md and holds only `.SKILL.md.<n>.tmp` files. Otherwise it is reported as `kept`.
  7. Extension:
     - If Desktop isn't running: delete `~/Library/Application Support/Claude/Claude Extensions/<ID>` and `Claude Extensions Settings/<ID>.json`, then remove `<ID>` from `extensions-installations.json` (`.extensions`), keeping other entries. The file is written atomically through a temp file and `rename`, mode 0600 forced with `chmod`. Desktop logs are deleted too.
     - If Desktop is running: status `deferred`/pending. Desktop keeps its extension list in memory and writes it back. The script spawns a detached `/bin/sh` waiter (stdout and stderr to `$TMPDIR/whoop-reset.log`, cwd tmpdir). It polls once a second for up to 3600 s. Once Desktop has been absent for 3 consecutive checks (a restart to update comes straight back), it `exec`s the script with `--finish-extension`. That removes the extension and the skills again, because the still-running extension rewrites them when it starts. Otherwise it prints "Claude Desktop didn't quit within an hour; run the whoop-reset skill again."
  8. `~/Downloads/whoop-mcp*.mcpb` files are `kept` unless `--include-downloads` is passed.
- Output labels: found = `would remove`, `removed`, `FAILED`, deferred = `pending`, `kept`, `skipped`, padded to 12 characters. If every item is `kept`, it prints `Nothing of whoop-mcp left: already clean.`; a dry run ends with `Dry run: nothing was removed. Run again with --yes to remove it.`. `--json` prints `{applied, items:[{what, path?, status, note?}]}`.
- SKILL.md instructs Claude to:
  - dry run and show a table, then run `--yes` (invoking the skill is the go-ahead), then dry run again;
  - report by label; for pending, tell the user to quit with ⌘Q (this also ends the session) and not to use WHOOP until Desktop has quit; the alternative is Settings → Extensions → Uninstall, then rerun;
  - remind the user that WHOOP remembers the earlier approval (sign out or use a private window), and that the developer app stays in the dashboard.

### README install, update and uninstall (user-facing behaviour)

- **Requirements:** Claude Desktop on macOS 13+, Apple Silicon or Intel.
- **Install:** download `whoop-mcp-macos.mcpb` from the latest release, double-click it (or drag it onto Settings → Extensions), click Install, then ask "connect WHOOP". No settings are needed.
- **Pre-0.3 migration:** quit Desktop (it rewrites `claude_desktop_config.json` on quit), delete the `whoop` entry under `mcpServers`, delete `~/.whoop-mcp`, and if needed run `claude mcp remove whoop --scope user`. The login and credentials carry over.
- **Update:** install the new `.mcpb` the same way. File-installed extensions don't auto-update. The login and credentials survive because they live outside the extension. macOS may ask for keychain access the first time a new build reads them. Find the version under Settings → Extensions or as `whoop_status.server_version`.
- **Uninstall:** disconnect first, then Settings → Extensions → WHOOP (unofficial) → Uninstall. Desktop has no uninstall hook, so manual cleanup is:
  `rm -rf ~/.claude/skills/whoop-{connect,disconnect,status} ~/.config/whoop-mcp ~/Library/Logs/whoop-mcp` and `security delete-generic-password -s whoop-mcp`.
- **Run from source:**
  - `bun install && bun run build:mcpb`.
  - Or add a differently named server (e.g. `whoop-dev`, command bun, args `src/index.ts`) to `claude_desktop_config.json`. A config entry with the same name overrides an extension.
  - CLI: `bun src/index.ts setup|login|status|logout|version`.
  - Env credentials take precedence only when both are set.

### History of design pivots (git log)

| Version / commit               | Change                                                                                                                                                                                                                           |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9b312b7                        | Scaffold: Bun + `@modelcontextprotocol/server` 2.4.0 stdio, `whoop_status` and `whoop_profile`, localhost OAuth, 0600 token file, smoke tests for both protocol eras, M0 probe spike                                             |
| 86c7e3f                        | bun skill, Biome + Husky, vendored OpenAPI YAML as source of truth, types generated on install                                                                                                                                   |
| d49678a                        | Versioning from package.json, release script, CI on Ubuntu + macOS, release cross-compiling macOS/Linux/Windows binaries                                                                                                         |
| 50a0e9e                        | **Claude Code plugin** (plugin/, marketplace.json, committed single-file bundle, userConfig for client ID/secret, `${CLAUDE_PLUGIN_DATA}`). CI macOS moved to manual dispatch because of runner capacity.                        |
| 62cc751 (v0.1.0)               | **MCP-only:** plugin removed. `install.sh`/`uninstall.sh` via `curl                                                                                                                                                              | sh`, SHA256SUMS verification, install to `~/.whoop-mcp/bin`, `whoop-mcp claude add | remove` for Code and Desktop config, browser setup page. Biome Markdown formatting mangled SKILL.md, so SKILL.md was excluded from Biome. |
| 0e2c2d4, e8af76c (v0.2.0)      | Installer warns about, and offers to restart, a running Desktop, because it rewrites `claude_desktop_config.json` on quit                                                                                                        |
| 58e29df (v0.3.0, **breaking**) | **Claude Desktop extension (.mcpb) only:** macOS bundle (arm64 + x64 + `launch.sh`) plus a Windows bundle; installers and Claude Code support removed; rotating file log; exit on stdin close                                    |
| 8040780 (v0.4.0)               | Macos `bundle.yml` added, release runs the Intel binary under Rosetta and has a timeout, build cleans its staging dir, leftovers removed (M0 probe, package.json `bin`, the user_config placeholder guard), RESEARCH.md archived |
| 3ef4659 (v0.5.0)               | Display name "WHOOP (unofficial)", `name` unchanged to keep the ID                                                                                                                                                               |
| b7d2809 (v0.6.0)               | MCP prompts whoop-connect and whoop-disconnect, also listed in the manifest                                                                                                                                                      |
| 3c3a066, 9eb327b (v0.6.1)      | `/usr/bin/security` fallback for keychain items owned by an older build (errSecInvalidOwnerEdit: every build is a different program to macOS). **Windows bundle dropped** (untested).                                            |
| 838a37a, 168a6e8 (v0.7.0)      | `/whoop-reset` skill; Claude Code `/whoop-*` skills written by the extension, controlled by `user_config.claude_code_commands`; `whoop-status` prompt                                                                            |

Roadmap (`docs/roadmap.md`): a possible remote mode (Streamable HTTP, `createMcpHandler` on `Bun.serve`) so claude.ai web and mobile can use it, originally milestone M6. Requirements: auth on every `/mcp` request (a bearer secret, or MCP OAuth with RFC 9728 and PKCE), reuse of the OAuth `state` check, no permanent data copy (WHOOP terms §4.2.2), and re-reading the third-party terms (§3.1.3, §4.2.1). Hosting for other people would not be allowed. Lessons are drawn from crerocksolid/whoop-mcp.

### Known Claude Desktop and mcpb quirks (recorded in code and docs)

- **mcpb#10:** no architecture field, so one bundle carries both binaries plus `launch.sh`.
- **mcpb#294 / #235:** an extracted file is executable only if its zip entry has owner-exec, and some builds drop it anyway. Hence the build packs on macOS/Linux, `checkExecutable` fails the build, `/bin/sh` is the command, and `launch.sh` runs `chmod`.
- **mcpb#278:** `mcpb sign` 2.1.2 bundles are refused by Desktop, so bundles are unsigned. Binaries are ad-hoc codesigned only.
- **mcpb#297:** `user_config` values don't reliably reach the server, so credentials are collected on the setup page, and an unexpanded `${user_config…}` counts as the default (on).
- The extension ID derives from author name plus `name`. Renaming either installs a second extension.
- Desktop keeps its extension list and `claude_desktop_config.json` in memory and writes them back on quit. Edit them only while Desktop is closed; the reset waits for a 3 s absence, since a restart to update returns immediately.
- Desktop starts the extension without the shell's environment, so it always uses `~/.config/whoop-mcp`, and `CLAUDE_CONFIG_DIR` may be missing.
- Desktop chat's `/` menu doesn't list extension prompts; they appear under **+ → Add from WHOOP (unofficial)**. Desktop asks for prompt arguments in a form, so prompts take none. Claude Code commands therefore have to be skills in `~/.claude/skills`. In a session, tool names may carry a prefix such as `mcp__WHOOP__unofficial___whoop_login`.
- Desktop has no uninstall hook, so skills and data remain after uninstall.
- Claude gives about 2 s between stdin EOF and SIGTERM, so the server's shutdown grace is 1500 ms.
- From a Claude session `pgrep` can't see Desktop's main process; the reset script uses `ps -axo comm=` instead.
- A Homebrew or self-built bun produces binaries with a higher minimum macOS, so release builds must use an official bun; the minos check is fatal in CI.

### Corrections and additions

Found when this part was checked against the code. Where they differ from the text above, these are right.

**Product scope and next planned feature** (README.md, "What it can't do (yet)")
- No memory between chats: no goals, injuries, training plan or daily log. The README's "next release" is a **local planning store** (goals, weekly plan, daily check-ins).
- No writes to WHOOP. WHOOP's API has no Journal, Stress Monitor, Strength Trainer sets or live heart rate.
- No medical advice: it is a planning and logging aid.
- Not on phone or claude.ai: it runs only inside Claude Desktop on the computer, while the app is open.

**CHANGELOG is partly hand-written** (CHANGELOG.md, scripts/release.ts, .github/workflows/release.yml)
- `release.ts` `changelogSection` generates only `- <subject> (<hash>)` lines. It skips `Release v…` commits and escapes leading `#`, `1.` and `- `.
- v0.3.0 has a manually added first bullet: `**Breaking:** whoop-mcp now installs only as a Claude Desktop extension (.mcpb) …`, with the instruction to remove a pre-0.3 `whoop` server.
- `release.yml` publishes the version's CHANGELOG section verbatim as the release notes, and fails if the section is missing. Add breaking-change notes by hand before tagging.

**History table additions** (git log)

| Commit  | Version | What                                                                                                                                                                                                                                                                                                                       |
| ------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| bd1854f | pre-0.1 | `whoop-mcp setup` wizard, verification against the token endpoint, keychain storage via `Bun.secrets` with a 0600 file fallback, `logout --forget-app`; a public-client (`none` auth, PKCE) probe that 8040780 later removed                                                                                               |
| 7e3a183 | v0.2.0  | WHOOP data tools for coaching added                                                                                                                                                                                                                                                                                        |
| 9fed2ae | v0.2.1  | Dead-login fixes (`invalid_grant` re-reads the token file, the dead token is never re-posted, `invalid_client` points to `reconfigure`); `whoop_today` gaps (open cycle after midnight, baseline_days); `data_quality` first-data and open-cycle dates; compact JSON; raw limited to 7 days; one WhoopClient per process   |
| 5ebfaa4 | v0.4.0  | "Claude waits, the page does the rest": data tools auto-start the login (60 s cooldown), `whoop_login wait_seconds` ≤45, new setup page (Copy buttons, auto check-and-save, works without JS), callback errors keep the flow alive, 20 min idle / 60 min max, CSP nonces, token-header JSON endpoints, rate-limited checks |
| 69a92b5 | v0.4.0  | Review fixes for that flow                                                                                                                                                                                                                                                                                                 |
| 4af7981 | v0.5.0  | `whoop_disconnect` (`DELETE /v2/user/access`); logins missing permissions refused (partial token revoked, nothing saved)                                                                                                                                                                                                   |
| ee11e99 | v0.5.0  | Review fixes in disconnect and the permission check                                                                                                                                                                                                                                                                        |
| c9350ef | v0.6.0  | Disconnect and `logout` delete app credentials by default (`keep_app` / `--keep-app`; `--forget-app` still accepted); a cancel mid-submit saves nothing; the pre-filled ID is forgotten                                                                                                                                    |
| 0e6c121 | v0.6.2  | "Open WHOOP in a new tab" as a plain link, fields table with Copy, stale "Not this login" approvals explained, no idle timeout while on WHOOP, reload on bfcache restore                                                                                                                                                   |

**Pre-0.3 installer-era lessons** (git 62cc751, 0e2c2d4, e8af76c, 8aa0eaa)
- These matter only if a migration goes back to installing via config files.
- 0e2c2d4: Claude Desktop keeps `claude_desktop_config.json` in memory and writes it back on quit, dropping entries added while it runs. Config edits must happen with Desktop closed.
- e8af76c: the "Restart Claude now? [y/N]" prompt read from `/dev/tty` so it worked under `curl | sh` (preset with `WHOOP_MCP_RESTART_CLAUDE`). It quit Claude by bundle id, waited up to 5 min, and changed nothing if Claude didn't quit.
- 62cc751: `whoop-mcp claude add` registered with Claude Code via the `claude` CLI on PATH or the one bundled with Desktop, with `~/.claude.json` only as a fallback.
- 8aa0eaa: Linux `ps` reports a symlinked `/bin/sleep` by its target name, so the fake-Claude installer tests used perl's `$0` rename.

**Claude Code plugin attempt (50a0e9e)**
- `userConfig` asked for the client ID and the (sensitive) secret at install; they arrive as env vars.
- An unexpanded `${...}` placeholder must not count as a credential. 8040780 later dropped that guard.
- Today `installSetting()` (src/skills.ts) treats an unexpanded `${user_config.claude_code_commands}` as **on**: anything non-empty that isn't `false`.
- Tokens lived in `${CLAUDE_PLUGIN_DATA}`.
- The committed single-file bundle had to be rebuilt by the pre-commit hook when `src/` changed, and CI failed on a stale bundle.
- The plugin was abandoned for MCP-only (62cc751), then for the Desktop extension (58e29df).

**Bun build leftovers** (.gitignore, scripts/build-mcpb.ts)
- The repo root holds 59 `.<hex>-00000000.bun-build` files: about 87 MB each, about 4.8 GB in total, gitignored by `*.bun-build`.
- Interrupted `bun build --compile` runs leave them in the cwd.
- `build-mcpb.ts` cleans only its staging dir and output, and `/whoop-reset` doesn't touch them.
- A recreation should add cleanup, or compile with a temp cwd.
