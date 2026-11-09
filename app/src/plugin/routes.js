import { createSignal } from "solid-js"





// Port of opencode's createPluginRoutes: later registrations of the same name win.
const routes = new Map                      ()
const [revision, setRevision] = createSignal(0)
const [current, setCurrent] = createSignal                                                    ()

export const pluginRoute = current

export function registerRoutes(list               ) {
  const key = Symbol()
  for (const item of list) routes.set(item.name, [...(routes.get(item.name) ?? []), { key, render: item.render }])
  setRevision((value) => value + 1)
  return () => {
    for (const item of list) {
      const next = routes.get(item.name)?.filter((entry) => entry.key !== key) ?? []
      if (next.length) routes.set(item.name, next)
      else routes.delete(item.name)
    }
    setRevision((value) => value + 1)
    const open = current()
    if (open && !routes.has(open.name)) setCurrent(undefined)
  }
}

export function routeRender(name        )                                                                             {
  revision()
  return routes.get(name)?.at(-1)?.render
}

export function hasRoute(name        ) {
  return routes.has(name)
}

export function showPluginRoute(name                    , params                          ) {
  setCurrent(name ? { name, params } : undefined)
}
