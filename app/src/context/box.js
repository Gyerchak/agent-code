import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { exit } from "./app"
import { flushConfig } from "./config"
import { log } from "./log"

// ---------------------------------------------------------------------------
// acode-box: when Agent Code runs inside a box (launched by box/scripts/acode-box.sh, which sets ACODE_BOX_DIR), the box
// uses Agent Code's own settings by default. "Own settings" gives the box its own copy (cfg/agent-code,
// switched on by the cfg/own-settings marker); "Reset to factory default" goes back to Agent Code's settings.
// Changing either restarts Agent Code: exit code 75 tells the launcher to start it again.
// ---------------------------------------------------------------------------

export const boxDir = process.env.ACODE_BOX_DIR || undefined
export const BOX_RESTART = 75

const marker = () => path.join(boxDir , "cfg", "own-settings")
const boxConfig = () => path.join(boxDir , "cfg", "agent-code", "config.json")
const boxDefaults = () => path.join(boxDir , "box", "settings.json")
const mainConfig = () => process.env.ACODE_MAIN_CONFIG || path.join(os.homedir(), ".config", "agent-code", "config.json")

/** True when this box keeps its own settings (false: Agent Code's shared settings). */
export function ownSettings() {
  return !!boxDir && existsSync(marker())
}

const read = (file        ) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return undefined
  }
}

/**
 * A box's own settings start from its defaults (box/settings.json, written by `acode-box` from
 * ~/.config/agent-code/acode-box/settings.json), plus Agent Code's providers so its models stay available.
 */
function initialOwnSettings() {
  const main = read(mainConfig()) ?? {}
  const defaults = read(boxDefaults())
  const out                          = defaults ?? { ...main }
  if (!defaults) for (const key of ["tabs", "promptHistory", "sessionModels", "recentModels"]) delete out[key]
  for (const key of ["providers", "providersImported", "mcpImported"]) if (main[key] !== undefined) out[key] = main[key]
  return out
}

/** Switch the box to its own settings (its defaults, or the copy it had) or back to Agent Code's. */
export function setOwnSettings(on         ) {
  if (!boxDir) return
  flushConfig()
  if (on) {
    if (!existsSync(boxConfig())) {
      mkdirSync(path.dirname(boxConfig()), { recursive: true })
      writeFileSync(boxConfig(), JSON.stringify(initialOwnSettings(), null, 2) + "\n")
    }
    writeFileSync(marker(), "This box uses its own Agent Code settings (cfg/agent-code). Remove this file to use Agent Code's settings.\n")
  } else rmSync(marker(), { force: true })
}

/** Factory default: the box uses Agent Code's settings again; its own copy is kept as a dated backup. */
export function resetBox() {
  if (!boxDir) return
  flushConfig()
  rmSync(marker(), { force: true })
  if (existsSync(boxConfig())) renameSync(boxConfig(), `${boxConfig()}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`)
}

/**
 * Claude Code ignores a folder's .claude/settings.json permissions until the folder is trusted. The box is
 * the user's own, so Agent Code marks it trusted before every Claude Code start (Claude Code itself may rewrite
 * ~/.claude.json and drop the flag, and a moved box has a new path).
 */
export function ensureBoxTrusted(cwd        ) {
  if (!boxDir || path.resolve(cwd) !== path.resolve(boxDir)) return
  const file = path.join(process.env.CLAUDE_CONFIG_DIR ?? os.homedir(), ".claude.json")
  try {
    const data = JSON.parse(readFileSync(file, "utf8"))
    const projects = (data.projects ??= {})
    const project = (projects[path.resolve(boxDir)] ??= {})
    if (project.hasTrustDialogAccepted === true) return
    project.hasTrustDialogAccepted = true
    const temp = `${file}.acode-box.${process.pid}`
    writeFileSync(temp, JSON.stringify(data, null, 2))
    chmodSync(temp, statSync(file).mode & 0o777)
    renameSync(temp, file)
    log("marked the box trusted", boxDir)
  } catch (error) {
    log("could not mark the box trusted", error)
  }
}

/** Restart Agent Code inside the box (the launcher starts it again with the new settings). */
export function restartBox() {
  exit(BOX_RESTART)
}
