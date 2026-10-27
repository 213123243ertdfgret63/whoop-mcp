#!/bin/sh
# Removes whoop-mcp from Claude Code and Claude Desktop, deletes its saved WHOOP tokens and app
# credentials, and deletes the installed binary.
#
#   curl -fsSL https://raw.githubusercontent.com/213123243ertdfgret63/whoop-mcp/main/uninstall.sh | sh
#
# Keep the saved tokens and credentials (e.g. to reinstall later):
#   curl -fsSL https://raw.githubusercontent.com/213123243ertdfgret63/whoop-mcp/main/uninstall.sh | sh -s -- --keep-data
set -eu

INSTALL_DIR="${WHOOP_MCP_INSTALL_DIR:-$HOME/.whoop-mcp}"
bin="$INSTALL_DIR/bin/whoop-mcp"
keep_data=0
for arg in "$@"; do
  case "$arg" in
    --keep-data) keep_data=1 ;;
    *) printf 'whoop-mcp uninstall: unknown option %s\n' "$arg" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
trap 'exit 130' INT TERM

# The Claude desktop app: its bundle id, and its main process as seen in `ps` (overridable so tests never act
# on, or wait for, a real Claude running on the machine).
CLAUDE_BUNDLE_ID="${WHOOP_MCP_CLAUDE_BUNDLE_ID:-com.anthropic.claudefordesktop}"
CLAUDE_APP_PATTERN="${WHOOP_MCP_CLAUDE_APP_PATTERN:-\.app/Contents/MacOS/Claude\$}"

claude_desktop_running() {
  [ "${WHOOP_MCP_ASSUME_DESKTOP_RUNNING:-}" = 1 ] && return 0
  # -x without -a: only this user's processes (another logged-in user's Claude isn't ours to restart).
  [ "$(uname -s)" = Darwin ] && ps -xo comm= 2>/dev/null | grep -q -e "$CLAUDE_APP_PATTERN"
}

# Running from a terminal inside Claude (e.g. the Code tab)? Quitting Claude closes that terminal too.
inside_claude() {
  [ "${__CFBundleIdentifier:-}" = "$CLAUDE_BUNDLE_ID" ] || [ "${WHOOP_MCP_FORCE_DETACH:-}" = 1 ]
}

# y/N question on the terminal. Under `curl | sh` stdin is this script, so read /dev/tty; without a terminal
# (CI, scripts) the answer is no. WHOOP_MCP_RESTART_CLAUDE=yes|no answers it up front.
ask_yes() {
  case "${WHOOP_MCP_RESTART_CLAUDE:-}" in
    y | yes | 1) return 0 ;;
    n | no | 0) return 1 ;;
  esac
  (exec </dev/tty) 2>/dev/null || return 1
  printf '%s [y/N] ' "$1" >/dev/tty
  read -r answer </dev/tty || return 1
  case "$answer" in
    [yY] | [yY][eE][sS]) return 0 ;;
    *) return 1 ;;
  esac
}

# Quits Claude Desktop, runs `whoop-mcp claude <add|remove>` only once it has really exited, optionally deletes a
# folder (uninstall), then reopens Claude. If Claude doesn't quit (the user cancels its confirmation, or macOS
# denies the Automation permission), it changes nothing and says what to do instead.
# Args: whoop-mcp binary, add|remove, log file, folder to delete afterwards ("" for none).
# Returns 0 done, 1 failed (in the foreground), 10 started detached.
restart_claude_desktop() {
  job='
    echo "Asking Claude to quit (confirm if it asks)..."
    osascript -e "tell application id \"$5\" to quit" || echo "Could not ask Claude to quit (see the error above)."
    i=0
    while ps -xo comm= | grep -q -e "$4" && [ "$i" -lt "$6" ]; do sleep 1; i=$((i + 1)); done
    if ps -xo comm= | grep -q -e "$4"; then
      echo "Claude did not quit, so its config was NOT changed. Quit Claude (Cmd+Q), then run:"
      echo "  \"$1\" claude $2"
      echo "restart failed"
      exit 1
    fi
    if [ "$2" = add ]; then "$1" claude add --command "$1"; else "$1" claude "$2"; fi
    status=$?
    [ "$status" = 0 ] && [ -n "$3" ] && rm -rf "$3"
    open -b "$5" || echo "Could not reopen Claude; open it yourself."
    if [ "$status" = 0 ]; then echo "restart finished"; else echo "whoop-mcp claude $2 failed (exit $status)"; echo "restart failed"; exit 1; fi
  '
  set -- "$1" "$2" "$4" "$CLAUDE_APP_PATTERN" "$CLAUDE_BUNDLE_ID" "${WHOOP_MCP_QUIT_TIMEOUT:-300}" "$3"
  log="$7"
  if inside_claude; then
    # This terminal closes with Claude: run detached (own session when perl is available, immune to SIGHUP)
    # so the job still finishes, and keep its output in the log.
    mkdir -p "$(dirname "$log")"
    if command -v perl >/dev/null 2>&1; then
      nohup perl -MPOSIX=setsid -e 'setsid(); exec @ARGV' sh -c "$job" sh "$1" "$2" "$3" "$4" "$5" "$6" >"$log" 2>&1 </dev/null &
    else
      nohup sh -c "$job" sh "$1" "$2" "$3" "$4" "$5" "$6" >"$log" 2>&1 </dev/null &
    fi
    return 10
  fi
  sh -c "$job" sh "$1" "$2" "$3" "$4" "$5" "$6"
}

if [ ! -x "$bin" ]; then
  say "whoop-mcp isn't installed at $bin; nothing to remove."
  say "If you added it to Claude some other way, remove the \"whoop\" MCP server there."
  exit 0
fi

# A running Claude Desktop writes its in-memory config back when it quits, which would restore the whoop entry
# (pointing at the binary we're about to delete). So it needs a restart: quit, unregister, reopen.
restart=0
if claude_desktop_running; then
  say "Claude Desktop is running. It rewrites its config when it quits, which would put whoop back, so it needs"
  say "a restart: quit, remove whoop, reopen. This closes Claude's windows and any running sessions."
  ask_yes "Restart Claude now?" && restart=1
fi

if [ "$restart" = 0 ]; then
  # Unregister first, while the binary that knows where Claude's config lives still exists.
  "$bin" claude remove || say "Couldn't fully remove whoop from Claude's configuration (see above)."
fi

if [ "$keep_data" = 1 ]; then
  say "Keeping saved WHOOP tokens and app credentials (--keep-data)."
else
  # Deletes tokens.json and the app credentials (keychain entry or client.json).
  "$bin" logout --forget-app || say "Couldn't delete the saved WHOOP data (see above)."
  config_dir="${WHOOP_MCP_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/whoop-mcp}"
  rmdir "$config_dir" 2>/dev/null || true
fi

if [ "$restart" = 1 ]; then
  # Unregistering needs the binary, so the restart deletes the install folder itself, and only on success.
  log="${TMPDIR:-/tmp}"
  log="${log%/}/whoop-mcp-uninstall.$$.log"
  rc=0
  restart_claude_desktop "$bin" remove "$log" "$INSTALL_DIR" || rc=$?
  case "$rc" in
    0) say "Removed $INSTALL_DIR." ;;
    10)
      say "This terminal is inside Claude, so it closes along with Claude; removal finishes in the background."
      say "If whoop is still listed afterwards, see $log."
      ;;
    *) say "Kept $INSTALL_DIR so you can finish later: after the step above, run this uninstaller again." ;;
  esac
else
  rm -rf "$INSTALL_DIR"
  say "Removed $INSTALL_DIR."
  if claude_desktop_running; then
    say "If whoop reappears in Claude Desktop after it restarts, quit Claude and remove the \"whoop\" entry from"
    say "its config (Settings > Developer > Edit Config)."
  else
    say "Restart Claude to finish."
  fi
fi
say "WHOOP access can also be revoked at https://developer-dashboard.whoop.com."
