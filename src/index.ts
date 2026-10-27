#!/usr/bin/env bun
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { SCOPES, loadClientCredentials } from "./config.ts";
import { login } from "./auth/login.ts";
import { toStored } from "./auth/oauth.ts";
import { deleteTokens, readTokens, tokenPath, writeTokens } from "./auth/store.ts";
import { createServer } from "./server.ts";

const [command = "serve", ...rest] = process.argv.slice(2);

async function main(): Promise<void> {
  switch (command) {
    case "serve":
      serveStdio(() => createServer());
      return;

    case "login": {
      const creds = loadClientCredentials();
      const { tokens } = await login(creds, { openBrowser: !rest.includes("--no-browser") });
      await writeTokens(toStored(tokens));
      const granted = tokens.scope?.split(/\s+/) ?? [];
      const missing = SCOPES.filter((s) => !granted.includes(s));
      console.error(`Logged in. Tokens saved to ${tokenPath()}.`);
      if (missing.length) console.error(`Warning: these scopes were not granted: ${missing.join(", ")}`);
      return;
    }

    case "status": {
      const tokens = await readTokens();
      if (!tokens) {
        console.error("Not logged in.");
        process.exitCode = 1;
        return;
      }
      const mins = Math.round((tokens.expires_at - Date.now()) / 60_000);
      console.error(
        `Logged in. Access token ${mins >= 0 ? `expires in ${mins} min` : `expired ${-mins} min ago`}; ` +
          `refresh token ${tokens.refresh_token ? "present" : "MISSING"}; scopes: ${tokens.scope ?? "(unknown)"}`,
      );
      return;
    }

    case "logout":
      // Server-side revocation (DELETE /v2/user/access) arrives in M1.
      await deleteTokens();
      console.error(`Deleted ${tokenPath()}.`);
      return;

    default:
      console.error("Usage: whoop-mcp [serve|login [--no-browser]|status|logout]");
      process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
