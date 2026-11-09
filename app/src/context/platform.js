import { existsSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"

// ---------------------------------------------------------------------------
// The few things that differ between Linux, macOS and Windows.
// ---------------------------------------------------------------------------

export const isWindows = process.platform === "win32"
export const isMac = process.platform === "darwin"

const found = new Map()

/**
 * The full path of a command on PATH (with Windows' .cmd/.exe/… extensions), or undefined. Also looks where
 * npm puts global commands, since a desktop launcher's PATH often lacks it.
 */
export function findBinary(name, { refresh = false } = {}) {
  if (!refresh && found.has(name)) return found.get(name) ?? undefined
  const extensions = isWindows ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""]
  const dirs = [
    ...(process.env.PATH ?? "").split(path.delimiter),
    path.dirname(process.execPath),
    isWindows ? path.join(process.env.APPDATA ?? "", "npm") : path.join(os.homedir(), ".local", "bin"),
    path.join(os.homedir(), ".npm-global", "bin"),
    ...(isWindows ? [] : ["/usr/local/bin", "/opt/homebrew/bin"]),
  ].filter(Boolean)
  let hit
  for (const dir of dirs) {
    for (const ext of ["", ...extensions]) {
      const file = path.join(dir, name + ext)
      try {
        if (existsSync(file) && statSync(file).isFile()) {
          hit = file
          break
        }
      } catch {}
    }
    if (hit) break
  }
  found.set(name, hit ?? null)
  return hit
}

/** spawn() options that let Windows run npm's .cmd shims (they need a shell there). */
export function spawnOptions(file) {
  return isWindows && /\.(cmd|bat)$/i.test(file) ? { shell: true, windowsHide: true } : {}
}

/** The command that opens a URL or file in the desktop's default app. */
export function openCommand(target) {
  if (isMac) return ["open", [target]]
  if (isWindows) return ["cmd", ["/c", "start", "", target]]
  return ["xdg-open", [target]]
}
