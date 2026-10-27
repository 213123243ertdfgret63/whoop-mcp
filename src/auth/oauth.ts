import { type ClientCredentials, SCOPES, WHOOP } from "../config.ts";
import type { StoredTokens } from "./store.ts";

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope?: string;
  id_token?: string;
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

export type ClientAuthMethod = "body" | "basic";

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function randomToken(byteLength: number): string {
  return base64url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

/** WHOOP's docs say `state` must be "eight characters"; length is configurable until M0 confirms what's accepted. */
export function randomState(length = 32): string {
  return randomToken(length).slice(0, length);
}

export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomToken(48);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

export function buildAuthorizeUrl(opts: {
  creds: ClientCredentials;
  state: string;
  scopes?: readonly string[];
  codeChallenge?: string;
}): string {
  const url = new URL(WHOOP.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", opts.creds.clientId);
  url.searchParams.set("redirect_uri", opts.creds.redirectUri);
  url.searchParams.set("scope", (opts.scopes ?? SCOPES).join(" "));
  url.searchParams.set("state", opts.state);
  if (opts.codeChallenge) {
    url.searchParams.set("code_challenge", opts.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  return url.toString();
}

async function postToken(
  creds: ClientCredentials,
  params: Record<string, string>,
  auth: ClientAuthMethod,
): Promise<TokenResponse> {
  const body = new URLSearchParams(params);
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  if (auth === "basic") {
    // RFC 6749 §2.3.1: form-encode id and secret before Basic-encoding them.
    const form = (v: string) => new URLSearchParams({ v }).toString().slice(2);
    headers.Authorization = `Basic ${btoa(`${form(creds.clientId)}:${form(creds.clientSecret)}`)}`;
  } else {
    body.set("client_id", creds.clientId);
    body.set("client_secret", creds.clientSecret);
  }
  const res = await fetch(WHOOP.tokenUrl, { method: "POST", headers, body });
  const text = await res.text();
  if (!res.ok) throw new OAuthHttpError(res.status, text);
  return JSON.parse(text) as TokenResponse;
}

export function exchangeCode(
  creds: ClientCredentials,
  code: string,
  opts: { codeVerifier?: string; auth?: ClientAuthMethod } = {},
): Promise<TokenResponse> {
  const params: Record<string, string> = {
    grant_type: "authorization_code",
    code,
    redirect_uri: creds.redirectUri,
  };
  if (opts.codeVerifier) params.code_verifier = opts.codeVerifier;
  return postToken(creds, params, opts.auth ?? "body");
}

/**
 * WHOOP refresh tokens are single-use: a successful refresh invalidates the old refresh token
 * (and existing access tokens). Callers must persist the result before using it.
 */
export function refreshTokens(
  creds: ClientCredentials,
  refreshToken: string,
  opts: { auth?: ClientAuthMethod; includeOfflineScope?: boolean } = {},
): Promise<TokenResponse> {
  const params: Record<string, string> = { grant_type: "refresh_token", refresh_token: refreshToken };
  if (opts.includeOfflineScope ?? true) params.scope = "offline";
  return postToken(creds, params, opts.auth ?? "body");
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
