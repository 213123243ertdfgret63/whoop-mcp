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
trap 'rm -rf "$tmp"' EXIT INT TERM

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

cat <<EOF

Done. Restart Claude (or reconnect MCP servers), then ask Claude to "connect WHOOP".
It opens a page in your browser that walks you through creating your WHOOP app
and approving access.

Update:     run this installer again
Uninstall:  curl -fsSL https://raw.githubusercontent.com/$REPO/main/uninstall.sh | sh
EOF
