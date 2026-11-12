import { createReadStream, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import readline from "node:readline"
import { createSignal } from "solid-js"
import { log } from "./log"
import { stateDir } from "./paths"

// ---------------------------------------------------------------------------
// What each reasoning level really costs, measured from Claude Code's own transcripts. Every API request Claude
// Code makes is saved with its model, its effort level and its token usage; summed per (model, level) that gives
// the average tokens and price of one request at that level. The price per token is the same at every level: what
// changes is how many tokens (mostly thinking) a request uses.
// ---------------------------------------------------------------------------

const cacheFile = path.join(stateDir, "effort-stats.json")
const MAX_FILES = 200

const [stats, setStats] = createSignal({})
let scanning
export const effortStats = stats

function projectsDir() {
  return path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"), "projects")
}

function readCache() {
  try {
    return JSON.parse(readFileSync(cacheFile, "utf8"))?.files ?? {}
  } catch {
    return {}
  }
}

/** The newest transcripts (main and subagent ones), newest first. */
function transcripts() {
  const out = []
  let projects = []
  try {
    projects = readdirSync(projectsDir())
  } catch {
    return out
  }
  const add = (file) => {
    try {
      const info = statSync(file)
      out.push({ file, size: info.size, mtime: info.mtimeMs })
    } catch {}
  }
  for (const project of projects) {
    const dir = path.join(projectsDir(), project)
    let names = []
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (name.endsWith(".jsonl")) add(path.join(dir, name))
      else if (!name.includes(".")) {
        try {
          for (const sub of readdirSync(path.join(dir, name, "subagents"))) if (sub.endsWith(".jsonl")) add(path.join(dir, name, "subagents", sub))
        } catch {}
      }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_FILES)
}

/** Per "model|effort": requests and their token counts, from one transcript. Streamed, so big files are fine. */
async function scanFile(file) {
  const totals = {}
  const seen = new Set()
  const lines = readline.createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity })
  for await (const line of lines) {
    if (!line.includes('"type":"assistant"') || !line.includes('"usage"')) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const message = entry.message
    const usage = message?.usage
    if (entry.type !== "assistant" || !usage || !message.model || message.model === "<synthetic>") continue
    // One request is saved as several entries (one per content block) with the same id and usage.
    const id = message.id ?? entry.requestId
    if (id) {
      if (seen.has(id)) continue
      seen.add(id)
    }
    const key = `${message.model}|${entry.effort ?? "default"}`
    const sum = (totals[key] ??= { n: 0, in: 0, out: 0, cr: 0, cw: 0 })
    sum.n++
    sum.in += usage.input_tokens ?? 0
    sum.out += usage.output_tokens ?? 0
    sum.cr += usage.cache_read_input_tokens ?? 0
    sum.cw += usage.cache_creation_input_tokens ?? 0
  }
  return totals
}

/** Read new or changed transcripts (the rest come from the cache) and publish the totals. */
export function refreshEffortStats() {
  if (scanning) return scanning
  scanning = (async () => {
    const cached = readCache()
    const files = {}
    for (const item of transcripts()) {
      const old = cached[item.file]
      if (old && old.size === item.size && old.mtime === item.mtime) files[item.file] = old
      else {
        try {
          files[item.file] = { size: item.size, mtime: item.mtime, totals: await scanFile(item.file) }
        } catch (error) {
          log("effort stats scan failed", item.file, String(error))
        }
      }
    }
    const all = {}
    for (const { totals } of Object.values(files)) {
      for (const [key, sum] of Object.entries(totals ?? {})) {
        const into = (all[key] ??= { n: 0, in: 0, out: 0, cr: 0, cw: 0 })
        for (const field of Object.keys(into)) into[field] += sum[field] ?? 0
      }
    }
    try {
      mkdirSync(stateDir, { recursive: true })
      writeFileSync(cacheFile, JSON.stringify({ files }))
    } catch {}
    setStats(all)
  })().finally(() => {
    scanning = undefined
  })
  return scanning
}

/**
 * The measured average of one request of `modelId` at `effort`: requests counted, output tokens, and price
 * ($, from `price` per million tokens) — undefined when that level was never used.
 */
export function effortCost(modelId, effort, price) {
  if (!modelId) return undefined
  const family = (id) => id.replace(/\[.*$/, "")
  const sum = Object.entries(stats()).find(([key]) => {
    const [model, level] = key.split("|")
    return family(model) === family(modelId) && level === (effort ?? "default")
  })?.[1]
  if (!sum?.n) return undefined
  const dollars = price
    ? (sum.in * price.input + sum.out * price.output + sum.cr * (price.cacheRead ?? price.input * 0.1) + sum.cw * (price.cacheWrite ?? price.input * 1.25)) / 1e6 / sum.n
    : undefined
  return { requests: sum.n, output: Math.round(sum.out / sum.n), dollars }
}
