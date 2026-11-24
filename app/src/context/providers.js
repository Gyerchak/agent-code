import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createStore } from "solid-js/store"
import { config, saveConfig } from "./config"
import { log } from "./log"
import { localModel, VARIANT } from "./local"
import { proxyURL, routerURL } from "./proxy"
import { authFile, readAuthFile, writeAuthEntries } from "./auth"
import { stateDir } from "./paths"
import { discoverHarness, harnessById, harnessInfo, HARNESSES } from "./harnesses"
import { findBinary } from "./platform"
import { applyPersonalSeed } from "./personal"

// ---------------------------------------------------------------------------
// Non-Anthropic providers. Claude Code talks to them through ANTHROPIC_BASE_URL: directly when the
// model answers the Anthropic Messages API, otherwise through Agent Code's translating proxy (proxy.ts).
// A model from one is stored as "<provider>/<model>".
// Agent Code keeps its own providers (config.json → providers) and keys (auth.ts: <data>/agent-code/auth.json, 0600).
// On first start it imports what opencode has once (its config's providers, its auth.json keys); after that
// opencode's files are never read again and /connect writes only Agent Code's own file.
// ---------------------------------------------------------------------------



/** appOnly: served only to the provider's own app (OpenCode Zen's free tier); Agent Code runs these through opencode. */














const BUILTIN                                                                                           = {
  "opencode-zen": { name: "OpenCode Zen", baseURL: "https://opencode.ai/zen", kind: "opencode", order: 1 },
  "opencode-go": { name: "OpenCode Go", baseURL: "https://opencode.ai/zen/go", kind: "opencode", order: 3 },
  ollama: { name: "Ollama (local)", baseURL: "http://127.0.0.1:11434", kind: "ollama", order: 6 },
  "ollama-cloud": { name: "Ollama Cloud", baseURL: "https://ollama.com", kind: "ollama", order: 4 },
  // Listed once a key is saved (/connect); their models also run inside Claude Code through Agent Code's proxy.
  deepseek: { name: "DeepSeek", baseURL: "https://api.deepseek.com", kind: "openai", order: 7 },
  openai: { name: "OpenAI", baseURL: "https://api.openai.com", kind: "openai", order: 8 },
}

/** models.dev ids for the opencode gateways, for per-model protocol and pricing. */
const MODELS_DEV                         = { "opencode-zen": "opencode", "opencode-go": "opencode-go" }

export const [providers, setProviders] = createStore                          ({ list: [] })

const cacheFile = path.join(stateDir, "providers.json")







let cache
function loadCache()        {
  if (cache) return cache
  try {
    cache = JSON.parse(readFileSync(cacheFile, "utf8"))
  } catch {
    cache = {}
  }
  return cache
}
function saveCache() {
  try {
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(cacheFile, JSON.stringify(cache))
  } catch (error) {
    log("provider cache write failed", error)
  }
}

// ---------------------------------------------------------------------------
// Agent Code's key store
// ---------------------------------------------------------------------------

export { authFile }

/** Provider keys from Agent Code's secrets file (auth.ts). */
function readAuth()                         {
  const out                         = {}
  for (const [id, value] of Object.entries     (readAuthFile())) if (value?.type === "api" && typeof value.key === "string" && value.key) out[id] = value.key
  return out
}

/** A provider's saved API key (Agent Code's auth.json), for harnesses that read it from their environment. */
export function apiKeyFor(id        ) {
  return readAuth()[id]
}

function writeAuth(keys                        ) {
  writeAuthEntries(
    (_, value) => value?.type === "api",
    Object.fromEntries(Object.entries(keys).map(([id, key]) => [id, { type: "api", key }])),
  )
  resolved = undefined
}

/** Save (or with no key, remove) a provider's API key in Agent Code's own store. */
export function saveKey(id        , key                    ) {
  const keys = readAuth()
  if (key) keys[id] = key
  else delete keys[id]
  writeAuth(keys)
}

// ---------------------------------------------------------------------------
// One-time import from opencode (its config's providers and its auth.json keys)
// ---------------------------------------------------------------------------

const xdg = (env                    , ...fallback          ) => env ?? path.join(os.homedir(), ...fallback)

/** The opencode config's provider section; old (`provider`/`options`) and new (`providers`/`settings`) shapes. */
function opencodeProviders()                                                                                         {
  const dir = path.join(xdg(process.env.XDG_CONFIG_HOME, ".config"), "opencode")
  for (const file of ["opencode.json", "opencode.jsonc"]) {
    try {
      const text = readFileSync(path.join(dir, file), "utf8").replace(/^\s*\/\/.*$/gm, "")
      const json = JSON.parse(text)
      const section = json.providers ?? json.provider ?? {}
      const out                                       = {}
      for (const [id, value] of Object.entries     (section)) {
        const settings = value?.settings ?? value?.options ?? {}
        out[id] = { name: value?.name, apiKey: settings.apiKey, baseURL: settings.baseURL, models: Object.keys(value?.models ?? {}) }
      }
      return out
    } catch {}
  }
  return {}
}

function opencodeAuth()                         {
  try {
    const json = JSON.parse(readFileSync(path.join(xdg(process.env.XDG_DATA_HOME, ".local", "share"), "opencode", "auth.json"), "utf8"))
    const out                         = {}
    for (const [id, value] of Object.entries     (json)) if (value?.type === "api" && typeof value.key === "string") out[id] = value.key
    return out
  } catch {
    return {}
  }
}

/** The key opencode would pick for a provider: its credential store by id ("opencode" = Zen) or endpoint, then its config. */
function opencodeKey(auth                        , id        , baseURL        , configKey         ) {
  const own = auth[id === "opencode-zen" ? "opencode" : id]
  if (own) return own
  if (baseURL.includes("opencode.ai/zen/go")) return auth["opencode-go"] ?? configKey
  if (baseURL.includes("opencode.ai/zen")) return auth["opencode"] ?? configKey
  if (baseURL.includes("ollama.com")) return auth["ollama-cloud"] ?? configKey
  return configKey
}

/**
 * Copy opencode's providers and keys into Agent Code's own config and key store, once (or again on request,
 * filling in only what Agent Code doesn't have yet). Keys that were in Agent Code's config.json move to the key store.
 */
export function importFromOpencode(force = false) {
  if (config.providersImported && !force) return { providers: 0, keys: 0 }
  const keys = readAuth()
  const before = { providers: Object.keys(config.providers ?? {}).length, keys: Object.keys(keys).length }
  const list = { ...(config.providers ?? {}) }
  for (const [id, entry] of Object.entries(list)) {
    if (entry.apiKey) keys[id] ??= entry.apiKey
    const { apiKey: _, ...rest } = entry
    list[id] = rest
  }
  const auth = opencodeAuth()
  const known = loadCache().modelsDev?.apis ?? {}
  for (const [id, oc] of Object.entries(opencodeProviders())) {
    const match = oc.name?.match(/^\s*(\d+)\.\s*(.*)$/)
    list[id] ??= {
      name: match?.[2]?.replace(/-/g, " ") ?? oc.name,
      baseURL: oc.baseURL,
      models: oc.models.length ? oc.models : undefined,
      order: match ? Number(match[1]) : undefined,
    }
    const baseURL = trimBase(list[id].baseURL ?? oc.baseURL ?? BUILTIN[id]?.baseURL ?? "")
    const key = opencodeKey(auth, id, baseURL, oc.apiKey)
    if (key) keys[id] ??= key
  }
  // Providers opencode only knew through a stored key (e.g. "llama"): endpoint and name from models.dev.
  for (const [id, key] of Object.entries(auth)) {
    if (id === "opencode") keys["opencode-zen"] ??= key
    else if (BUILTIN[id] || list[id]) keys[id] ??= key
    else if (known[id]) {
      list[id] = { name: known[id].name, baseURL: known[id].api }
      keys[id] ??= key
    }
  }
  config.providers = list
  config.providersImported = new Date().toISOString()
  saveConfig()
  writeAuth(keys)
  const imported = { providers: Object.keys(list).length - before.providers, keys: Object.keys(keys).length - before.keys }
  log("imported from opencode", imported)
  return imported
}

const trimBase = (url        ) => url.replace(/\/+$/, "").replace(/\/v1$/, "")
const isLocal = (url        ) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(url)

function kindOf(id        , baseURL        )                   {
  if (BUILTIN[id]) return BUILTIN[id].kind
  if (baseURL.includes("opencode.ai/zen")) return "opencode"
  if (baseURL.includes("ollama.com") || /:11434$/.test(baseURL)) return "ollama"
  return "openai"
}

/** Every configured provider, without models (cheap, synchronous; re-read every few seconds). */
let resolved
function resolveAll()             {
  if (resolved && Date.now() - resolved.time < 3000) return resolved.list
  resolved = { time: Date.now(), list: readAll() }
  return resolved.list
}

function readAll()             {
  applyPersonalSeed()
  importFromOpencode()
  const keys = readAuth()
  const ids = [...new Set([...Object.keys(BUILTIN), ...Object.keys(config.providers ?? {})])]
  const list             = []
  for (const id of ids) {
    const own = config.providers?.[id]
    const builtin = BUILTIN[id]
    if (own?.enabled === false) continue
    const rawBase = own?.baseURL ?? builtin?.baseURL
    if (!rawBase) continue
    const baseURL = trimBase(rawBase)
    const local = isLocal(baseURL)
    const apiKey = keys[id] ?? own?.apiKey ?? (local ? "local" : undefined)
    if (!apiKey) continue
    const kind = kindOf(id, baseURL)
    const name = builtin?.name ?? own?.name ?? id
    const order = own?.order ?? builtin?.order ?? 50
    list.push({ id, name, baseURL, apiKey, kind, configModels: own?.models ?? [], order, sessionHeader: kind === "opencode" })
  }
  // Built-in entries only when Agent Code's own providers don't already point at the same endpoint.
  const configured = (item          ) => !!config.providers?.[item.id]
  return list
    .filter((item) => !BUILTIN[item.id] || configured(item) || !list.some((other) => other !== item && configured(other) && other.baseURL === item.baseURL))
    .sort((a, b) => a.order - b.order)
}

function resolve(id        ) {
  return resolveAll().find((item) => item.id === id) ?? (BUILTIN[id] ? { id, ...BUILTIN[id], apiKey: "local", configModels: [], sessionHeader: false } : undefined)
}

async function getJSON(url        , apiKey         , timeout = 4000)               {
  const response = await fetch(url, {
    headers: { "user-agent": "agent-code/1.0", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    signal: AbortSignal.timeout(timeout),
  })
  if (!response.ok) throw new Error(`${response.status} ${url}`)
  return response.json()
}

/** models.dev catalogue (cached for a day): per-model protocol and pricing for the opencode gateways. */
async function modelsDev()                               {
  const state = loadCache()
  if (state.modelsDev?.apis && state.modelsDev.v === 2 && Date.now() - state.modelsDev.time < 86_400_000) return state.modelsDev.data
  try {
    const all = await getJSON("https://models.dev/api.json", undefined, 8000)
    const data                      = {}
    for (const id of Object.values(MODELS_DEV)) {
      data[id] = Object.fromEntries(
        Object.entries     (all[id]?.models ?? {}).map(([model, info]) => [
          model,
          { npm: info.provider?.npm, free: info.cost?.input === 0 && info.cost?.output === 0, deprecated: info.status === "deprecated" || undefined },
        ]),
      )
    }
    const apis                                                = {}
    for (const [id, info] of Object.entries     (all))
      if (typeof info?.api === "string" && /openai-compatible/.test(info.npm ?? "")) apis[id] = { api: info.api, name: info.name ?? id }
    state.modelsDev = { v: 2, time: Date.now(), data, apis }
    resolved = undefined
    saveCache()
    return data
  } catch (error) {
    log("models.dev unavailable", error)
    return state.modelsDev?.data ?? {}
  }
}

/** The main Agent Code's provider cache, for a box (its launcher names the main state folder). */
function sharedModels(key        )                       {
  const dir = process.env.ACODE_SHARED_STATE
  if (!dir) return undefined
  try {
    return JSON.parse(readFileSync(path.join(dir, "providers.json"), "utf8")).models?.[key]
  } catch {
    return undefined
  }
}

async function listModels(provider          )                           {
  const state = loadCache()
  const key = `${provider.id}@${provider.baseURL}`
  const catalogue = MODELS_DEV[provider.id] ? ((await modelsDev())[MODELS_DEV[provider.id]] ?? {}) : {}
  let ids           = []
  try {
    if (provider.kind === "ollama") {
      // Local Ollama lists what is installed; for Ollama Cloud the configured list is the user's pick.
      if (!isLocal(provider.baseURL) && provider.configModels.length) ids = provider.configModels
      else ids = ((await getJSON(`${provider.baseURL}/api/tags`, provider.apiKey, 2000)).models ?? []).map((model     ) => model.name).filter((name        ) => !VARIANT.test(name)).sort()
    } else {
      const list = (apiKey         ) => getJSON(`${provider.baseURL}/v1/models`, apiKey, 8000)
      // Zen lists its models to anyone: an expired or missing key still gets the list.
      const answer = await list(provider.apiKey).catch((error) => (provider.id === "opencode-zen" ? list(undefined) : Promise.reject(error)))
      ids = (answer.data ?? []).map((model     ) => model.id).sort()
      // OpenAI lists embeddings, speech, images and moderation too: keep the chat models.
      if (provider.id === "openai")
        ids = ids.filter((id        ) => /^(gpt-|o\d|codex|chatgpt)/.test(id) && !/audio|realtime|tts|transcribe|image|search|embedding|moderation|instruct/.test(id))
    }
    if (ids.length) {
      state.models = { ...state.models, [key]: ids }
      saveCache()
    }
  } catch (error) {
    log("model list failed", provider.id, String(error))
    // Without a live list (a rejected key, offline): everything known about the provider, so no model goes missing.
    const known = Object.entries(catalogue)
      .filter(([, info]     ) => !info?.deprecated)
      .map(([id]) => id)
    ids = [...new Set([...(state.models?.[key] ?? []), ...(sharedModels(key) ?? []), ...provider.configModels, ...known])].sort()
  }
  const models = ids.map((id) => ({ id, free: catalogue[id]?.free || /-free$/.test(id) || undefined }))
  // Zen's free tier only serves the opencode app itself ("FreeTierError"): these tabs run inside opencode (acp.ts).
  if (provider.id === "opencode-zen") return models.map((model) => (model.free ? { ...model, appOnly: true } : model))
  return models
}

/**
 * OpenCode Zen's free models answer only the opencode app ("FreeTierError" elsewhere): Agent Code runs them
 * through opencode itself. Returns opencode's own id ("opencode/<model>") for such models.
 */
export function opencodeModel(value                    )                     {
  const split = splitModel(value)
  if (split?.provider.id !== "opencode-zen") return undefined
  const listed = providers.list.find((provider) => provider.id === "opencode-zen")?.models.find((model) => model.id === split.model)
  const free = listed ? !!listed.appOnly : !!loadCache().modelsDev?.data?.opencode?.[split.model]?.free || /-free$/.test(split.model)
  return free ? `opencode/${split.model}` : undefined
}

/** Rebuild the provider list (called when the model picker opens). */
export async function refreshProviders() {
  await modelsDev()
  const harnessList = harnessProviders()
  const list = await Promise.all(
    resolveAll().map(async (provider)                        => ({
      id: provider.id,
      name: provider.name,
      baseURL: provider.baseURL,
      apiKey: provider.apiKey,
      sessionHeader: provider.sessionHeader,
      models: await listModels(provider),
    })),
  )
  const usable = [...list, ...harnessList].filter((provider) => provider.models.length)
  setProviders("list", usable)
  // Harnesses answer slowly (they start up): ask them in the background and list their models once known.
  for (const harness of HARNESSES)
    void discoverHarness(harness, apiKeyFor).then((entry) => {
      if (!entry?.models?.length) return
      const current = providers.list.find((provider) => provider.id === harness.id)
      if (current && current.models.length === entry.models.length) return
      setProviders("list", (items) => [...items.filter((provider) => provider.id !== harness.id), harnessProvider(harness, entry)])
    })
  return usable
}

function harnessProvider(harness, entry) {
  return { id: harness.id, name: harness.name, baseURL: "", harness: true, models: (entry?.models ?? []).map((model) => ({ id: model.id, label: model.name })) }
}

/** The installed harnesses with the models they listed last time. */
function harnessProviders() {
  return HARNESSES.filter((harness) => findBinary(harness.bin)).map((harness) => harnessProvider(harness, harnessInfo(harness.id)))
}

/** Each harness: installed or not, its models, the last discovery error and how to install it. */
export function harnessStatus() {
  return HARNESSES.map((harness) => ({ ...harness, installed: !!findBinary(harness.bin), info: harnessInfo(harness.id) }))
}

/**
 * The harness that runs a model value, with the harness's own model id: "dsh/<model>", "codex/<model>",
 * "opencode/<provider/model>", and OpenCode Zen's free models (served only to opencode itself).
 */
export function harnessModel(value                    ) {
  const zen = opencodeModel(value)
  if (zen) return { harness: harnessById("opencode"), model: zen }
  const split = splitModel(value)
  const harness = split && harnessById(split.provider.id)
  return harness ? { harness, model: split.model } : undefined
}

/** Split "ollama/qwen3:14b" into provider + model; Anthropic models return undefined. */
export function splitModel(value                    )                                                                         {
  if (!value) return undefined
  const slash = value.indexOf("/")
  if (slash < 0) return undefined
  const id = value.slice(0, slash)
  const harness = harnessById(id)
  const known =
    providers.list.find((item) => item.id === id) ?? (BUILTIN[id] ? { id, name: BUILTIN[id].name } : harness ? { id, name: harness.name } : resolve(id))
  if (!known) return undefined
  return { provider: known, model: value.slice(slash + 1) }
}

export function providerName(value                    ) {
  const split = splitModel(value)
  return split ? (split.provider.name ?? split.provider.id) : "Anthropic"
}

/** Which API a provider model answers; probed once for gateway models models.dev doesn't pin down. */
async function protocolOf(provider          , model        )                    {
  if (provider.kind === "ollama") return "anthropic"
  // OpenAI's own API serves its newest models (gpt-5, *-codex) only through the Responses API.
  if (provider.id === "openai") return "responses"
  if (provider.kind === "openai") return "chat"
  const npm = (await modelsDev())[MODELS_DEV[provider.id] ?? "opencode"]?.[model]?.npm
  if (npm === "@ai-sdk/anthropic") return "anthropic"
  if (npm === "@ai-sdk/openai") return "responses"
  const state = loadCache()
  const key = `${provider.baseURL}|${model}`
  if (state.protocols?.[key]) return state.protocols[key]
  let protocol           = "anthropic"
  try {
    const response = await fetch(`${provider.baseURL}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "agent-code/1.0",
        "anthropic-version": "2023-06-01",
        "x-api-key": provider.apiKey ?? "",
        "x-opencode-session": `acode-probe-${process.pid}`,
      },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
      signal: AbortSignal.timeout(20000),
    })
    const text = await response.text()
    if (/ProtocolUnsupported/i.test(text)) protocol = npm === undefined && /^(gpt|grok|muse)/.test(model) ? "responses" : "chat"
    else if (!response.ok) return protocol // account/limit errors: don't cache, Claude Code shows the message
  } catch {
    return protocol
  }
  state.protocols = { ...state.protocols, [key]: protocol }
  saveCache()
  return protocol
}

/** Environment for a Claude Code process that should talk to a third-party provider. */
export async function providerEnv(value                    , sessionId                    )                                              {
  const split = splitModel(value)
  if (!split) return undefined
  const provider = resolve(split.provider.id)
  if (!provider?.apiKey) {
    log("provider without api key", split.provider.id)
    return undefined
  }
  const protocol = await protocolOf(provider, split.model)
  const session = provider.sessionHeader && sessionId ? { "x-opencode-session": sessionId } : undefined
  // Always through Agent Code's proxy: it translates protocols and writes the model's variant into each request.
  const baseURL = await proxyURL({ baseURL: provider.baseURL, apiKey: provider.apiKey, protocol, headers: session, model: value })
  // Local Ollama: a variant whose context fits the GPU (the default 4K would cut Claude Code's prompt).
  const model = providerKind(value) === "local" ? await localModel(provider.baseURL, split.model) : split.model
  log("provider", split.provider.id, model, protocol)
  const env                         = {
    ANTHROPIC_BASE_URL: baseURL,
    ANTHROPIC_API_KEY: provider.apiKey,
    ANTHROPIC_AUTH_TOKEN: provider.apiKey,
    // Claude Code's own background calls (titles, Haiku helpers, subagents) must use this model too.
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    ANTHROPIC_SMALL_FAST_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  }
  if (session) env.ANTHROPIC_CUSTOM_HEADERS = `x-opencode-session: ${sessionId}`
  return env
}

/**
 * Mixed providers in one Claude Code process: Claude Code keeps its Claude login and talks to Agent Code's router,
 * which sends "<provider>/<model>" requests to that provider and everything else to Anthropic.
 */
export async function routerEnv(sessionId                    , main         )                                  {
  const url = await routerURL({
    async resolve(model) {
      const split = splitModel(model)
      if (!split) return undefined
      const provider = resolve(split.provider.id)
      if (!provider?.apiKey) return undefined
      const protocol = await protocolOf(provider, split.model)
      const name = providerKind(model) === "local" ? await localModel(provider.baseURL, split.model) : split.model
      const headers = provider.sessionHeader && sessionId ? { "x-opencode-session": sessionId } : undefined
      return {
        model: name,
        protocol,
        upstream: { baseURL: provider.baseURL, apiKey: provider.apiKey, protocol, headers },
      }
    },
  })
  // A tab on a non-Claude model keeps Claude Code's own background calls (titles, summaries) on that
  // model too, so it never spends the Claude plan; Claude subagents still reach Claude by alias.
  return splitModel(main) ? { ANTHROPIC_BASE_URL: url, ANTHROPIC_SMALL_FAST_MODEL: main  } : { ANTHROPIC_BASE_URL: url }
}



/** Where a model runs: Claude plan, this machine, a free/paid cloud, or an OpenCode gateway. */
export function providerKind(value                    )               {
  const split = splitModel(value)
  if (!split) return "anthropic"
  if (split.provider.id === "opencode-go") return "go"
  if (split.provider.id === "opencode-zen") return "zen"
  if (harnessById(split.provider.id)) return "harness"
  const provider = resolve(split.provider.id)
  if (provider?.kind === "ollama") return isLocal(provider.baseURL) ? "local" : "cloud"
  if (provider && isLocal(provider.baseURL)) return "local"
  return "other"
}

export const KIND_ICON                               = { anthropic: "✻", local: "⌂", cloud: "☁", go: "◆", zen: "◇", harness: "◈", other: "○" }
