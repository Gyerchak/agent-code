
import { createSlot, createSolidSlotRegistry } from "@opentui/solid"
import { createSignal,          } from "solid-js"
import { log } from "../context/log"





// Before the registry exists (or with no plugins) a slot renders its fallback children.
const fallback           = (props) => props.children ?? null
const [view, setView] = createSignal          (fallback)

/** Plugin slot, same names and modes as opencode's TuiHostSlotMap. */
export function Slot                                            (
  props                                                                                                                                  ,
) {
  return <>{view()(props             )}</>
}

let registry
let errorHandler

export function setupSlots(renderer             , context        , onError                                                                  ) {
  errorHandler = onError
  registry = createSolidSlotRegistry          (renderer, context, {
    onPluginError(event) {
      log("plugin slot error", event.pluginId, event.slot, event.phase, event.error?.stack ?? String(event.error))
      errorHandler?.(event.pluginId, event.slot, event.error)
    },
  })
  const slot = createSlot          (registry)
  setView(() => (props           ) => slot(props       ))
}

let anonymous = 0
export function registerSlots(plugin            , owner        ) {
  if (!registry) throw new Error("slot registry is not ready")
  const id = plugin.id ?? `${owner}:${++anonymous}`
  return registry.register({ ...plugin, id }       )
}
