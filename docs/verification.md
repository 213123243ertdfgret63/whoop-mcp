# M0 verification log

This file answers the open questions in [RESEARCH.md §8](../RESEARCH.md) by testing them directly. `scripts/m0-probe.ts` writes raw probe output to `docs/m0-results.json`; that file is gitignored and never contains tokens. Record the conclusions here.

Status values: ✅ confirmed · ❌ refuted · ⏳ needs credentials · ❓ still open

## Confirmed without credentials (2026-10-27)

| #   | Question                                    | Result                                                                                                                                                            | Evidence                               |
| --- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| —   | OIDC discovery URL and endpoints            | ✅ The issuer is `https://api.prod.whoop.com/oauth/`. The auth, token and revoke endpoints match `src/config.ts`                                                  | `m0-probe public`                      |
| 3   | Client authentication at the token endpoint | ✅ Discovery advertises `client_secret_post`, `client_secret_basic`, `private_key_jwt` and `none`. ⏳ Still to check: which ones a dashboard app actually accepts | discovery                              |
| 4   | PKCE                                        | ❓ Discovery has **no** `code_challenge_methods_supported`. Since `none` is listed, public-client PKCE might work. ⏳ Test with `login --pkce`                    | discovery                              |
| 8   | `openid` scope                              | ✅ It is listed in `scopes_supported` (alongside `offline`; the read scopes aren't listed there). ⏳ Still to check: whether an id_token actually comes back      | discovery                              |
| —   | OpenAPI spec                                | ✅ It is OpenAPI 3.0.1 with 22 operations: 13 consumer and 9 partner                                                                                              | `m0-probe public`, `bun run gen:types` |
| 14  | Scope for `GET /v2/cycle/{id}/sleep`        | ❓ The spec declares **no** security on it, and none on `/v1/activity-mapping/{id}`. ⏳ Test with `m0-probe api`                                                  | openapi                                |
| 17  | `step_count` field                          | ✅ It is in the spec as `step_count?: number \| null` on Cycle. ⏳ Still to check: whether it shows up without re-consent                                         | `src/whoop/openapi.d.ts`               |

## MCP SDK / Bun (2026-10-27)

| #   | Question                                                          | Result                                                                                                                                                                                                                                                                | Evidence                                   |
| --- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 19  | Protocol eras                                                     | ✅ `serveStdio` serves **both**: 2026-07-28 (`server/discover`) and 2025-11-25 (`initialize`). Note that the v2 _client_ defaults to `versionNegotiation: legacy`, so it negotiates 2025-era unless you pin it; expect real clients to arrive on 2025-era for a while | `test/smoke.test.ts`                       |
| 20  | SDK v2 under `bun run` and `bun build --compile`                  | ✅ Both work over stdio. The compiled binary is about 84 MB on darwin-arm64                                                                                                                                                                                           | `WHOOP_MCP_BINARY=dist/whoop-mcp bun test` |
| 21  | `registerTool` / `registerResource` / `registerPrompt` signatures | ✅ Read from `dist/*.d.mts`. Pass schemas as `z.object(...)`; the raw-shape form is deprecated. A tool with no input gets the callback `(ctx)`. `registerResource(name, uri \| ResourceTemplate, config, cb)`                                                         | SDK types                                  |
| —   | Tooling                                                           | TS 7.0 has no JS API, so `openapi-typescript` runs through an isolated `bunx` (see `scripts/gen-types.ts`)                                                                                                                                                            |                                            |
| —   | Bun                                                               | 1.4.4 (Homebrew)                                                                                                                                                                                                                                                      |                                            |

## Needs a WHOOP developer app (run in this order)

Set up first:
- Create an app at <https://developer-dashboard.whoop.com>.
- Register the redirect URI `http://localhost:8787/callback`.
- Select every read scope.
- Put the client ID and secret in `.env`, copied from `.env.example`.

| #     | Command                                                                                            | Answers                                                                                                                                 |
| ----- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Dashboard: try registering `http://localhost:8787/callback`, then `http://127.0.0.1:8787/callback` | Which localhost redirect forms are allowed ⏳                                                                                           |
| 2     | `bun scripts/m0-probe.ts login` (32-character `state`) and, if that fails, `--state-len 8`         | Whether `state` longer than 8 characters is accepted ⏳                                                                                 |
| 3     | `login --auth basic`, after which the default `body` path will already have run                    | Which client authentication method works ⏳                                                                                             |
| 4     | `login --pkce`                                                                                     | Whether PKCE with the secret is accepted ⏳                                                                                             |
| 6     | Look at `token.expires_in` and `has_refresh_token` in the login output                             | Access-token lifetime, and whether `offline` returns a refresh token ⏳                                                                 |
| 8     | Look at `token.has_id_token`                                                                       | Whether `openid` returns an id_token ⏳                                                                                                 |
| 5     | `refresh`, then `refresh --no-offline-scope`                                                       | Whether `scope=offline` is needed on refresh, and whether the refresh token rotates ⏳                                                  |
| —     | Look at `old_access_token_profile_status` in the refresh output                                    | Whether the old access token dies on refresh (401) ⏳                                                                                   |
| 7     | `refresh --probe-reuse` ⚠️ **This may revoke the grant.** Run it last, then log in again           | Whether replaying an old refresh token triggers reuse detection ⏳                                                                      |
| 11–15 | `bun scripts/m0-probe.ts api`                                                                      | The `X-RateLimit-*` header format, error body shape, `limit=26` behaviour, `next_token` null handling, and the scope for cycle→sleep ⏳ |
| 10    | Dashboard                                                                                          | Whether creating an app requires a paid membership ⏳                                                                                   |

## Conclusions

_Fill in once the probes have run. Each decision should be reflected in `src/auth/*` before M1._
