import { type ClientCredentials, missingScopesMessage, SCOPES, WHOOP } from "../config.ts";
import { errorFields, log } from "../log.ts";
import type { StoredTokens } from "./store.ts";

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope?: string;
  id_token?: string;
}

/** WHOOP granted only some of the permissions; the login was refused (and revoked). */
export class MissingScopesError extends Error {
  override name = "MissingScopesError";
  constructor(readonly missing: string[]) {
    super(missingScopesMessage(missing));
  }
}

/**
 * Revokes this app's access to the user's WHOOP account (DELETE /v2/user/access), which ends the login at
 * WHOOP, not only on this computer. Returns whether WHOOP confirmed it; never throws.
 */
export async function revokeAccess(accessToken: string): Promise<boolean> {
  try {
    const res = await fetch(`${WHOOP.apiBase}/v2/user/access`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    log.info("revoked WHOOP access", { status: res.status });
    return res.ok;
  } catch (err) {
    log.warn("could not revoke WHOOP access", errorFields(err));
    return false;
  }
}

export class OAuthHttpError extends Error {
  override name = "OAuthHttpError";
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`WHOOP token endpoint returned ${status}: ${body.slice(0, 300)}`);
  }
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function randomToken(byteLength: number): string {
  return base64url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

/** WHOOP accepts a 32-character `state` (its docs mention eight characters, as a minimum). */
export function randomState(length = 32): string {
  return randomToken(length).slice(0, length);
}

export function buildAuthorizeUrl(opts: {
  creds: ClientCredentials;
  state: string;
  scopes?: readonly string[];
}): string {
  const url = new URL(WHOOP.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", opts.creds.clientId);
  url.searchParams.set("redirect_uri", opts.creds.redirectUri);
  url.searchParams.set("scope", (opts.scopes ?? SCOPES).join(" "));
  url.searchParams.set("state", opts.state);
  return url.toString();
}

/** WHOOP gets this long to answer a code exchange; a stalled one must not hold a login open forever. */
const EXCHANGE_TIMEOUT_MS = 20_000;

/**
 * Posts to WHOOP's token endpoint with the client secret in the form body (client_secret_post). `timeoutMs`
 * aborts the request; refreshes pass none (see refreshTokens).
 */
async function postToken(
  creds: ClientCredentials,
  params: Record<string, string>,
  timeoutMs?: number,
): Promise<TokenResponse> {
  const body = new URLSearchParams({ ...params, client_id: creds.clientId, client_secret: creds.clientSecret });
  let res: Response;
  try {
    res = await fetch(WHOOP.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body,
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    });
  } catch (err) {
    if ((err as Error).name === "TimeoutError")
      throw new Error("WHOOP didn't answer the token request in time; try again.");
    throw err;
  }
  const text = await res.text();
  if (!res.ok) throw new OAuthHttpError(res.status, text);
  return JSON.parse(text) as TokenResponse;
}

export function exchangeCode(creds: ClientCredentials, code: string): Promise<TokenResponse> {
  return postToken(
    creds,
    { grant_type: "authorization_code", code, redirect_uri: creds.redirectUri },
    EXCHANGE_TIMEOUT_MS,
  );
}

/**
 * WHOOP refresh tokens are single-use: a successful refresh invalidates the old refresh token
 * (and existing access tokens). Callers must persist the result before using it.
 */
/** Never aborted: WHOOP may already have used up the old refresh token, so the reply must still be saved. */
export function refreshTokens(creds: ClientCredentials, refreshToken: string): Promise<TokenResponse> {
  return postToken(creds, { grant_type: "refresh_token", refresh_token: refreshToken, scope: "offline" });
}

export function toStored(resp: TokenResponse, previous?: StoredTokens | null, now = Date.now()): StoredTokens {
  return {
    access_token: resp.access_token,
    // Keep the old refresh token only if the server didn't send a new one.
    refresh_token: resp.refresh_token ?? previous?.refresh_token,
    token_type: resp.token_type,
    scope: resp.scope ?? previous?.scope,
    expires_at: now + resp.expires_in * 1000,
    obtained_at: now,
  };
}
