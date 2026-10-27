#!/usr/bin/env bun
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { deleteStoredCredentials, readStoredCredentials, resolveClientCredentials } from "./auth/credentials.ts";
import { deleteTokens, readTokens, tokenPath } from "./auth/store.ts";
import { terminalIO } from "./cli/terminal.ts";
import { createServer } from "./server.ts";
import { loginAndSave, runSetup } from "./setup.ts";

const [command = "serve", ...rest] = process.argv.slice(2);
const flag = (name: string) => rest.includes(name);
const print = (text: string) => console.error(text);

const USAGE = `Usage: whoop-mcp <command>

  serve                 Run the MCP server over stdio (default)
  setup                 Save your WHOOP app credentials, then log in with the browser
      --no-browser        Print URLs instead of opening them
      --no-login          Only save the credentials
      --skip-verify       Don't check the credentials with WHOOP before saving
  login [--no-browser]  Log in with the browser using the saved credentials
  status                Show credential and login state
  logout [--forget-app] Delete saved tokens (and, with --forget-app, the app credentials)`;

async function main(): Promise<void> {
  switch (command) {
    case "serve":
      serveStdio(() => createServer());
      return;

    case "setup":
      await runSetup(terminalIO(), {
        openBrowser: !flag("--no-browser"),
        verify: !flag("--skip-verify"),
        login: !flag("--no-login"),
        redirectUri: process.env.WHOOP_REDIRECT_URI?.trim() || undefined,
      });
      return;

    case "login": {
      const { creds } = await resolveClientCredentials();
      await loginAndSave(creds, print, { openBrowser: !flag("--no-browser") });
      return;
    }

    case "status": {
      const stored = await readStoredCredentials();
      const fromEnv = Boolean(process.env.WHOOP_CLIENT_ID && process.env.WHOOP_CLIENT_SECRET);
      print(
        `App credentials: ${fromEnv ? "environment variables" : (stored?.source ?? "not set up (run `whoop-mcp setup`)")}`,
      );
      const tokens = await readTokens();
      if (!tokens) {
        print("Not logged in.");
        process.exitCode = 1;
        return;
      }
      const mins = Math.round((tokens.expires_at - Date.now()) / 60_000);
      print(
        `Logged in. Access token ${mins >= 0 ? `expires in ${mins} min` : `expired ${-mins} min ago`}; ` +
          `refresh token ${tokens.refresh_token ? "present" : "MISSING"}; scopes: ${tokens.scope ?? "(unknown)"}`,
      );
      return;
    }

    case "logout":
      // Server-side revocation (DELETE /v2/user/access) arrives in M1.
      await deleteTokens();
      print(`Deleted ${tokenPath()}.`);
      if (flag("--forget-app")) {
        print((await deleteStoredCredentials()) ? "Deleted saved app credentials." : "No saved app credentials.");
      }
      return;

    case "help":
    case "--help":
    case "-h":
      print(USAGE);
      return;

    default:
      print(USAGE);
      process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
