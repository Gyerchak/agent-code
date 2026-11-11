# {{BOX_NAME}} (agentcode-box)

A self-contained workspace for **Claude Code through Agent Code** (`~/agent-code`): its own
instructions, memory, sessions and Agent Code settings, and a write boundary (it can read anywhere but writes
only inside this folder and its scratch folder). Created by `agentcode-box`.

## Open it

- **Double-click `{{BOX_NAME}}.desktop`** — opens a terminal running the box.
- Or in a terminal: `box/scripts/agentcode-box.sh` (`run continue` takes over a running instance).
- Health check: `box/scripts/agentcode-box.sh doctor`

## What's inside

- `CLAUDE.md` — the box's instructions · `memory/` — durable memory (memory-first)
- `knowladge/` — sources (`box/scripts/tools/index-knowledge.sh` rebuilds `INDEX.md`)
- `Projekt/` — lasting projects · `work/` — one-off tasks
- **Settings** — by default the box uses Agent Code's own settings. Agent Code → Settings → "Box: own settings" gives
  it its own copy (`cfg/agent-code/`, started from the box's defaults in `box/settings.json`); "Box: reset to factory
  default" goes back to Agent Code's (the own copy is kept as a dated backup). Keys and MCP servers are always
  Agent Code's shared `~/.local/share/agent-code/auth.json`.
- `sessions/` — Agent Code state, and a link to the box's Claude Code sessions
- `.claude/` — permissions and the write-boundary hook

The folder can be moved or renamed; every path is recomputed on start (re-create the `.desktop` file
with `agentcode-box --desktop` inside the box after moving it).
