# WHOOP API: what the code relies on

Facts the shipped code depends on, checked against WHOOP's live API and discovery document (2026-10-27/28). Each user brings their own WHOOP developer app; see the README.

| Topic                 | What we rely on                                                                                                             | Where                   |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Endpoints             | Issuer `https://api.prod.whoop.com/oauth/`; authorize `…/oauth2/auth`, token `…/oauth2/token`                               | `src/config.ts`         |
| Redirect URI          | A dashboard app accepts `http://localhost:8787/callback`                                                                    | `DEFAULT_REDIRECT_URI`  |
| `state`               | A 32-character `state` is accepted (WHOOP's docs mention eight characters as a minimum)                                     | `randomState()`         |
| Client authentication | The client secret in the form body (`client_secret_post`) works; it is the only method we use                               | `postToken()`           |
| Refresh tokens        | `scope=offline` on login returns a refresh token; each refresh returns a new one and the old one stops working (single-use) | `WhoopClient.refresh()` |
| Collections           | Paginated with `limit` (max 25), `nextToken` and `start`/`end` on the record's start time; newest first                     | `listAll()`             |
| `percent_recorded`    | The live API returns a 0–1 fraction (the spec says 0–100), so the code multiplies by 100                                    | `shapeWorkout()`        |
| `step_count`          | Present on cycles                                                                                                           | `shapeCycle()`          |
| HTTP                  | Cloudflare refuses some generic user agents (e.g. Python's) with 403                                                        | —                       |

Not used: PKCE, HTTP Basic or public-client (`none`) authentication, `openid`/id tokens, webhooks. The discovery document advertises `client_secret_post`, `client_secret_basic`, `private_key_jwt` and `none`, but no `code_challenge_methods_supported`.

The OpenAPI spec is vendored in `openapi/whoop.yaml` (`bun run spec:update` refreshes it) and generates `src/whoop/openapi.d.ts`.
