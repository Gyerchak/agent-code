# Agent Code

**One terminal for every coding agent.** Agent Code is a fast, keyboard-first terminal UI that runs
**Claude Code**, **opencode**, **DeepSeek Harness** and **Codex** side by side — each conversation in its
own tab, all with the same transcript, tool views, permission prompts and shortcuts.

The interface follows [opencode](https://github.com/anomalyco/opencode)'s TUI (layout, themes, keybinds),
built on the same renderer (OpenTUI + Solid). The agents underneath are the real ones you install:
Agent Code drives Claude Code through the Claude Agent SDK and the other harnesses through the
[Agent Client Protocol](https://agentclientprotocol.com).

Agent Code comes in two forms that share everything (sessions, settings, keys, memory): the **terminal app**
(`acode`) and the **web app** (`acode-web`), a desktop app in a browser window whose look mixes Agent Code's
terminal theme with the layout of [chat.deepseek.com](https://chat.deepseek.com) (a chats sidebar you fold away, a
centred chat, a rounded message box), without any sign-in: it runs on your computer and talks to nothing but the
agents you use. It is not affiliated with DeepSeek; the likeness is only the layout.

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
- **Memory that stays small** — Claude sees only an index of what it remembers and opens a memory when the
  work needs it; each session keeps its own open set, restored after compaction.
- **Remote desktop on your phone** — on-demand screen and sound, mouse, keyboard, voice typing and a game
  mode, from the same phone app (KDE Plasma on Wayland).
- **Orchestrator mode** — the main chat plans and delegates to subagents it picks itself, within limits you set
  (reasoning levels, models, providers).
- **Subagent routing** — fix the exact model and variant for each kind of delegated task and each complexity level.
- **Chat mode** — new chats start as a plain conversation (no tools unless you ask); Tab switches to Build or Plan.
- **One conversation across engines** — switch a tab from Claude to opencode, DeepSeek or Codex and back: the
  chat stays one, and each new model gets the conversation so far. Unsent messages and drafts survive restarts.
- **Windows like a browser's** — a second `acode` opens a new window whose tabs continue the numbering; closing
  one hands its tabs to the other; drag a tab off the strip to give it its own window.
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

### Web app (`acode-web`)

The installers set it up too: they ask for the browser engine (**Chromium-based**: Chromium, Chrome, Brave, Edge,
Vivaldi; or **Firefox**), offer to install the browser if it is missing, and add a launcher (Linux: app menu,
macOS: `~/Applications/Agent Code.app`, Windows: Start menu). Run it with:

```sh
acode-web                     # this folder, the saved engine
acode-web ~/project --engine firefox
acode-web --user work         # another user: a setup of its own (settings, keys, tabs, chats)
```

The window has the chats on the left (fold them with ⟨ or Ctrl+B), the chat in the middle, Agent Code's panels on
the right (context, usage, tasks; Ctrl+.), and a **terminal view** (⌨ or Ctrl+`) that shows Agent Code's own screen
live, so every option of the terminal app is there too. Settings has the switches, the **users** (switch, create,
factory reset) and **New acode-box**. Closing the window ends Agent Code.

### Everything it needs, by system

Node.js 26+ is the one hard requirement; a browser for the web app; the rest is optional.

| System | Node.js 26 | Browser for the web app | Optional extras |
| --- | --- | --- | --- |
| Arch, CachyOS, Manjaro | `sudo pacman -S nodejs npm` (or nvm) | `sudo pacman -S chromium` / `firefox` | `sudo pacman -S git qrencode openssl python-gobject gst-plugins-good wl-clipboard ydotool` |
| Debian, Ubuntu, Mint, Pop!_OS | nvm: `curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh \| bash && nvm install 26` | `sudo apt install chromium` (Ubuntu: `sudo snap install chromium`) / `firefox` | `sudo apt install git qrencode openssl python3-gi gstreamer1.0-plugins-good wl-clipboard ydotool` |
| Fedora | `sudo dnf install nodejs` (or nvm) | `sudo dnf install chromium` / `firefox` | `sudo dnf install git qrencode openssl python3-gobject gstreamer1-plugins-good wl-clipboard ydotool` |
| openSUSE | `sudo zypper install nodejs26` (or nvm) | `sudo zypper install chromium` / `MozillaFirefox` | `sudo zypper install git qrencode openssl python3-gobject gstreamer-plugins-good wl-clipboard ydotool` |
| Void | `sudo xbps-install nodejs` (or nvm) | `sudo xbps-install chromium` / `firefox` | `sudo xbps-install git qrencode openssl python3-gobject gst-plugins-good1 wl-clipboard ydotool` |
| Alpine | `sudo apk add nodejs npm` | `sudo apk add chromium` / `firefox` | `sudo apk add git libqrencode-tools openssl py3-gobject3 gst-plugins-good wl-clipboard` |
| Gentoo | `sudo emerge net-libs/nodejs` | `sudo emerge www-client/chromium` / `www-client/firefox-bin` | `sudo emerge dev-vcs/git media-gfx/qrencode dev-python/pygobject` |
| NixOS | `nix-shell -p nodejs_26` | `nix-shell -p chromium` / `firefox` | `nix-shell -p git qrencode openssl` |
| Any Linux (Flatpak) | nvm | `flatpak install flathub org.chromium.Chromium` / `org.mozilla.firefox` | — |
| macOS | `brew install node` | `brew install --cask chromium` / `firefox` (or Chrome, Brave, Edge) | `brew install git qrencode openssl` |
| Windows | `winget install OpenJS.NodeJS` | Edge is built in; `winget install Google.Chrome` / `Mozilla.Firefox` | `winget install Git.Git` |

Agents (any of them; Claude Code for the Claude models):

```sh
npm i -g @anthropic-ai/claude-code && claude      # log in once
npm i -g opencode-ai                              # optional
npm i -g @deepseek-ai/dsh                         # optional (a DeepSeek key in /connect)
npm i -g @openai/codex @agentclientprotocol/codex-acp   # optional
```

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
