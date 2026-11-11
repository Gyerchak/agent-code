
import { createSignal } from "solid-js"
import { config, saveConfig } from "./config"
import { active } from "./tabs"

// Route and prompt mode belong to the focused tab.
export const route = () => active().store.view
export const setRoute = (view                    ) => active().setStore("view", view)
export const promptMode = () => active().store.promptMode
export const setPromptMode = (mode                    ) => active().setStore("promptMode", mode)

/** Coarse clock for countdowns (usage reset timers). */
export const [clock, setClock] = createSignal(Date.now())
setInterval(() => setClock(Date.now()), 30_000).unref()

export const [sidebarOpen, setSidebarOpen] = createSignal                     (undefined)
export const [showThinking, setShowThinking] = createSignal(config.thinking !== "hide")
export const [showDetails, setShowDetails] = createSignal(config.showDetails !== false)
export const [showScrollbar, setShowScrollbar] = createSignal(config.scrollbar === true)

/** Whether the session sidebar is showing at this terminal width (auto: whenever wider than 120 columns, like opencode). */
export function sidebarShown(width        ) {
  const open = sidebarOpen()
  if (open !== undefined) return open
  return (config.sidebarMode ?? "auto") === "auto" && width > 120
}

/** Below this width the sidebar overlays the transcript instead of sitting beside it. */
export const SIDEBAR_DOCK_WIDTH = 100

export function toggleThinking() {
  const next = !showThinking()
  setShowThinking(next)
  config.thinking = next ? "show" : "hide"
  saveConfig()
}

export function toggleDetails() {
  const next = !showDetails()
  setShowDetails(next)
  config.showDetails = next
  saveConfig()
}

export function toggleScrollbar() {
  const next = !showScrollbar()
  setShowScrollbar(next)
  config.scrollbar = next
  saveConfig()
}

/** Transcript → app hooks (app.tsx fills them in; it owns the dialogs and the prompt). */
export const actions = {
  /** opencode's "Message Actions" for a user message: Revert / Copy / Fork. */
  message: (_id        ) => {},
  /** Choose how long to pause the focused tab. */
  pause: () => {},
  /** Ask, then restore what a revert hid (click on the "reverted" banner). */
  redo: () => {},
  /** Scroll the transcript to a message, drawing older history first if it isn't drawn (session.tsx). */
  reveal: (id        , _highlight = false) => void refs.scroll?.scrollChildIntoView(`msg-${id}`),
}

export const refs = {
  prompt: undefined                                  ,
  scroll: undefined                                   ,
}

/** Prompt draft of the focused tab (kept per tab so switching doesn't lose unsent text). */
export const draft = new Proxy({}                                      , {
  get: (_, key) => (active().draft       )[key],
  set: (_, key, value) => {
    ;(active().draft       )[key] = value
    return true
  },
})

export function focusPrompt() {
  const input = refs.prompt
  if (input && !input.isDestroyed) input.focus()
}

let exitHandler
export function setExitHandler(fn                         ) {
  exitHandler = fn
}
/** Quit Agent Code (`code` 75 inside an acode-box: the launcher starts it again). */
export function exit(code         ) {
  exitHandler?.(code)
}
