#!/bin/sh
# Installs (or updates) whoop-mcp and adds it to Claude Code and Claude Desktop.
#
#   curl -fsSL https://raw.githubusercontent.com/213123243ertdfgret63/whoop-mcp/main/install.sh | sh
#
# Options (environment variables):
#   WHOOP_MCP_VERSION=0.1.0      install that release instead of the latest
#   WHOOP_MCP_INSTALL_DIR=...    install location (default: ~/.whoop-mcp)
#   WHOOP_MCP_NO_CLAUDE=1        only install the binary; don't touch Claude's configuration
set -eu

REPO="213123243ertdfgret63/whoop-mcp"
INSTALL_DIR="${WHOOP_MCP_INSTALL_DIR:-$HOME/.whoop-mcp}"
VERSION="${WHOOP_MCP_VERSION:-latest}"
# For testing against a local copy of the release assets.
DOWNLOAD_URL="${WHOOP_MCP_DOWNLOAD_URL:-}"

say() { printf '%s\n' "$*"; }
fail() { printf 'whoop-mcp install: %s\n' "$*" >&2; exit 1; }

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

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "unsupported OS $(uname -s); download a binary from https://github.com/$REPO/releases instead" ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) fail "unsupported CPU $(uname -m)" ;;
esac
# An x64 shell under Rosetta on Apple Silicon should still get the native binary.
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
  arch=arm64
fi
asset="whoop-mcp-$os-$arch"

if [ -z "$DOWNLOAD_URL" ]; then
  if [ "$VERSION" = latest ]; then
    DOWNLOAD_URL="https://github.com/$REPO/releases/latest/download"
  else
    DOWNLOAD_URL="https://github.com/$REPO/releases/download/v${VERSION#v}"
  fi
fi

download() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 2 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1"
  else
    fail "needs curl or wget"
  fi
}

sha256() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    fail "needs shasum or sha256sum to verify the download"
  fi
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
# Exit on Ctrl-C (including at the restart prompt); the EXIT trap still cleans up.
trap 'exit 130' INT TERM

say "Downloading $asset ($VERSION)…"
download "$DOWNLOAD_URL/$asset" "$tmp/$asset" || fail "download failed: $DOWNLOAD_URL/$asset"
download "$DOWNLOAD_URL/SHA256SUMS" "$tmp/SHA256SUMS" || fail "download failed: $DOWNLOAD_URL/SHA256SUMS"

expected="$(awk -v f="$asset" '$2 == f || $2 == "*" f { print $1 }' "$tmp/SHA256SUMS")"
[ -n "$expected" ] || fail "SHA256SUMS has no entry for $asset"
actual="$(sha256 "$tmp/$asset")"
[ "$expected" = "$actual" ] || fail "checksum mismatch for $asset (expected $expected, got $actual)"

mkdir -p "$INSTALL_DIR/bin"
chmod +x "$tmp/$asset"
# Downloads from a browser carry a quarantine flag; curl's don't, but clearing it is harmless.
[ "$os" = darwin ] && xattr -d com.apple.quarantine "$tmp/$asset" 2>/dev/null || true
# Same path every time, so re-running this script updates in place and Claude's config stays valid.
mv -f "$tmp/$asset" "$INSTALL_DIR/bin/whoop-mcp"
bin="$INSTALL_DIR/bin/whoop-mcp"
installed="$("$bin" --version)" || fail "the installed binary doesn't run: $bin"
say "Installed whoop-mcp $installed to $bin"

if [ "${WHOOP_MCP_NO_CLAUDE:-}" = 1 ]; then
  say "Skipping Claude configuration (WHOOP_MCP_NO_CLAUDE=1)."
  exit 0
fi

"$bin" claude add --command "$bin" || fail "couldn't add whoop to Claude (see above)"

# The Claude desktop app keeps claude_desktop_config.json in memory (it also holds its preferences) and writes
# it back on quit, dropping entries added while it was running. Claude Code's registration is not affected.
restarted=0
if claude_desktop_running; then
  say ""
  say "Claude Desktop is running. It rewrites its config when it quits, which would drop the entry just added,"
  say "so it needs a restart: quit, re-add whoop, reopen. This closes Claude's windows and any running sessions."
  if ask_yes "Restart Claude now?"; then
    rc=0
    restart_claude_desktop "$bin" add "$INSTALL_DIR/restart.log" "" || rc=$?
    case "$rc" in
      0) restarted=1 ;;
      10)
        restarted=1
        say "This terminal is inside Claude, so it closes along with Claude; the restart finishes in the background."
        say "If whoop is missing afterwards, see $INSTALL_DIR/restart.log."
        ;;
      *) say "Claude Desktop's config wasn't updated (see above)." ;;
    esac
  else
    say "Later, to make sure Claude Desktop keeps it: quit Claude (Cmd+Q), run"
    say "  \"$bin\" claude add"
    say "and open Claude again. (Claude Code is already set up: just start a new session.)"
  fi
fi

if [ "$restarted" = 1 ]; then
  next="Once Claude has reopened (in Claude Code, start a new session),"
else
  next="Restart Claude (and start a new session in Claude Code), then"
fi
cat <<EOF

Done. $next ask Claude to "connect WHOOP".
It opens a page in your browser that walks you through creating your WHOOP app
and approving access.

Update:     run this installer again
Uninstall:  curl -fsSL https://raw.githubusercontent.com/$REPO/main/uninstall.sh | sh
EOF
