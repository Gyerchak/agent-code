
import { createRoot, createSignal } from "solid-js"
import { execFile } from "node:child_process"
import { mkdirSync } from "node:fs"
import path from "node:path"
import { config, saveConfig,                 } from "../context/config"
import { log } from "../context/log"
import { toast } from "../ui/toast"
import { createApi,            } from "./api"
import { cacheDir, loadPluginModule } from "./loader"














const entries          = []
const [status, setStatus] = createSignal                ([])
export const pluginStatus = status

let renderer

function publish() {
  setStatus(
    entries.map((entry) => ({
      id: entry.meta.id,
      source: entry.meta.source,
      spec: entry.meta.spec,
      enabled: isEnabled(entry),
      active: entry.active,
      error: entry.error,
    })),
  )
}

function isEnabled(entry       ) {
  return entry.locked || config.plugin_enabled?.[entry.meta.id] !== false
}

function report(id        , error         , what = "failed") {
  const message = error instanceof Error ? error.message : String(error)
  log(`plugin ${id} ${what}`, error)
  toast.show({ variant: "error", title: `Plugin ${id}`, message: `${what}: ${message}`, duration: 6000 })
}

const reported = new Set        ()
export function reportSlotError(plugin        , slot                    , error       ) {
  const key = `${plugin}:${slot}`
  if (reported.has(key)) return
  reported.add(key)
  report(plugin, error, `render error in ${slot ?? "slot"}`)
}

/** Port of opencode's createPluginScope: disposers run in reverse order with a time limit. */
function createScope(id        , timeoutMs = 5000) {
  const controller = new AbortController()
  let list                                                    = []
  let done = false
  let disposeRoot
  const scope                                                                              = {
    signal: controller.signal,
    onDispose(fn) {
      if (done) return () => {}
      const key = Symbol()
      list.push({ key, fn })
      return () => {
        list = list.filter((item) => item.key !== key)
      }
    },
    guard                                   (fn   )    {
      return ((...args       ) => {
        try {
          const result = fn(...args)
          if (result instanceof Promise) return result.catch((error) => report(id, error, "error"))
          return result
        } catch (error) {
          report(id, error, "error")
          return undefined
        }
      })
    },
    setRoot(fn) {
      disposeRoot = fn
    },
    async dispose() {
      if (done) return
      done = true
      controller.abort()
      const queue = [...list].reverse()
      list = []
      const until = Date.now() + timeoutMs
      for (const item of queue) {
        const left = until - Date.now()
        if (left <= 0) {
          log(`plugin ${id} cleanup timed out`)
          break
        }
        try {
          await Promise.race([Promise.resolve(item.fn()), new Promise((resolve) => setTimeout(resolve, left))])
        } catch (error) {
          log(`plugin ${id} cleanup failed`, error)
        }
      }
      disposeRoot?.()
    },
  }
  return scope
}

const manager                       = {
  list: () => status(),
  activate: (id) => setEnabled(id, true),
  deactivate: (id) => setEnabled(id, false),
  async add(spec) {
    const list = config.plugin ?? []
    if (list.some((item) => (Array.isArray(item) ? item[0] : item) === spec)) return false
    config.plugin = [...list, spec]
    saveConfig()
    const entry = externalEntry(spec)
    if (entries.some((item) => item.meta.id === entry.meta.id)) return false
    entries.push(entry)
    publish()
    return activate(entry)
  },
  install(spec) {
    return new Promise((resolve) => {
      mkdirSync(cacheDir, { recursive: true })
      execFile("npm", ["install", "--prefix", cacheDir, "--no-audit", "--no-fund", spec], { timeout: 180_000 }, (error, _stdout, stderr) => {
        if (error) {
          log("plugin install failed", spec, stderr)
          resolve({ ok: false, message: (stderr || error.message).trim().split("\n").at(-1) })
          return
        }
        resolve({ ok: true })
      })
    })
  },
}

async function activate(entry       ) {
  if (entry.active || !renderer) return entry.active
  entry.error = undefined
  let mod
  try {
    mod = await entry.load()
    if (typeof mod?.tui !== "function") throw new Error("module does not export a `tui` function")
  } catch (error) {
    entry.error = error instanceof Error ? error.message : String(error)
    publish()
    report(entry.meta.id, error, "failed to load")
    return false
  }
  const scope = createScope(entry.meta.id)
  const api = createApi({ meta: entry.meta, scope, renderer, plugins: manager })
  try {
    await new Promise      ((resolve, reject) => {
      createRoot((dispose) => {
        scope.setRoot(dispose)
        Promise.resolve(mod.tui(api, entry.options, entry.meta)).then(resolve, reject)
      })
    })
  } catch (error) {
    entry.error = error instanceof Error ? error.message : String(error)
    await scope.dispose()
    publish()
    report(entry.meta.id, error, "failed to start")
    return false
  }
  entry.scope = scope
  entry.active = true
  publish()
  return true
}

async function deactivate(entry       ) {
  if (!entry.active) return true
  entry.active = false
  const scope = entry.scope
  entry.scope = undefined
  await scope?.dispose()
  publish()
  return true
}

async function setEnabled(id        , enabled         ) {
  const entry = entries.find((item) => item.meta.id === id)
  if (!entry || (entry.locked && !enabled)) return false
  config.plugin_enabled = { ...(config.plugin_enabled ?? {}), [id]: enabled }
  saveConfig()
  const ok = enabled ? await activate(entry) : await deactivate(entry)
  publish()
  return ok
}

function specOf(item            ) {
  return Array.isArray(item) ? item[0] : item
}

function externalEntry(item            )        {
  const spec = specOf(item)
  const options = Array.isArray(item) ? item[1] : undefined
  const local = /^(\.|\/|~|file:)/.test(spec)
  const id = local ? path.basename(spec).replace(/\.[cm]?[jt]sx?$/, "") : spec.replace(/@[^@/]+$/, "")
  const entry        = {
    meta: { id, source: local ? "file" : "npm", spec },
    options,
    active: false,
    load: async () => {
      const loaded = await loadPluginModule(spec)
      if (loaded.module.id && loaded.module.id !== entry.meta.id) {
        const clash = entries.some((other) => other !== entry && other.meta.id === loaded.module.id)
        if (!clash) entry.meta.id = loaded.module.id
      }
      entry.meta.root = loaded.root
      return loaded.module
    },
  }
  return entry
}

export function registerBuiltin(plugin                                               ) {
  entries.push({
    meta: { id: plugin.id, source: "internal", spec: `internal:${plugin.id}` },
    load: async () => plugin,
    locked: plugin.locked,
    active: false,
  })
}

/** Start built-ins, then external plugins from config (after the first render, so the UI never waits on them). */
export async function startPlugins(value             ) {
  renderer = value
  for (const item of config.plugin ?? []) entries.push(externalEntry(item))
  publish()
  for (const entry of entries) {
    if (!isEnabled(entry)) continue
    await activate(entry)
  }
}

export async function stopPlugins() {
  for (const entry of [...entries].reverse()) await deactivate(entry)
}
