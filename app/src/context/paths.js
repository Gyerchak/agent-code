import { existsSync, lstatSync, mkdirSync, renameSync, symlinkSync } from "node:fs"
import os from "node:os"
import path from "node:path"

// Agent Code keeps its files under "agent-code" in the XDG config/state/cache/data dirs. Installs from before a
// rename used "open-claude-code" (and before that "opencode-claude"): the folder is moved over once and a link
// is left behind, so anything still using the old name (a window that was already open, a script) keeps working.

export const APP = "agent-code"
const OLD = ["open-claude-code", "opencode-claude"]

function base(env                    , fallback          ) {
  return env ?? path.join(os.homedir(), ...fallback)
}

function migrated(root        ) {
  const next = path.join(root, APP)
  try {
    if (!existsSync(next)) {
      for (const name of OLD) {
        const old = path.join(root, name)
        if (!existsSync(old) || lstatSync(old).isSymbolicLink()) continue
        renameSync(old, next)
        symlinkSync(next, old)
        break
      }
    }
  } catch {}
  return next
}

export const configDir = migrated(base(process.env.XDG_CONFIG_HOME, [".config"]))
export const stateDir = migrated(base(process.env.XDG_STATE_HOME, [".local", "state"]))
export const cacheDir = migrated(base(process.env.XDG_CACHE_HOME, [".cache"]))
/** Secrets (provider API keys): ~/.local/share/agent-code. */
export const dataDir = migrated(base(process.env.XDG_DATA_HOME, [".local", "share"]))

export function ensureDir(dir        ) {
  mkdirSync(dir, { recursive: true })
  return dir
}
