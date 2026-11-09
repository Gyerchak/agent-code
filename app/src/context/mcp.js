
import { existsSync, readFileSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { config, saveConfig } from "./config"
import { log } from "./log"
import { authFile, readAuthFile, writeAuthEntries } from "./auth"
import { dataDir } from "./paths"
import { applyPersonalSeed } from "./personal"

// ---------------------------------------------------------------------------
// occ's own MCP servers live in its secrets file (auth.ts, auth.json; server env often holds tokens):
//   "mcp:<name>": { "type": "mcp", "server": { command, args, env } | { type, url, headers }, "disabled": true? }
// The server part has Claude Code's `mcpServers` shape; `"disabled": true` keeps one without starting it. occ hands them to every Claude Code process;
// an occ server overrides a same-named one from ~/.claude.json. Project `.mcp.json`, plugin and claude.ai
// servers still load as Claude Code decides (and approves) them.
// On first start the servers in Claude Code's user config and opencode's config are copied here once.
// ---------------------------------------------------------------------------



/** The file to edit MCP servers in. */
export const mcpFile = authFile
const PREFIX = "mcp:"
const isMcp = (id        , value     ) => id.startsWith(PREFIX) && value?.type === "mcp"

function read()                        {
  migrate()
  const out                        = {}
  for (const [id, value] of Object.entries     (readAuthFile()))
    if (isMcp(id, value) && value.server && typeof value.server === "object") out[id.slice(PREFIX.length)] = { ...value.server, ...(value.disabled ? { disabled: true } : {}) }
  return out
}

function write(servers                       ) {
  writeAuthEntries(
    isMcp,
    Object.fromEntries(
      Object.entries(servers).map(([name, { disabled, ...server }]) => [PREFIX + name, { type: "mcp", server, ...(disabled ? { disabled: true } : {}) }]),
    ),
  )
}

// v3.1.0 kept them in a separate mcp.json: fold it into auth.json once.
const OLD_FILE = path.join(dataDir, "mcp.json")
let migrated = false
function migrate() {
  if (migrated) return
  migrated = true
  if (!existsSync(OLD_FILE)) return
  try {
    // The old file wins over auth.json: it was the one edited (e.g. a token pasted in after the move).
    const merged                        = JSON.parse(readFileSync(OLD_FILE, "utf8")).mcpServers ?? {}
    if (Object.keys(merged).length) {
      const existing                      = Object.fromEntries(Object.entries(readAuthFile()).filter(([id, value]) => isMcp(id, value)))
      writeAuthEntries(isMcp, {
        ...existing,
        ...Object.fromEntries(Object.entries(merged).map(([name, { disabled, ...server }]) => [PREFIX + name, { type: "mcp", server, ...(disabled ? { disabled: true } : {}) }])),
      })
    }
    rmSync(OLD_FILE)
    log("mcp.json moved into auth.json")
  } catch (error) {
    log("mcp.json migration failed", error)
  }
}

/** Make sure the secrets file exists (so it can be opened in an editor). */
export function ensureMcpFile() {
  importMcp()
  if (!existsSync(authFile)) write({})
}

const home = (...parts          ) => path.join(os.homedir(), ...parts)

/** Claude Code's user-scope servers (~/.claude.json → mcpServers). */
function claudeServers()                        {
  try {
    const file = process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json") : home(".claude.json")
    return JSON.parse(readFileSync(file, "utf8")).mcpServers ?? {}
  } catch {
    return {}
  }
}

/** opencode's servers (`mcp` or `mcp.servers`; local = command list + environment, remote = url + headers). */
function opencodeServers()                        {
  const dir = path.join(process.env.XDG_CONFIG_HOME ?? home(".config"), "opencode")
  for (const file of ["opencode.json", "opencode.jsonc"]) {
    try {
      const json = JSON.parse(readFileSync(path.join(dir, file), "utf8").replace(/^\s*\/\/.*$/gm, ""))
      const section = json.mcp?.servers ?? json.mcp ?? {}
      const out                        = {}
      for (const [name, value] of Object.entries     (section)) {
        if (value?.type === "local" && Array.isArray(value.command) && value.command.length) {
          out[name] = { command: value.command[0], args: value.command.slice(1), env: value.environment, disabled: value.enabled === false || undefined }
        } else if (value?.type === "remote" && typeof value.url === "string") {
          out[name] = { type: "http", url: value.url, headers: value.headers, disabled: value.enabled === false || undefined }
        }
      }
      return out
    } catch {}
  }
  return {}
}

/** Copy Claude Code's and opencode's MCP servers into occ's file once (or on request: only missing ones). */
export function importMcp(force = false) {
  if (config.mcpImported && !force) return 0
  const servers = read()
  let added = 0
  for (const [name, entry] of Object.entries({ ...opencodeServers(), ...claudeServers() })) {
    if (servers[name]) continue
    servers[name] = entry
    added++
  }
  write(servers)
  config.mcpImported = new Date().toISOString()
  saveConfig()
  log("imported mcp servers", added)
  return added
}

/** The servers to start (without `disabled` ones), for Claude Code's `mcpServers` option. */
export function occMcpServers()                                  {
  applyPersonalSeed()
  importMcp()
  const out                                  = {}
  for (const [name, { disabled, ...entry }] of Object.entries(read())) if (!disabled) out[name] = entry
  return out
}

