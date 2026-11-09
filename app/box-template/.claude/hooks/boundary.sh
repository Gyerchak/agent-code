#!/usr/bin/env bash
# boundary.sh — PreToolUse hook: an occ-box may write ONLY inside itself and its scratch folder
# (/tmp/occ-box/<escaped box path>, also in $OCC_BOX_SCRATCH). Runs before occ's auto-allow, so it
# holds even when "Allow everything" is on. Reads anywhere stay allowed.
input="$(cat)"
box="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
box="$(realpath -m -- "$box")"
scratch="/tmp/occ-box/$(printf '%s' "$box" | sed 's/[^a-zA-Z0-9]/-/g')"
path="$(printf '%s' "$input" | python3 -I -c '
import json, sys
i = json.load(sys.stdin).get("tool_input", {})
print(i.get("file_path") or i.get("notebook_path") or "")')"
[ -z "$path" ] && exit 0
case "$path" in /*) ;; *) path="$box/$path" ;; esac
real="$(realpath -m -- "$path")"
case "$real" in
  "$box"|"$box"/*|"$scratch"|"$scratch"/*) exit 0 ;;
esac
echo "occ-box boundary: writes are allowed only inside $box and $scratch (blocked: $real)" >&2
exit 2
