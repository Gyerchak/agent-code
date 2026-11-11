#!/bin/sh
# acode installer for Linux and macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/Gyerchak/agent-code/main/install.sh | sh
#   ./install.sh            (from a downloaded copy of the repository)
#
# Environment: ACODE_REPO (owner/name, default Gyerchak/agent-code), ACODE_HOME (install folder, default
# ~/.local/share/acode), ACODE_BIN (folder for the command, default ~/.local/bin).
set -eu

REPO="${ACODE_REPO:-Gyerchak/agent-code}"
HOME_DIR="${ACODE_HOME:-$HOME/.local/share/acode}"
BIN_DIR="${ACODE_BIN:-$HOME/.local/bin}"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*" >&2; }
fail() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

bold "acode installer"

# 1. Node.js 26 or newer.
NODE="$(command -v node || true)"
for candidate in "$NODE" $(ls -d "${NVM_DIR:-$HOME/.nvm}"/versions/node/v*/bin/node 2>/dev/null | sort -rV); do
  [ -n "$candidate" ] && [ -x "$candidate" ] || continue
  major="$("$candidate" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$major" -ge 26 ] 2>/dev/null; then NODE="$candidate"; break; fi
  NODE=""
done
if [ -z "$NODE" ]; then
  warn "acode needs Node.js 26 or newer."
  if [ "$(uname)" = "Darwin" ]; then warn "Install it with: brew install node   (or nvm: nvm install 26)"
  else warn "Install it with nvm: curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | bash && nvm install 26"; fi
  fail "Then run this installer again."
fi
PATH="$(dirname "$NODE"):$PATH"
export PATH
bold "Node.js $("$NODE" --version) found."

# 2. The code: from this copy of the repository, or downloaded from GitHub.
SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd || echo)"
mkdir -p "$HOME_DIR"
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/app/package.json" ]; then
  bold "Copying acode from $SCRIPT_DIR/app"
  rm -rf "$HOME_DIR/app.new"
  cp -R "$SCRIPT_DIR/app" "$HOME_DIR/app.new"
else
  bold "Downloading acode from github.com/$REPO"
  TMP="$(mktemp -d)"
  URL="https://codeload.github.com/$REPO/tar.gz/refs/heads/main"
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$URL" -o "$TMP/agent-code.tar.gz"
  elif command -v wget >/dev/null 2>&1; then wget -qO "$TMP/agent-code.tar.gz" "$URL"
  else fail "Neither curl nor wget is installed."; fi
  tar -xzf "$TMP/agent-code.tar.gz" -C "$TMP"
  rm -rf "$HOME_DIR/app.new"
  cp -R "$TMP"/*/app "$HOME_DIR/app.new"
  rm -rf "$TMP"
fi
# An update keeps nothing but the code: settings and keys live in your config folders.
rm -rf "$HOME_DIR/app"
mv "$HOME_DIR/app.new" "$HOME_DIR/app"

# 3. Dependencies and build.
bold "Installing dependencies and building (a minute)"
( cd "$HOME_DIR/app" && npm ci --no-audit --no-fund --loglevel=error && npm run build --silent )

# 4. The commands.
mkdir -p "$BIN_DIR"
ln -sf "$HOME_DIR/app/bin/acode" "$BIN_DIR/acode"
if [ "$(uname)" = "Linux" ]; then
  ln -sf "$HOME_DIR/app/bin/acode-window" "$BIN_DIR/acode-window"
  ln -sf "$HOME_DIR/app/bin/acode-box" "$BIN_DIR/acode-box"
fi
bold "Installed: $BIN_DIR/acode"
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) warn "Add $BIN_DIR to your PATH (e.g. in ~/.profile): export PATH=\"$BIN_DIR:\$PATH\"" ;; esac

# 5. The engines.
if ! command -v claude >/dev/null 2>&1; then
  warn "Claude Code is not installed. For the Claude Code engine: npm i -g @anthropic-ai/claude-code, then run claude once to log in."
fi
echo "Optional harnesses: opencode (npm i -g opencode-ai), DeepSeek Harness (npm i -g @deepseek-ai/dsh),"
echo "Codex (npm i -g @openai/codex @agentclientprotocol/codex-acp)."
bold "Done. Start with: acode"
