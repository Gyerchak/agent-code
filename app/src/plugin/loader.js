import { existsSync, readFileSync, statSync } from "node:fs"
import module, { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { configDir } from "../context/config"

import { cacheDir as appCache } from "../context/paths"

export const cacheDir = path.join(appCache, "plugins")

// occ's install root (dist/ lives directly under it).
const occRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const occRootUrl = pathToFileURL(occRoot + path.sep).href
const HOST = Symbol.for("occ.host")

/** Modules plugins must share with occ (one Solid runtime, one renderer). */
export function provideHostModules(modules                                         ) {
  ;(globalThis       )[HOST] = modules
}

const SHARED = new Set(["solid-js", "solid-js/store", "@opentui/solid", "@opentui/core"])
const compileExt = /\.(tsx|ts|mts|cts|jsx)$/

let installed = false
function installHooks() {
  if (installed) return
  installed = true
  const hooks = (module       ).registerHooks
  if (!hooks) throw new Error("this Node version can't load occ plugins (needs module.registerHooks)")
  hooks({
    resolve(specifier        , context     , next     ) {
      const parent                     = context.parentURL
      const fromOcc = !!parent?.startsWith(occRootUrl)
      if (SHARED.has(specifier) && !fromOcc) return { url: `occ-host:${specifier}`, shortCircuit: true }
      return next(specifier, context)
    },
    load(url        , context     , next     ) {
      if (url.startsWith("occ-host:")) {
        const spec = url.slice("occ-host:".length)
        const host = (globalThis       )[HOST]?.[spec]
        if (!host) throw new Error(`occ does not provide ${spec}`)
        const names = Object.keys(host).filter((name) => name !== "default" && /^[A-Za-z_$][\w$]*$/.test(name))
        const source = [
          `const m = globalThis[Symbol.for("occ.host")][${JSON.stringify(spec)}];`,
          ...names.map((name) => `export const ${name} = m[${JSON.stringify(name)}];`),
          `export default m.default ?? m;`,
        ].join("\n")
        return { format: "module", source, shortCircuit: true }
      }
      const bare = url.split(/[?#]/)[0]
      if (bare.startsWith("file:") && compileExt.test(bare) && !bare.includes("/node_modules/")) {
        const file = fileURLToPath(bare)
        return { format: "module", source: compile(file), shortCircuit: true }
      }
      return next(url, context)
    },
  })
}

let babel
const compiled = new Map                                         ()

/** Compile a local plugin file the same way occ's own sources are built (Solid universal JSX for OpenTUI). */
function compile(file        ) {
  const mtime = statSync(file).mtimeMs
  const cached = compiled.get(file)
  if (cached && cached.mtime === mtime) return cached.code
  if (!babel) {
    // Babel and the Solid preset are dependencies of @opentui/solid; resolve them from there.
    const solidRequire = createRequire(path.join(occRoot, "node_modules", "@opentui", "solid", "index.js"))
    babel = {
      transformSync: solidRequire("@babel/core").transformSync,
      solid: solidRequire("babel-preset-solid"),
      ts: solidRequire("@babel/preset-typescript"),
    }
  }
  const presets            = []
  if (/\.[jt]sx$/.test(file)) presets.push([babel.solid, { moduleName: "@opentui/solid", generate: "universal" }])
  if (/\.[cm]?tsx?$/.test(file)) presets.push([babel.ts])
  const result = babel.transformSync(readFileSync(file, "utf8"), { filename: file, configFile: false, babelrc: false, presets })
  const code = result?.code ?? ""
  compiled.set(file, { mtime, code })
  return code
}

function expandHome(spec        ) {
  if (spec.startsWith("~/")) return path.join(os.homedir(), spec.slice(2))
  return spec
}

function exportTarget(value         )                     {
  if (typeof value === "string") return value
  if (value && typeof value === "object") {
    const record = value
    return exportTarget(record.import ?? record.default ?? record.node)
  }
  return undefined
}

/** Resolve an npm plugin installed under occ's plugin cache: exports["./tui"], then "occ", then the main entry. */
function resolveNpm(spec        ) {
  const name = spec.startsWith("@") ? spec.split("@").slice(0, 2).join("@") : spec.split("@")[0]
  const dir = path.join(cacheDir, "node_modules", name)
  const pkgFile = path.join(dir, "package.json")
  if (!existsSync(pkgFile)) throw new Error(`${name} is not installed — run /plugins and install it, or \`npm install --prefix ${cacheDir} ${spec}\``)
  const pkg = JSON.parse(readFileSync(pkgFile, "utf8"))
  const exportsField = pkg.exports
  let entry
  if (exportsField && typeof exportsField === "object" && !Array.isArray(exportsField)) {
    entry = exportTarget(exportsField["./tui"]) ?? exportTarget(exportsField["."])
    if (!entry && !Object.keys(exportsField).some((key) => key.startsWith("."))) entry = exportTarget(exportsField)
  } else entry = exportTarget(exportsField)
  entry = (typeof pkg.occ === "string" ? pkg.occ : undefined) ?? entry ?? pkg.module ?? pkg.main ?? "index.js"
  return { file: path.resolve(dir, entry ), root: dir }
}

export async function loadPluginModule(spec        )                                                  {
  installHooks()
  let file
  let root
  if (/^(\.|\/|~|file:)/.test(spec)) {
    file = spec.startsWith("file:") ? fileURLToPath(spec) : path.resolve(configDir, expandHome(spec))
    if (!existsSync(file)) throw new Error(`file not found: ${file}`)
    root = path.dirname(file)
  } else {
    const resolved = resolveNpm(spec)
    file = resolved.file
    root = resolved.root
  }
  const url = pathToFileURL(file)
  url.searchParams.set("v", String(statSync(file).mtimeMs))
  const mod = await import(url.href)
  const candidate = (typeof mod.tui === "function" ? mod : mod.default)
  if (!candidate || typeof candidate.tui !== "function") throw new Error("module must export `tui(api, options, meta)`")
  return { module: { id: candidate.id ?? mod.id, tui: candidate.tui }, root }
}
