# WHOOP MCP Server (Bun + TypeScript): Build Brief

*Put together from the api, oauth, existing-servers and mcp-bun research reports, with the fact-check corrections applied. Research date: 2026-10-27. Anything marked **UNVERIFIED** still needs to be tested or confirmed.*

---

## 1. TL;DR

- **Use WHOOP API v2 only.** v2 launched on 2025-07-01. WHOOP says v1 is "no longer supported" and has stopped publishing v1 webhooks. WHOOP gives no sunset date for the v1 REST endpoints. The only v1 path left in the spec is the ID-mapping endpoint. There is a machine-readable OpenAPI 3.0.1 spec at `https://api.prod.whoop.com/developer/doc/openapi.json`, which we can use to generate types.
- **WHOOP has no official SDK and no official MCP server.** About 20 community MCP servers exist. None of them combines all of the following:
  - Bun-native distribution
  - correct cross-process handling of rotating refresh tokens
  - output tolerant of WHOOP's data quirks and cheap on tokens
  - analytics computed on the server
  - caching that respects the Terms of Use
- **Start with a local stdio server.** Each user registers their own WHOOP developer app; the Sandbox tier allows up to 10 members, which is plenty for personal use. The MCP spec says stdio servers should take credentials from the environment, so MCP's own auth layer isn't needed. A remote server would need its own OAuth 2.1 authorization server. Leave that for later.
- **Refresh tokens are single-use and rotate.** When a refresh succeeds, both the old refresh token and the existing access tokens stop working. Two consequences:
  - Refreshes must be serialized within one process and across processes, because Claude Desktop, Claude Code and Cursor can each start their own instance.
  - Save the new token before using it, and re-read the token store whenever a request returns 401.
- **Stack:**
  - `@modelcontextprotocol/server` 2.4.0 (SDK v2, targets MCP spec 2026-07-28, can still serve older clients)
  - `zod` ^4.2.0
  - Bun 1.4.4
  - stdio transport through `serveStdio`
  - `Bun.secrets` for tokens, with a 0600 file as fallback
  - shipped as a `bun build --compile` binary, plus `bunx`, plus an MCPB bundle of type `binary`
- **The Terms of Use shape the design** (API ToU, effective 2026-10-06, only three weeks old):
  - no databases or permanent copies of data, so cache in memory only
  - encrypt data at rest
  - no medical or professional advice, so outputs carry a disclaimer
  - no developer credentials in open-source code, so users bring their own client ID and secret
  - the AI clause bans using WHOOP data to "create, develop, test, train, fine-tune or improve" AI or ML systems, so don't build eval sets from real data
- **Design tools around tasks, not endpoints.** Examples: a daily summary, trends, baselines, a period comparison. Hide pagination, convert units (hours, kcal, km, local time), report `score_state` explicitly, and offer a `raw` escape hatch.
- **Limits:**
  - 100 requests per minute and 10,000 per day
  - `limit` is at most 25 records per page, so 90 days of data is 4 or more pages per resource
  - the server should read the `X-RateLimit-*` headers and back off on 429

---

## 2. WHOOP API essentials

### Base URLs

| Item | Value |
|---|---|
| API base | `https://api.prod.whoop.com/developer` |
| OAuth authorize | `https://api.prod.whoop.com/oauth/oauth2/auth` |
| OAuth token (code exchange and refresh) | `https://api.prod.whoop.com/oauth/oauth2/token` |
| RFC 7009 token revocation (advertised in discovery, not in WHOOP's docs) | `https://api.prod.whoop.com/oauth/oauth2/revoke` |
| OIDC discovery | `https://api.prod.whoop.com/oauth/.well-known/openid-configuration` (the RFC 8414 path returns 404) |
| OpenAPI spec | `https://api.prod.whoop.com/developer/doc/openapi.json` (about 76 KB, 22 operations, 34 schemas) |
| Developer dashboard | `https://developer-dashboard.whoop.com` (sign-in goes through id.whoop.com) |

### Endpoints for consumer apps

| Method | Path | Scope | Notes |
|---|---|---|---|
| GET | `/v2/user/profile/basic` | read:profile | Returns `user_id`, `email`, `first_name`, `last_name` |
| GET | `/v2/user/measurement/body` | read:body_measurement | Returns `height_meter`, `weight_kilogram`, `max_heart_rate` |
| DELETE | `/v2/user/access` | (OAuth) | Revokes the app's access and returns 204. Webhooks stop for that user |
| GET | `/v2/cycle` | read:cycles | Paginated |
| GET | `/v2/cycle/{cycleId}` | read:cycles | `cycleId` is an int64 |
| GET | `/v2/cycle/{cycleId}/sleep` | none in the spec (probably read:sleep, **UNVERIFIED**) | New in v2 |
| GET | `/v2/cycle/{cycleId}/recovery` | read:recovery | |
| GET | `/v2/recovery` | read:recovery | Sorted by the related sleep's start time, newest first |
| GET | `/v2/activity/sleep` | read:sleep | Paginated |
| GET | `/v2/activity/sleep/{sleepId}` | read:sleep | `sleepId` is a UUID |
| GET | `/v2/activity/workout` | read:workout | Paginated |
| GET | `/v2/activity/workout/{workoutId}` | read:workout | `workoutId` is a UUID |
| GET | `/v1/activity-mapping/{activityV1Id}` | none in the spec | Maps an old ID to `{ v2_activity_id }`. For one-time migration only. Documents only 200, 404 and 500 responses |

- **There is no "workouts by cycle" endpoint.** To get a cycle's workouts, query the workout collection with `start` and `end` set to the cycle's bounds.
- **There are no write endpoints for consumer data.** The `/v2/partner/*` endpoints (Trusted Partner client credentials, lab and diagnostics workflows) do accept POST and PATCH, but they are irrelevant here. Exclude them from type generation.
- **Responses:** each endpoint documents some of 200, 400, 401, 404, 429 and 500. The spec defines no error body schema (**UNVERIFIED**).
- **Tracing:** responses carry an `x-whoop-trace-id` header. Log it, because WHOOP support can use it.

### Key fields (v2)

- **ID types:**
  - `user_id`, cycle `id` and `cycle_id` are int64.
  - Sleep `id`, workout `id` and recovery `sleep_id` are UUIDs.
  - Recovery has no `id` of its own. It is identified by its cycle.
- **`score_state`** is `SCORED`, `PENDING_SCORE` or `UNSCORABLE`. `score` is present only when the state is `SCORED`.
- **Cycle:**
  - Fields: `start`, `end?`, `timezone_offset`, `score`, `step_count?`.
  - A missing `end` means the cycle is still in progress.
  - `step_count` is a nullable int32, added on 2026-09-23. The claim that it needs no re-consent is **UNVERIFIED**.
  - `CycleScore` contains `strain`, `kilojoule`, `average_heart_rate`, `max_heart_rate`.
- **Recovery score:**
  - `recovery_score` (0–100), `resting_heart_rate`, `hrv_rmssd_milli`, `user_calibrating`
  - `spo2_percentage?` and `skin_temp_celsius?`, reported only by WHOOP 4.0 and later
- **Sleep:**
  - Fields: `nap` (bool), `start`, `end`, plus a score.
  - The score has `stage_summary`: in-bed, awake, no-data, light, slow-wave and REM durations in milliseconds, plus `sleep_cycle_count` and `disturbance_count`.
  - It also has `sleep_needed`: `baseline_milli`, `need_from_sleep_debt_milli`, `need_from_recent_strain_milli`, `need_from_recent_nap_milli`.
  - Optional percentages: `respiratory_rate`, plus sleep performance, consistency and efficiency.
- **Workout (WorkoutV2):**
  - `sport_name` is required. Use it as the sport identifier.
  - Score fields: `strain`, average and max heart rate, `kilojoule`, `percent_recorded`, and optionally `distance_meter`, `altitude_gain_meter`, `altitude_change_meter`.
  - `zone_durations` gives `zone_zero_milli` through `zone_five_milli`.
- **Deprecated fields:**
  - `v1_id` (on Sleep and Workout) and `sport_id` are marked "Will not exist past 09/01/2025". Treat them as absent.
  - The official example still shows `sport_id: 1`.
  - Whether that example contradicts the sports table is unverifiable, so rely on `sport_name`.
- **Time zones:** every record has `timezone_offset` as `+hh:mm`, `-hh:mm` or `Z`.

### Pagination and filters

These apply to the cycle, recovery, sleep and workout collections.

| Parameter | Meaning |
|---|---|
| `limit` | int32, default 10, **maximum 25** |
| `start` | ISO 8601 datetime, inclusive |
| `end` | ISO 8601 datetime, exclusive; defaults to now |
| `nextToken` | Pass the previous response's `next_token` |

- The response shape is `{ records, next_token? }`, sorted newest first.
- If `next_token` is missing, you are on the last page.
- **Observed but not documented:** WHOOP returns `next_token: null` and explicit `null` for optional fields. This broke strict zod schemas in shashank #276. Parse every optional field with `.nullish()`.

### Rate limits

- **Defaults:** 100 requests per minute **and** 10,000 per day. Both apply. Going over either returns 429.
- **Headers:**
  - `X-RateLimit-Limit` uses a multi-window format, for example `100, 100;window=60, 10000;window=86400`. It needs a real parser, not `parseInt`.
  - `X-RateLimit-Remaining`
  - `X-RateLimit-Reset`, in seconds.
- **Raising the limits:** Dashboard → Open Request → "Rate limit increase".
- **Scope:** the docs talk about "an API key's rate limit", which suggests the limit is per app. They don't say so explicitly (**UNVERIFIED**).

### Webhooks (remote mode only; a stdio server can't receive them)

- **Events:**
  - `recovery`, `sleep` and `workout`, each `.updated` or `.deleted`. New records arrive as `.updated`.
  - There are no events for cycles, the profile or body measurements.
- **Payload:** `{ user_id: int64, id, type, trace_id }`.
  - In v2, `id` is a UUID.
  - Recovery events carry the **sleep UUID**, not the cycle ID.
- **Signature:**
  - Compute `base64(HMAC-SHA256(timestampHeader + rawBody, client_secret))` and compare it with `X-WHOOP-Signature`.
  - `X-WHOOP-Signature-Timestamp` is in milliseconds.
  - Compare in constant time and add our own replay window. The docs specify neither.
- **Delivery:**
  - Respond 2xx within about 1 second. That is a recommendation, not a hard limit.
  - WHOOP retries 5 times over about an hour.
  - Deliveries can be missed or duplicated, so deduplicate on `trace_id` and run a reconciliation poll.
- **Versioning:** chosen per URL in the dashboard. v2 is the default. v1 still appears in the dropdown, labelled legacy, and is no longer published.

---

## 3. Auth plan

### Flow (authorization code, confidential client)

**1. Authorize.** Send a GET to `.../oauth2/auth` with these parameters:

| Parameter | Value |
|---|---|
| `response_type` | `code` |
| `client_id` | the user's app client ID |
| `redirect_uri` | the registered loopback URI |
| `scope` | `offline read:recovery read:cycles read:sleep read:workout read:profile read:body_measurement`, space-separated (`URLSearchParams` encodes spaces as `+`; this works in practice per domestique, but WHOOP doesn't document the separator) |
| `state` | see the state rules below |

**2. Code exchange.** POST to `.../oauth2/token` with `application/x-www-form-urlencoded` and `grant_type=authorization_code`, `code`, `client_id`, `client_secret`, `redirect_uri`.
- WHOOP's own docs don't list this request body. It comes from domestique's working client.
- Discovery advertises `client_secret_post`, `client_secret_basic`, `private_key_jwt` and `none`.

**3. Refresh.** POST to the same URL with `grant_type=refresh_token`, `refresh_token`, `client_id`, `client_secret`, `scope=offline`.
- **Correction:** the docs never say `scope` is *required* on refresh. Their example includes it, and field reports suggest leaving it out causes problems (shashank #249). Always send it.
- **Body encoding:** the OAuth page shows a JSON-style body, while RFC 6749 and working clients use form-urlencoded. Default to form encoding and test JSON as a fallback (**UNVERIFIED**).

**4. Response.** Contains `access_token`, `expires_in`, `refresh_token`, `scope`, `token_type: bearer`.
- **Drive expiry from `expires_in`.** 3600 appears only in the sample response.

**5. Requests.** Send `Authorization: Bearer <token>`. An invalid or expired token returns 401.

**6. Logout.** Call `DELETE /developer/v2/user/access` (returns 204), then delete the stored tokens.

### Scopes

- The six data scopes are `read:recovery`, `read:cycles`, `read:workout`, `read:sleep`, `read:profile` and `read:body_measurement`.
- **`offline` is required to get a refresh token.** You can't select it in the dashboard; it is added only in the authorize request.
- The dashboard requires selecting at least one data scope.
- Discovery also lists `openid`. Whether WHOOP returns an id_token is **UNVERIFIED**. If it does, the userinfo `sub` could identify users on a future remote server.

### `state`

- The WHOOP docs say it "must be eight characters long" if you generate it yourself.
- fosite, which WHOOP's authorization server appears to be built on, enforces a minimum of 8 characters (`MinParameterEntropy = 8`).
- **Plan:**
  - Generate it with a CSPRNG (`crypto.getRandomValues`), never `Math.random`. domestique uses `Math.random`, which is a security regression to avoid.
  - Default to a long base64url value.
  - Verify early that WHOOP accepts it. If it doesn't, fall back to exactly 8 CSPRNG characters, which satisfies both readings.

### Redirect URI

- WHOOP requires an exact match with a URI registered in the dashboard. Its examples show only `https://` and `whoop://` URIs.
- **Whether the dashboard accepts `http://127.0.0.1` or `http://localhost` is UNVERIFIED.**
- **fosite's matching rules:**
  - It compares strings exactly; trailing slashes and ports count.
  - It has an RFC 8252 loopback exception: a registered `http://127.0.0.1/...` or `http://[::1]/...` matches any port.
  - That exception doesn't cover `localhost`, and `127.0.0.1` doesn't match `::1`.
  - Whether WHOOP runs this fosite version is unverified.
- **Recommendation:**
  - Register `http://127.0.0.1:<fixed port>/callback` and make the port configurable.
  - Document fallbacks: `https://localhost` with a self-signed certificate, or a tunnel. The self-signed-certificate requirement comes from a community report and is unverifiable.

### PKCE

- Not mentioned in WHOOP's docs, and discovery doesn't list `code_challenge_methods_supported`.
- Sending S256 as defence-in-depth is probably harmless (**UNVERIFIED**). Test it, and make it optional.
- The client secret is required either way.

### Refresh behaviour and pitfalls

1. **Rotation is single-use.** A refresh invalidates the old refresh token *and* any existing access tokens. If two refreshes run at once, the second fails.
   - Whether WHOOP also detects reuse and revokes the whole grant (as Hydra can) is unverifiable. Assume the worst case: one race means the user has to log in again.
2. **Single-flight within the process.** Keep one shared `refreshPromise` that every concurrent call awaits.
3. **Cross-process lock.** Use `fs.openSync(lockPath, 'wx')` with the PID inside and a stale-lock timeout, or `proper-lockfile` 4.1.2. While holding the lock:
   1. Re-read the store.
   2. Skip the refresh if another process already rotated the token.
   3. Refresh.
   4. **Write atomically before using the new token**: write a temp file, chmod 0600, rename.
   5. Release the lock.
4. **On a 401:** first re-read the store, because another process's refresh may have invalidated our cached access token. Use the newer token if there is one. Otherwise refresh under the lock and retry once.
5. **Refresh proactively** when less than about 120 seconds remain.
6. **On `invalid_grant`:** stop. Return a tool error saying "run `whoop-mcp login`". Never loop.
7. **Never read a response body twice.** That bug blocked shashank's 401 refresh path (#219).
8. **The refresh-token lifetime is undocumented.** Expect tokens that sit unused for a long time to die.
9. WHOOP suggests a background cron refresh. That doesn't suit short-lived stdio processes; lazy refresh behind the lock is enough.

**Other failure modes to handle:**
- No refresh token was issued because `offline` was missing from the request.
- A `state` that is too short.
- Redirect URI mismatches.
- `request_forbidden` after consent, attributed to sandbox, member or scope restrictions in a community report (**UNVERIFIED**).
- Old tutorials that still use v1.

### Login UX (stdio)

- **A separate `whoop-mcp login` CLI**, run outside the MCP process:
  - It starts `Bun.serve({ hostname: "127.0.0.1", port, routes: { "/callback": ... } })`.
  - It opens the browser (`open`, `xdg-open` or `start`) and also prints the URL.
  - It checks `state`, exchanges the code, saves the tokens and shows a "you can close this tab" page.
  - It calls `server.stop()` and gives up after about 5 minutes.
- **Never write to stdout** from the MCP server. stdout carries JSON-RPC; logs go to stderr.
- **Optional login from inside a conversation:** when no tokens exist, a tool returns "run login". URL-mode elicitation through MRTR `inputRequired` is another option, but client support is **UNVERIFIED**, so the CLI comes first.

### Local token storage

1. **Primary: `Bun.secrets`** (added in Bun v1.2.21, still experimental and slow).
   - Backends: macOS Keychain, libsecret on Linux, Windows Credential Manager.
   - **Every method is async:** `get` returns `Promise<string|null>`, `set` returns `Promise<void>`, `delete` returns `Promise<boolean>`.
   - The `persist` option affects Windows only.
   - The maximum value size depends on the platform, typically 2048–4096 bytes.
   - Store one JSON blob: `{access_token, refresh_token, expires_at, scope}`.
   - macOS may show a keychain prompt; Linux needs a running secret-service daemon.
2. **Fallback: `$XDG_CONFIG_HOME/whoop-mcp/tokens.json`**, by default `~/.config/whoop-mcp/tokens.json`.
   - Directory mode 0700, file mode 0600, written atomically.
   - Needed for Linux without libsecret, CI and Docker.
   - ToU §2.4 requires encryption at rest, so consider encrypting this file. A plain 0600 file may not satisfy §2.4 (an open question).
3. **Don't use `keytar`.** It has been archived since December 2022 and is a native addon.
4. **Client credentials:** `WHOOP_CLIENT_ID` and `WHOOP_CLIENT_SECRET` come from environment variables in the MCP client config, from MCPB `user_config` with `sensitive: true`, or from the same keychain entry. Never ship them in the package (§3.2.1).

### When MCP's own auth matters

- **stdio:** the MCP spec says stdio servers "SHOULD NOT follow" its authorization spec and should take credentials from the environment. Nothing to do.
- **A remote Streamable HTTP server** would need all of this:
  - its own OAuth 2.1 authorization server
  - RFC 9728 Protected Resource Metadata
  - 401 responses with `WWW-Authenticate: Bearer resource_metadata=…`
  - audience validation (RFC 8707)
  - CIMD (DCR is deprecated in 2026-07-28)
  - a WHOOP grant stored separately per user
- **WHOOP can't be the MCP authorization server.** Its metadata has no PKCE methods, it offers no CIMD or DCR, and it requires a confidential client. Passing tokens through is forbidden.
  - The PKCE-refusal and passthrough wording comes from the 2025-11-25 spec. Whether 2026-07-28 keeps that exact wording is unverified.
- **Two 2026-07-28 nuances:**
  - The `offline_access` rule only stops servers from *advertising* it.
  - Clients validate `iss` only when it is present, and WHOOP doesn't advertise support for it.

---

## 4. Existing WHOOP MCP servers

### Built on the official v2 API

| Project | Stack | Activity (2026-10-27) | Auth | Tools | What it does well | Problems |
|---|---|---|---|---|---|---|
| [shashankswe2020-ux/whoop-mcp](https://github.com/shashankswe2020-ux/whoop-mcp) (npm `whoop-ai-mcp` 1.1.0) | TS/Node 20+ | 175★, 2,866 downloads/month, the most used | Own dev app, localhost:3000, browser OAuth on start | 16 core tools plus 9 HYROX/triathlon tools, 4 resources, 5 prompts | Relative dates, baselines and percentiles, regression trends, `data_quality` flags, aggregate mode, `setup --client=` | Refresh without `scope=offline` (#249), body read twice (#219), draft-07 outputSchema (#251), null `next_token` (#276), cache assumes a single identity (#172), scope creep |
| [yuridivonis/whoop-mcp-server](https://github.com/yuridivonis/whoop-mcp-server) | TS, Docker | 16★ / 193 forks (Railway template) | Remote, OAuth 2.1, password-gated, tokens encrypted at rest | 6 | Remote-first; stopped storing health data in v1.3.0 | Needs hosting; small toolset |
| [davidmosiah/whoop-mcp](https://github.com/davidmosiah/whoop-mcp) (`whoop-mcp-unofficial` 0.6.7) | TS/Node, better-sqlite3 | 14★, 1,725 downloads/month | `setup`/`auth`/`doctor` CLI | About 27 | `response_format`, confidence values, demo mode, privacy audit | draft-07 schema (#21); SQLite cache conflicts with §4.2.2 |
| [oryanomer1/whoop-mcp](https://github.com/oryanomer1/whoop-mcp) (`@oryanomer/whoop-mcp` 1.0.3) | TS/Node 20.11+ | 1★, 888 downloads/month, new | Own dev app, 0600 token file | 10 | **Compact normalized units with `raw:true`**, automatic pagination up to 200, GET-only client enforced by a test, `readOnlyHint`, ships `.mcpb` and a Claude Code plugin | Little track record |
| [AlixAkhribi/mcp-whoop](https://github.com/AlixAkhribi/mcp-whoop) (`mcp-whoop` 0.8.0) | TS/Node 22+, **SDK v2** | 322 downloads/month | Loopback CLI plus a login offer inside the conversation | 14, gated by granted scopes | Targets spec 2026-07-28, validates env at startup, logs to stderr only | Pre-1.0 |
| [Yadheedhya06/mcp-server-whoop](https://github.com/Yadheedhya06/mcp-server-whoop) | TS/Node 18+ | 1★, listed in the official registry | 0600 credentials file with path checks | 5 | Minimal; `processing` status, provisional strain, no cache, SBOM and CodeQL | Narrow coverage |
| [vicens-aniol/whoop-mcp](https://github.com/vicens-aniol/whoop-mcp) | TS on Cloudflare Workers | 0★ | Full OAuth 2.1 authorization server (PKCE, DCR, CIMD, RFC 8414/9728/7009) | 13, mostly 1:1 | **Refresh serialized per user in a Durable Object**; signed webhooks | Spanish UI; no analytics |
| [nchemb/whoop-mcp](https://github.com/nchemb/whoop-mcp) | TS/Node 22.13+ | 3★ | Shared OAuth relay, capped at 100 users | 6, including `whoop_query` (SQL) | 6-month backfill into SQLite | Every refresh passes through the author's relay; database conflicts with §4.2.2 |
| [VelkyVenik/missingmcp](https://github.com/VelkyVenik/missingmcp) | Python gateway | 16★ | Multi-user OAuth 2.1, AES-GCM tokens | About 8 | No install needed | 100-user cap; requires trusting a third party |
| [RomanEvstigneev/whoop-mcp-server](https://github.com/RomanEvstigneev/whoop-mcp-server) | Python | 27★, stale since 2025-07 | Author-hosted relay | 5 | | Hit the "user limit" (#1), expired links (#4, #2) |
| [nissand/whoop-mcp-server-claude](https://github.com/nissand/whoop-mcp-server-claude) | TS | 16★, stale | Auth code pasted into chat | About 16, 1:1 | | Hardcoded secret (#11); tokens pass through the LLM context |

Smaller projects: JasonBates, jonnyhaynes, AshwanthramKL, rajdeepmondaldotcom, Zayden16 (Go), cunicopia-dev (Postgres) and open-wearables (2,724★, multi-device). [Glama lists more than 20](https://glama.ai/mcp/servers?query=whoop).

### Built on the private API (avoid)

| Project | Notes |
|---|---|
| [thebriangao/totem](https://github.com/thebriangao/totem) | 136★, 55 tools, including writes and private features. Uses Cognito email, password and MFA, impersonates the iOS client, needs re-login about every 30 days. The author says it is against the ToS. Its architecture is worth copying: zod projections, fixture tests, a `raw` escape hatch |
| [JedPattersonn/whoop-mcp](https://github.com/JedPattersonn/whoop-mcp) | **The only Bun precedent.** Stale (last push 2025-10-28), private API. Its smithery.yaml puts email and password in the config schema. That Smithery passes them as query params is an inference the repo doesn't show (only partly verified) |
| [ctvidic/whoop-mcp-server](https://github.com/ctvidic/whoop-mcp-server) | Broken install |

### Reusable TypeScript clients

- **[`whoopper`](https://github.com/car1os/whoopper) 0.1.2:**
  - Zero dependencies and covers every v2 endpoint.
  - Has an iterator, a `TokenStore` interface and unit helpers.
  - Stale, with 26 downloads a month. Whether it serializes refreshes is **UNVERIFIED**.
  - Learn from it or vendor parts of it.
- **[`@kaiord/whoop`](https://www.npmjs.com/package/@kaiord/whoop):** tied to its own framework.
- **[`@crvouga/mockingbird-service-whoop`](https://www.npmjs.com/package/@crvouga/mockingbird-service-whoop) 1.9.0:** a stateful WHOOP v2 emulator that also simulates OAuth refresh. **Use it for CI.**

### Problems that recur across projects

1. Races on rotating refresh tokens, causing re-auth loops.
2. `outputSchema` strictness.
   - Claude clients reject draft-07 and want JSON Schema 2020-12. This comes from issue #251, not from a primary Anthropic source.
   - Null-versus-optional mismatches.
3. Shared OAuth apps hit the user caps, and WHOOP approvals stall.
4. Local stdio servers can't reach claude.ai web or mobile, or ChatGPT.
5. Secrets in chat, in query params, or hardcoded.
6. Private-API drift.

### Gaps we can fill

| Gap | What we'd do |
|---|---|
| **Bun-native single binary** | Use `bun build --compile` per OS. No Node version problems, fast cold start. |
| **Correct token handling as a headline feature** | In-process single-flight plus cross-process lock, persist before use, re-read on 401, always send `scope=offline`, keychain storage. No local server does multi-process locking well. |
| **Schemas that tolerate WHOOP's data** | `.nullish()` everywhere, 2020-12 `outputSchema` or none, contract tests against fixtures and the emulator. |
| **Output that is cheap on tokens and accurate** | Converted units, explicit `score_state`, server-side aggregation, a `response_format` option. The best existing ideas are spread across oryanomer, Yadheedhya06 and shashank. |
| **Server-side analytics** | Baselines and z-scores, acute:chronic strain, sleep debt, lagged correlations, sample counts and missing days, without shashank's bloat. |
| **Rate-limit awareness** | Nobody tells the model how much quota is left. |
| **Caching that respects the ToU** | Memory only. Several projects keep SQLite or Postgres mirrors. |
| **Resources and prompts** | Rare in existing projects and cheap to add. |
| **Onboarding** | A guided `setup` command with the exact dashboard fields, `doctor` and status tools, and a synthetic demo mode. |
| **Later: one codebase for local and remote** | Optional Streamable HTTP plus OAuth 2.1 plus webhooks. |

---

## 5. Recommended stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | **Bun 1.4.4** | Built-in `fetch`, `Bun.serve` (callback, later HTTP), `Bun.secrets`, `bun test`, `--compile`. Few dependencies. |
| MCP SDK | **`@modelcontextprotocol/server` 2.4.0** (published 2026-10-23) | See below. |
| Schemas | **`zod` ^4.2.0** via `import * as z from 'zod/v4'`, with `"overrides": { "zod": "^4.2.0" }` | The SDK requires zod 4. Two zod copies in the tree cause TS2589 and type errors. Whether zod v3 schemas work is **UNVERIFIED**; assume they don't. |
| Transport | **stdio via `serveStdio(factory)`** | Fits Claude Desktop and Claude Code. Later, `createMcpHandler(factory)` returns a `{ fetch }` object that Bun serves directly. |
| Types | `bunx openapi-typescript https://api.prod.whoop.com/developer/doc/openapi.json -o src/whoop.d.ts`, filtering out `/v2/partner/*` | Generated from the spec. Add the gaps by hand: `offline` scope, error bodies, nullability. |
| Runtime validation | Hand-written zod projections over the generated types, `.nullish()` throughout | Tolerates WHOOP's quirks and catches drift (totem's pattern). |
| HTTP client | A thin wrapper over `fetch` | Bearer auth, 401 → re-read store / refresh once, 429 backoff using `X-RateLimit-Reset`, multi-window header parser, logs `x-whoop-trace-id` to stderr, GET-only (enforced by a test). |
| Cache | **In-memory LRU with short TTLs, keyed by user ID and query** | See below. |
| Token storage | `Bun.secrets`, then a 0600 file (encryption optional) | See §3. |
| Locking | `fs.openSync(...,'wx')` lockfile or `proper-lockfile` 4.1.2 | Cross-process refresh. |
| Testing | `bun test` + SDK `InMemoryTransport` (both halves from the same package) + mockingbird emulator + recorded fixtures (synthetic or scrubbed) + MCP Inspector 2.12.0 | See below. |
| Packaging | (1) `bun build --compile --minify --bytecode` for darwin-arm64/x64, linux-x64/arm64 (+musl), windows-x64; (2) npm package with a `bin` entry for `bunx`; (3) MCPB `manifest_version: "0.3"`, `server.type: "binary"` with `platform_overrides`; (4) official registry `server.json` | See below. |

**Why SDK v2 rather than the alternatives:**
- It is runtime-neutral, and its README says it runs on Bun.
- It targets spec 2026-07-28, and its `serveStdio` default (`legacy:'serve'`) also serves 2025-era clients that start with `initialize`. Which revision Claude clients negotiate today is unverifiable, and this default makes that safe.
- It doesn't pull in Express. The legacy `@modelcontextprotocol/sdk` 1.32.2 hard-depends on express, hono, cors, ajv and more, and has a duplicate-zod issue (#2011).
- The v2 packages are widely used: about 44M and 29M downloads a month.
- **Alternatives:**
  - FastMCP 4.23.8 targets the 2025-11-25 spec or earlier.
  - mcp-lite is stale and has no stdio.
  - xmcp and mcp-handler are heavy or Next.js-focused.
  - `@hono/mcp` is v1-only.
  - `tmcp`'s spec support is UNVERIFIED.

**Why the cache stays in memory:**
- §4.2.2 bans databases, permanent copies, and caching beyond what cache headers allow.
- §7.1 requires deleting data when access ends.
- So don't use `bun:sqlite` by default. If we ever add a persistent cache, make it opt-in and encrypted, with a purge command, and get legal review first.

**Testing notes:**
- Don't use real WHOOP data in eval or test datasets. §4.2.3 bans using the data to "develop" or "test" AI systems.
- Inspector's `--protocol-era legacy|modern` tests both spec eras.
- Without a keychain, Inspector stores env secrets **unencrypted** in `~/.mcp-inspector/secrets.json`.

**Packaging notes:**
- **The packaging decision:** Bun-only APIs (`Bun.secrets`) mean the npm package runs only under `bunx` or as the compiled binary. A `--target=node` build would need a different secret store.
- **Compile flags:**
  - Pass `--no-compile-autoload-dotenv` and `--no-compile-autoload-bunfig`; these are separate flags.
  - macOS signing needs `codesign` with JIT entitlements, on Bun 1.2.4 or later.
- **Registry listing:**
  - `mcpName` should be `io.github.<user>/whoop`.
  - `server.json` uses the 2025-12-11 schema. Whether a newer schema exists is unverifiable.
  - Run `mcp-publisher validate` before publishing.
- **MCPB tooling:** the `mcpb` CLI 2.1.2 was last published on 2025-12-04 and still depends on zod 3. Keep it out of our dependency tree and install it globally.

**SDK usage notes:**
- Use `registerTool`, `registerResource` and `registerPrompt`, with `inputSchema` and `outputSchema` as `z.object(...)`. Exact resource and prompt signatures aren't confirmed.
- Set annotations `readOnlyHint: true` and `idempotentHint: true`.
- Return `structuredContent` together with a short text rendering.
- Argument validation failures become `isError: true` results, which the model can read and retry from.
- `maxToolInputElements` goes in the constructor's *second* (options) argument and is off by default.
- The transport's `maxRequestBodySize` is 4 MiB.
- Return tools from `tools/list` in a deterministic order.
- **2026-07-28 details:**
  - The log level is set per request in `_meta`; don't emit `notifications/message` unless the request asked for it.
  - Error codes were renumbered: -32022 is unsupported protocol version, -32020 is header mismatch, -32021 is a missing required client capability.
  - `serverInfo` should go in each result's `_meta`. Whether the SDK adds it automatically is unverified.
  - Server-minted handles replace sessions.
- **For later HTTP mode:**
  - Wrap the handler with `localhostAllowedHostnames()` / `localhostAllowedOrigins()`. The handler does no Host or Origin validation (issue #2844).
  - `Bun.serve`'s default `idleTimeout` of 10 s needs raising, or call `server.timeout(req, 0)`.

**Host limits to design for:**
- **Claude Code:** warns above 10k tokens of output and caps at 25k by default (`MAX_MCP_OUTPUT_TOKENS`). `MCP_TOOL_TIMEOUT` defaults to about 28 hours. A per-server timeout below 1000 ms is ignored.
- **Claude Desktop:** requires absolute paths. Use the absolute path to `bun` or to the binary, since GUI apps may not inherit the shell PATH (a practical precaution, unverified). Server stderr goes to `~/Library/Logs/Claude/mcp-server-NAME.log`.

---

## 6. Proposed tool surface

### Shared conventions

- **Prefix and annotations:** every tool is prefixed `whoop_` and marked `readOnlyHint: true` and `idempotentHint: true`.
- **Dates:**
  - Inputs are `start_date` / `end_date` as `z.iso.date()` (`YYYY-MM-DD`), optionally with `days` (for example 7).
  - Ranges are interpreted in the user's local time zone and converted using the record's `timezone_offset`.
  - The default range is 7 days and the maximum is 90, with an explicit truncation note.
- **`response_format`:** `"concise"` (default) or `"detailed"`. Concise mode returns about a third of the tokens.
- **`raw`:** a boolean, default false. When true, the original WHOOP objects are included.
- **Units:** hours and minutes, kcal (from kJ), km, % and local ISO time. IDs are hidden unless `detailed` or `raw` is set.
- **`data_quality` on every result:**
  - `score_state` counts
  - `pending` / `unscorable` / `calibrating` flags
  - sample count (`n`)
  - missing days
  - **never** substitute an older recovery for a missing one
- **Every result ends with a one-line not-medical-advice note** (§3.1.10 and §3.1.11).
- **`meta` on every result:** remaining rate-limit quota and the data as-of time.
- **Errors** are actionable `isError: true` text, for example "end_date must be ≥ start_date (YYYY-MM-DD)" or "Not logged in: run `whoop-mcp login`".

### Tools

| Tool | Parameters | Returns |
|---|---|---|
| `whoop_today` | `date?` (default today), `response_format` | One snapshot: last night's sleep (duration, stage breakdown, performance/efficiency, sleep needed vs. obtained), today's recovery (score, HRV, RHR, SpO2/skin temp if available), the current cycle's strain so far (marked provisional if the cycle is open), steps if present, today's workouts. Joins the cycle, recovery, sleep and workout endpoints |
| `whoop_daily_summaries` | `start_date`, `end_date` or `days`, `response_format`, `raw` | One row per day: recovery %, HRV, RHR, sleep hours/performance, day strain, kcal, workouts count, steps. Paging is handled inside the server |
| `whoop_trends` | `metric` (enum: `recovery`, `hrv`, `rhr`, `sleep_duration`, `sleep_performance`, `strain`, `steps`, `respiratory_rate`, …), `days` (default 30, max 90), `response_format` | Mean, median, min, max, standard deviation, linear slope per week, 7-day rolling values, the latest value vs. the period's percentile, `n`, missing days |
| `whoop_baselines` | `days` (default 30), `metrics?` | A personal baseline (mean, standard deviation, p10/p50/p90) per metric, with a minimum sample count; plus today's z-score per metric |
| `whoop_compare_periods` | `period_a` {start_date, end_date}, `period_b` {…}, `metrics?` | Side-by-side means, absolute and % change, `n` per period |
| `whoop_training_load` | `days` (default 28) | Daily strain, 7-day acute and 28-day chronic load, acute:chronic ratio, sleep debt (from `sleep_needed`), workout time per HR zone |
| `whoop_correlate` | `x_metric`, `y_metric`, `lag_days` (0–3), `days` (max 90) | Pearson/Spearman correlation and `n`; example: "strain > 15 vs. next-day recovery". Includes a note that correlation is not causation |
| `whoop_workouts` | `start_date`, `end_date` or `days`, `sport?` (matched on `sport_name`), `response_format`, `raw` | A list: sport, local start time, duration, strain, average and max HR, kcal, distance, altitude, time in zones, `percent_recorded`; plus totals grouped by sport |
| `whoop_sleep_detail` | `date?` or `start_date`/`end_date`, `include_naps` (default false) | Per-sleep stages, disturbances, sleep cycles, sleep-needed breakdown, consistency and efficiency |
| `whoop_profile` | none | Name, height, weight, max HR. Email only when `detailed` |
| `whoop_get_record` | `type` (`cycle`, `sleep`, `workout`, `recovery_for_cycle`, `sleep_for_cycle`), `id` | The escape hatch: one normalized record, plus the raw object |
| `whoop_status` | none | Auth state, granted scopes, token expiry, rate-limit quota, cache stats, server version. Works without a login, as the "doctor" |

**Kept out of the MCP tool surface:**
- `login`, `logout` (revoke plus delete) and `purge-cache` are CLI subcommands, so the LLM can't do anything destructive or touch credentials.
- If we expose logout later, make it a tool with `destructiveHint: true` and a required `confirm: true` (vicens-aniol's pattern).

**Tool gating:** tools whose scopes weren't granted are hidden (mcp-whoop's pattern).

### Resources and prompts (cheap extras)

- **Resources:**
  - `whoop://today`
  - `whoop://baselines`
  - `whoop://sports` (the sport_name list)
- **Prompts:**
  - `weekly_review`
  - `sleep_analysis`
  - `training_load_check`
- The descriptions tell the model to avoid diagnostic or medical framing.

### Demo mode

- `WHOOP_MCP_DEMO=1` serves synthetic data, for trying the server out and for evals without real data.

---

## 7. Project layout and milestones

```
whoop-mcp/
├─ package.json            # bin: whoop-mcp; mcpName; overrides.zod
├─ bunfig.toml / tsconfig.json
├─ manifest.json           # MCPB 0.3, server.type=binary, user_config (client id/secret, sensitive)
├─ server.json             # MCP registry metadata
├─ src/
│  ├─ index.ts             # CLI entry: `serve` (default) | `login` | `logout` | `status` | `purge-cache` | `setup`
│  ├─ server.ts            # createServer() factory: registers tools/resources/prompts
│  ├─ whoop/
│  │  ├─ openapi.d.ts      # generated (partner paths filtered)
│  │  ├─ schemas.ts        # zod v4 projections (.nullish())
│  │  ├─ client.ts         # fetch wrapper: auth, 401 path, 429 backoff, rate-limit parser, trace-id log
│  │  └─ paginate.ts       # async iterator over next_token, range caps
│  ├─ auth/
│  │  ├─ oauth.ts          # authorize URL, code exchange, refresh (form-encoded)
│  │  ├─ login.ts          # Bun.serve 127.0.0.1 callback, state check, timeout
│  │  ├─ store.ts          # TokenStore: BunSecretsStore | FileStore (atomic 0600)
│  │  └─ refresh.ts        # single-flight + cross-process lock + persist-before-use
│  ├─ domain/
│  │  ├─ normalize.ts      # units, local time, score_state handling
│  │  ├─ daily.ts          # cycle↔recovery↔sleep↔workout join
│  │  └─ analytics.ts      # baselines, trends, ACWR, correlation
│  ├─ tools/*.ts           # one file per tool
│  ├─ cache.ts             # in-memory LRU, TTL, keyed by user_id
│  └─ log.ts               # stderr only
├─ test/
│  ├─ fixtures/            # synthetic/scrubbed responses (incl. nulls, PENDING_SCORE, open cycle)
│  ├─ refresh.race.test.ts # concurrent + multi-process refresh
│  ├─ tools.test.ts        # InMemoryTransport end-to-end
│  └─ emulator.test.ts     # mockingbird WHOOP emulator
└─ scripts/build.ts        # cross-compile matrix, codesign
```

### Milestones

| # | Milestone | Done when |
|---|---|---|
| M0 | **Spike and verification** (½–1 day) | Dev app created. Probes run: http://127.0.0.1 redirect acceptance; `state` length; form vs. JSON token body; PKCE with the secret; whether `scope=offline` on refresh matters; `expires_in`; whether `openid` returns an id_token. SDK v2 smoke test under `bun run` **and** `bun build --compile` with stdio. Results recorded in `docs/verification.md` |
| M1 | **Auth core** | `login` / `logout` / `status` CLI. Both token stores. Single-flight plus cross-process lock. 401 re-read path. Race tests pass |
| M2 | **API client** | Generated types, zod projections, pagination iterator, rate-limit parser, 429 backoff, in-memory cache. Contract tests against fixtures and the emulator |
| M3 | **First tools** | `whoop_today`, `whoop_daily_summaries`, `whoop_workouts`, `whoop_sleep_detail`, `whoop_profile`, `whoop_status`, `whoop_get_record`. Checked with Inspector (both protocol eras) and in Claude Code and Claude Desktop |
| M4 | **Analytics** | `whoop_trends`, `whoop_baselines`, `whoop_compare_periods`, `whoop_training_load`, `whoop_correlate`. Resources and prompts. Demo mode |
| M5 | **Packaging** | Cross-compiled binaries, signed on macOS. npm/bunx package. `.mcpb`. `setup` command writes client configs. Registry `server.json`. README with exact dashboard steps |
| M6 (optional) | **Remote mode** | `createMcpHandler` on `Bun.serve` with Host/Origin validation. Our own OAuth 2.1 authorization server (RFC 9728, CIMD, PKCE). Encrypted WHOOP grant per user. Webhooks with HMAC, `trace_id` dedup and cache invalidation. Needs a ToU and legal review first (§3.1.3, §4.2.1) |

---

## 8. Open questions, risks and unverified items

### WHOOP OAuth and platform (resolve in M0)

1. **Redirect URIs:** does the dashboard accept `http://127.0.0.1:<port>/callback` and `http://localhost`? The `https://localhost` with a self-signed certificate workaround and the `request_forbidden` failure are unverifiable community reports.
2. **`state` length:** does WHOOP accept more than 8 characters? fosite says at least 8; the docs literally say "eight".
3. **Token request encoding:** is the body form-urlencoded, JSON, or either? Is the client authenticated with body parameters or HTTP Basic?
4. **PKCE:** is S256 accepted alongside the client secret?
5. **`scope=offline` on refresh:** actually required, or just good practice?
6. **Token lifetimes:**
   - The refresh-token TTL is unknown.
   - The exact access-token lifetime is unknown; read it from `expires_in`.
7. **Reuse detection:** does reusing a rotated refresh token revoke the whole grant? This rests on Hydra behaviour and is unverifiable.
8. **The `openid` scope:** does it return an id_token? Does the `/oauth2/revoke` endpoint work for WHOOP clients?
9. **Authorization server identity:** that WHOOP runs Ory Hydra/fosite is inferred from fingerprints, not confirmed.
10. **Membership requirement:** is a paid WHOOP membership needed to create a developer app?

### API behaviour

11. Are rate limits per app or per user?
12. What do error response bodies look like?
13. Do the v1 data endpoints still respond? Irrelevant if we stay on v2.
14. The required scope for `GET /v2/cycle/{id}/sleep`: probably `read:sleep`.
15. Is `next_token: null` and explicit `null` behaviour documented? (It is observed, not documented.)
16. The `sport_id` / `sport_name` pairing in the docs example (unverifiable).
17. Was `step_count` really added without needing re-consent?
18. The webhook replay window: undefined, so we define our own.

### MCP and Bun

19. Which protocol revision Claude Desktop and Claude Code negotiate (covered by the legacy fallback).
20. Whether SDK v2 has any Bun or `--compile` bugs. None are known, but smoke-test in M0.
21. Exact `registerResource` and `registerPrompt` signatures in v2.
22. Whether the SDK adds `serverInfo` to `_meta` automatically.
23. Whether the 2026-07-28 security page keeps the PKCE-refusal wording.
24. Client support for URL-mode elicitation.
25. Whether `Bun.secrets` behaves well on headless Linux and the keychain prompt UX on macOS. It is experimental.
26. How `bunx` handles shebangs (no primary source was fetched).
27. Whether a `server.json` schema newer than 2025-12-11 exists.
28. Whether `fastmcp`'s suggested "ViteMCP" or `tmcp` support 2026-07-28 (not researched; not needed).

### Terms of Use and legal risks

**The ToU became effective on 2026-10-06 and WHOOP can change it at any time (§9.1). Re-check it before release.**

- **§4.2.3, AI and ML:** bans using WHOOP data to "create, develop, test, train, fine-tune or improve" AI or ML systems.
  - Sending data to an LLM for inference isn't expressly banned, but it isn't expressly allowed either. This is the biggest ambiguity for an MCP server.
  - Don't log conversations or build datasets from real data.
- **§4.2.1, third parties:** exposing data to third parties requires the user's explicit opt-in. An LLM provider is arguably a third party.
  - Mitigation: a first-run consent notice in `login` and in the README.
- **§4.2.2 and §7.1, storage:** no databases or permanent copies, and delete data when access ends.
  - Mitigation: an in-memory cache and a `purge-cache` command.
  - Whether a personal-use local cache violates §4.2.2 is a legal question (unverified, not legal advice).
- **§2.4, security:** encrypt data at rest and report security incidents within 48 hours. Does a 0600 plaintext token file comply? Probably not; prefer the keychain or encrypt the file.
- **§3.2.1, credentials:** no developer credentials in open-source code, so every user needs their own dev app. A shared relay would bring back the user caps and the stalled approvals.
- **§3.1.2 and §3.1.3, redistribution:** no selling or redistributing data, and no marketing or licensing it to third parties even with consent. This matters for hosted or remote mode.
- **§3.1.10 and §3.1.11, medical:** no medical-device use and no medical, legal or professional advice. Add disclaimers and keep analytics wording non-diagnostic.
- **§5.1 and §5.2, branding:** no WHOOP logos, no implied endorsement, and no public statements without approval. Pick the name and README wording with care.
- **§1.4, §3.1.12 and §3.1.13, access methods:** documented means only; no reverse engineering or circumventing controls. This rules out private-API features.
- **App approval** (only relevant if we go beyond 10 users):
  - Approval is manual and can take months.
  - You need at least 50% of your current tier's limit connected (from Build onward) and testing with at least one member.
  - You need a privacy policy and a contact email.
  - Don't contact staff outside the dashboard.
- **Research numbering:** the two reports numbered the ToU sections differently. This brief uses the rendered page's numbering, which the fact-checker confirmed.

---

## 9. Sources

**WHOOP (primary)**
- https://developer.whoop.com/api (also https://developer.whoop.com/api/)
- https://api.prod.whoop.com/developer/doc/openapi.json
- https://api.prod.whoop.com/oauth/.well-known/openid-configuration
- https://developer.whoop.com/docs/developing/oauth
- https://developer.whoop.com/docs/tutorials/refresh-token-javascript
- https://developer.whoop.com/docs/developing/getting-started
- https://developer.whoop.com/docs/developing/app-approval
- https://developer.whoop.com/docs/developing/rate-limiting
- https://developer.whoop.com/docs/developing/webhooks
- https://developer.whoop.com/docs/developing/user-data/workout
- https://developer.whoop.com/docs/developing/v1-v2-migration
- https://developer.whoop.com/docs/api-changelog/
- https://developer.whoop.com/api-terms-of-use/
- https://developer-dashboard.whoop.com
- https://www.community.whoop.com/t/no-response-on-api-app-approval-to-raise-the-10-user-limit/15246

**OAuth server internals and references**
- https://github.com/ory/fosite/blob/master/fosite.go
- https://github.com/ory/fosite/blob/master/authorize_request_handler.go
- https://github.com/ory/fosite/blob/master/authorize_helper.go
- https://www.ory.com/docs/hydra/guides/graceful-token-refresh (not fetched)
- https://raw.githubusercontent.com/gesteves/domestique/main/src/scripts/whoop-oauth.ts
- https://nango.dev/docs/integrations/all/whoop.md
- https://tessl.io/registry/skills/github/Demerzels-lab/elsamultiskillagent/whoop (community, unverified)
- https://tryterra.co/blog/whoop-api-data-access-permissions-limitations-2026
- https://docs.tryterra.co/faq/help-topics/data-api-sdk/api-endpoints-errors-and-migrations/whoop-v1-to-v2-migration

**MCP spec and SDK**
- https://modelcontextprotocol.io/specification/versioning
- https://modelcontextprotocol.io/specification/latest
- https://modelcontextprotocol.io/specification/2026-07-28/changelog (also `.md`)
- https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/index.md
- https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation.md
- https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
- https://modelcontextprotocol.io/docs/2026-07-28/learn/versioning
- https://modelcontextprotocol.io/docs/develop/connect-local-servers
- https://github.com/modelcontextprotocol/typescript-sdk (README; docs: get-started/packages.md, first-server.md, servers/tools.md, servers/input-required.md, serving/stdio.md, serving/web-standard.md, serving/legacy-clients.md, troubleshooting.md, testing.md)
- typescript-sdk issues: #91, #709, #1269, #1564, #1987, #2011, #2844
- https://registry.npmjs.org/@modelcontextprotocol/server
- https://registry.npmjs.org/@modelcontextprotocol/sdk (and `/latest`)
- https://github.com/modelcontextprotocol/inspector (also clients/cli/README.md)
- https://registry.npmjs.org/@modelcontextprotocol/inspector
- https://github.com/modelcontextprotocol/mcpb (also MANIFEST.md)
- https://registry.npmjs.org/@anthropic-ai/mcpb
- https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/quickstart.mdx
- https://code.claude.com/docs/en/mcp
- https://www.anthropic.com/engineering/writing-tools-for-agents

**Frameworks**
- https://registry.npmjs.org/fastmcp
- https://github.com/punkpeye/fastmcp
- https://github.com/vitemcp/server
- https://github.com/fiberplane/mcp-lite
- https://registry.npmjs.org/mcp-lite
- https://registry.npmjs.org/xmcp
- https://registry.npmjs.org/@hono/mcp
- https://registry.npmjs.org/@modelcontextprotocol/hono
- https://registry.npmjs.org/mcp-handler
- https://registry.npmjs.org/tmcp

**Bun**
- https://registry.npmjs.org/bun/latest
- https://bun.com/docs/runtime/http/server
- https://bun.com/docs/bundler/executables
- https://bun.com/docs/runtime/secrets
- https://bun.com/blog/bun-v1.2.21
- https://bun.com/docs/runtime/sqlite
- https://www.theregister.com/2025/08/27/bun_js_toolkit_adds_mysql/

**Libraries**
- https://api.github.com/repos/atom/node-keytar
- https://registry.npmjs.org/proper-lockfile/latest
- https://github.com/car1os/whoopper
- https://www.npmjs.com/package/@kaiord/whoop
- https://www.npmjs.com/package/@crvouga/mockingbird-service-whoop
- https://www.nuget.org/packages/Whoop.Sdk/
- https://github.com/felixnext/whoopy
- https://pypi.org/project/whoop
- https://github.com/hedgertronic/whoop

**Existing MCP servers and surveys**
- https://freddy.coach/articles/whoop-mcp-servers
- https://glama.ai/mcp/servers?query=whoop
- https://github.com/shashankswe2020-ux/whoop-mcp (issues #172, #219, #249, #251, #276; references/tools.md)
- https://github.com/shashankswe2020-ux/whoop-mcp-rs
- https://github.com/yuridivonis/whoop-mcp-server
- https://github.com/davidmosiah/whoop-mcp (issues #17, #21)
- https://github.com/oryanomer1/whoop-mcp
- https://github.com/AlixAkhribi/mcp-whoop
- https://github.com/Yadheedhya06/mcp-server-whoop
- https://github.com/vicens-aniol/whoop-mcp
- https://github.com/nchemb/whoop-mcp
- https://github.com/VelkyVenik/missingmcp
- https://missingmcp.com/whoop
- https://github.com/RomanEvstigneev/whoop-mcp-server (issues #1, #2, #4)
- https://github.com/nissand/whoop-mcp-server-claude (issue #11)
- https://github.com/JasonBates/whoop-mcp-server
- https://github.com/jonnyhaynes/whoop-mcp-server
- https://github.com/AshwanthramKL/whoop-mcp
- https://github.com/rajdeepmondaldotcom/whoop-mcp-server
- https://github.com/Zayden16/whoop-mcp-server
- https://github.com/cunicopia-dev/whoop-mcp
- https://github.com/the-momentum/open-wearables
- https://github.com/thebriangao/totem (WHOOP.md; issues #2, #27)
- https://github.com/JedPattersonn/whoop-mcp (src/whoop-client.ts, smithery.yaml)
- https://github.com/ctvidic/whoop-mcp-server (issues #1, #4, #5)
- https://github.com/kabirrgrover/whoop-mcp-poke
- https://www.npmjs.com/package/@scom82/whoop-mcp
- https://github.com/jd1207/whoop-write-api
- https://github.com/koala73/whoopskill
- https://github.com/TomasWard1/whoop-cli
- https://github.com/xonika9/whoop-cli
- https://lobehub.com/mcp/aaronroef-whoop-mcp-server
- https://glama.ai/mcp/servers/AaronRoeF/whoop-mcp
- https://glama.ai/mcp/servers/@izqui/whoop-mcp
- https://www.getdrio.com/mcp/io-github-souravpn-whoop-mcp/md
- https://conductatlas.com/platform/whoop/whoop-terms-of-use/provision/CA-P-060226/prohibition-on-reverse-engineering-software/
- Private-API legacy: https://github.com/pelo-tech/whoop-api-spec, https://github.com/ianm199/unofficialWhoopAPI

### Local files

- Downloaded OpenAPI spec: `/private/tmp/claude-501/-Users-kamil-Documents-mcps/b6e65c69-e9fa-44c4-9eea-4eebeccd2b1e/scratchpad/spec/openapi.json`
- README snapshots of existing servers: `/private/tmp/claude-501/-Users-kamil-Documents-mcps/b6e65c69-e9fa-44c4-9eea-4eebeccd2b1e/scratchpad/readmes/`
