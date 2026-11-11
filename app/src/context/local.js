import { execFile } from "node:child_process"
import { createStore } from "solid-js/store"
import { config } from "./config"
import { log } from "./log"

// ---------------------------------------------------------------------------
// Local Ollama models: Ollama loads models with a small default context (often 4096 tokens), far less
// than Claude Code's own instructions (~20K), so the start of every prompt was silently cut off.
// Agent Code creates a variant with a context sized to the GPU ("<model>-acode<N>k", same weights, no extra
// disk) and watches the loaded model for the two things that degrade a local session: the context
// running past what is loaded (Ollama drops the oldest tokens → quality) and the model spilling from
// VRAM into system RAM (→ speed).
// ---------------------------------------------------------------------------

export const VARIANT = /-(?:acode|occ)\d+k$/ // "occ": variants made before the rename









export const [local, setLocal] = createStore                            ({})

function gpuMemory()                                                       {
  return new Promise((resolve) => {
    execFile("nvidia-smi", ["--query-gpu=memory.total,memory.used", "--format=csv,noheader,nounits"], { timeout: 3000 }, (error, stdout) => {
      if (error) return resolve(undefined)
      // Several GPUs: Ollama can split across them; add them up.
      let total = 0
      let used = 0
      for (const line of stdout.trim().split("\n")) {
        const [t, u] = line.split(",").map((value) => Number(value.trim()) * 1024 * 1024)
        if (Number.isFinite(t)) total += t
        if (Number.isFinite(u)) used += u
      }
      resolve(total ? { total, used } : undefined)
    })
  })
}

async function post(baseURL        , route        , body         ) {
  const response = await fetch(`${baseURL}${route}`, { method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw new Error(`${route} ${response.status}`)
  return response.json()
}

/** Bytes of GPU memory one token of context takes (K+V cache; Ollama quantises it to about 8 bits). */
function kvBytesPerToken(info                     ) {
  const arch = info["general.architecture"]
  const get = (key        ) => Number(info[`${arch}.${key}`])
  const layers = get("block_count")
  const heads = get("attention.head_count_kv") || get("attention.head_count")
  const embed = get("embedding_length")
  const keyLength = get("attention.key_length") || embed / (get("attention.head_count") || 1)
  const valueLength = get("attention.value_length") || keyLength
  if (!layers || !heads || !keyLength) return undefined
  // Measured on qwen3:4b: ~0.58 × the fp16 size, rounded up for runner overhead.
  return layers * heads * (keyLength + valueLength) * 1.2
}

/** The largest context that keeps the model and its cache on the GPU, within the model's trained window. */
async function pickContext(baseURL        , model        ) {
  const show = await post(baseURL, "/api/show", { model })
  const info = show.model_info ?? {}
  const trained = Number(info[`${info["general.architecture"]}.context_length`]) || 32_768
  const wanted = config.localContext && config.localContext > 0 ? config.localContext : undefined
  if (wanted) return Math.min(wanted, trained)
  const tags = await fetch(`${baseURL}/api/tags`).then((response) => response.json()                )
  const weights = Number(tags.models?.find((item     ) => item.name === model || item.model === model)?.size) || 0
  const gpu = await gpuMemory()
  const perToken = kvBytesPerToken(info)
  let fit = 65_536
  if (gpu && perToken && weights) fit = Math.floor(((gpu.total - gpu.used) * 0.9 - weights) / perToken)
  // Claude Code needs ~20K for its own instructions; below 32K a session is barely usable, so take 32K
  // even if part of it spills to the CPU (slower, but complete). Cap at 128K: beyond that local
  // models rarely stay coherent and prompt processing gets very slow.
  const size = Math.max(32_768, Math.min(trained, fit, 131_072))
  return Math.floor(size / 8192) * 8192
}

const variants = new Map                ()

/** The model name to send for a local model: a variant with a GPU-sized context (created once). */
export async function localModel(baseURL        , model        )                  {
  if (config.localContext === -1 || VARIANT.test(model)) return model
  const key = `${baseURL}|${model}`
  const known = variants.get(key)
  if (known) return known
  try {
    const context = await pickContext(baseURL, model)
    const name = `${model.includes(":") ? model : model + ":latest"}-acode${Math.round(context / 1024)}k`
    const exists = await fetch(`${baseURL}/api/show`, { method: "POST", body: JSON.stringify({ model: name }) }).then((response) => response.ok)
    if (!exists) await post(baseURL, "/api/create", { model: name, from: model, parameters: { num_ctx: context }, stream: false })
    variants.set(key, name)
    log("local model", model, "→", name)
    return name
  } catch (error) {
    log("local variant failed", model, String(error))
    return model
  }
}

/** Refresh what is loaded for a model: its context window and how much of it is in VRAM. */
export async function pollLocal(baseURL        , model        , key        ) {
  try {
    const ps = await fetch(`${baseURL}/api/ps`, { signal: AbortSignal.timeout(3000) }).then((response) => response.json()                )
    const name = variants.get(`${baseURL}|${model}`) ?? model
    const loaded = (ps.models ?? []).find((item     ) => item.name === name || item.model === name)
    const fromName = Number(name.match(/-(?:acode|occ)(\d+)k$/)?.[1]) * 1024 || undefined
    setLocal(key, {
      context: loaded?.context_length ?? fromName,
      vram: loaded?.size ? Math.min(1, (loaded.size_vram ?? 0) / loaded.size) : undefined,
    })
  } catch {}
}
