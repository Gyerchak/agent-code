import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { dataDir } from "./paths"

// ---------------------------------------------------------------------------
// occ's one secrets file: <data>/open-claude-code/auth.json (0600).
//   "<provider id>": { "type": "api", "key": "…" }                     provider API keys (providers.ts)
//   "mcp:<server>":  { "type": "mcp", "server": { command, args, env } } MCP servers, `"disabled": true` keeps one off (mcp.ts)
// Each module reads and writes only its own entries; the rest of the file is kept as it is.
// ---------------------------------------------------------------------------

export const authFile = path.join(dataDir, "auth.json")

export function readAuthFile()                      {
  try {
    const json = JSON.parse(readFileSync(authFile, "utf8"))
    return json && typeof json === "object" ? json : {}
  } catch {
    return {}
  }
}

/** Replace the entries `owns` selects with `entries`, keeping everything else in the file. */
export function writeAuthEntries(owns                                     , entries                     ) {
  const kept = Object.fromEntries(Object.entries(readAuthFile()).filter(([id, value]) => !owns(id, value)))
  mkdirSync(path.dirname(authFile), { recursive: true })
  writeFileSync(authFile, JSON.stringify({ ...kept, ...entries }, null, 2) + "\n", { mode: 0o600 })
  chmodSync(authFile, 0o600)
}
