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

if [ ! -x "$bin" ]; then
  say "whoop-mcp isn't installed at $bin; nothing to remove."
  say "If you added it to Claude some other way, remove the \"whoop\" MCP server there."
  exit 0
fi

# Unregister first, while the binary that knows where Claude's config lives still exists.
"$bin" claude remove || say "Couldn't fully remove whoop from Claude's configuration (see above)."

if [ "$keep_data" = 1 ]; then
  say "Keeping saved WHOOP tokens and app credentials (--keep-data)."
else
  # Deletes tokens.json and the app credentials (keychain entry or client.json).
  "$bin" logout --forget-app || say "Couldn't delete the saved WHOOP data (see above)."
  config_dir="${WHOOP_MCP_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/whoop-mcp}"
  rmdir "$config_dir" 2>/dev/null || true
fi

rm -rf "$INSTALL_DIR"
say "Removed $INSTALL_DIR."
say "Restart Claude to finish. WHOOP access can also be revoked at https://developer-dashboard.whoop.com."
