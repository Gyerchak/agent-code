import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createStore } from "solid-js/store"
import { stateDir } from "../context/paths"

// Small persisted key/value store for plugins (opencode's api.kv), reactive like opencode's.
export { stateDir }
const file = path.join(stateDir, "kv.json")

function load()                          {
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return {}
  }
}

const [kvStore, setKvStore] = createStore                         (load())

let timer
function save() {
  clearTimeout(timer)
  timer = setTimeout(() => {
    try {
      mkdirSync(stateDir, { recursive: true })
      writeFileSync(file, JSON.stringify(kvStore, null, 2) + "\n")
    } catch {}
  }, 200)
}

export const kv = {
  get             (key        , fallback    )    {
    const value = kvStore[key]
    return (value === undefined ? fallback : value)
  },
  set(key        , value         ) {
    setKvStore(key, value       )
    save()
  },
  ready: true,
}
