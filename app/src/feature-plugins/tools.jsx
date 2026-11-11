// acode-tools: two behaviour skills toggled in /settings.
//   Prefer tools  (on by default)  — use the tools already on the machine instead of spending tokens on the same work.
//   Install tools (off by default) — allowed to download and set up new tools when that clearly pays off.
import { config } from "../context/config"
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

export const INSTALL_TOOLS_OFF = `# Tool installation is off
Do not install, download or upgrade software. If a missing tool would make the task much easier, name it and how to install it, and continue with what is available.`

export const toolsPlugin         = (api) => {
  api.lifecycle.onDispose(registerPromptPart("acode-tools-prefer", () => (config.preferTools === false ? undefined : PREFER_TOOLS)))
  api.lifecycle.onDispose(registerPromptPart("acode-tools-install", () => (config.installTools === true ? INSTALL_TOOLS_ON : INSTALL_TOOLS_OFF)))
}
