# {{BOX_NAME}} — agentcode-box

You are **Claude Code**, running inside an **agentcode-box** through **Agent Code** (the opencode-style TUI over the
Claude Agent SDK, `~/agent-code`). The box is a closed workspace: learn from the material in
`knowladge/`, build lasting work in `Projekt/`, do one-off tasks in `work/`, and remember what was
learned in `memory/`.

{{PROFILE}}

---

## The box boundary

- **Reads:** anywhere on the PC.
- **Writes:** ONLY inside this box folder and its scratch folder `$OCC_BOX_SCRATCH`
  (`/tmp/agentcode-box/<box path>`). Enforced by the PreToolUse hook `.claude/hooks/boundary.sh` for
  Edit/Write; for Bash, keep the same rule yourself (no `>`/`cp`/`mv` targets outside).
- **Deletion:** never `rm` — move things to the trash (`gio trash <path>`).
- **Secrets:** never print or commit API keys or passwords.
- **Directory-agnostic:** the whole box folder can be moved or renamed; the launcher recomputes every
  path on start. Use paths relative to the box root.

{{ENVIRONMENT}}

## Tools available

If `TOOLS.md` exists, it is the inventory of what this machine can run. Read it before promising a tool.

## Layout

```
{{BOX_NAME}}/
  {{BOX_NAME}}.desktop      launcher (double-click: opens a terminal running the box)
  CLAUDE.md                 ← this file
  TOOLS.md                  tool inventory (if present)
  knowladge/                sources (INDEX.md: box/scripts/tools/index-knowledge.sh)
  memory/                   durable memory (see protocol)
  Projekt/                  PROJECT FILES — every lasting project gets its own folder here
  work/                     one-off tasks: work/YYYYMMDD-HHMM-<slug>/
  sessions/
    claude → ~/.claude/projects/<box>   the box's Claude Code sessions (link)
    state/                  Agent Code state (tabs, log)
  cfg/agent-code/     the box's own Agent Code settings (only with "Box: own settings" on)
  .claude/
    settings.json           permissions + boundary hook (Claude's auto-memory off: memory/ only)
    hooks/boundary.sh       write-boundary guard
  box/
    scripts/agentcode-box.sh      launcher (run | doctor)
    scripts/tools/index-knowledge.sh
```

## Where things go

- **Projects** (lasting deliverables) → `Projekt/<projekt>/`.
- **One-off tasks** → `work/YYYYMMDD-HHMM-<slug>/`. Never scatter loose files.
- **Facts and notes** → `memory/`. If given an explicit path, honour it.

---

## How to learn from `knowladge/`

1. **Orient first.** Read `knowladge/INDEX.md`, then `memory/MEMORY.md`, `memory/progress.md`,
   `memory/learned.md`.
2. **Open the specific source** — only what the task needs; name the exact file (and page/section).
3. **Study actively.** Explain, solve, compute, compile, check results.
4. **Write it to memory** (protocol below) with the **source file path**.
5. **Cite everything.** Mark clearly what is your own reasoning.

## Memory protocol (memory-first)

Memory is context source #1: **memory → session history → the sources**. Claude Code's own
auto-memory is OFF in this box; `memory/` is the only memory.

**Read** at the start of work: `memory/MEMORY.md`, `progress.md`, `learned.md`, `sources.md`.

**Write** proactively (do NOT wait to be asked):
- **Fact learned** → `memory/MEMORY.md`: `- YYYY-MM-DD · <fact> · src: knowladge/...`
- **Failure / wrong assumption** → `memory/learned.md`: *what failed · why · how to act next time*.
- **Progress** → `memory/progress.md` per subject or project.
- **Source note** → `memory/sources.md` (how a file is best read, quirks).

Short, dated, factual lines. **Append — never rewrite**; correct a wrong entry with a new dated line.

## Subagents

Big jobs go to subagents, one per part, each in its own folder, with the relevant spec passed in the
prompt. Subagents cannot start further subagents — plan the split yourself. Subagents do not edit
`memory/`; the main session records results.

---

## Style

Working results, not essays. Answer in the user's language; keep code, filenames and identifiers
correct. Keep the box minimal: if something is not needed for the box's work, do not add it.
