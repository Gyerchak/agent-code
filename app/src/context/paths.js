import { existsSync, mkdirSync, renameSync, symlinkSync } from "node:fs"
import os from "node:os"
import path from "node:path"

// Open Claude Code keeps its files under "open-claude-code" in the XDG config/state/cache dirs.
// Installs from before the rename used "opencode-claude": move them over once and leave a link behind.

export const APP = "open-claude-code"
const OLD = "opencode-claude"

function base(env                    , fallback          ) {
  return env ?? path.join(os.homedir(), ...fallback)
}

function migrated(root        ) {
  const next = path.join(root, APP)
  const old = path.join(root, OLD)
  try {
    if (!existsSync(next) && existsSync(old)) {
      renameSync(old, next)
      symlinkSync(next, old)
    }
  } catch {}
  return next
}

export const configDir = migrated(base(process.env.XDG_CONFIG_HOME, [".config"]))
export const stateDir = migrated(base(process.env.XDG_STATE_HOME, [".local", "state"]))
export const cacheDir = migrated(base(process.env.XDG_CACHE_HOME, [".cache"]))
/** Secrets (provider API keys): ~/.local/share/open-claude-code. */
export const dataDir = migrated(base(process.env.XDG_DATA_HOME, [".local", "share"]))

export function ensureDir(dir        ) {
  mkdirSync(dir, { recursive: true })
  return dir
}
