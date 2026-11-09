# occ plugin API reference

The shape of the `api` object a plugin receives in `tui(api, options, meta)`, the slot names and their
props, as type declarations (documentation only — occ itself is plain JavaScript).

```ts
// occ plugin API — shaped after opencode's TuiPluginApi (packages/plugin/src/tui.ts) but backed by Claude Code.
//
// A plugin module exports `{ id?, tui(api, options, meta) }` (default export or named). JSX must be compiled
// for `@opentui/solid` with `solid-js` and `@opentui/*` kept external; occ maps those imports to its own copies
// so plugins share the renderer and Solid runtime. Local `.tsx`/`.ts` files are compiled on load.
import type { CliRenderer, KeyEvent, SlotMode } from "@opentui/core"
import type { JSX } from "solid-js"
import type { SessionStore, Message, PermissionRequest, QuestionRequest, Todo, ToolPart } from "../context/session"

export type SlotMap = {
  app: {}
  app_bottom: {}
  home_logo: {}
  home_prompt: {}
  home_prompt_right: {}
  home_bottom: {}
  home_footer: {}
  session_prompt: { session_id: string }
  session_prompt_right: { session_id: string }
  sidebar_title: { session_id: string; title: string }
  sidebar_content: { session_id: string }
  sidebar_footer: { session_id: string }
}

export type SlotContext = { theme: PluginApi["theme"] }

export type SlotPlugin = {
  id?: string
  order?: number
  slots: { [K in keyof SlotMap]?: (ctx: SlotContext, props: SlotMap[K]) => JSX.Element } & {
    [name: string]: ((ctx: SlotContext, props: any) => JSX.Element) | undefined
  }
}

export type PluginCommand = {
  name: string
  title: string
  category?: string
  description?: string
  /** Slash command name (without "/"). */
  slashName?: string
  slashAliases?: string[]
  hidden?: boolean
  enabled?: boolean | (() => boolean)
  run: (event?: KeyEvent) => void | boolean | Promise<unknown>
}

export type PluginToast = { title?: string; message: string; variant?: "info" | "success" | "warning" | "error"; duration?: number }

export type PluginDialogSelectOption<T = unknown> = {
  title: string
  value: T
  description?: string
  footer?: string
  category?: string
  disabled?: boolean
}

export type PluginRoute = { name: string; render: (input: { params?: Record<string, unknown> }) => JSX.Element }

export type PluginEvent =
  | { type: "session.created"; properties: { sessionID: string; tab: string } }
  | { type: "session.closed"; properties: { sessionID?: string; tab: string } }
  | { type: "session.status"; properties: { sessionID?: string; tab: string; status: { type: "busy" | "idle" } } }
  | { type: "session.error"; properties: { sessionID?: string; tab: string; error: string } }
  | { type: "message.sent"; properties: { sessionID?: string; tab: string; id: string } }
  | { type: "permission.asked"; properties: { sessionID?: string; tab: string } }
  | { type: "permission.replied"; properties: { sessionID?: string; tab: string; id: string; decision: string } }
  | { type: "question.asked"; properties: { sessionID?: string; tab: string } }
  | { type: "question.replied"; properties: { sessionID?: string; tab: string; id: string } }
  | { type: "tab.changed"; properties: { tab: string; sessionID?: string } }

export type PluginStatus = {
  id: string
  source: "internal" | "file" | "npm"
  spec: string
  enabled: boolean
  active: boolean
  error?: string
}

export type PluginMeta = { id: string; source: PluginStatus["source"]; spec: string; root?: string }

export type ClaudeClient = {
  session: {
    list(): Promise<{ id: string; title: string; updated: number }[]>
    /** Open (or focus) a stored session in a tab. */
    open(id: string): Promise<void>
    /** Open a new tab with a fresh conversation. */
    create(): Promise<string>
    close(tab: string): void
    select(tab: string): void
    prompt(tab: string, text: string): void
    interrupt(tab: string): Promise<void>
    messages(tab: string): Message[]
  }
  tabs: {
    list(): { tab: string; sessionID?: string; title?: string; status: "idle" | "running" }[]
    active(): string
  }
}

export type PluginApi = {
  app: { readonly version: string; readonly claudeVersion: string | undefined }
  attention: { notify(input: { title?: string; message: string; sound?: boolean }): void }
  keys: { format(id: string): string }
  keymap: {
    registerLayer(layer: {
      commands: PluginCommand[]
      bindings?: Record<string, string>
      enabled?: () => boolean
      priority?: number
      handler?: (event: KeyEvent) => boolean | void
    }): () => void
    dispatchCommand(name: string): boolean
  }
  /** Legacy opencode v1 command API. */
  command: {
    register(cb: () => PluginCommand[]): () => void
    trigger(name: string): boolean
  }
  route: {
    register(routes: PluginRoute[]): () => void
    navigate(name: string, params?: Record<string, unknown>): void
    readonly current: { name: string; params?: Record<string, unknown> }
  }
  ui: {
    Dialog: (props: { title: string; children?: JSX.Element; onClose?: () => void }) => JSX.Element
    DialogAlert: (props: { title: string; message: string }) => JSX.Element
    DialogConfirm: (props: { title: string; message: string; onConfirm: () => void; onCancel?: () => void }) => JSX.Element
    DialogPrompt: (props: { title: string; value?: string; placeholder?: string; description?: string; onConfirm: (value: string) => void }) => JSX.Element
    DialogSelect: <T>(props: {
      title: string
      options: PluginDialogSelectOption<T>[]
      current?: T
      placeholder?: string
      onSelect?: (option: PluginDialogSelectOption<T>) => void
      onMove?: (option: PluginDialogSelectOption<T>) => void
    }) => JSX.Element
    Slot: <Name extends keyof SlotMap | (string & {})>(props: { name: Name; mode?: SlotMode; children?: JSX.Element } & Record<string, unknown>) => JSX.Element
    Prompt: (props: { home?: boolean }) => JSX.Element
    toast: (input: PluginToast) => void
    dialog: {
      replace(render: () => JSX.Element, onClose?: () => void, size?: "medium" | "large" | "xlarge"): void
      push(render: () => JSX.Element, onClose?: () => void): void
      pop(): void
      clear(): void
      readonly open: boolean
      readonly depth: number
    }
  }
  tuiConfig: Readonly<{ theme?: string; plugin: unknown[]; plugin_enabled: Record<string, boolean>; keybinds: { get(id: string): string } }>
  kv: { get<T = unknown>(key: string, fallback?: T): T; set(key: string, value: unknown): void; readonly ready: boolean }
  state: {
    readonly ready: boolean
    readonly path: { config: string; state: string; directory: string }
    readonly vcs: { branch?: string }
    session: {
      count(): number
      /** Reactive session state for a tab key or Claude session id (the focused tab when omitted). */
      get(id?: string): Readonly<SessionStore> | undefined
      messages(id?: string): Message[]
      todo(id?: string): Todo[]
      diff(id?: string): { file: string; additions: number; deletions: number }[]
      status(id?: string): "idle" | "running" | undefined
      permission(id?: string): PermissionRequest[]
      question(id?: string): QuestionRequest[]
      subagents(id?: string): ToolPart[]
    }
    mcp(): SessionStore["mcp"]
    limits(): { fiveHour?: { utilization: number; resetsAt?: number }; week?: { utilization: number; resetsAt?: number } }
  }
  theme: {
    readonly current: Record<string, any>
    readonly selected: string
    has(name: string): boolean
    set(name: string): boolean
    install(name: string, json: { defs?: Record<string, unknown>; theme: Record<string, unknown> }): boolean
    mode(): "dark" | "light"
    readonly ready: boolean
  }
  client: ClaudeClient
  event: { on<T extends PluginEvent["type"]>(type: T, handler: (event: Extract<PluginEvent, { type: T }>) => void): () => void }
  renderer: CliRenderer
  slots: { register(plugin: SlotPlugin): () => void }
  plugins: {
    list(): ReadonlyArray<PluginStatus>
    activate(id: string): Promise<boolean>
    deactivate(id: string): Promise<boolean>
    add(spec: string): Promise<boolean>
    install(spec: string): Promise<{ ok: boolean; message?: string }>
  }
  lifecycle: { readonly signal: AbortSignal; onDispose(fn: () => void | Promise<void>): () => void }
}

export type Plugin = (api: PluginApi, options: Record<string, unknown> | undefined, meta: PluginMeta) => void | Promise<void>
export type PluginModule = { id?: string; tui: Plugin }
```
