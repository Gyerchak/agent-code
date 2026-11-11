#!/usr/bin/env bash
set -euo pipefail
# acode-box.sh — runs this acode-box: Claude Code through acode (~/agent-code), inside this folder.
#
#   acode-box.sh [run]        start acode here, in this terminal (what the .desktop launcher runs)
#   acode-box.sh run continue  take over from a running instance of this box
#   acode-box.sh run [continue] -- <acode args>   pass arguments to acode (e.g. -- -r <session> -p "prompt")
#   acode-box.sh doctor       check the setup
#
# Everything the box needs lives in this folder; every path is recomputed on start, so the folder can
# be moved or renamed. Created by `acode-box` (see ~/agent-code/bin/acode-box).

BOX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BOX_NAME="$(basename "$BOX_DIR")"
ESCAPED="$(printf '%s' "$BOX_DIR" | sed 's/[^a-zA-Z0-9]/-/g')"
SESSIONS_DIR="$BOX_DIR/sessions"      # acode state + link to the box's Claude Code sessions
CFG_DIR="$BOX_DIR/cfg"                # the box's own acode settings, used only when cfg/own-settings exists
OWN_MARKER="$CFG_DIR/own-settings"    # created/removed by acode: Settings → "Box: own settings"
SCRATCH_DIR="/tmp/acode-box/$ESCAPED"   # the box's scratch space (writes allowed here too)
LOCKFILE="${TMPDIR:-/tmp}/acode-box$ESCAPED.lock"
# Claude Code keeps sessions per directory in ~/.claude/projects/<escaped path>
CLAUDE_PROJECT_STORE="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/$ESCAPED"
ORIG_XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-}"
# Folders from before the rename to Agent Code ("open-claude-code") move over once; a link keeps the old name working.
moved_over() {
  [ -e "$1/agent-code" ] && return 0
  [ -d "$1/open-claude-code" ] && [ ! -L "$1/open-claude-code" ] || return 0
  mv "$1/open-claude-code" "$1/agent-code" && ln -s "$1/agent-code" "$1/open-claude-code"
}
moved_over "${XDG_CONFIG_HOME:-$HOME/.config}"
moved_over "${XDG_STATE_HOME:-$HOME/.local/state}"
moved_over "$CFG_DIR"
ACODE_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/agent-code/config.json"   # acode's own settings
LAUNCH_LOG="$SESSIONS_DIR/state/launcher.log"

log() { mkdir -p "$(dirname "$LAUNCH_LOG")"; printf '[%s] %s\n' "$(date '+%F %T')" "$*" >> "$LAUNCH_LOG" 2>/dev/null || true; }

# Opened from the .desktop launcher the window would vanish on an error: keep it open and say why.
on_exit() {
  local status=$?
  [ -n "${LOCK_TAKEN:-}" ] && rm -f "$LOCKFILE"
  log "exit $status"
  if [ "$status" -ne 0 ] && { : </dev/tty; } 2>/dev/null; then
    echo
    echo "acode-box stopped (exit $status). Details: $LAUNCH_LOG"
    read -r -p "Press Enter to close…" _ </dev/tty || true
  fi
}
trap on_exit EXIT
trap 'log "error at line $LINENO: $BASH_COMMAND"' ERR

ACODE_BIN=""
for c in "$BOX_DIR/box/bin/acode" "$(command -v acode 2>/dev/null || true)" "$HOME/.local/bin/acode" "$HOME/agent-code/bin/acode"; do
  [ -n "$c" ] && [ -x "$c" ] && { ACODE_BIN="$c"; break; }
done

prepare_env() {
  mkdir -p "$SESSIONS_DIR/state" "$CFG_DIR" "$SCRATCH_DIR" "$CLAUDE_PROJECT_STORE"
  # Claude Code ignores the box's .claude/settings.json permissions in an untrusted folder; the box is
  # yours, so mark it trusted (again after a move or rename: the path is the key).
  python3 -I - "${CLAUDE_CONFIG_DIR:-$HOME}/.claude.json" "$BOX_DIR" <<'PY' || log "could not mark the box trusted"
import json, os, sys
path, box = sys.argv[1], sys.argv[2]
try:
    data = json.load(open(path))
except Exception:
    sys.exit(0)
project = data.setdefault("projects", {}).setdefault(box, {})
if project.get("hasTrustDialogAccepted") is True:
    sys.exit(0)
project["hasTrustDialogAccepted"] = True
temp = f"{path}.acode-box.{os.getpid()}"
with open(temp, "w") as out:
    json.dump(data, out, indent=2)
os.chmod(temp, os.stat(path).st_mode & 0o777)
os.replace(temp, path)
PY
  # visible link to the box's Claude Code sessions (recomputed: the box may have moved)
  ln -sfn "$CLAUDE_PROJECT_STORE" "$SESSIONS_DIR/claude"
}

doctor() {
  echo "acode-box — $BOX_DIR"
  [ -n "$ACODE_BIN" ] && echo "  ✓ acode: $ACODE_BIN" || { echo "  ✗ acode not found (~/agent-code/bin/acode)"; exit 1; }
  command -v node >/dev/null 2>&1 && echo "  ✓ node $(node --version)" || echo "  ✗ node missing (acode needs Node ≥ 26)"
  for f in CLAUDE.md memory/MEMORY.md .claude/settings.json .claude/hooks/boundary.sh; do
    [ -f "$BOX_DIR/$f" ] && echo "  ✓ $f" || echo "  ✗ $f missing"
  done
  for d in knowladge memory Projekt work; do
    [ -d "$BOX_DIR/$d" ] && echo "  ✓ $d/ ($(find "$BOX_DIR/$d" -type f 2>/dev/null | wc -l) files)" || echo "  ✗ $d/ missing"
  done
  echo "  · claude sessions: $CLAUDE_PROJECT_STORE"
  if [ -f "$OWN_MARKER" ]; then echo "  · settings:        own ($CFG_DIR/agent-code/config.json)"; else echo "  · settings:        acode's ($ACODE_CONFIG)"; fi
  echo "  · scratch:         $SCRATCH_DIR"
  echo "Health check done."
}

MODE="${1:-run}"
ARG2="${2:-}"
# Everything after "--" goes to acode.
ACODE_ARGS=()
for ((i = 1; i <= $#; i++)); do
  if [ "${!i}" = "--" ]; then ACODE_ARGS=("${@:i+1}"); break; fi
done
[ "$ARG2" = "--" ] && ARG2=""

case "$MODE" in
  doctor) doctor; exit 0 ;;
  run|launch) ;;
  *) echo "usage: acode-box.sh [run [continue] | doctor]" >&2; exit 2 ;;
esac

if [ -z "$ACODE_BIN" ]; then
  echo "acode not found — expected ~/agent-code/bin/acode (or box/bin/acode)." >&2
  exit 1
fi

# One instance per box: a second start says so (and `run continue` takes over).
if [ -f "$LOCKFILE" ]; then
  LOCK_PID="$(cat "$LOCKFILE" 2>/dev/null || true)"
  if [ -n "$LOCK_PID" ] && kill -0 "$LOCK_PID" 2>/dev/null && [ "$LOCK_PID" != "$$" ]; then
    if [ "$ARG2" != "continue" ]; then
      echo "$BOX_NAME is already open (PID $LOCK_PID). Use that window, or: acode-box.sh run continue"
      command -v notify-send >/dev/null 2>&1 && notify-send -a acode-box "$BOX_NAME is already open" "Use the existing window." || true
      sleep 3
      exit 0
    fi
    kill "$LOCK_PID" 2>/dev/null || true
    sleep 1
  fi
  rm -f "$LOCKFILE"
fi
echo $$ > "$LOCKFILE"
LOCK_TAKEN=1
log "start (acode: $ACODE_BIN)"

prepare_env

# Settings: acode's own by default; the box's copy when "Box: own settings" is on (checked on every start).
use_settings() {
  if [ -f "$OWN_MARKER" ]; then
    mkdir -p "$CFG_DIR/agent-code"
    local cfg="$CFG_DIR/agent-code/config.json"
    # First time: the box's defaults (box/settings.json) plus acode's providers.
    [ -f "$cfg" ] || python3 -I - "$BOX_DIR/box/settings.json" "$ACODE_CONFIG" "$cfg" <<'PY' || log "could not create own settings"
import json, sys
defaults_file, main_file, out = sys.argv[1:]
def read(path):
    try:
        return json.load(open(path))
    except Exception:
        return None
main = read(main_file) or {}
settings = read(defaults_file) or {k: v for k, v in main.items() if k not in ("tabs", "promptHistory", "sessionModels", "recentModels")}
for key in ("providers", "providersImported", "mcpImported"):
    if key in main:
        settings[key] = main[key]
json.dump(settings, open(out, "w"), indent=2)
PY
    export XDG_CONFIG_HOME="$CFG_DIR"
    log "settings: own ($cfg)"
  else
    if [ -n "$ORIG_XDG_CONFIG_HOME" ]; then export XDG_CONFIG_HOME="$ORIG_XDG_CONFIG_HOME"; else unset XDG_CONFIG_HOME; fi
    log "settings: acode ($ACODE_CONFIG)"
  fi
}

# Plan usage is shared with every other acode window (one poller; the endpoint rate-limits).
export ACODE_SHARED_STATE="${XDG_STATE_HOME:-$HOME/.local/state}/agent-code"
export XDG_STATE_HOME="$SESSIONS_DIR/state"
export ACODE_BOX_DIR="$BOX_DIR"
export ACODE_BOX_SCRATCH="$SCRATCH_DIR"
export ACODE_MAIN_CONFIG="$ACODE_CONFIG"

cd "$BOX_DIR"
printf '\033]0;%s\007\033]2;%s\007' "$BOX_NAME" "$BOX_NAME"

# plain acode reopens the box's last tabs (else the most recent session); exit code 75 = restart
# (acode asks for it after switching the box's settings).
while :; do
  use_settings
  set +e
  trap - ERR   # acode's own exit codes are not launcher errors
  if { : </dev/tty; } 2>/dev/null; then
    "$ACODE_BIN" "${ACODE_ARGS[@]}" "$BOX_DIR" </dev/tty
  else
    "$ACODE_BIN" "${ACODE_ARGS[@]}" "$BOX_DIR"
  fi
  status=$?
  set -e
  trap 'log "error at line $LINENO: $BASH_COMMAND"' ERR
  # A restart reopens the box normally (the passed arguments were for the first start only).
  [ "$status" -eq 75 ] && { log "restart"; ACODE_ARGS=(); continue; }
  exit "$status"
done
