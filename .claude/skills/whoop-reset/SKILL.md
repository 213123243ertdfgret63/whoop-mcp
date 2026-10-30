---
name: whoop-reset
description: Wipe whoop-mcp from this Mac so a connect or install test starts from scratch. Revokes the WHOOP login, deletes the keychain item, config, logs and leftovers from earlier builds, and removes the Claude Desktop extension. Use only when the user runs /whoop-reset or asks to reset, wipe or clean up whoop-mcp or its extension data for testing.
disable-model-invocation: true
---

# Reset whoop-mcp for a clean test

One script does the work. It's safe to run twice: the second run reports "already clean".

## 1. Show what's there

```bash
bun .claude/skills/whoop-reset/scripts/whoop-reset.ts
```

This is a dry run and changes nothing. Show the user the list in a short table: what, and where.

## 2. Remove it

The user invoking this skill is the go-ahead. Run:

```bash
bun .claude/skills/whoop-reset/scripts/whoop-reset.ts --yes
```

Add `--include-downloads` only if the user asks to delete the downloaded `.mcpb` installers too. Add `--no-revoke` only if they ask not to contact WHOOP.

In order, it:
1. Stops the extension's server process.
2. Revokes whoop-mcp's access at WHOOP, using the repo's own `logout`. That refreshes an expired token first.
3. Deletes every `whoop-mcp` keychain item, using Apple's `security` tool. That also works for items an older build saved.
4. Deletes these files:
   - `~/.config/whoop-mcp`: the login, the file-store credentials and old setup leftovers. A `WHOOP_MCP_HOME` or `$XDG_CONFIG_HOME/whoop-mcp` folder goes too, but only if it's named `whoop-mcp`;
   - `~/Library/Logs/whoop-mcp`;
   - Claude Desktop's `mcp-server-*whoop*` logs;
   - Claude Code's `mcp-logs-*whoop*` caches;
   - `~/.claude/plugins/cache/whoop-mcp`;
   - the extension's `/whoop-connect`, `/whoop-disconnect` and `/whoop-status` skills in `~/.claude/skills`, only where `SKILL.md` carries the extension's marker. A same-named skill of the user's own is reported as **kept**.
5. Removes the Claude Desktop extension: its folder, its settings file and its entry in `extensions-installations.json`.

## 3. Check and report

Run the dry run from step 1 again. Only the pending extension and any kept installers should be left.

Report each item from the `--yes` output by its label:
- **removed**: done.
- **pending**: Claude Desktop is running, so the extension is removed when Desktop quits. Desktop keeps its extension list in memory and would write the entry back. Tell the user to quit Claude Desktop with ⌘Q. Quitting also ends this session. A background job then finishes the removal once Desktop has stayed closed for 3 seconds, and they can reopen Desktop. Its output is in `$TMPDIR/whoop-reset.log`. A restart to update doesn't count as quitting. Not quitting within an hour cancels the job; running the skill again starts a new one. For a removal without quitting, they can click **Uninstall** under **Settings → Extensions → WHOOP (unofficial)**, then run the skill again.
- **FAILED**: give the note, which says what to do by hand.
- **skipped**: `WHOOP_MCP_HOME` points at a folder not named `whoop-mcp`, so it was left alone on purpose. The note says what to delete by hand.
- **kept**: the downloaded installers, which are left alone unless the user asked, and any `whoop-*` skill the user wrote themselves.

When removal is pending, say plainly not to use WHOOP until Desktop has quit. The extension is still enabled until then, and a WHOOP request would start it again.

Then remind the user of two things the script can't reset:
- **WHOOP remembers the earlier approval.** If their browser is still signed in to WHOOP, reconnecting may skip the approval screen. To see WHOOP's sign-in and approval screens again, they sign out at whoop.com or use a private window.
- **The WHOOP developer app is still in the WHOOP developer dashboard.** That's fine for testing: the setup page's "Already have an app?" path reuses it. To test creating an app from scratch, they delete it in the dashboard.
