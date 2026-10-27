import { homedir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };

/** package.json is the single source of truth; `bun run release` bumps it. Inlined into compiled binaries. */
export const VERSION: string = pkg.version;

export const WHOOP = {
  apiBase: "https://api.prod.whoop.com/developer",
  authorizeUrl: "https://api.prod.whoop.com/oauth/oauth2/auth",
  tokenUrl: "https://api.prod.whoop.com/oauth/oauth2/token",
  revokeUrl: "https://api.prod.whoop.com/oauth/oauth2/revoke",
  discoveryUrl: "https://api.prod.whoop.com/oauth/.well-known/openid-configuration",
  openapiUrl: "https://api.prod.whoop.com/developer/doc/openapi.json",
} as const;

/** `offline` is what gets us a refresh token. */
export const SCOPES = [
  "offline",
  "read:profile",
  "read:body_measurement",
  "read:cycles",
  "read:recovery",
  "read:sleep",
  "read:workout",
] as const;

export const DEFAULT_REDIRECT_URI = "http://localhost:8787/callback";

export interface ClientCredentials {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

/**
 * A trimmed env value, or undefined when blank or an unexpanded `${...}` placeholder (e.g. a client config's
 * `${user_config.client_id}` that was never filled in), so it can't masquerade as a real credential.
 */
export function envValue(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v && !/^\$\{[^}]*\}$/.test(v) ? v : undefined;
}

/** Each user brings their own WHOOP developer app (ToU §3.2.1: no developer credentials in source). */
export function loadClientCredentials(env = process.env): ClientCredentials {
  const clientId = envValue(env.WHOOP_CLIENT_ID);
  const clientSecret = envValue(env.WHOOP_CLIENT_SECRET);
  if (!clientId || !clientSecret) {
    throw new ConfigError(
      "WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET must be set (create an app at https://developer-dashboard.whoop.com).",
    );
  }
  return { clientId, clientSecret, redirectUri: envValue(env.WHOOP_REDIRECT_URI) ?? DEFAULT_REDIRECT_URI };
}

export function configDir(env = process.env): string {
  if (env.WHOOP_MCP_HOME) return env.WHOOP_MCP_HOME;
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "whoop-mcp");
}
