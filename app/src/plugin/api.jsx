
import { TextAttributes } from "@opentui/core"
import { Show,          } from "solid-js"
import path from "node:path"
import { configDir, config } from "../context/config"
import { addLayer, keybind, registerDefaultKeybinds, runCommand, shortcut,              } from "../context/keymap"
import { isSubagentTool, limits, onSessionEvent,                             } from "../context/session"
import {
  active,
  app,
  closeTab,
  findTab,
  focusTab,
  newSession,
  openSession,
  refreshSessions,
  tabs,
  onTabEvent,
} from "../context/tabs"
import { installTheme, setTheme, theme, themeName, themes,                } from "../context/theme"
import { Prompt } from "../component/prompt"
import { dialog, DialogAlert, DialogConfirm, DialogPrompt, DialogSelect } from "../ui/dialog"
import { toast } from "../ui/toast"
import { kv, stateDir } from "./kv"
import { registerRoutes, showPluginRoute, pluginRoute } from "./routes"
import { registerSlots, Slot } from "./slots"

import { setRoute } from "../context/app"

const occVersion = "1.0.0"

function toCommand(command               )          {
  const enabled = command.enabled
  return {
    id: command.name,
    title: command.title,
    category: command.category ?? "Plugins",
    description: command.description,
    slash: command.slashName,
    slashAliases: command.slashAliases,
    palette: !command.hidden,
    enabled: enabled === undefined ? undefined : typeof enabled === "function" ? enabled : () => enabled,
    run: command.run,
  }
}

function sessionFor(id         )                      {
  if (!id) return active()
  return findTab(id)
}

function subagents(session                     )             {
  if (!session) return []
  const out             = []
  for (const message of session.store.messages) {
    if (message.type !== "assistant") continue
    for (const part of message.parts) if (part.type === "tool" && isSubagentTool(part.name)) out.push(part)
  }
  return out
}

function PluginDialog(props                                           ) {
  return (
    <box gap={1} paddingBottom={1} paddingLeft={4} paddingRight={4}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          {props.title}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.pop()}>
          esc
        </text>
      </box>
      <Show when={props.children}>{props.children}</Show>
    </box>
  )
}

export const client               = {
  session: {
    async list() {
      await refreshSessions()
      return app.sessions.map((item) => ({
        id: item.sessionId,
        title: item.customTitle ?? item.summary ?? item.firstPrompt ?? item.sessionId,
        updated: item.lastModified,
      }))
    },
    async open(id) {
      await openSession(id)
    },
    async create() {
      const session = await newSession()
      return session.key
    },
    close(tab) {
      const session = findTab(tab)
      if (session) closeTab(session)
    },
    select(tab) {
      const session = findTab(tab)
      if (session) focusTab(session)
    },
    prompt(tab, text) {
      findTab(tab)?.send(text)
    },
    async interrupt(tab) {
      await findTab(tab)?.interrupt()
    },
    messages(tab) {
      return findTab(tab)?.store.messages ?? []
    },
  },
  tabs: {
    list() {
      return tabs().map((tab) => ({ tab: tab.key, sessionID: tab.store.sessionID, title: tab.store.title, status: tab.store.status }))
    },
    active() {
      return active().key
    },
  },
}

/** Subscribe to Agent Code session events translated to opencode-style `{ type, properties }`. */
function onPluginEvent(handler                              ) {
  const offSession = onSessionEvent((event) => {
    const base = { sessionID: event.session.store.sessionID, tab: event.session.key }
    switch (event.type) {
      case "sent":
        return handler({ type: "message.sent", properties: { ...base, id: event.id } })
      case "status":
        return handler({ type: "session.status", properties: { ...base, status: { type: event.status === "running" ? "busy" : "idle" } } })
      case "idle":
        if (event.error) handler({ type: "session.error", properties: { ...base, error: event.error } })
        return
      case "attention":
        return handler({ type: event.kind === "question" ? "question.asked" : "permission.asked", properties: base })
      case "permission.replied":
        return handler({ type: "permission.replied", properties: { ...base, id: event.id, decision: event.decision } })
      case "question.replied":
        return handler({ type: "question.replied", properties: { ...base, id: event.id } })
      case "closed":
        return handler({ type: "session.closed", properties: base })
    }
  })
  const offTabs = onTabEvent((event) => {
    if (event.type === "focus") handler({ type: "tab.changed", properties: { tab: event.session.key, sessionID: event.session.store.sessionID } })
    else handler({ type: "session.created", properties: { tab: event.session.key, sessionID: event.session.store.sessionID ?? "" } })
  })
  return () => {
    offSession()
    offTabs()
  }
}








export function createApi(input




 )            {
  const { scope, meta } = input
  const track = (dispose            ) => {
    let done = false
    const off = scope.onDispose(() => {
      if (!done) dispose()
      done = true
    })
    return () => {
      if (done) return
      done = true
      off()
      dispose()
    }
  }
  const wrapCommand = (command               )                => ({ ...command, run: scope.guard(command.run) })

  return {
    app: {
      get version() {
        return occVersion
      },
      get claudeVersion() {
        return active().store.version
      },
    },
    attention: {
      notify(value) {
        if (value.sound !== false) process.stdout.write("\x07")
        toast.show({ title: value.title, message: value.message, variant: "info" })
      },
    },
    keys: { format: (id) => shortcut(id) },
    keymap: {
      registerLayer(layer) {
        const offDefaults = layer.bindings ? registerDefaultKeybinds(layer.bindings) : () => {}
        const offLayer = addLayer({
          commands: () => layer.commands.map(wrapCommand).map(toCommand),
          enabled: layer.enabled,
          priority: layer.priority,
          handler: layer.handler ? scope.guard(layer.handler) : undefined,
        })
        return track(() => {
          offLayer()
          offDefaults()
        })
      },
      dispatchCommand: (name) => runCommand(name),
    },
    command: {
      register(cb) {
        return track(addLayer({ commands: () => cb().map(wrapCommand).map(toCommand) }))
      },
      trigger: (name) => runCommand(name),
    },
    route: {
      register: (list) => track(registerRoutes(list)),
      navigate(name, params) {
        if (name === "home" || name === "session") {
          showPluginRoute(undefined)
          setRoute(name)
          return
        }
        showPluginRoute(name, params)
      },
      get current() {
        const plugin = pluginRoute()
        return plugin ?? { name: active().store.view }
      },
    },
    ui: {
      Dialog: (props) => <PluginDialog title={props.title}>{props.children}</PluginDialog>,
      DialogAlert: (props) => <DialogAlert title={props.title} message={props.message} />,
      DialogConfirm: (props) => <DialogConfirm {...props} />,
      DialogPrompt: (props) => <DialogPrompt title={props.title} value={props.value} placeholder={props.placeholder} onConfirm={props.onConfirm} />,
      DialogSelect: (props     ) => <DialogSelect {...props} />,
      Slot: (props     ) => <Slot {...props} />,
      Prompt: (props) => <Prompt home={props.home} />,
      toast: (value) => toast.show({ variant: value.variant ?? "info", title: value.title, message: value.message, duration: value.duration }),
      dialog: {
        replace: (render, onClose, size) => dialog.replace(render, onClose, size),
        push: (render, onClose) => dialog.push(render, onClose),
        pop: () => dialog.pop(),
        clear: () => dialog.clear(),
        get open() {
          return dialog.open
        },
        get depth() {
          return dialog.depth
        },
      },
    },
    tuiConfig: Object.freeze({
      get theme() {
        return config.theme
      },
      plugin: [...(config.plugin ?? [])],
      plugin_enabled: { ...(config.plugin_enabled ?? {}) },
      keybinds: { get: (id        ) => keybind(id) },
    }),
    kv,
    state: {
      get ready() {
        return active().store.ready
      },
      path: { config: configDir, state: stateDir, directory: app.cwd },
      get vcs() {
        return { branch: active().store.branch }
      },
      session: {
        count: () => tabs().length,
        get: (id) => sessionFor(id)?.store,
        messages: (id) => sessionFor(id)?.store.messages ?? [],
        todo: (id) => sessionFor(id)?.store.todos ?? [],
        diff: (id) =>
          Object.entries(sessionFor(id)?.store.files ?? {}).map(([file, diff]) => ({ file, additions: diff.additions, deletions: diff.deletions })),
        status: (id) => sessionFor(id)?.store.status,
        permission: (id) => sessionFor(id)?.store.permissions ?? [],
        question: (id) => sessionFor(id)?.store.questions ?? [],
        subagents: (id) => subagents(sessionFor(id)),
      },
      mcp: () => active().store.mcp,
      limits: () => ({ fiveHour: limits.fiveHour, week: limits.week }),
    },
    theme: {
      get current() {
        return theme
      },
      get selected() {
        return themeName()
      },
      has: (name) => !!themes[name],
      set(name) {
        if (!themes[name]) return false
        setTheme(name)
        return true
      },
      install: (name, json) => installTheme(name, json             ),
      mode: () => "dark",
      ready: true,
    },
    client,
    event: {
      on(type, handler) {
        const guarded = scope.guard(handler                                )
        return track(onPluginEvent((event) => event.type === type && guarded(event       )))
      },
    },
    renderer: input.renderer,
    slots: {
      register: (plugin) => track(registerSlots(plugin, meta.id)),
    },
    plugins: input.plugins,
    lifecycle: {
      signal: scope.signal,
      onDispose: scope.onDispose,
    },
  }
}

export function pluginRoot(spec        ) {
  return path.dirname(spec)
}
