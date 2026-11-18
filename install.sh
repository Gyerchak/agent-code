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

# 5. The web app (acode-web): a desktop app in a browser window, Chromium-based or Firefox.
#    ACODE_BROWSER=chromium|firefox|none picks (default: ask when a terminal is attached, else what is installed).
ln -sf "$HOME_DIR/app/bin/acode-web" "$BIN_DIR/acode-web"
have_chromium() { for b in chromium chromium-browser google-chrome-stable google-chrome brave brave-browser microsoft-edge-stable vivaldi-stable; do command -v "$b" >/dev/null 2>&1 && return 0; done; [ -d "/Applications/Google Chrome.app" ] || [ -d "/Applications/Chromium.app" ] || [ -d "/Applications/Brave Browser.app" ]; }
have_firefox() { command -v firefox >/dev/null 2>&1 || command -v librewolf >/dev/null 2>&1 || [ -d "/Applications/Firefox.app" ]; }
ENGINE="${ACODE_BROWSER:-}"
if [ -z "$ENGINE" ] && [ -t 0 ] || { [ -z "$ENGINE" ] && [ -r /dev/tty ]; }; then
  printf 'Web app browser engine: [1] Chromium-based  [2] Firefox  [3] skip  (Enter = 1): '
  read -r answer < /dev/tty || answer=""
  case "$answer" in 2) ENGINE=firefox ;; 3) ENGINE=none ;; *) ENGINE=chromium ;; esac
fi
[ -n "$ENGINE" ] || { if have_chromium; then ENGINE=chromium; elif have_firefox; then ENGINE=firefox; else ENGINE=chromium; fi; }
install_browser() {
  # $1 = chromium | firefox. Uses the system's package manager (asks for your password); prints the command if none fits.
  if [ "$(uname)" = "Darwin" ]; then
    if command -v brew >/dev/null 2>&1; then brew install --cask "$( [ "$1" = firefox ] && echo firefox || echo chromium )"; else warn "Install Homebrew (https://brew.sh) or get the browser from its website."; fi
    return
  fi
  pkg=""
  if command -v pacman >/dev/null 2>&1; then pkg="sudo pacman -S --needed $( [ "$1" = firefox ] && echo firefox || echo chromium )"
  elif command -v apt-get >/dev/null 2>&1; then pkg="sudo apt-get install -y $( [ "$1" = firefox ] && echo firefox || echo chromium )"
  elif command -v dnf >/dev/null 2>&1; then pkg="sudo dnf install -y $( [ "$1" = firefox ] && echo firefox || echo chromium )"
  elif command -v zypper >/dev/null 2>&1; then pkg="sudo zypper install -y $( [ "$1" = firefox ] && echo MozillaFirefox || echo chromium )"
  elif command -v xbps-install >/dev/null 2>&1; then pkg="sudo xbps-install -y $( [ "$1" = firefox ] && echo firefox || echo chromium )"
  elif command -v apk >/dev/null 2>&1; then pkg="sudo apk add $( [ "$1" = firefox ] && echo firefox || echo chromium )"
  elif command -v emerge >/dev/null 2>&1; then pkg="sudo emerge $( [ "$1" = firefox ] && echo www-client/firefox-bin || echo www-client/chromium )"
  elif command -v flatpak >/dev/null 2>&1; then pkg="flatpak install -y flathub $( [ "$1" = firefox ] && echo org.mozilla.firefox || echo org.chromium.Chromium )"
  fi
  if [ -z "$pkg" ]; then warn "Install a browser with your package manager, then run acode-web."; return; fi
  if [ -r /dev/tty ]; then
    printf 'Install it now with: %s ?  [y/N] ' "$pkg"
    read -r yes < /dev/tty || yes=""
    case "$yes" in y|Y|yes) sh -c "$pkg" ;; *) echo "Later: $pkg" ;; esac
  else echo "Install it with: $pkg"; fi
}
if [ "$ENGINE" = chromium ] && ! have_chromium; then install_browser chromium; fi
if [ "$ENGINE" = firefox ] && ! have_firefox; then install_browser firefox; fi
if [ "$ENGINE" != none ]; then
  CONF="${XDG_CONFIG_HOME:-$HOME/.config}/agent-code"
  mkdir -p "$CONF"
  [ -f "$CONF/web.json" ] || printf '{ "engine": "%s" }\n' "$ENGINE" > "$CONF/web.json"
  if [ "$(uname)" = "Linux" ]; then
    # A launcher entry, so it starts like any app (menu, dock, search).
    APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
    mkdir -p "$APPS"
    cp "$HOME_DIR/app/web/icon.svg" "${XDG_DATA_HOME:-$HOME/.local/share}/icons/agent-code.svg" 2>/dev/null || { mkdir -p "${XDG_DATA_HOME:-$HOME/.local/share}/icons"; cp "$HOME_DIR/app/web/icon.svg" "${XDG_DATA_HOME:-$HOME/.local/share}/icons/agent-code.svg"; }
    cat > "$APPS/agent-code-web.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Agent Code
Comment=Every coding agent in one app (Claude Code, opencode, DeepSeek Harness, Codex)
Exec=$BIN_DIR/acode-web %F
Icon=${XDG_DATA_HOME:-$HOME/.local/share}/icons/agent-code.svg
Terminal=false
Categories=Development;
StartupWMClass=agent-code
DESKTOP
    command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS" >/dev/null 2>&1 || true
  elif [ "$(uname)" = "Darwin" ]; then
    # A small app bundle in ~/Applications that runs acode-web.
    APP="$HOME/Applications/Agent Code.app/Contents/MacOS"
    mkdir -p "$APP"
    printf '#!/bin/sh\nexec "%s/acode-web" "$HOME"\n' "$BIN_DIR" > "$APP/Agent Code"
    chmod +x "$APP/Agent Code"
    printf '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleExecutable</key><string>Agent Code</string><key>CFBundleName</key><string>Agent Code</string><key>CFBundleIdentifier</key><string>dev.agentcode.web</string></dict></plist>\n' > "$HOME/Applications/Agent Code.app/Contents/Info.plist"
  fi
  bold "Web app: acode-web  (engine: $ENGINE; change it with acode-web --engine chromium|firefox)"
fi

# 6. The engines.
if ! command -v claude >/dev/null 2>&1; then
  warn "Claude Code is not installed. For the Claude Code engine: npm i -g @anthropic-ai/claude-code, then run claude once to log in."
fi
echo "Optional harnesses: opencode (npm i -g opencode-ai), DeepSeek Harness (npm i -g @deepseek-ai/dsh),"
echo "Codex (npm i -g @openai/codex @agentclientprotocol/codex-acp)."
bold "Done. Start with: acode   (terminal)   or   acode-web   (app window)"
