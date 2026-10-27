#!/usr/bin/env bun
/**
 * M0 spike: answers the open WHOOP OAuth/API questions from RESEARCH.md §8 empirically.
 * Results (never tokens) are appended to docs/m0-results.json; transcribe conclusions into docs/verification.md.
 *
 *   bun scripts/m0-probe.ts public                       # no credentials needed
 *   bun scripts/m0-probe.ts login [--pkce] [--state-len 8] [--auth basic|body]
 *   bun scripts/m0-probe.ts refresh [--auth basic|body] [--no-offline-scope] [--probe-reuse]
 *   bun scripts/m0-probe.ts api                          # hits each v2 read endpoint once
 */
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { login } from "../src/auth/login.ts";
import {
  type ClientAuthMethod,
  OAuthHttpError,
  refreshTokens,
  type TokenResponse,
  toStored,
} from "../src/auth/oauth.ts";
import { readTokens, writeTokens } from "../src/auth/store.ts";
import { loadClientCredentials, WHOOP } from "../src/config.ts";

const RESULTS = join(import.meta.dir, "..", "docs", "m0-results.json");

const { positionals, values } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    pkce: { type: "boolean", default: false },
    "state-len": { type: "string" },
    auth: { type: "string", default: "body" },
    "no-offline-scope": { type: "boolean", default: false },
    "probe-reuse": { type: "boolean", default: false },
  },
});
const auth = values.auth as ClientAuthMethod;

async function record(probe: string, result: Record<string, unknown>): Promise<void> {
  const entry = { probe, at: new Date().toISOString(), ...result };
  console.log(JSON.stringify(entry, null, 2));
  await mkdir(join(import.meta.dir, "..", "docs"), { recursive: true });
  await appendFile(RESULTS, `${JSON.stringify(entry)}\n`);
}

/** Shape of a token response with every secret removed. */
function describeTokens(t: TokenResponse) {
  return {
    keys: Object.keys(t).sort(),
    token_type: t.token_type,
    expires_in: t.expires_in,
    scope: t.scope,
    has_refresh_token: Boolean(t.refresh_token),
    has_id_token: Boolean(t.id_token),
    access_token_length: t.access_token.length,
  };
}

async function profileStatus(accessToken: string): Promise<number> {
  const res = await fetch(`${WHOOP.apiBase}/v2/user/profile/basic`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  await res.body?.cancel();
  return res.status;
}

async function tryRefresh(refreshToken: string, opts: Parameters<typeof refreshTokens>[2]) {
  try {
    return { ok: true as const, tokens: await refreshTokens(loadClientCredentials(), refreshToken, opts) };
  } catch (err) {
    if (err instanceof OAuthHttpError) return { ok: false as const, status: err.status, body: err.body.slice(0, 500) };
    throw err;
  }
}

async function probePublic(): Promise<void> {
  const disco = (await (await fetch(WHOOP.discoveryUrl)).json()) as Record<string, unknown>;
  await record("discovery", {
    issuer: disco.issuer,
    authorization_endpoint: disco.authorization_endpoint,
    token_endpoint: disco.token_endpoint,
    revocation_endpoint: disco.revocation_endpoint,
    token_endpoint_auth_methods_supported: disco.token_endpoint_auth_methods_supported,
    code_challenge_methods_supported: disco.code_challenge_methods_supported,
    grant_types_supported: disco.grant_types_supported,
    scopes_supported: disco.scopes_supported,
    response_types_supported: disco.response_types_supported,
  });

  const res = await fetch(WHOOP.openapiUrl);
  const spec = (await res.json()) as {
    openapi: string;
    info: { version: string };
    paths: Record<string, Record<string, { security?: unknown }>>;
  };
  const ops = Object.entries(spec.paths).flatMap(([path, methods]) =>
    Object.entries(methods).map(([method, op]) => ({ method: method.toUpperCase(), path, security: op.security })),
  );
  await record("openapi", {
    openapi: spec.openapi,
    info_version: spec.info.version,
    bytes: Number(res.headers.get("content-length")) || undefined,
    operation_count: ops.length,
    consumer_operations: ops.filter((o) => !o.path.includes("/partner/")),
    partner_operation_count: ops.filter((o) => o.path.includes("/partner/")).length,
  });
}

async function probeLogin(): Promise<void> {
  const creds = loadClientCredentials();
  const stateLength = values["state-len"] ? Number(values["state-len"]) : 32;
  try {
    const { tokens, callbackParams } = await login(creds, { pkce: values.pkce, stateLength, auth });
    await writeTokens(toStored(tokens));
    await record("login", {
      ok: true,
      redirect_uri: creds.redirectUri,
      pkce: values.pkce,
      state_length: stateLength,
      client_auth: auth,
      callback_params: Object.keys(callbackParams),
      token: describeTokens(tokens),
      profile_status: await profileStatus(tokens.access_token),
    });
  } catch (err) {
    await record("login", {
      ok: false,
      redirect_uri: creds.redirectUri,
      pkce: values.pkce,
      state_length: stateLength,
      client_auth: auth,
      error: err instanceof Error ? err.message : String(err),
    });
    process.exitCode = 1;
  }
}

async function probeRefresh(): Promise<void> {
  const before = await readTokens();
  if (!before?.refresh_token) throw new Error("No stored refresh token; run the login probe first.");

  const first = await tryRefresh(before.refresh_token, { auth, includeOfflineScope: !values["no-offline-scope"] });
  if (!first.ok) {
    await record("refresh", { client_auth: auth, offline_scope: !values["no-offline-scope"], ...first });
    process.exitCode = 1;
    return;
  }
  const after = toStored(first.tokens, before);
  await writeTokens(after); // persist immediately: the old refresh token is presumed dead

  const result: Record<string, unknown> = {
    ok: true,
    client_auth: auth,
    offline_scope: !values["no-offline-scope"],
    token: describeTokens(first.tokens),
    refresh_token_rotated: Boolean(first.tokens.refresh_token) && first.tokens.refresh_token !== before.refresh_token,
    old_access_token_profile_status: await profileStatus(before.access_token),
    new_access_token_profile_status: await profileStatus(after.access_token),
  };

  if (values["probe-reuse"]) {
    // Replays the rotated-out refresh token. If WHOOP does reuse detection this may revoke the whole grant,
    // in which case the follow-up check fails and you need to log in again.
    const reuse = await tryRefresh(before.refresh_token, { auth });
    result.reuse_old_refresh_token = reuse.ok ? { ok: true } : { ok: false, status: reuse.status, body: reuse.body };
    if (reuse.ok) await writeTokens(toStored(reuse.tokens, after));
    const latest = await readTokens();
    const follow = await tryRefresh(latest!.refresh_token!, { auth });
    result.current_refresh_token_after_reuse = follow.ok
      ? { ok: true }
      : { ok: false, status: follow.status, body: follow.body };
    if (follow.ok) await writeTokens(toStored(follow.tokens, latest));
  }
  await record("refresh", result);
}

async function probeApi(): Promise<void> {
  const tokens = await readTokens();
  if (!tokens) throw new Error("Not logged in; run the login probe first.");
  const get = async (path: string) => {
    const res = await fetch(`${WHOOP.apiBase}${path}`, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      if (/^x-ratelimit|^x-whoop-trace-id$|^retry-after$|^cache-control$|^content-type$/i.test(k)) headers[k] = v;
    });
    const body = await res.text();
    let shape: unknown;
    try {
      const json = JSON.parse(body);
      shape = Array.isArray(json.records)
        ? {
            record_count: json.records.length,
            next_token: json.next_token === null ? null : typeof json.next_token,
            first_record_keys: Object.keys(json.records[0] ?? {}),
          }
        : { keys: Object.keys(json) };
    } catch {
      shape = { non_json_body: body.slice(0, 200) };
    }
    return { path, status: res.status, headers, shape };
  };

  const results = [];
  for (const path of [
    "/v2/cycle?limit=1",
    "/v2/recovery?limit=1",
    "/v2/activity/sleep?limit=1",
    "/v2/activity/workout?limit=1",
    "/v2/cycle?limit=26",
    "/v2/cycle?start=not-a-date",
  ]) {
    results.push(await get(path));
  }
  const cycles = (await (
    await fetch(`${WHOOP.apiBase}/v2/cycle?limit=1`, { headers: { Authorization: `Bearer ${tokens.access_token}` } })
  ).json()) as { records: { id: number }[] };
  const cycleId = cycles.records[0]?.id;
  if (cycleId !== undefined) {
    results.push(await get(`/v2/cycle/${cycleId}/sleep`), await get(`/v2/cycle/${cycleId}/recovery`));
  }
  results.push(await get("/v2/activity/sleep/00000000-0000-0000-0000-000000000000"));
  await record("api", { results });
}

const probes: Record<string, () => Promise<void>> = {
  public: probePublic,
  login: probeLogin,
  refresh: probeRefresh,
  api: probeApi,
};
const probe = probes[positionals[0] ?? ""];
if (!probe) {
  console.error(`Usage: bun scripts/m0-probe.ts <${Object.keys(probes).join("|")}> [options]`);
  process.exit(2);
}
await probe();
