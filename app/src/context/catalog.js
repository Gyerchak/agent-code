import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createStore } from "solid-js/store"
import { config } from "./config"
import { log } from "./log"
import { stateDir } from "./paths"
import { providerKind, providers, splitModel,                   } from "./providers"
import { planDetails } from "./usage"

// ---------------------------------------------------------------------------
// What each model costs *for this user* and how big its context is.
//  - prices, price tiers and context windows: models.dev (cached for a day)
//  - which plan pays: Claude subscription vs API key, OpenCode Go plan, Ollama free/pro, local = free
//  - OpenCode Go meters: GET opencode.ai/zen/go/v1/usage (rolling / weekly / monthly, like its console)
// ---------------------------------------------------------------------------






/** models.dev's reasoning controls for a model: effort levels, an on/off toggle, a thinking-token budget. */


// v2: + reasoning options (variants); older caches are refetched.


const DEV_PROVIDERS = ["anthropic", "opencode", "opencode-go", "ollama-cloud"]
const file = path.join(stateDir, "catalog.json")

export const [catalog, setCatalog] = createStore




  ({ dev: {} })

function load()        {
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return {}
  }
}

function save(cache       ) {
  try {
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(file, JSON.stringify(cache))
  } catch (error) {
    log("catalog write failed", error)
  }
}

const price = (cost     )                    =>
  cost && typeof cost.input === "number" ? { input: cost.input, output: cost.output ?? 0, cacheRead: cost.cache_read, cacheWrite: cost.cache_write } : undefined

async function fetchDev()                        {
  const response = await fetch("https://models.dev/api.json", { headers: { "user-agent": "agent-code" }, signal: AbortSignal.timeout(10_000) })
  const all      = await response.json()
  const out                            = {}
  for (const id of DEV_PROVIDERS) {
    out[id] = {}
    for (const [model, info] of Object.entries     (all[id]?.models ?? {})) {
      out[id][model] = {
        name: info.name,
        cost: price(info.cost),
        tiers: (info.cost?.tiers ?? [])
          .filter((tier     ) => tier.tier?.type === "context" && typeof tier.tier.size === "number")
          .map((tier     ) => ({ ...price(tier) , above: tier.tier.size })),
        context: info.limit?.context,
        reasoning: info.reasoning,
        options: info.reasoning_options,
        npm: info.provider?.npm,
      }
    }
  }
  return out
}

async function fetchGo()                                      {
  const key = config.providers?.["opencode-go"]?.apiKey ?? providers.list.find((item) => item.id === "opencode-go")?.apiKey
  if (!key) return undefined
  const response = await fetch("https://opencode.ai/zen/go/v1/usage", {
    headers: { authorization: `Bearer ${key}`, "user-agent": "agent-code" },
    signal: AbortSignal.timeout(10_000),
  })
  if (response.status === 403) return null
  if (!response.ok) return undefined
  const usage = ((await response.json())       ).usage ?? {}
  const window = (raw     )                     =>
    raw && typeof raw.percent === "number" ? { utilization: raw.percent, resetsAt: raw.resetsAt ? Date.parse(raw.resetsAt) : undefined } : undefined
  return { rolling: window(usage.rolling), weekly: window(usage.weekly), monthly: window(usage.monthly) }
}

let refreshing
/** Refresh prices (daily), plan type and Go meters. Cheap to call often. */
export function refreshCatalog() {
  refreshing ??= (async () => {
    const cache = load()
    if (cache.dev) setCatalog("dev", cache.dev)
    try {
      if (!cache.dev || cache.v !== 2 || !cache.time || Date.now() - cache.time > 86_400_000) {
        cache.dev = await fetchDev()
        cache.time = Date.now()
        cache.v = 2
        setCatalog("dev", cache.dev )
      }
    } catch (error) {
      log("models.dev unavailable", String(error))
    }
    save(cache)
    const plan = await planDetails()
    setCatalog("plan", plan?.type)
    setCatalog("planLabel", plan?.label)
    try {
      setCatalog("go", await fetchGo())
    } catch (error) {
      log("go usage unavailable", String(error))
    }
  })().finally(() => (refreshing = undefined))
  return refreshing
}

// ---------------------------------------------------------------------------
// Per-model facts
// ---------------------------------------------------------------------------

export const CLAUDE_IDS                         = { opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-5-5", fable: "claude-fable-5-1" }







               // OpenCode Zen free tier: served only to opencode, so Agent Code runs these through opencode itself









/** Facts about a model value as stored in a session ("haiku", "opencode-go/kimi-k3", "ollama-local/qwen3:14b"). */
export function modelMeta(value                    , resolvedId         )            {
  const kind = providerKind(value)
  const split = splitModel(value)
  if (!split) {
    const id = resolvedId ?? CLAUDE_IDS[value ?? ""] ?? value ?? ""
    const dev = catalog.dev.anthropic?.[id]
    return { kind, billing: catalog.plan ? "plan" : "api", price: dev?.cost, tiers: dev?.tiers, context: dev?.context }
  }
  const model = split.model
  const listed = providers.list.find((item) => item.id === split.provider.id)?.models.find((item) => item.id === model)
  if (kind === "local") return { kind, billing: "local" }
  if (kind === "go") {
    const dev = catalog.dev["opencode-go"]?.[model]
    return { kind, billing: listed?.free ? "free" : "go", price: dev?.cost, tiers: dev?.tiers, context: dev?.context }
  }
  if (kind === "zen") {
    const dev = catalog.dev.opencode?.[model]
    if (listed?.appOnly) return { kind, billing: "app-only", context: dev?.context }
    return { kind, billing: listed?.free ? "free" : "api", price: dev?.cost, tiers: dev?.tiers, context: dev?.context }
  }
  if (kind === "cloud") {
    const dev = catalog.dev["ollama-cloud"]?.[model.replace(/:latest$/, "")]
    // Ollama Cloud bills by plan, not per token; the provider's name says which plan the key is on.
    const name = `${split.provider.id} ${split.provider.name ?? ""}`.toLowerCase()
    return { kind, billing: /free/.test(name) || listed?.free ? "free" : "api", price: /pro/.test(name) ? undefined : dev?.cost, context: dev?.context }
  }
  // Another harness: it bills through its own login or keys.
  if (kind === "harness") return { kind, billing: "harness" }
  return { kind, billing: listed?.free ? "free" : "api" }
}

const money = (n        ) => (n === 0 ? "0" : n < 0.1 ? n.toFixed(3).replace(/0+$/, "") : n < 10 ? n.toFixed(2).replace(/\.?0+$/, "") : n.toFixed(0))
export const priceText = (price        ) => (price ? `$${money(price.input)}/$${money(price.output)}` : "")

const PLAN                         = { pro: "Pro", max: "Max", team: "Team", enterprise: "Enterprise", free: "Free" }

/**
 * How a plan is named on screen: "Max Plan [5x Pro]" (a Max plan with five times Pro's usage), "Pro Plan".
 * `label` is the short name from Anthropic's profile ("Max 5×", "Pro").
 */
export function planTitle(label = catalog.planLabel ?? PLAN[catalog.plan ?? ""] ?? catalog.plan) {
  if (!label) return ""
  const match = String(label).match(/^(.*?)\s*(\d+)\s*[×x]$/i)
  const name = (match ? match[1] : String(label)).trim()
  const title = `${name.charAt(0).toUpperCase()}${name.slice(1)} Plan`
  return match ? `${title} [${match[2]}x Pro]` : title
}

/** Short label for the model picker: who pays and how much (per million input/output tokens). */
export function billingLabel(meta           , providerName         ) {
  switch (meta.billing) {
    case "plan":
      return planTitle() || "Claude plan"
    case "local":
      return "Free · local"
    case "free":
      return "Free"
    case "app-only":
      return "Free · via opencode"
    case "harness":
      return `via ${providerName ?? "harness"}`
    case "go":
      return meta.price ? `Go plan · ${priceText(meta.price)}` : "Go plan"
    case "api":
      return meta.price ? priceText(meta.price) : /pro/i.test(providerName ?? "") ? `${providerName}` : "paid"
  }
}

export const contextText = (tokens         ) => (!tokens ? "" : tokens >= 1_000_000 ? `${Math.round(tokens / 100_000) / 10}M`.replace(".0M", "M") : `${Math.round(tokens / 1000)}K`)

// ---------------------------------------------------------------------------
// Subagent tiers (Settings → Subagents): which non-Claude models may run delegated work
// ---------------------------------------------------------------------------


export const SUBAGENT_TIERS                                                        = [
  { tier: "local", title: "Local models", hint: "this machine: free, private, slower" },
  { tier: "free", title: "Free cloud models", hint: "free tiers (OpenCode Go free, Ollama Cloud free)" },
  { tier: "go", title: "OpenCode Go models", hint: "from the Go plan allowance" },
  { tier: "zen", title: "Paid OpenCode Zen models", hint: "pay per token from the Zen balance" },
  { tier: "paid", title: "Other paid cloud models", hint: "other paid providers and plans" },
]

/** The subagent tier of a provider model; Claude models and app-only models (run by opencode, not Claude Code) have none. */
export function subagentTier(value        )                           {
  const meta = modelMeta(value)
  if (meta.kind === "anthropic" || meta.billing === "app-only" || meta.kind === "harness") return undefined
  if (meta.billing === "local") return "local"
  if (meta.billing === "free") return "free"
  if (meta.kind === "go") return "go"
  if (meta.kind === "zen") return "zen"
  return "paid"
}

/** Every provider model value, by tier, in provider order. */
export function tierModels(tier              ) {
  return providers.list.flatMap((provider) => provider.models.map((model) => `${provider.id}/${model.id}`)).filter((value) => subagentTier(value) === tier)
}
