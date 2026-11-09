import { createSignal } from "solid-js"
import { catalog,                      } from "./catalog"
import { config } from "./config"
import { log } from "./log"
import { providerKind, providers, splitModel } from "./providers"

// ---------------------------------------------------------------------------
// Variants (reasoning levels) of non-Claude models, like opencode: every model has its own set.
// Claude models keep the levels Claude Code reports. Provider models take theirs from models.dev's
// `reasoning_options` (effort values, an on/off toggle, a thinking budget); local Ollama models from
// their capabilities. Claude Code can't send these, so occ's proxy (proxy.ts) writes the chosen
// variant into each request in the provider's own format.
// ---------------------------------------------------------------------------



const DEV                         = { go: "opencode-go", zen: "opencode", cloud: "ollama-cloud" }

function devModel(value        ) {
  const split = splitModel(value)
  const kind = providerKind(value)
  const ids = [split.model, split.model.replace(/:latest$/, ""), split.model.replace(/:[^:]*$/, "")]
  const sources = DEV[kind] ? [DEV[kind]] : Object.values(DEV)
  for (const source of sources) for (const id of ids) if (catalog.dev[source]?.[id]) return catalog.dev[source][id]
  return undefined
}

function fromOptions(options                   )       {
  const efforts = [...new Set(options.flatMap((option) => (option.type === "effort" ? option.values.map((value) => value ?? "none") : [])))]
  const toggle = options.some((option) => option.type === "toggle")
  const budget = options.some((option) => option.type === "budget_tokens")
  const levels = [
    ...(toggle && !efforts.includes("none") ? ["none"] : []),
    ...efforts,
    ...(budget && !efforts.length ? ["high", "max"] : []),
    ...(toggle && !efforts.length && !budget ? ["high"] : []),
  ]
  return { levels: [...new Set(levels)], efforts, toggle, budget: budget && !efforts.length }
}

const effortSpec = (efforts          )       => ({ levels: efforts, efforts, toggle: false, budget: false })

/** Models models.dev doesn't know: opencode's family rules. Unknown families get none. */
function guess(id        )       {
  const name = id.toLowerCase()
  if (/claude-/.test(name)) return effortSpec(["low", "medium", "high", "xhigh", "max"])
  if (/(^|\/)gpt-5|(^|\/)o\d/.test(name)) return effortSpec(["minimal", "low", "medium", "high"])
  if (/gpt-oss/.test(name)) return effortSpec(["low", "medium", "high"])
  if (/gemini/.test(name)) return effortSpec(["low", "high"])
  if (/grok-3-mini/.test(name)) return effortSpec(["low", "high"])
  return effortSpec([])
}

// Local Ollama: /api/show says whether a model thinks; gpt-oss takes levels, the rest switch on/off.
const local                                  = {}
const asking = new Set        ()
const [localVersion, setLocalVersion] = createSignal(0)

function localSpec(value        )       {
  localVersion()
  const split = splitModel(value)
  const baseURL = providers.list.find((provider) => provider.id === split.provider.id)?.baseURL
  const key = `${baseURL}|${split.model}`
  if (!(key in local) && baseURL && !asking.has(key)) {
    asking.add(key)
    fetch(`${baseURL}/api/show`, { method: "POST", body: JSON.stringify({ model: split.model }), signal: AbortSignal.timeout(4000) })
      .then((response) => (response.ok ? response.json() : undefined))
      .then((info     ) => (local[key] = info?.capabilities ?? null))
      .catch((error) => {
        log("ollama show failed", split.model, String(error))
        local[key] = null
      })
      .finally(() => setLocalVersion((n) => n + 1))
  }
  if (!local[key]?.includes("thinking")) return effortSpec([])
  if (/gpt-oss/i.test(split.model)) return effortSpec(["low", "medium", "high"])
  return { levels: ["none", "high"], efforts: [], toggle: true, budget: false }
}

function spec(value        )       {
  if (providerKind(value) === "local") return localSpec(value)
  const dev = devModel(value)
  if (dev?.reasoning === false) return effortSpec([])
  if (dev?.options) return fromOptions(dev.options)
  return guess(splitModel(value) .model)
}

/** A provider model's variants ([] = it has none); undefined for Claude models (Claude Code's own list). */
export function modelVariants(value                    )                       {
  if (!splitModel(value)) return undefined
  return spec(value ).levels
}

/** The variant chosen for a provider model (stored per model), if it is one of the model's own. */
export function chosenVariant(value        )                     {
  const variant = config.modelEffort?.[value]
  if (!variant || variant === "default") return undefined
  return spec(value).levels.includes(variant) ? variant : undefined
}

// Thinking budget for budget/toggle models: it must stay below max_tokens.
const budgetFor = (variant        , maxTokens                    ) => {
  const max = Math.max(1024, (maxTokens ?? 32_000) - 1)
  return variant === "max" ? Math.min(31_999, max) : Math.min(16_000, Math.max(1024, Math.floor(max / 2)))
}

/**
 * Write the model's chosen variant into an outgoing request (mutates it). `request` is the Anthropic body
 * for "anthropic", the translated OpenAI body for "chat" / "responses". Without a chosen variant the
 * request stays as Claude Code made it (the model's default).
 */
export function applyVariant(protocol                                    , request     , value                    ) {
  if (!value || !splitModel(value)) return
  const variant = chosenVariant(value)
  if (!variant) return
  const model = spec(value)
  const effort = model.efforts.includes(variant)
  const off = variant === "none" && (effort || model.toggle)
  if (protocol === "anthropic") {
    if (request.output_config) delete request.output_config.effort
    if (off) request.thinking = { type: "disabled" }
    else if (effort) {
      request.output_config = { ...request.output_config, effort: variant }
      if (!request.thinking || request.thinking.type === "disabled") request.thinking = { type: "adaptive" }
      // Ollama's own field for gpt-oss levels.
      if (providerKind(value) === "local") request.think = variant
    } else if (!request.max_tokens || request.max_tokens > 1024) request.thinking = { type: "enabled", budget_tokens: budgetFor(variant, request.max_tokens) }
    if (request.output_config && !Object.keys(request.output_config).length) delete request.output_config
    return
  }
  if (protocol === "chat") {
    if (effort) request.reasoning_effort = variant
    else request.thinking = off ? { type: "disabled" } : { type: "enabled", ...(model.budget ? { budget_tokens: budgetFor(variant, request.max_tokens) } : {}) }
    return
  }
  request.reasoning = { effort: effort ? variant : off ? "none" : "high", summary: "auto" }
}
