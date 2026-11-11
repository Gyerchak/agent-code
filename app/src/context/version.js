import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

/** The app's name, shown wherever the harness names itself. */
export const APP_NAME = "Agent Code"

let version
/** Agent Code's own version (package.json). */
export function appVersion() {
  if (version !== undefined) return version
  try {
    version = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")).version ?? ""
  } catch {
    version = ""
  }
  return version
}
