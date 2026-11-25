// acode-tools: the behaviour parts of the access settings (per harness, see context/access.js).
//   Prefer installed tools (on by default) — use the tools already on the machine instead of generating the same work.
//   Install software (off by default) — allowed to set up new tools when that clearly pays off.
//   Download files (follows Install software until set) — model weights, datasets, archives.
//   Web access (on by default) — searching and reading pages.
import { accessFor } from "../context/access"
import { registerPromptPart } from "../context/session"


export const PREFER_TOOLS = `# Skill: prefer available tools
Work that a tool on this machine can do exactly should be done by that tool, not by generating it token by token.
- Before writing a helper from scratch, check what exists: \`which <cmd>\`, the package manager's list, project scripts (package.json, Makefile, scripts/), installed Python/Node modules, MCP tools and skills.
- Use tools for: searching and counting (rg, grep, find, wc), computing (python3, bc, sympy/numpy), converting and extracting (pandoc, pdftotext, libreoffice --headless, ffmpeg, magick, jq), formatting and linting (the project's formatter), compiling/running code to check results, and file moves/copies (cp/mv, not re-typing contents).
- Prefer one batched command or script over many small tool calls; prefer reading only the needed lines over whole files.
- Never reproduce large file contents, tables or data in your reply when a tool can write or transform them directly.
- Reason in tokens only where judgement is needed: design, explaining, deciding between options, reviewing results.`

export const INSTALL_TOOLS_ON = `# Skill: install new tools
You may download and set up new tools when that clearly saves work or is needed for the task.
- First prefer what is installed; install only when the gain is real (repeated work, accuracy, or impossible otherwise).
- Detect the platform and package manager (pacman/apt/dnf/brew/winget) and use it for system tools; use project-local environments for language packages (python -m venv, npm install in the project, cargo install --root under the user's home).
- Ask before anything that needs sudo, is larger than ~500 MB, changes system configuration, or comes from outside official repositories/registries. Never use unofficial mirrors or curl-pipe-to-shell from unknown sites.
- After installing, verify it runs, and tell the user in one line what was installed, where, and how to remove it.`

export const INSTALL_TOOLS_OFF = `# Software installation is off
Do not install or upgrade software (programs, system packages, language packages). If a missing tool would make the task much easier, name it and how to install it, and continue with what is available.`

export const DOWNLOADS_ON = `# Downloads are allowed
You may download files the task needs — model weights, datasets, archives, documents — from their official sources (the project's own site or releases, Hugging Face, GitHub, official registries).
- Put them in a sensible place (the project, or a named folder in the home folder), and say in one line what you downloaded and where.
- Ask first for anything over ~5 GB, behind a login or licence click-through, or from an unofficial mirror.`

export const DOWNLOADS_OFF = `# Downloads are off
Do not download files from the internet (model weights, datasets, archives, documents). If the task needs one, say exactly what and from where, and continue with what is available. (Installing software is a separate switch.)`

export const WEB_OFF = `# Web access is off
Do not search the web or fetch web pages. Work from the project and what you know, and say when something would need checking online.`

export const toolsPlugin         = (api) => {
  // Each harness has its own access settings: the tab's engine decides (Claude Code when none).
  const access = (context) => accessFor(context?.session?.store)
  api.lifecycle.onDispose(registerPromptPart("acode-tools-prefer", (context) => (access(context).preferTools ? PREFER_TOOLS : undefined)))
  api.lifecycle.onDispose(registerPromptPart("acode-tools-install", (context) => (access(context).installTools ? INSTALL_TOOLS_ON : INSTALL_TOOLS_OFF)))
  api.lifecycle.onDispose(registerPromptPart("acode-tools-downloads", (context) => (access(context).downloads ? DOWNLOADS_ON : DOWNLOADS_OFF)))
  api.lifecycle.onDispose(registerPromptPart("acode-tools-web", (context) => (access(context).web ? undefined : WEB_OFF)))
}
