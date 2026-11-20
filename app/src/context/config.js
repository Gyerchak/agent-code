import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createSignal } from "solid-js"
import { log } from "./log"
import { configDir } from "./paths"


























































































export const COMPACT_AT = 90_000
export const CONTEXT_WARN_AT = 100_000

export { configDir }
const file = path.join(configDir, "config.json")

function read()         {
  return JSON.parse(readFileSync(file, "utf8"))
}

function load()         {
  try {
    return read()
  } catch (error) {
    // A config that doesn't parse (hand edit, cut-off write) is kept aside instead of being overwritten.
    if (existsSync(file)) {
      try {
        copyFileSync(file, `${file}.broken-${Date.now()}`)
      } catch {}
      process.stderr.write(`Agent Code: ${file} could not be read (${error instanceof Error ? error.message : error}); a copy was kept beside it.\n`)
    }
    return {}
  }
}

export const config         = load()
/** The config as last read or written: what this process changed since is what it writes back. */
let base                      = structuredClone(config)
// The old `sidebar` key could be stuck on "hide"; start over from opencode's auto default.
delete (config       ).sidebar
// v2.5: "Different providers" became per-tier switches; keep what it allowed (provider models of any kind).
if ((config       ).subagentProviders === true && !config.subagentTiers) config.subagentTiers = { local: true, free: true, go: true, zen: true, paid: true }
delete (config       ).subagentProviders

/** Read config.json again (after an edit outside Agent Code): what this process had pending is written first. */
export function reloadConfig() {
  flushConfig()
  const fresh = load()
  for (const key of Object.keys(config)) delete config[key]
  Object.assign(config, fresh)
  base = structuredClone(config)
}

// ---------------------------------------------------------------------------
// Saved settings: named copies of the settings, and a reset to the defaults. What Agent Code keeps for itself (open
// tabs, prompt history, session models, connected providers, one-time markers) is not a setting: a reset or a
// restore leaves it as it is. Keys live in auth.json and are never touched here.
// ---------------------------------------------------------------------------

const STATE_KEYS = new Set([
  "tabs",
  "sessionModels",
  "sessionEffort",
  "sessionAgentMode",
  "promptHistory",
  "recentModels",
  "stash",
  "providers",
  "providersImported",
  "mcpImported",
  "dropTipShown",
  "plugin",
])
export const savedSettingsDir = path.join(configDir, "saved-settings")

/** The settings part of the config (what Save stores and Reset clears). */
export function currentSettings() {
  return Object.fromEntries(Object.entries(config).filter(([key]) => !STATE_KEYS.has(key)))
}

/** Store the current settings under a name; returns the file. */
export function saveSettings(name) {
  const safe = (name || new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")).replace(/[^\w.-]+/g, "-").slice(0, 60)
  mkdirSync(savedSettingsDir, { recursive: true })
  const file = path.join(savedSettingsDir, `${safe}.json`)
  writeFileSync(file, JSON.stringify({ savedAt: new Date().toISOString(), settings: currentSettings() }, null, 2) + "\n")
  return file
}

/** Saved settings, newest first. */
export function listSavedSettings() {
  if (!existsSync(savedSettingsDir)) return []
  return readdirSync(savedSettingsDir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => {
      const full = path.join(savedSettingsDir, file)
      try {
        const data = JSON.parse(readFileSync(full, "utf8"))
        return { name: file.slice(0, -5), file: full, savedAt: data.savedAt ?? statSync(full).mtime.toISOString(), count: Object.keys(data.settings ?? {}).length }
      } catch {
        return undefined
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt))
}

// Every per-conversation record ("session…": engines, chains, held messages, pauses, drafts, instructions…) is state,
// not a setting: a reset or a restored save must not drop it or bring back an old copy.
const isState = (key) => STATE_KEYS.has(key) || key.startsWith("session") || key === "codeModeSessions"

function replaceSettings(next) {
  const tabRules = config.stopAfter?.tabs
  for (const key of Object.keys(config)) if (!isState(key)) delete config[key]
  for (const [key, value] of Object.entries(next ?? {})) if (!isState(key)) config[key] = structuredClone(value)
  // Stop after: the rule for every tab is a setting, each tab's own rule is that tab's.
  if (tabRules) config.stopAfter = { ...(config.stopAfter ?? {}), tabs: tabRules }
  else if (config.stopAfter) config.stopAfter = { ...config.stopAfter, tabs: {} }
  saveConfig()
}

/** Put saved settings back (the current ones are saved first, as "before-restore"). */
export function restoreSettings(file) {
  const data = JSON.parse(readFileSync(file, "utf8"))
  saveSettings("before-restore")
  replaceSettings(data.settings)
}

/** Every setting back to its default (the current ones are saved first, as "before-reset"). */
export function resetSettings() {
  const backup = saveSettings("before-reset")
  replaceSettings({})
  return backup
}

// `config` is a plain object: views that show a setting read configRevision() to redraw when one is saved.
const [revision, setRevision] = createSignal(0)
export const configRevision = revision

let timer
export function saveConfig() {
  setRevision((n) => n + 1)
  clearTimeout(timer)
  timer = setTimeout(writeConfig, 100)
}

/** Write any pending config change immediately (used on exit). */
export function flushConfig() {
  if (!timer) return
  clearTimeout(timer)
  writeConfig()
}

// A JSON copy: the config only holds JSON, and a value taken from a Solid store (a proxy) can't go through
// structuredClone — it threw, and the config stopped being written at all.
const copy = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))
const isObject = (value         )                               => !!value && typeof value === "object" && !Array.isArray(value)
const same = (a         , b         ) => JSON.stringify(a) === JSON.stringify(b)

/** Apply what changed from `before` to `mine` onto `disk` (key by key, into nested records). */
function merge(before                     , mine                     , disk                     ) {
  for (const key of new Set([...Object.keys(before), ...Object.keys(mine)])) {
    if (same(before[key], mine[key])) continue
    if (isObject(before[key]) && isObject(mine[key]) && isObject(disk[key])) merge(before[key], mine[key], disk[key])
    else if (key in mine) disk[key] = copy(mine[key])
    else delete disk[key]
  }
  return disk
}

/**
 * Several Agent Code windows share config.json: each writes only what it changed onto the file as it is now
 * (and takes the others' changes), so one window no longer reverts another's settings or saved tabs.
 */
let unreadable = 0
function writeConfig() {
  timer = undefined
  let disk                      = {}
  try {
    disk = read()
  } catch (error) {
    // There but unreadable right now (another program mid-write): try again shortly instead of replacing the whole
    // file with only this window's changes.
    if (existsSync(file) && ++unreadable <= 20) {
      timer = setTimeout(writeConfig, 250)
      return
    }
    if (existsSync(file)) log("config unreadable, writing this window's copy", error)
    disk = copy(config)
  }
  unreadable = 0
  try {
    const merged = merge(base, config                       , disk)
    mkdirSync(configDir, { recursive: true })
    // Write-then-rename: a crash mid-write can't leave a cut-off config.
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(merged, null, 2) + "\n")
    renameSync(temp, file)
    // Only once it is on disk: a failed write leaves the change pending, and it is tried again.
    for (const key of Object.keys(config)) if (!(key in merged)) delete (config       )[key]
    Object.assign(config, copy(merged))
    base = copy(merged)
  } catch (error) {
    log("config write failed", error)
    timer = setTimeout(writeConfig, 3000)
  }
}














