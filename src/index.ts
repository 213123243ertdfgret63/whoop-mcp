#!/usr/bin/env bun
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { BackgroundLogin } from "./auth/background-login.ts";
import { deleteStoredCredentials, resolveClientCredentials } from "./auth/credentials.ts";
import { deleteTokens, readTokens, tokenPath } from "./auth/store.ts";
import { terminalIO } from "./cli/terminal.ts";
import { ConfigError, VERSION } from "./config.ts";
import { errorFields, log } from "./log.ts";
import { createServer } from "./server.ts";
import { loginAndSave, runSetup } from "./setup.ts";
import { WhoopClient } from "./whoop/client.ts";

const [command = "serve", ...rest] = process.argv.slice(2);
const flag = (name: string) => rest.includes(name);
const print = (text: string) => console.error(text);

const USAGE = `whoop-mcp v${VERSION}

Usage: whoop-mcp <command>

  serve                 Run the MCP server over stdio (default)
  setup                 Save your WHOOP app credentials, then log in with the browser
      --no-browser        Print URLs instead of opening them
      --no-login          Only save the credentials
      --skip-verify       Don't check the credentials with WHOOP before saving
  login [--no-browser]  Log in with the browser using the saved credentials
  status                Show credential and login state
  logout [--forget-app] Delete saved tokens (and, with --forget-app, the app credentials)
  version               Print the version`;

/** How long shutdown waits for a token refresh to save: under the 2s Claude gives between EOF and SIGTERM. */
const SHUTDOWN_GRACE_MS = 1500;

/**
 * One idempotent shutdown for every way the connection can end. It waits briefly for a token refresh to be
 * saved (WHOOP has already spent the old refresh token) and for the login page to close, then exits. A second
 * trigger, such as SIGTERM arriving during that wait, joins the first instead of cutting it short.
 */
function stopper(loginFlow: BackgroundLogin, client: WhoopClient): (reason: string) => void {
  let stopping = false;
  return (reason) => {
    if (stopping) return;
    stopping = true;
    log.info("client disconnected", { reason });
    setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
    void Promise.allSettled([loginFlow.cancel(), client.drain()]).then(() => process.exit(0));
  };
}

async function main(): Promise<void> {
  switch (command) {
    case "serve":
      // Claude Desktop copies stderr into its own log; keep that to problems and the details in our file.
      log.configure({ ...process.env, WHOOP_MCP_LOG_STDERR_LEVEL: process.env.WHOOP_MCP_LOG_STDERR_LEVEL ?? "warn" });
      log.info("starting", {
        version: VERSION,
        pid: process.pid,
        platform: `${process.platform}-${process.arch}`,
        bun: Bun.version,
        log_level: log.settings().level,
        log_file: log.settings().file ?? "off",
      });
      process.on("uncaughtException", (err) => {
        log.error("uncaught exception", { ...errorFields(err), stack: err.stack });
        process.exit(1);
      });
      process.on("unhandledRejection", (reason) => log.error("unhandled rejection", errorFields(reason)));
      process.once("exit", (exitCode) => log.info("exited", { exit_code: exitCode }));
      {
        // One login flow and one API client per process, shared by whichever protocol-era instance serves the
        // connection, so token refreshes stay single-flight across instances.
        const loginFlow = new BackgroundLogin();
        const client = new WhoopClient();
        serveStdio(() => createServer(client, loginFlow), {
          onerror: (err) => log.warn("transport error", errorFields(err)),
        });
        const shutdown = stopper(loginFlow, client);
        // However the connection ends, close the login page's server (port 8787) and exit: something (that
        // server, a timer, a keep-alive socket) could otherwise keep this process alive after Claude is gone.
        process.stdin.once("end", () => shutdown("stdin closed"));
        process.stdin.once("close", () => shutdown("stdin closed"));
        for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => shutdown(signal));
      }
      return;

    case "version":
    case "--version":
    case "-v":
      console.log(VERSION);
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
      const resolved = await resolveClientCredentials().catch((err: unknown) => {
        if (err instanceof ConfigError) throw new Error("No WHOOP app credentials yet: run `whoop-mcp setup` first.");
        throw err;
      });
      await loginAndSave(resolved.creds, print, { openBrowser: !flag("--no-browser") });
      return;
    }

    case "status": {
      const source = (await resolveClientCredentials().catch(() => null))?.source;
      const where = { env: "environment variables", keychain: "keychain", file: "file" } as const;
      print(`App credentials: ${source ? where[source] : "not set up (run `whoop-mcp setup`)"}`);
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
      if ((await readTokens()) !== null) {
        const revoked = await new WhoopClient().revokeAccess();
        print(
          revoked === "revoked"
            ? "Revoked access at WHOOP."
            : "Couldn't revoke access at WHOOP; deleting the login anyway.",
        );
      }
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
