import { resolveClientCredentials } from "../auth/credentials.ts";
import { refreshTokens, toStored } from "../auth/oauth.ts";
import { readTokens, type StoredTokens, writeTokens } from "../auth/store.ts";
import { type ClientCredentials, WHOOP } from "../config.ts";
import { log } from "../log.ts";

export class NotLoggedInError extends Error {
  override name = "NotLoggedInError";
  constructor() {
    super("Not logged in to WHOOP. Call the whoop_login tool (or run `whoop-mcp login` in a terminal) first.");
  }
}

export class WhoopApiError extends Error {
  override name = "WhoopApiError";
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: string,
    readonly traceId?: string,
  ) {
    super(`WHOOP API ${status} on ${path}${traceId ? ` (trace ${traceId})` : ""}: ${body.slice(0, 300)}`);
  }
}

export interface ResponseMeta {
  traceId?: string;
  /** Raw X-RateLimit-* headers; the format is parsed properly in M2. */
  rateLimit: Record<string, string>;
}

const REFRESH_SKEW_MS = 60_000;
const MAX_RATE_LIMIT_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 30_000;

/** How long a 429 asks us to wait: Retry-After or X-RateLimit-Reset (seconds), capped; 2s if neither. */
export function retryDelayMs(res: Response): number {
  const seconds = Number(res.headers.get("retry-after") ?? res.headers.get("x-ratelimit-reset"));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, MAX_RETRY_DELAY_MS) : 2000;
}

/**
 * M0 client: bearer auth, refresh-before-expiry, and one 401 retry that first re-reads the
 * store (another process may already have rotated the token). Cross-process locking is M1.
 */
export class WhoopClient {
  lastMeta: ResponseMeta = { rateLimit: {} };
  private refreshing: Promise<StoredTokens> | null = null;

  constructor(
    private readonly creds: () => ClientCredentials | Promise<ClientCredentials> = async () =>
      (await resolveClientCredentials()).creds,
  ) {}

  async get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    const url = new URL(WHOOP.apiBase + path);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));

    let tokens = await this.validTokens();
    let res = await this.send(url, tokens.access_token);
    if (res.status === 401) {
      const latest = await readTokens();
      if (!latest) throw new NotLoggedInError(); // logged out elsewhere: don't resurrect the session
      tokens = latest.access_token !== tokens.access_token ? latest : await this.refresh(latest);
      res = await this.send(url, tokens.access_token);
    }
    for (let attempt = 0; res.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES; attempt++) {
      await Bun.sleep(retryDelayMs(res));
      res = await this.send(url, tokens.access_token);
    }
    const text = await res.text();
    if (!res.ok) throw new WhoopApiError(res.status, path, text, this.lastMeta.traceId);
    return JSON.parse(text) as T;
  }

  private async send(url: URL, accessToken: string): Promise<Response> {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } });
    const rateLimit: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      if (key.toLowerCase().startsWith("x-ratelimit")) rateLimit[key.toLowerCase()] = value;
    });
    this.lastMeta = { traceId: res.headers.get("x-whoop-trace-id") ?? undefined, rateLimit };
    if (this.lastMeta.traceId) log(`GET ${url.pathname} -> ${res.status} trace=${this.lastMeta.traceId}`);
    return res;
  }

  private async validTokens(): Promise<StoredTokens> {
    const tokens = await readTokens();
    if (!tokens) throw new NotLoggedInError();
    if (tokens.expires_at - REFRESH_SKEW_MS > Date.now()) return tokens;
    return this.refresh(tokens);
  }

  /** Single-flight within this process. */
  private refresh(tokens: StoredTokens): Promise<StoredTokens> {
    this.refreshing ??= (async () => {
      if (!tokens.refresh_token) throw new NotLoggedInError();
      const resp = await refreshTokens(await this.creds(), tokens.refresh_token);
      const next = toStored(resp, tokens);
      await writeTokens(next); // persist before use: the old refresh token is now dead
      return next;
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }
}
