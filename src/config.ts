import { homedir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };

/** package.json is the single source of truth; `bun run release` bumps it. Inlined into compiled binaries. */
export const VERSION: string = pkg.version;

export const WHOOP = {
  apiBase: "https://api.prod.whoop.com/developer",
  authorizeUrl: "https://api.prod.whoop.com/oauth/oauth2/auth",
  tokenUrl: "https://api.prod.whoop.com/oauth/oauth2/token",
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

/**
 * The scopes in SCOPES that `granted` (a token response's space-separated `scope`) lacks. WHOOP's consent page
 * lets people untick permissions, and an app may not have them all enabled. An absent `scope` can't be
 * checked, so it counts as complete.
 */
export function missingScopes(granted: string | undefined): string[] {
  if (granted === undefined) return [];
  const have = new Set(granted.split(/\s+/).filter(Boolean));
  return SCOPES.filter((s) => !have.has(s));
}

/** What to tell the user when WHOOP granted only some permissions. */
export function missingScopesMessage(missing: string[]): string {
  return `WHOOP didn't grant every permission whoop-mcp needs (missing: ${missing.join(", ")}), so it didn't connect. Approve all of them on WHOOP's page; if one isn't offered, tick it under Scopes in your WHOOP app. Then try again.`;
}

export const DEFAULT_REDIRECT_URI = "http://localhost:8787/callback";

export interface ClientCredentials {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

/** A trimmed env value, or undefined when unset or blank. */
export function envValue(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

/**
 * App credentials from WHOOP_CLIENT_ID / WHOOP_CLIENT_SECRET (for development), or null when either is missing.
 * Each user brings their own WHOOP developer app (ToU §3.2.1: no developer credentials in source).
 */
export function loadClientCredentials(env = process.env): ClientCredentials | null {
  const clientId = envValue(env.WHOOP_CLIENT_ID);
  const clientSecret = envValue(env.WHOOP_CLIENT_SECRET);
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, redirectUri: envValue(env.WHOOP_REDIRECT_URI) ?? DEFAULT_REDIRECT_URI };
}

export function configDir(env = process.env): string {
  if (env.WHOOP_MCP_HOME) return env.WHOOP_MCP_HOME;
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "whoop-mcp");
}
