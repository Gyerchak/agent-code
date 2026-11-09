import { appendFileSync, mkdirSync } from "node:fs"
import path from "node:path"
import { stateDir } from "./paths"

const dir = stateDir
export const logFile = path.join(dir, "log.txt")
try {
  mkdirSync(dir, { recursive: true })
} catch {}

export function log(...args           ) {
  const line = args
    .map((arg) => (arg instanceof Error ? (arg.stack ?? arg.message) : typeof arg === "string" ? arg : JSON.stringify(arg)))
    .join(" ")
  try {
    appendFileSync(logFile, `[${new Date().toISOString()}] ${line}\n`)
  } catch {}
}
