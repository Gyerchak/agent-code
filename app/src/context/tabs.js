import { listSessions, query,                                       } from "@anthropic-ai/claude-agent-sdk"
import { batch, createRoot, createSignal } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { randomUUID } from "node:crypto"
import { config, saveConfig } from "./config"
import { opencodeApi } from "./acp"
import { log } from "./log"
import { createSession, DEFAULT_MODEL, onSessionEvent, storedEffort, storeEffort,                                 } from "./session"

// ---------------------------------------------------------------------------
// Tab registry: every open tab owns a Session with its own Claude Code process.
// ---------------------------------------------------------------------------

export const [app, setApp] = createStore                                                                    ({
  cwd: process.cwd(),
  sessions: [],
})

const [tabs, setTabs] = createSignal           ([])
const [activeTab, setActiveTab] = createSignal         ()
export { tabs }

export function active()          {
  const session = activeTab()
  if (session) return session
  // Only reachable before initTabs() ran; never create sessions inside reactive computations.
  if (!initial) initTabs()
  return initial
}

let initial
/** Create the first tab. Must run before rendering (signal writes inside computations are deferred). */
export function initTabs() {
  if (initial) return initial
  initial = makeSession()
  setTabs([initial])
  setActiveTab(initial)
  return initial
}

/** Reactive view of the focused tab's state; reading it inside JSX tracks tab switches too. */
export const store = new Proxy({}                , {
  get(_, key        ) {
    if (key === "sessions") return app.sessions
    return (active().store       )[key]
  },
})

function lastReady() {
  return tabs().findLast((tab) => tab.store.ready) ?? activeTab()
}

function makeSession(from          ) {
  return createSession({
    cwd: app.cwd,
    model: app.defaultModel ?? config.model,
    effort: storedEffort(app.defaultModel ?? config.model ?? DEFAULT_MODEL),
    from: from ?? lastReady(),
  })
}

function isPristine(session         ) {
  return !session.disposed && !session.store.messages.length && session.store.status === "idle" && !session.store.dormant
}

const tabListeners = new Set                                                               ()
export function onTabEvent(fn                                                               ) {
  tabListeners.add(fn)
  return () => tabListeners.delete(fn)
}
function emitTab(type                  , session         ) {
  for (const fn of tabListeners) {
    try {
      fn({ type, session })
    } catch (error) {
      log("tab listener error", error)
    }
  }
}

export function focusTab(session         ) {
  if (session.disposed) return
  const changed = activeTab() !== session
  batch(() => {
    setActiveTab(session)
    if (session.store.unseen) session.setStore("unseen", undefined)
  })
  if (session.store.dormant) void session.ensureStarted()
  persistTabs()
  if (changed) emitTab("focus", session)
}

export function addTab(session         , focus = true) {
  setTabs((list) => [...list, session])
  emitTab("open", session)
  if (focus) focusTab(session)
  return session
}

/** New conversation: reuse the focused tab if it's untouched, otherwise open a new tab. */
export async function newSession() {
  const current = activeTab()
  if (current && isPristine(current) && current.live) {
    current.setStore("view", "home")
    return current
  }
  const session = addTab(makeSession())
  await session.start({ sessionId: randomUUID() })
  return session
}

/** Open a stored session: focus its tab if open, otherwise load it (into the untouched tab or a new one). */
export async function openSession(id        , title         ) {
  const existing = findTab(id)
  if (existing) {
    focusTab(existing)
    existing.setStore("view", "session")
    return existing
  }
  const current = activeTab()
  const session = current && isPristine(current) ? current : addTab(makeSession())
  if (session === current) focusTab(session)
  await session.load(id, title)
  persistTabs()
  return session
}

export async function continueLast() {
  await refreshSessions()
  const last = app.sessions[0]
  if (last) return openSession(last.sessionId, last.customTitle ?? last.summary)
  return startFresh()
}

export async function startFresh() {
  const session = active()
  if (!session.live && !session.store.booting) await session.start({ sessionId: randomUUID() })
  return session
}

/**
 * Fork the focused conversation into a new tab; the original keeps running.
 * With `messageID` (opencode's message "Fork"), the fork ends just before that prompt.
 */
export async function forkSession(messageID         ) {
  const source = active()
  const id = source.store.sessionID
  if (!id) return undefined
  // Harnesses other than opencode have no fork in their protocol.
  if (source.store.engine && source.store.engine !== "opencode") return undefined
  if (source.store.engine === "opencode") {
    const forked = await opencodeApi(source.store.cwd, "POST", `/api/session/${id}/fork`, messageID?.startsWith("msg_") ? { before: messageID } : {})
    if (!forked?.id) return undefined
    const session = addTab(makeSession(source))
    batch(() => {
      session.setStore("model", source.store.model)
      session.setStore("mode", source.store.mode)
    })
    await session.load(forked.id, source.store.title ? `${source.store.title} (fork)` : undefined)
    persistTabs()
    return session
  }
  const index = messageID ? source.store.messages.findIndex((m) => m.id === messageID) : -1
  const messages = index >= 0 ? source.store.messages.slice(0, index) : source.store.messages
  const before = index >= 0 ? messages.findLast((m) => m.type === "assistant" && !!m.sdkUuid) : undefined
  const session = addTab(makeSession(source))
  batch(() => {
    session.setStore("messages", JSON.parse(JSON.stringify(messages)))
    session.setStore("title", source.store.title ? `${source.store.title} (fork)` : undefined)
    session.setStore("view", "session")
    session.setStore("model", source.store.model)
    session.setStore("effort", source.store.effort)
    session.setStore("mode", source.store.mode)
  })
  // The fork keeps the original's per-session settings (agent mix).
  const forkId = randomUUID()
  if (config.sessionAgentMix?.[id]) {
    config.sessionAgentMix = { ...config.sessionAgentMix, [forkId]: structuredClone(config.sessionAgentMix[id]) }
    saveConfig()
  }
  // Forking before the first prompt leaves nothing to resume: a fresh conversation.
  if (index >= 0 && !before) await session.start({ sessionId: forkId })
  else await session.start({ resume: id, resumeAt: before?.type === "assistant" ? before.sdkUuid : undefined, fork: true, sessionId: forkId })
  return session
}

export function findTab(sessionID        ) {
  return tabs().find((tab) => tab.store.sessionID === sessionID || tab.key === sessionID)
}

export function nextTab(direction        ) {
  const list = tabs()
  if (list.length < 2) return
  const index = list.indexOf(active())
  focusTab(list[(index + direction + list.length) % list.length])
}

export function gotoTab(index        ) {
  const tab = tabs()[index]
  if (tab) focusTab(tab)
}

export function closeTab(session = active()) {
  const list = tabs()
  const index = list.indexOf(session)
  if (index < 0) return
  session.dispose()
  const rest = list.filter((tab) => tab !== session)
  if (!rest.length) {
    const fresh = makeSession(session)
    batch(() => {
      setTabs([fresh])
      setActiveTab(fresh)
    })
    void fresh.start({ sessionId: randomUUID() })
  } else {
    batch(() => {
      setTabs(rest)
      if (activeTab() === session) setActiveTab(rest[Math.min(index, rest.length - 1)])
    })
    const next = activeTab()
    if (next?.store.dormant) void next.ensureStarted()
  }
  persistTabs()
}

export function moveTab(session         , direction        ) {
  const list = [...tabs()]
  const index = list.indexOf(session)
  const target = index + direction
  if (index < 0 || target < 0 || target >= list.length) return
  ;[list[index], list[target]] = [list[target], list[index]]
  setTabs(list)
  persistTabs()
}

/** Put a tab at `index` (dragging a tab along the strip). */
export function moveTabTo(session, index) {
  const list = [...tabs()]
  const from = list.indexOf(session)
  if (from < 0 || index < 0 || index >= list.length || from === index) return
  list.splice(from, 1)
  list.splice(index, 0, session)
  setTabs(list)
  persistTabs()
}

export async function refreshSessions() {
  try {
    const list = await listSessions({ dir: app.cwd })
    setApp("sessions", reconcile(list.sort((a, b) => b.lastModified - a.lastModified)))
  } catch (error) {
    log("listSessions error", error)
  }
}

export function disposeAll() {
  for (const tab of tabs()) tab.stop()
}

// ---------------------------------------------------------------------------
// Persistence: open tabs per directory come back on the next plain `agentcode`.
// ---------------------------------------------------------------------------

let persistTimer
export function persistTabs() {
  clearTimeout(persistTimer)
  persistTimer = setTimeout(writeTabs, 200)
}

/** Write the open tabs now (on exit, a pending debounced write would be lost). */
export function flushTabs() {
  if (!persistTimer) return
  clearTimeout(persistTimer)
  writeTabs()
}

function writeTabs() {
  persistTimer = undefined
  {
    const open = tabs()
      // A dormant tab of another harness has no transcript until it is opened: it is still a saved tab.
      .filter((tab) => tab.store.sessionID && (tab.store.dormant || tab.store.messages.some((m) => m.type === "user")))
      .map((tab) => tab.store.sessionID )
    const focused = activeTab()?.store.sessionID
    config.tabs = { ...(config.tabs ?? {}), [app.cwd]: { open, active: focused && open.includes(focused) ? focused : undefined } }
    if (!open.length) delete config.tabs[app.cwd]
    saveConfig()
  }
}

/**
 * Restore saved tabs as dormant (history only); only the focused one boots.
 * With `keepActive`, the current tab stays focused (e.g. `agentcode -c`) and the saved ones come back beside it.
 * Returns false when nothing was saved.
 */
export async function restoreTabs(options                                           = {}) {
  const saved = config.tabs?.[app.cwd]
  if (!saved?.open.length) return false
  const initial = activeTab()
  const skip = options.keepActive ? initial?.store.sessionID : undefined
  await refreshSessions()
  // All saved tabs load at once (each only reads its transcript); the order stays the saved one.
  const loaded = await Promise.all(
    saved.open.map(async (id) => {
      if (id === skip) return initial
      const session = makeSession()
      const info = app.sessions.find((item) => item.sessionId === id)
      const ok = await session.load(id, info?.customTitle ?? info?.summary, false).catch((error) => {
        log("restore error", id, error)
        return false
      })
      if (ok) return session
      session.dispose()
      return undefined
    }),
  )
  const restored            = loaded.filter(Boolean)
  if (!restored.length) return false
  if (options.keepActive && initial) {
    batch(() => setTabs(restored.includes(initial) ? restored : [...restored, initial]))
    persistTabs()
    return true
  }
  const keepInitial = initial && !isPristine(initial)
  batch(() => {
    setTabs(keepInitial ? [...restored, initial ] : restored)
  })
  if (initial && !keepInitial) initial.dispose()
  const target =
    (options.focus && restored.find((tab) => tab.store.sessionID === options.focus)) ||
    restored.find((tab) => tab.store.sessionID === saved.active) ||
    restored.at(-1)
  focusTab(target)
  return true
}

// Mark background tabs that finish or need attention.
createRoot(() => {
  onSessionEvent((event) => {
    if (event.session === activeTab()) return
    if (event.type === "attention") event.session.setStore("unseen", "attention")
    else if (event.type === "idle" && event.session.store.unseen !== "attention") event.session.setStore("unseen", "done")
  })
  onSessionEvent((event) => {
    if (event.type === "sent" || event.type === "idle") persistTabs()
  })
})

// ---------------------------------------------------------------------------
// Auto model: let Haiku pick the model + effort for a new conversation.
// ---------------------------------------------------------------------------

const ROUTER_PROMPT = `You route coding-assistant requests to a Claude model. Reply with JSON only: {"model":"opus"|"sonnet"|"haiku","effort":"low"|"medium"|"high"|"xhigh"|"max","reason":"<6 words>"}.
- haiku: trivial questions, small lookups, formatting, quick one-file edits.
- sonnet: everyday coding, moderate features, debugging with a clear cause.
- opus: architecture, large refactors, hard debugging, ambiguous multi-step work, security or correctness-critical tasks.
Effort scales with how much reasoning the task needs.`

export async function pickModel(prompt        )                                                                                {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 20_000)
  try {
    const q = query({
      prompt: `${ROUTER_PROMPT}\n\nRequest:\n${prompt.slice(0, 4000)}`,
      options: {
        cwd: app.cwd,
        model: "haiku",
        effort: "medium",
        maxTurns: 1,
        tools: [],
        settingSources: [],
        persistSession: false,
        abortController: abort,
        systemPrompt: "You are a request router. Output only the JSON object.",
        env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "agent-code" },
      }       ,
    })
    let text = ""
    for await (const message of q) {
      if (message.type === "result" && message.subtype === "success") text = message.result
    }
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) return undefined
    const parsed = JSON.parse(match[0])
    if (!["opus", "sonnet", "haiku"].includes(parsed.model)) return undefined
    const effort = ["low", "medium", "high", "xhigh", "max"].includes(parsed.effort) ? (parsed.effort               ) : undefined
    return { model: parsed.model, effort, reason: typeof parsed.reason === "string" ? parsed.reason : undefined }
  } catch (error) {
    log("auto model error", error)
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Thin wrappers over the focused tab (resolved at call time).
// ---------------------------------------------------------------------------

export const send                  = (...args) => active().send(...args)
export const interrupt                       = () => active().interrupt()
export const appendContext                           = (...args) => active().appendContext(...args)
export const backgroundTasks                             = () => active().backgroundTasks()
export const setFast                     = (...args) => active().setFast(...args)
export const setMode                     = (...args) => active().setMode(...args)
export const cycleAgent                        = (...args) => active().cycleAgent(...args)
export const currentAgent                          = () => active().currentAgent()
export const currentModel                          = () => active().currentModel()
export const modelLabel                        = (...args) => active().modelLabel(...args)
export const refreshMcp                        = () => active().refreshMcp()
export const toggleMcp                       = (...args) => active().toggleMcp(...args)
export const reconnectMcp                          = (...args) => active().reconnectMcp(...args)
export const undo                  = () => active().undo()
export const redo                  = () => active().redo()
export const revert                    = (...args) => active().revert(...args)
export const unrevert                      = () => active().unrevert()
export const replyPermission                             = (...args) => active().replyPermission(...args)
export const replyQuestion                           = (...args) => active().replyQuestion(...args)
export const replyElicitation                              = (...args) => active().replyElicitation(...args)
export const relative                      = (file) => active().relative(file)

/** Model choice is per tab, and the last choice becomes the default for new tabs. */
export async function setModel(value        ) {
  config.model = value
  config.recentModels = [value, ...(config.recentModels ?? []).filter((item) => item !== value)].slice(0, 10)
  saveConfig()
  await active().setModel(value)
}

/** The reasoning level is remembered per model (and comes back when that model is picked again). */
export async function setEffort(value                         ) {
  config.effort = value
  storeEffort(active().store.model, value)
  await active().setEffort(value)
}


