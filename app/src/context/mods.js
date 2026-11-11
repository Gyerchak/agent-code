import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { config, saveConfig,                 } from "./config"
import { configDir } from "./paths"

// ---------------------------------------------------------------------------
// Claude Code mods: plugins whose hooks/hooks.json names a hooks module (the plugin-authoring skill
// writes them). Agent Code loads the enabled ones into each Claude Code process (the SDK's `plugins`), so their
// hooks, tools, commands and agents run in the engine as in Claude Code, and attaches to the engine as a
// remote surface (`ui_attach`, like Claude Code Desktop) to draw what they show: the band above the
// prompt, panes, toasts, status lines and log lines (see session.ts and component/mods.tsx).
// ---------------------------------------------------------------------------











/** Agent Code's own mods folder: put a mod folder here to have Agent Code load it. */
export const modsDir = path.join(configDir, "mods")

/**
 * Off unless switched on: mods that skin Claude Code's own terminal and would draw a second copy of
 * what Agent Code already shows (opencode-skin's logo above the prompt).
 */
const DEFAULT_OFF = new Set(["opencode-skin"])

function readMod(dir        , source                   )                      {
  try {
    const manifest = JSON.parse(readFileSync(path.join(dir, ".claude-plugin", "plugin.json"), "utf8"))
    const hooks = JSON.parse(readFileSync(path.join(dir, "hooks", "hooks.json"), "utf8"))
    if (!Array.isArray(hooks.modules) || !hooks.modules.length) return undefined
    return {
      name: String(manifest.name ?? path.basename(dir)),
      path: dir,
      description: typeof manifest.description === "string" ? manifest.description : undefined,
      version: typeof manifest.version === "string" ? manifest.version : undefined,
      source,
      mtime: statSync(dir).mtimeMs,
    }
  } catch {
    return undefined
  }
}

const subdirs = (dir        ) => {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => path.join(dir, entry.name))
  } catch {
    return []
  }
}

/** The plugin folders CLAUDE_CODE_PLUGIN_DIRS names (Agent Code passes them itself, so they can be switched off). */
export function envPluginDirs() {
  return (process.env.CLAUDE_CODE_PLUGIN_DIRS ?? "")
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => (item.startsWith("~/") ? path.join(os.homedir(), item.slice(2)) : item))
}

let cached

/** Every mod on this machine, one per name: Agent Code's folder first, then the environment, then the newest copy. */
export function discoverMods(force = false)            {
  if (!force && cached && Date.now() - cached.time < 5000) return cached.list
  const found            = []
  for (const dir of subdirs(modsDir)) {
    const mod = readMod(dir, "acode")
    if (mod) found.push(mod)
  }
  for (const dir of envPluginDirs()) {
    const mod = readMod(dir, "env")
    if (mod) found.push(mod)
  }
  // Claude Code writes each session's mods into ~/.claude/dev-mods/<session>/<mod>.
  const claudeDir = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"), "dev-mods")
  for (const session of subdirs(claudeDir))
    for (const dir of subdirs(session)) {
      const mod = readMod(dir, "claude")
      if (mod) found.push(mod)
    }
  const rank = { acode: 0, env: 1, claude: 2 }
  const byName = new Map                 ()
  for (const mod of found.sort((a, b) => rank[a.source] - rank[b.source] || b.mtime - a.mtime)) if (!byName.has(mod.name)) byName.set(mod.name, mod)
  cached = { time: Date.now(), list: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)) }
  return cached.list
}

const settings = ()             => config.mods ?? {}

export function modsEnabled() {
  return settings().enabled !== false
}

export function modEnabled(name        ) {
  const own = settings()
  if (own.off?.includes(name)) return false
  if (own.on?.includes(name)) return true
  return !DEFAULT_OFF.has(name)
}

export function setModEnabled(name        , value         ) {
  const own = { ...settings() }
  own.off = (own.off ?? []).filter((item) => item !== name)
  own.on = (own.on ?? []).filter((item) => item !== name)
  if (value !== !DEFAULT_OFF.has(name)) (value ? own.on : own.off).push(name)
  config.mods = own
  saveConfig()
}

/** What Agent Code draws of the mods (each default on). */

export function modsShows(part          ) {
  return modsEnabled() && settings()[part] !== false
}

export function setModsSetting(key                      , value         ) {
  config.mods = { ...settings(), [key]: value }
  saveConfig()
}

/** The SDK `plugins` entries for every enabled mod. */
export function modPlugins()                                    {
  if (!modsEnabled()) return []
  return discoverMods()
    .filter((mod) => modEnabled(mod.name))
    .map((mod) => ({ type: "local"         , path: mod.path }))
}

export function ensureModsDir() {
  mkdirSync(modsDir, { recursive: true })
  return existsSync(modsDir)
}
