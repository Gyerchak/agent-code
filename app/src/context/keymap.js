
import { createSignal, onCleanup } from "solid-js"
import { config } from "./config"
import { log } from "./log"

// Default bindings mirror opencode's (packages/tui/src/config/keybind.ts).
export const DEFAULT_KEYBINDS                         = {
  leader: "ctrl+x",
  "app.exit": "ctrl+c,ctrl+d,<leader>q",
  "command.palette.show": "ctrl+p",
  "help.show": "none",
  "prompt.editor": "<leader>e",
  "theme.switch": "<leader>t",
  "session.sidebar.toggle": "<leader>b",
  "status.show": "<leader>s",
  "session.export": "<leader>x",
  "session.new": "<leader>n",
  "session.list": "<leader>l",
  "session.timeline": "<leader>g",
  "session.find": "<leader>f",
  "session.find.next": "f3",
  "session.find.previous": "shift+f3",
  "session.rename": "ctrl+r",
  "session.interrupt": "escape",
  "session.background": "ctrl+b",
  "session.compact": "<leader>c",
  "session.page.up": "pageup,ctrl+alt+b",
  "session.page.down": "pagedown,ctrl+alt+f",
  "session.line.up": "ctrl+alt+y",
  "session.line.down": "ctrl+alt+e",
  "session.half.page.up": "ctrl+alt+u",
  "session.half.page.down": "ctrl+alt+d",
  "session.first": "ctrl+g,home",
  "session.last": "ctrl+alt+g,end",
  "messages.copy": "<leader>y",
  "session.undo": "<leader>u",
  "session.redo": "<leader>r",
  "session.pause": "<leader>p",
  "session.toggle.thinking": "none",
  "session.toggle.details": "none",
  "model.list": "<leader>m",
  "model.cycle_recent": "f2",
  "model.cycle_recent_reverse": "shift+f2",
  "mcp.list": "none",
  "agent.list": "<leader>a",
  "agent.cycle": "shift+tab,tab",
  "agent.cycle.reverse": "none",
  "variant.cycle": "ctrl+t",
  "variant.list": "none",
  "permission.mode.list": "none",
  "prompt.clear": "ctrl+c",
  "prompt.paste": "ctrl+v",
  "prompt.history.previous": "up",
  "prompt.history.next": "down",
  "dialog.select.prev": "up,ctrl+p",
  "dialog.select.next": "down,ctrl+n",
  "dialog.select.page_up": "pageup",
  "dialog.select.page_down": "pagedown",
  "session.toggle.scrollbar": "none",
  "session.child.first": "<leader>down",
  "session.child.next": "right",
  "session.child.prev": "left",
  "session.parent": "up",
  "tasks.list": "<leader>k",
  "model.dialog.favorite": "ctrl+f",
  "model.dialog.forget": "ctrl+d",
  "model.cycle_favorite": "none",
  "model.cycle_favorite_reverse": "none",
  "tab.next": "<leader>right,ctrl+pagedown",
  "tab.prev": "<leader>left,ctrl+pageup",
  "tab.close": "<leader>w",
  "tab.goto.1": "<leader>1",
  "tab.goto.2": "<leader>2",
  "tab.goto.3": "<leader>3",
  "tab.goto.4": "<leader>4",
  "tab.goto.5": "<leader>5",
  "tab.goto.6": "<leader>6",
  "tab.goto.7": "<leader>7",
  "tab.goto.8": "<leader>8",
  "tab.goto.9": "<leader>9",
  "settings.show": "none",
  "plugins.list": "none",
  "terminal.suspend": "ctrl+z",
  "session.copy": "none",
  "prompt.stash": "none",
  "prompt.stash.pop": "none",
  "prompt.stash.list": "none",
  "prompt.skills": "none",
  "provider.connect": "none",
}

/** Defaults contributed by plugins; user config and built-in defaults win over them. */
const pluginDefaults = new Map                                ()

export function registerDefaultKeybinds(map                        ) {
  const key = Symbol()
  pluginDefaults.set(key, map)
  return () => {
    pluginDefaults.delete(key)
  }
}

function pluginDefault(id        ) {
  for (const map of pluginDefaults.values()) if (map[id]) return map[id]
  return undefined
}



export function parseBinding(value        )            {
  if (!value || value === "none") return []
  return value.split(",").map((item) => {
    let text = item.trim()
    let leader = false
    if (text.startsWith("<leader>")) {
      leader = true
      text = text.slice("<leader>".length)
    }
    const parts = text.split("+")
    const name = parts.pop() ?? ""
    return {
      name: name === "enter" ? "return" : name === "esc" ? "escape" : name,
      ctrl: parts.includes("ctrl"),
      shift: parts.includes("shift"),
      meta: parts.includes("alt") || parts.includes("meta") || parts.includes("option"),
      leader,
    }
  })
}

export function keybind(id        ) {
  return config.keybinds?.[id] ?? DEFAULT_KEYBINDS[id] ?? pluginDefault(id) ?? "none"
}

export function bindings(id        ) {
  return parseBinding(keybind(id))
}

export function matches(event          , binding         , leader         ) {
  if (binding.leader !== leader) return false
  const name = event.name === "enter" ? "return" : event.name
  if (name !== binding.name) return false
  if (!!event.ctrl !== binding.ctrl) return false
  if (!!(event.meta || event.option) !== binding.meta) return false
  if (binding.shift !== !!event.shift) {
    // Terminals report shift+tab as name "tab" with shift, and some as "backtab".
    return false
  }
  return true
}

export function matchesId(event          , id        , leader = false) {
  return bindings(id).some((binding) => matches(event, binding, leader))
}

/** Human readable shortcut, the way opencode prints it ("ctrl+x n"). */
export function shortcut(id        ) {
  const first = bindings(id)[0]
  if (!first) return ""
  const leaderKey = bindings("leader")[0]
  const fmt = (b         ) =>
    [b.ctrl ? "ctrl" : "", b.meta ? "alt" : "", b.shift ? "shift" : "", b.name === "return" ? "enter" : b.name === "escape" ? "esc" : b.name]
      .filter(Boolean)
      .join("+")
  return first.leader && leaderKey ? `${fmt(leaderKey)} ${fmt(first)}` : fmt(first)
}

// ---------------------------------------------------------------------------
// Commands & layered dispatch
// ---------------------------------------------------------------------------


























const layers          = []
const [leaderActive, setLeaderActive] = createSignal(false)
export { leaderActive }
let leaderTimer

/** Register a key layer outside a component (plugins); returns the disposer. */
export function addLayer(layer       ) {
  layers.push(layer)
  return () => {
    const index = layers.indexOf(layer)
    if (index >= 0) layers.splice(index, 1)
  }
}

export function useLayer(layer       ) {
  onCleanup(addLayer(layer))
}

export function allCommands() {
  const seen = new Set        ()
  const out            = []
  for (const layer of ordered()) {
    if (layer.modal) continue
    if (layer.enabled && !layer.enabled()) continue
    for (const command of layer.commands()) {
      if (seen.has(command.id)) continue
      seen.add(command.id)
      out.push(command)
    }
  }
  return out
}

export function runCommand(id        ) {
  const command = allCommands().find((item) => item.id === id && (!item.enabled || item.enabled()))
  if (!command) return false
  safeRun(command)
  return true
}

let commandErrorHandler
export function onCommandError(fn                                            ) {
  commandErrorHandler = fn
}

function safeRun(command         , event           ) {
  try {
    const result = command.run(event)
    if (result instanceof Promise) result.catch((error) => commandErrorHandler?.(command, error))
    return result
  } catch (error) {
    commandErrorHandler?.(command, error)
    return undefined
  }
}

function ordered() {
  return layers
    .map((layer, index) => ({ layer, index }))
    .sort((a, b) => (b.layer.priority ?? 0) - (a.layer.priority ?? 0) || b.index - a.index)
    .map((item) => item.layer)
}

function activeLayers() {
  const out          = []
  for (const layer of ordered()) {
    if (layer.enabled && !layer.enabled()) continue
    out.push(layer)
    if (layer.modal) break
  }
  return out
}

export function dispatchKey(event          ) {
  // Escape handling differs between terminals; keep a trace to diagnose double-fires.
  if (event.name === "escape")
    log("key escape", JSON.stringify({ seq: event.sequence, raw: (event       ).raw, type: (event       ).eventType, repeated: (event       ).repeated, source: (event       ).source }))
  const leader = leaderActive()
  if (leader) {
    clearTimeout(leaderTimer)
    setLeaderActive(false)
  }
  for (const layer of activeLayers()) {
    if (layer.handler && !leader) {
      const handled = layer.handler(event)
      if (handled) {
        event.preventDefault()
        return
      }
    }
    for (const command of layer.commands()) {
      if (command.keybind === false) continue
      if (command.enabled && !command.enabled()) continue
      const id = command.keybind ?? command.id
      if (!matchesId(event, id, leader)) continue
      const result = safeRun(command, event)
      if (result === false) continue
      event.preventDefault()
      return
    }
  }
  if (!leader && matchesId(event, "leader")) {
    event.preventDefault()
    setLeaderActive(true)
    leaderTimer = setTimeout(() => setLeaderActive(false), 2000)
  }
}
