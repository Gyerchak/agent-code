import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { AcpClient } from "./acp"
import { log } from "./log"
import { stateDir } from "./paths"
import { findBinary } from "./platform"

// ---------------------------------------------------------------------------
// Other agent harnesses, run as engines next to Claude Code. Each speaks the Agent Client Protocol (ACP,
// JSON-RPC over stdio); Agent Code starts it, sends the prompts and draws its replies, tools and permission asks
// in the same transcript, as it does for Claude Code. A model from one is stored as "<harness>/<model>".
// ---------------------------------------------------------------------------

/** Keys for the env variables a harness reads, by the Agent Code provider whose key they take (/connect). */
export const HARNESSES = [
  {
    id: "opencode",
    name: "opencode",
    bin: "opencode",
    args: ["acp"],
    install: "npm i -g opencode-ai   (or: curl -fsSL https://opencode.ai/install | bash)",
    env: {},
  },
  {
    id: "dsh",
    name: "DeepSeek Harness",
    bin: "dsh",
    args: ["--profile", "acp"],
    install: "npm i -g @deepseek-ai/dsh",
    env: { DEEPSEEK_API_KEY: "deepseek" },
    // Telemetry hard off (dsh's own switch); Agent Code's instructions and MCP servers go to it too.
    fixedEnv: { DSH_TELEMETRY_DISABLED: "1" },
    instructions: true,
    mcp: true,
  },
  {
    id: "codex",
    name: "Codex (OpenAI)",
    bin: "codex-acp",
    args: [],
    install: "npm i -g @openai/codex @agentclientprotocol/codex-acp   (then `codex login`, or an OpenAI key in /connect)",
    env: { OPENAI_API_KEY: "openai", CODEX_API_KEY: "openai" },
  },
]

export const harnessById = (id) => HARNESSES.find((harness) => harness.id === id)

/** How to start a harness, or undefined while it isn't installed. */
export function harnessLaunch(harness, keyFor) {
  const command = findBinary(harness.bin)
  if (!command) return undefined
  const env = { ...(harness.fixedEnv ?? {}) }
  for (const [name, provider] of Object.entries(harness.env)) {
    const key = keyFor?.(provider)
    if (key) env[name] = key
  }
  return { command, args: harness.args, env }
}

// ---------------------------------------------------------------------------
// What each harness offers: its models (and reasoning levels), read from a throwaway ACP session and kept a
// day in state/harnesses.json, so the model picker lists them without starting anything.
// ---------------------------------------------------------------------------

const cacheFile = path.join(stateDir, "harnesses.json")
let cache
function load() {
  if (cache) return cache
  try {
    cache = JSON.parse(readFileSync(cacheFile, "utf8"))
  } catch {
    cache = {}
  }
  return cache
}
function save() {
  try {
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(cacheFile, JSON.stringify(cache))
  } catch {}
}

/** The model option of an ACP session (`configOptions` with category/id model, or the `models` block). */
export function acpModels(result) {
  const option = (result?.configOptions ?? []).find((item) => item.id === "model" || item.category === "model")
  if (option?.options?.length)
    return { via: "config", configId: option.id, current: option.currentValue, list: flatOptions(option.options).map((item) => ({ id: item.value, name: item.name ?? item.value })) }
  const models = result?.models
  if (models?.availableModels?.length)
    return { via: "set_model", current: models.currentModelId, list: models.availableModels.map((item) => ({ id: item.modelId, name: item.name ?? item.modelId })) }
  return undefined
}

/** A select option's choices, flat: ACP allows groups ({ group, name, options }), as DeepSeek Harness uses per provider. */
function flatOptions(options) {
  return options.flatMap((item) =>
    Array.isArray(item?.options) ? item.options.map((inner) => ({ ...inner, name: item.name && inner.name ? `${item.name} · ${inner.name}` : inner.name })) : [item],
  )
}

/** The reasoning-level option of an ACP session, if the harness has one. */
export function acpEffort(result) {
  const option = (result?.configOptions ?? []).find((item) => item.id === "effort" || item.category === "thought_level" || /reasoning|effort|thinking/i.test(item.id ?? ""))
  return option?.options?.length ? { configId: option.id, values: flatOptions(option.options).map((item) => item.value) } : undefined
}

/** The mode option (build/plan, read-only, …) of an ACP session. */
export function acpModes(result) {
  const option = (result?.configOptions ?? []).find((item) => item.id === "mode" || item.category === "mode")
  if (option?.options?.length) return { via: "config", configId: option.id, values: flatOptions(option.options).map((item) => item.value) }
  const modes = result?.modes?.availableModes
  return modes?.length ? { via: "set_mode", values: modes.map((item) => item.id) } : undefined
}

/** Cached facts about a harness: `{ models, efforts, error, time }`. */
export function harnessInfo(id) {
  return load()[id]
}

const inflight = new Map()

/** Ask a harness for its models (once a day unless forced); resolves to the cached entry. */
export function discoverHarness(harness, keyFor, force = false) {
  const entry = load()[harness.id]
  if (!force && entry && Date.now() - entry.time < 86_400_000 && !entry.error) return Promise.resolve(entry)
  if (inflight.has(harness.id)) return inflight.get(harness.id)
  const launch = harnessLaunch(harness, keyFor)
  if (!launch) return Promise.resolve(undefined)
  const job = new Promise((resolve) => {
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      client.close()
      cache = { ...load(), [harness.id]: { ...value, time: Date.now() } }
      save()
      resolve(cache[harness.id])
    }
    const client = new AcpClient(
      os.tmpdir(),
      { update: () => {}, request: async () => ({ outcome: { outcome: "cancelled" } }), exit: (error) => finish({ models: entry?.models ?? [], error: error ?? "exited" }) },
      launch,
      harness.name,
    )
    const timer = setTimeout(() => finish({ models: entry?.models ?? [], error: "no answer within 45 s" }), 45_000)
    ;(async () => {
      try {
        await client.request("initialize", { protocolVersion: 1, clientCapabilities: {} })
        const result = await client.request("session/new", { cwd: os.tmpdir(), mcpServers: [] })
        const models = acpModels(result)
        finish({ models: models?.list ?? [], efforts: acpEffort(result)?.values, error: models ? undefined : "lists no models" })
      } catch (error) {
        log("harness discovery failed", harness.id, String(error))
        finish({ models: entry?.models ?? [], error: String(error?.message ?? error) })
      }
    })()
  }).finally(() => inflight.delete(harness.id))
  inflight.set(harness.id, job)
  return job
}
