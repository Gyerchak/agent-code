# Agent Code

**One terminal for every coding agent.** Agent Code is a fast, keyboard-first terminal UI that runs
**Claude Code**, **opencode**, **DeepSeek Harness** and **Codex** side by side — each conversation in its
own tab, all with the same transcript, tool views, permission prompts and shortcuts.

The interface follows [opencode](https://github.com/anomalyco/opencode)'s TUI (layout, themes, keybinds),
built on the same renderer (OpenTUI + Solid). The agents underneath are the real ones you install:
Agent Code drives Claude Code through the Claude Agent SDK and the other harnesses through the
[Agent Client Protocol](https://agentclientprotocol.com).

## Highlights

- **Several harnesses, one window** — Claude Code, opencode, DeepSeek Harness and Codex as engines; pick any
  of their models from one model picker (favourites, recent, per provider).
- **Your providers inside Claude Code** — OpenAI, DeepSeek, OpenCode Zen/Go, Ollama (local and cloud) and any
  OpenAI-compatible endpoint can run inside Claude Code through Agent Code's built-in protocol proxy.
- **Tabs and sessions** — many conversations at once, restored on the next start; fork, revert/redo messages,
  timeline, session list.
- **Attachments** — drop or paste files of any kind; pictures, GIFs, video and sound preview in the chat
  (click to view full size or play).
- **Plan usage at a glance** — exact 5-hour, weekly and per-model (Fable) Claude plan meters, auto-resume after a
  limit resets, a one-click 5-hour reset when Anthropic offers one, and each model's API and effective plan price.
- **Extensible** — Claude Code mods (plugins with UI) are drawn in Agent Code; Agent Code has its own plugin API as well.
- **33 themes**, subagent views, MCP servers, skills, voice input/output (optional), and much more.

## Install

Requirements: **Node.js 26 or newer**. For the Claude Code engine: [Claude Code](https://docs.claude.com/en/docs/claude-code)
installed and logged in (`claude`). The other harnesses are optional.

**Linux and macOS**

```sh
curl -fsSL https://raw.githubusercontent.com/Gyerchak/agent-code/main/install.sh | sh
```

**Windows** (PowerShell)

```powershell
irm https://raw.githubusercontent.com/Gyerchak/agent-code/main/install.ps1 | iex
```

Or download this repository and run `install.sh` (Linux/macOS) or double-click `install.cmd` (Windows).
The installer copies Agent Code to `~/.local/share/acode` (Windows: `%LOCALAPPDATA%\acode`), builds it and adds the
`acode` command to your PATH.

### Optional harnesses

| Harness | Install | Sign-in |
| --- | --- | --- |
| Claude Code | `npm i -g @anthropic-ai/claude-code` | `claude` (log in once) |
| opencode | `npm i -g opencode-ai` | its own `/connect` |
| DeepSeek Harness | `npm i -g @deepseek-ai/dsh` | a DeepSeek key in Agent Code's `/connect` |
| Codex (OpenAI) | `npm i -g @openai/codex @agentclientprotocol/codex-acp` | `codex login`, or an OpenAI key in `/connect` |

Installed harnesses appear in the model picker (`ctrl+x m`) by themselves.

## Use

```sh
acode                 # new session in the current folder (or the tabs you left open)
acode ~/project       # open a folder
acode -c              # continue the last session here
acode -r [id]         # resume a session (no id: the session list)
acode -m sonnet       # start with a model
acode "fix the tests" # start with a prompt
```

| Key | Action |
| --- | --- |
| `ctrl+p` | command palette |
| `ctrl+x m` | models (`ctrl+f` favourite, `ctrl+d` remove from recent) |
| `ctrl+t` | reasoning level |
| `tab` | next mode (Build, Plan, your own) |
| `ctrl+tab` | modes |
| `ctrl+f` | find in the chat (newest first) |
| `ctrl+1`…`ctrl+9` | jump to a tab (drag tabs to reorder) |
| `ctrl+x n` / `ctrl+x l` | new session / sessions |
| `ctrl+x ←` / `ctrl+x →` | previous / next tab |
| `ctrl+x u` / `ctrl+x r` | undo / redo a message |
| `ctrl+x g` | timeline |
| `ctrl+x b` | sidebar |
| `esc esc` | interrupt |
| `@` / `/` / `!` | mention a file / commands / shell mode |

`/login` runs each harness's own login (Claude Code, opencode, Codex) right inside Agent Code, `/find` searches your
chats, `/settings` holds the options (and can save, restore or reset them), `/connect` adds provider keys,
`/mods` manages Claude Code mods, `/update` updates Agent Code.

## On your phone

`/phone` starts Agent Code's phone server (local network, a public address or this computer only; port and HTTPS
are settings) and shows a QR code. Scan it on Android or iPhone and add the page to the home screen: the phone
then shows your tabs and chats live, sends prompts and files, stops, pauses and approves tools — the work keeps
running on the computer. Files a chat produced can be downloaded on the phone when you allow it.

## Pause

The pause bar at the bottom of the sidebar (`ctrl+x p`) stops the work at its next step until you resume (or until
a time, or until the plan limit resets). Nothing is sent while paused and resuming sends nothing extra. With
"Pause before a limit" on, Agent Code does this by itself when a Claude plan limit window reaches the "Pause at" level
(95% by default). Turn it on or off with the switch right below the pause bar, and right-click the switch to set the
level (or use `/settings`). Resume to go on up to 100% of that window.

## Files

| What | Where |
| --- | --- |
| Settings | `~/.config/agent-code/config.json` |
| Provider keys | `~/.local/share/agent-code/auth.json` (only on your machine) |
| State and logs | `~/.local/state/agent-code/` |

Conversations are the harnesses' own: Claude Code sessions stay Claude Code sessions (`claude --resume`
sees them), opencode's stay opencode's.

## Build from source

```sh
cd app
npm ci
npm run build
./bin/acode          # Windows: bin\acode.cmd
```

## Licence and credits

MIT — see [LICENSE](LICENSE). The TUI's look and components are adapted from
[opencode](https://github.com/anomalyco/opencode) (MIT, see [OPENCODE-LICENSE](OPENCODE-LICENSE)).
Agent Code is an independent project, not affiliated with Anthropic, OpenAI, DeepSeek or the opencode authors;
their names identify the tools Agent Code can run.
