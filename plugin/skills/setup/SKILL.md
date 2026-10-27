---

## description: Connect Claude to the user's WHOOP account through the whoop plugin — create the WHOOP developer app, configure the plugin, and sign in with the browser. Use when the user asks to set up, connect, log in to or fix WHOOP, or when a whoop_ tool reports missing credentials or not being logged in.

# Set up WHOOP

The whoop plugin talks to WHOOP through the user's **own** WHOOP developer app (WHOOP's terms don't allow shipping shared app credentials). Setup has three parts; check where the user is before explaining all of it.

## 1. Check the current state

Call the `whoop_status` tool.

- If the tool isn't available, the MCP server didn't start. The usual cause is that [Bun](https://bun.sh) isn't installed or isn't on the PATH Claude Code sees. Check with `bun --version`; if it's missing, suggest `curl -fsSL https://bun.sh/install | bash` (or `brew install oven-sh/bun/bun`), then `/reload-plugins`.
- `logged_in: true` → setup is done; say so and stop.
- `app_credentials: "missing"` → go to step 2.
- Otherwise → go to step 3.

## 2. Create the WHOOP app and configure the plugin

Walk the user through this (they do it; you can't):

1. Open https://developer-dashboard.whoop.com and create an app (a WHOOP account is required).
2. Set the redirect URI to exactly `http://localhost:8787/callback`.
3. Enable the scopes `read:profile`, `read:body_measurement`, `read:cycles`, `read:recovery`, `read:sleep`, `read:workout`.
4. Run `/plugin configure whoop@whoop-mcp` and paste the app's Client ID and Client Secret. The secret is kept in the system keychain.
5. Run `/reload-plugins` so the server picks up the new credentials.

Then call `whoop_status` again and continue with step 3.

## 3. Sign in with the browser

Call `whoop_login`. It opens WHOOP's consent page and returns the URL right away — show the URL to the user in case the browser didn't open, and ask them to approve access and tell you when they're done. Then call `whoop_status` to confirm `logged_in: true`.

If the login fails:

- **WHOOP shows a redirect_uri error** → the app's redirect URI doesn't exactly match `http://localhost:8787/callback` (or the `redirect_uri` plugin setting). Fix it in the dashboard and call `whoop_login` again.
- **"Could not start the callback server on port 8787"** → another program uses that port. Pick another port, set it on the WHOOP app and via `/plugin configure whoop@whoop-mcp` (redirect URI), `/reload-plugins`, and retry.
- **invalid_client** → the Client ID or secret is wrong; re-enter them with `/plugin configure whoop@whoop-mcp`.

WHOOP data is not medical advice; keep any analysis non-diagnostic.
