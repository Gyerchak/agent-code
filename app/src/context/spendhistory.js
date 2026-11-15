// What every Claude Code session has cost so far, its subagents included, read from the transcripts Claude Code keeps
// (<project>/<session>.jsonl and <project>/<session>/subagents/*.jsonl): each API reply once (by message id), priced
// for its own model from the catalog. Transcripts only grow, so each file is read once and then only from where it
// was left. The totals live in one file shared by every Agent Code window, acode-boxes included.
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { catalog, modelMeta, refreshCatalog } from "./catalog"
import { log } from "./log"
import { sharedStateDir } from "./usage"

const projectsDir = () => path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"), "projects")
const cacheFile = () => path.join(sharedStateDir, "session-spend.json")
const escape = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, "-")

let cache
function readCache() {
  if (cache) return cache
  try {
    cache = JSON.parse(readFileSync(cacheFile(), "utf8"))
  } catch {}
  if (!cache || cache.v !== 1) cache = { v: 1, files: {} }
  return cache
}
let saveTimer
function saveSoon() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try {
      mkdirSync(path.dirname(cacheFile()), { recursive: true })
      writeFileSync(cacheFile(), JSON.stringify(cache))
    } catch (error) {
      log("session spend save", error)
    }
  }, 1500)
  saveTimer.unref?.()
}

/** One reply's price for its model ($), from its usage; 0 when the model's price isn't known. */
export function replyCost(model, usage) {
  const price = model ? modelMeta(String(model).split("#")[0]).price : undefined
  if (!price || !usage) return 0
  return (
    ((usage.input_tokens ?? 0) * price.input +
      (usage.output_tokens ?? 0) * price.output +
      (usage.cache_read_input_tokens ?? 0) * (price.cacheRead ?? price.input * 0.1) +
      (usage.cache_creation_input_tokens ?? 0) * (price.cacheWrite ?? price.input * 1.25)) /
    1e6
  )
}

const CHUNK = 4 * 1024 * 1024

/** Read a transcript from where it was left up to `limit` bytes (default: its end); returns its total so far. */
async function scanFile(file, limit) {
  const files = readCache().files
  let size
  try {
    size = statSync(file).size
  } catch {
    return files[file]?.total ?? 0
  }
  const end = Math.min(size, limit ?? size)
  const prev = files[file]
  if (prev && prev.offset >= end) return prev.total
  // A file that shrank was rewritten: start over.
  const state = prev && prev.offset <= size ? { ...prev } : { offset: 0, total: 0, lastId: undefined, lastCost: 0 }
  const fd = openSync(file, "r")
  try {
    let rest = ""
    let at = state.offset
    while (at < end) {
      const length = Math.min(CHUNK, end - at)
      const buffer = Buffer.alloc(length)
      readSync(fd, buffer, 0, length, at)
      at += length
      const text = rest + buffer.toString("utf8")
      const cut = text.lastIndexOf("\n")
      if (cut < 0) {
        rest = text
        continue
      }
      rest = text.slice(cut + 1)
      for (const line of text.slice(0, cut).split("\n")) {
        if (!line.includes('"usage"')) continue
        let entry
        try {
          entry = JSON.parse(line)
        } catch {
          continue
        }
        const message = entry.message
        if (entry.type !== "assistant" || !message?.id || !message.usage || message.model === "<synthetic>") continue
        const cost = replyCost(message.model, message.usage)
        // One reply is written once per content block, each with the reply's usage: count it once (the last one).
        if (message.id === state.lastId) state.total += cost - state.lastCost
        else state.total += cost
        state.lastId = message.id
        state.lastCost = cost
      }
      // Yield between chunks so a big transcript doesn't hold up the screen.
      await new Promise((resolve) => setImmediate(resolve))
    }
    state.offset = end - Buffer.byteLength(rest)
  } finally {
    closeSync(fd)
  }
  files[file] = state
  saveSoon()
  return state.total
}

function sessionFiles(cwd, sessionId) {
  const dir = path.join(projectsDir(), escape(cwd))
  const main = path.join(dir, `${sessionId}.jsonl`)
  let subs = []
  try {
    subs = readdirSync(path.join(dir, sessionId, "subagents"))
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => path.join(dir, sessionId, "subagents", name))
  } catch {}
  return { main, subs }
}

/**
 * What a session has cost up to now ($): its own replies and its subagents'. Pass the files' sizes taken earlier
 * (`snapshot`) to count only what was there then (a session that goes on meanwhile counts the rest live).
 */
export async function sessionSpend(cwd, sessionId, snapshot) {
  if (!catalog.dev?.anthropic) await refreshCatalog().catch(() => {})
  const { main, subs } = sessionFiles(cwd, sessionId)
  const own = existsSync(main) ? await scanFile(main, snapshot?.[main]) : 0
  let sub = 0
  for (const file of subs) sub += await scanFile(file, snapshot?.[file])
  return { main: own, sub }
}

/** The sizes of a session's transcripts now, for `sessionSpend`. */
export function spendSnapshot(cwd, sessionId) {
  const { main, subs } = sessionFiles(cwd, sessionId)
  const out = {}
  for (const file of [main, ...subs]) {
    try {
      out[file] = statSync(file).size
    } catch {}
  }
  return out
}

/** The last known total of a session ($), from the shared file only (no reading): for lists. */
export function knownSessionSpend(cwd, sessionId) {
  const files = readCache().files
  const { main, subs } = sessionFiles(cwd, sessionId)
  let total = files[main]?.total ?? 0
  let sub = 0
  for (const file of subs) sub += files[file]?.total ?? 0
  return total + sub > 0 ? { main: total, sub } : undefined
}

/**
 * Bring every session of every project up to date (main Agent Code and acode-boxes share ~/.claude/projects), once
 * a day, in the background, a file at a time.
 */
export async function scanAllSpend({ force = false } = {}) {
  const state = readCache()
  if (!force && state.scannedAt && Date.now() - state.scannedAt < 20 * 3600_000) return
  if (!catalog.dev?.anthropic) await refreshCatalog().catch(() => {})
  if (!catalog.dev?.anthropic) return
  let count = 0
  const started = Date.now()
  try {
    for (const project of readdirSync(projectsDir())) {
      const dir = path.join(projectsDir(), project)
      let names
      try {
        names = readdirSync(dir)
      } catch {
        continue
      }
      for (const name of names) {
        if (name.endsWith(".jsonl")) {
          await scanFile(path.join(dir, name))
          count++
        } else if (/^[0-9a-f-]{36}$/.test(name)) {
          let subs = []
          try {
            subs = readdirSync(path.join(dir, name, "subagents")).filter((file) => file.endsWith(".jsonl"))
          } catch {}
          for (const file of subs) {
            await scanFile(path.join(dir, name, "subagents", file))
            count++
          }
        }
      }
    }
  } catch (error) {
    log("session spend scan", error)
  }
  state.scannedAt = Date.now()
  saveSoon()
  log("session spend scan", `${count} transcripts in ${Math.round((Date.now() - started) / 1000)} s`)
}
