import { RGBA, TextAttributes } from "@opentui/core"
import { isWindows } from "../context/platform"
import os from "node:os"
import { providerKind, providerName, providers, splitModel } from "../context/providers"
import { modelVariants } from "../context/variants"
import { catalog, modelMeta } from "../context/catalog"
import { local, pollLocal } from "../context/local"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, For, Match, on, onCleanup, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { config, saveConfig } from "../context/config"
import { clock, draft, exit, focusPrompt, SIDEBAR_DOCK_WIDTH, sidebarShown, promptMode, refs, setPromptMode, setRoute, showDetails } from "../context/app"
import { allCommands, leaderActive, matchesId, runCommand, shortcut, useLayer } from "../context/keymap"
import { agentIndex, limits, stripAnsi } from "../context/session"
import { active, currentAgent, interrupt, modelLabel, pickModel, store } from "../context/tabs"
import { agentColor, syntax, theme, tint } from "../context/theme"
import { listFiles, rankFiles } from "../context/files"
import { clipboardProblem, readClipboard } from "../context/clipboard"
import { harnessById } from "../context/harnesses"
import { attachmentToken, clipboardImage, pastedPaths, readAttachment } from "../context/attachments"
import { AttachmentChip } from "./attachment"
import { EmptyBorder, SplitBorder } from "../ui/border"
import { dialog } from "../ui/dialog"
import { toast } from "../ui/toast"
import { Scanner } from "./spinner"

const placeholders = {
  normal: ["Fix a TODO in the codebase", "What is the tech stack of this project?", "Fix broken tests"],
  shell: ["ls -la", "git status", "pwd"],
}



const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

/** The engine the focused tab runs on: Claude Code or another harness (opencode, DeepSeek Harness, Codex). */
const engineName = () => (store.engine ? (harnessById(store.engine)?.name ?? store.engine) : "Claude Code")

export function Prompt(props                                         ) {
  // The tab this prompt belongs to (the prompt remounts when the focused tab changes).
  const session = active()
  let input
  let anchor
  const dimensions = useTerminalDimensions()
  const [store_, setStore] = createStore({
    placeholder: Math.floor(Math.random() * 3),
    interrupt: 0,
    historyIndex: -1,
    text: draft.text,
    routing: false,
    /** Unsent text saved while browsing prompt history (restored when coming back down). */
    saved: "",
    /** Placeholders of the attachments in the draft (draft.attachments holds the files). */
    attached: [...draft.attachments.keys()]            ,
    /** Placeholders of collapsed pastes in the draft (draft.pastes holds their text). */
    pasted: [...draft.pastes.keys()]            ,
  })
  const [auto, setAuto] = createStore({
    visible: false                     ,
    query: "",
    start: 0,
    selected: 0,
    options: []            ,
  })

  const running = createMemo(() => store.status === "running")
  const muted = () => leaderActive()
  const agent = createMemo(() => currentAgent())
  const color = createMemo(() => agentColor(agentIndex(agent().id)))
  const highlight = createMemo(() => {
    if (muted()) return theme.border
    if (promptMode() === "shell") return theme.primary
    return color()
  })
  const borderColor = createMemo(() => tint(theme.border, highlight(), 1))
  const promptBg = createMemo(() => theme.backgroundElement)

  const autoLabel = createMemo(() => {
    switch (store.mode) {
      case "acceptEdits":
        return "auto"
      case "auto":
        return "auto mode"
      case "bypassPermissions":
        return "bypass"
      case "dontAsk":
        return "don't ask"
      default:
        return undefined
    }
  })

  const placeholderText = createMemo(() => {
    if (promptMode() === "shell") return `Run a command… "${placeholders.shell[store_.placeholder % 3]}"`
    if (store.suggestion && !props.home) return `${store.suggestion}  (→ to accept)`
    return `Ask anything… "${placeholders.normal[store_.placeholder % 3]}"`
  })

  const history = () => config.promptHistory ?? []

  function setText(text        ) {
    if (!input || input.isDestroyed) return
    input.setText(text)
    input.gotoBufferEnd()
    setStore("text", text)
    draft.text = text
  }

  function expandPastes(text        ) {
    const used           = []
    let out = text
    for (const [token, content] of draft.pastes) {
      if (!out.includes(token)) continue
      out = out.replace(token, content)
      used.push(content)
    }
    return { text: out, pastes: used }
  }

  async function runShell(command        ) {
    const id = randomUUID()
    // Output keeps streaming into this tab even if the user switches away.
    const setSession = session.setStore
    setSession("messages", (list) => [...list, { type: "shell", id, command, output: "", exitCode: null, running: true }])
    setSession("view", "session")
    // Shell mode runs the user's shell (cmd.exe's /c on Windows).
    const [shell, flag] = isWindows ? [process.env.ComSpec || "cmd.exe", "/c"] : [process.env.SHELL || "bash", "-c"]
    const child = spawn(shell, [flag, command], { cwd: session.store.cwd, env: process.env, windowsHide: true })
    let output = ""
    const append = (chunk        ) => {
      output += chunk.toString()
      const clipped = output.length > 200_000 ? output.slice(-200_000) : output
      setSession("messages", (m) => m.id === id, "output"       , stripAnsi(clipped))
    }
    child.stdout.on("data", append)
    child.stderr.on("data", append)
    child.on("close", (code) => {
      setSession("messages", (m) => m.id === id, "running"       , false)
      setSession("messages", (m) => m.id === id, "exitCode"       , code)
      session.appendContext(
        `<bash-input>${command}</bash-input>\n<bash-stdout>${stripAnsi(output).slice(-30_000)}</bash-stdout><bash-stderr></bash-stderr>`,
      )
    })
  }

  function submit() {
    const raw = input.plainText
    const trimmed = raw.trim()
    if (!trimmed) return
    if (promptMode() === "shell") {
      void runShell(trimmed)
      setPromptMode("normal")
      setText("")
      return
    }
    // Like opencode: up to 200 prompts; past the newest 100 only those without attachments or pastes.
    const placeholder = /\[(Image|PDF|File|Folder|Pasted) [^\]]*\]/
    config.promptHistory = [raw, ...history().filter((item) => item !== raw)]
      .filter((item, index) => index < 100 || !placeholder.test(item))
      .slice(0, 200)
    saveConfig()
    setStore("historyIndex", -1)
    // Local TUI commands take precedence, everything else goes to Claude Code.
    if (trimmed.startsWith("/")) {
      const [name, ...rest] = trimmed.slice(1).split(/\s+/)
      const command = allCommands().find(
        (item) => (item.slash === name || item.slashAliases?.includes(name)) && (!item.enabled || item.enabled()),
      )
      // An occ command that has nothing to act on right now (/undo with no prompt, /timeline with no messages…)
      // must not go to the model as text.
      const idle = command
        ? undefined
        : allCommands().find((item) => (item.slash === name || item.slashAliases?.includes(name)) && !store.commands.some((own) => own.name === name))
      if (idle) {
        setText("")
        toast.show({ variant: "info", message: `/${name}: nothing to do here yet`, duration: 2500 })
        return
      }
      if (command) {
        setText("")
        clearPastes()
        if (command.runArgs) command.runArgs(rest.join(" "))
        else void command.run()
        return
      }
    }
    if (!store.ready) {
      toast.show({ variant: "warning", message: store.fatal ?? `${engineName()} is still starting…` })
      return
    }
    const expanded = expandPastes(raw)
    const attachments = [...draft.attachments.entries()].filter(([token]) => raw.includes(token)).map(([token, item]) => ({ ...item, token }))
    setText("")
    clearPastes()
    clearAttachments()
    setRoute("session")
    const first = !session.store.messages.some((m) => m.type === "user")
    if (config.autoModel && first && !expanded.text.startsWith("/")) {
      // Auto model: Haiku judges the task first, then the prompt goes to the chosen model.
      setStore("routing", true)
      void pickModel(expanded.text).then(async (choice) => {
        setStore("routing", false)
        if (choice) {
          await session.setModel(choice.model)
          if (choice.effort && session.currentModel()?.supportedEffortLevels?.includes(choice.effort)) await session.setEffort(choice.effort)
          toast.show({
            variant: "info",
            message: `Auto: ${session.modelLabel()}${choice.effort ? ` · ${choice.effort}` : ""}${choice.reason ? ` — ${choice.reason}` : ""}`,
            duration: 3000,
          })
        }
        session.send(expanded.text, { pastes: expanded.pastes, attachments })
      })
      return
    }
    session.send(expanded.text, { pastes: expanded.pastes, attachments })
  }

  function clearPastes() {
    draft.pastes.clear()
    setStore("pasted", [])
  }

  function clearAttachments() {
    draft.attachments.clear()
    setStore("attached", [])
  }

  /** Add a file to the draft as a placeholder at the cursor, numbered per kind like opencode's [Image 1]. */
  function attach(item            ) {
    const same = [...draft.attachments.values()].filter((other) => other.kind === item.kind).length
    let token = attachmentToken(item, same + 1)
    for (let n = 2; draft.attachments.has(token); n++) token = attachmentToken(item, same + n)
    draft.attachments.set(token, item)
    setStore("attached", [...draft.attachments.keys()])
    if (!input.isDestroyed) input.insertText(token + " ")
  }

  function detach(token        ) {
    draft.attachments.delete(token)
    setStore("attached", [...draft.attachments.keys()])
    if (input.isDestroyed) return
    setText(input.plainText.replace(token + " ", "").replace(token, ""))
  }

  /** Dropped files arrive as a paste of their paths: attach them (when the setting is on). */
  async function pasteFiles(text        ) {
    if (config.dropFiles === false) return false
    const paths = pastedPaths(text, store.cwd)
    if (!paths) return false
    for (const file of paths) {
      try {
        attach(await readAttachment(file))
      } catch (error) {
        toast.show({ variant: "warning", message: `Could not attach ${file}: ${String(error)}` })
      }
    }
    return true
  }

  /** Put a collapsed paste's full text back in place of its placeholder. */
  function expandPaste(token        ) {
    const content = draft.pastes.get(token)
    if (content === undefined || input.isDestroyed) return
    const text = input.plainText
    const at = text.indexOf(token)
    if (at < 0) return
    draft.pastes.delete(token)
    setStore("pasted", [...draft.pastes.keys()])
    input.setText(text.slice(0, at) + content + text.slice(at + token.length))
    input.cursorOffset = at + content.length
    setStore("text", input.plainText)
    draft.text = input.plainText
  }

  /** A click inside a paste placeholder expands it (the cursor lands where the click was). */
  function expandAtCursor() {
    if (input.isDestroyed) return
    const text = input.plainText
    const cursor = input.cursorOffset
    for (const token of draft.pastes.keys()) {
      for (let at = text.indexOf(token); at >= 0; at = text.indexOf(token, at + 1)) {
        if (cursor >= at && cursor < at + token.length) {
          expandPaste(token)
          return
        }
      }
    }
  }

  /**
   * Like opencode: each paste placeholder is one highlighted unit (an extmark with the "extmark.paste" style),
   * deleted as a whole. Re-applied after any change, so restored or edited prompts keep it.
   */
  function markPastes() {
    if (input.isDestroyed) return
    const extmarks = (input       ).extmarks
    if (!extmarks) return
    extmarks.clear()
    if (!draft.pastes.size) return
    const styleId = syntax().getStyleId("extmark.paste")
    const text = input.plainText
    for (const token of draft.pastes.keys())
      for (let at = text.indexOf(token); at >= 0; at = text.indexOf(token, at + token.length))
        extmarks.create({ start: at, end: at + token.length, virtual: true, styleId })
  }

  function insertPaste(text        ) {
    const lines = text.split("\n").length
    if (lines < 3 && text.length < 800) {
      input.insertText(text)
      return
    }
    const token = `[Pasted ~${lines} lines]`
    let unique = token
    let n = 2
    while (draft.pastes.has(unique)) unique = token.replace("]", ` #${n++}]`)
    draft.pastes.set(unique, text)
    setStore("pasted", [...draft.pastes.keys()])
    // A space after it, like opencode, so typing continues outside the highlighted unit.
    input.insertText(unique + " ")
    markPastes()
  }

  function pasteClipboard() {
    const content = readClipboard()
    if (!content) {
      const problem = clipboardProblem()
      if (problem) toast.show({ variant: "warning", message: problem, duration: 6000 })
      return false
    }
    if (content.mime.startsWith("image/")) {
      const index = [...draft.attachments.values()].filter((item) => item.kind === "image").length + 1
      void clipboardImage(content.mime, content.data, index).then(attach)
      return true
    }
    const text = content.data.replace(/\r\n/g, "\n")
    // A file copied in a file manager arrives as its path or file:// URI.
    void pasteFiles(text).then((done) => {
      if (!done && !input.isDestroyed) insertPaste(text)
    })
    return true
  }

  // ---------------------------------------------------------------------------
  // Autocomplete
  // ---------------------------------------------------------------------------

  async function updateAutocomplete() {
    if (!input || input.isDestroyed) return
    const text = input.plainText
    const cursor = input.cursorOffset
    const before = text.slice(0, cursor)
    if (promptMode() === "normal" && /^\/[^\s]*$/.test(before)) {
      const query = before.slice(1).toLowerCase()
      const local = allCommands().filter((command) => command.slash && (!command.enabled || command.enabled()))
      const localNames = new Set(local.flatMap((command) => [command.slash , ...(command.slashAliases ?? [])]))
      const options           = [
        ...local.map((command) => ({
          display: "/" + command.slash,
          value: command.slash ,
          description: command.description ?? command.title,
          kind: "command"         ,
        })),
        ...store.commands
          .filter((command) => !localNames.has(command.name))
          .map((command) => ({
            display: "/" + command.name + (command.argumentHint ? ` ${command.argumentHint}` : ""),
            value: command.name,
            description: command.description,
            kind: "command"         ,
          })),
      ]
      const filtered = options
        .filter((option) => option.value.toLowerCase().includes(query))
        .sort((a, b) => {
          const as = a.value.toLowerCase().startsWith(query) ? 0 : 1
          const bs = b.value.toLowerCase().startsWith(query) ? 0 : 1
          return as - bs || a.value.localeCompare(b.value)
        })
      setAuto({ visible: "/", query, start: 0, selected: 0, options: filtered })
      return
    }
    const mention = before.match(/(?:^|\s)@([^\s]*)$/)
    if (mention) {
      const query = mention[1]
      const start = cursor - query.length - 1
      const files = await listFiles(store.cwd)
      if (input.isDestroyed || input.plainText.slice(0, input.cursorOffset) !== before) return
      const agents = store.agents
        .filter((item) => item.name.toLowerCase().includes(query.toLowerCase()))
        .map((item) => ({ display: "@" + item.name, value: `@agent-${item.name}`, description: "agent", kind: "agent"          }))
      const options           = [
        ...rankFiles(files, query, 10).map((file) => ({ display: "@" + file, value: "@" + file, kind: "file"          })),
        ...agents.slice(0, 3),
      ]
      setAuto({ visible: "@", query, start, selected: 0, options })
      return
    }
    if (auto.visible) setAuto("visible", false)
  }

  function acceptAutocomplete(submitAfter         ) {
    const option = auto.options[auto.selected]
    if (!option) {
      setAuto("visible", false)
      return
    }
    if (auto.visible === "/") {
      const local = allCommands().find((command) => command.slash === option.value)
      if (local && submitAfter) {
        setText("")
        setAuto("visible", false)
        void local.run()
        return
      }
      setText(`/${option.value} `)
      setAuto("visible", false)
      if (submitAfter && !store.commands.find((command) => command.name === option.value)?.argumentHint) submit()
      return
    }
    const text = input.plainText
    const end = input.cursorOffset
    const next = text.slice(0, auto.start) + option.value + " " + text.slice(end)
    input.setText(next)
    input.cursorOffset = auto.start + option.value.length + 1
    setAuto("visible", false)
  }

  // ---------------------------------------------------------------------------
  // Keys
  // ---------------------------------------------------------------------------

  useLayer({
    enabled: () => !dialog.open && !!input && input.focused && !store.permissions.length && !store.questions.length,
    commands: () => [
      {
        id: "prompt.clear",
        title: "Clear prompt",
        category: "Prompt",
        palette: false,
        run: () => {
          if (!input.plainText) return false
          setText("")
          clearPastes()
          clearAttachments()
          setPromptMode("normal")
        },
      },
      {
        id: "session.interrupt",
        title: "Interrupt session",
        category: "Session",
        palette: false,
        enabled: () => running() || promptMode() === "shell",
        run: () => {
          // Same rules as opencode's session.interrupt: two presses within 5s.
          if (auto.visible) return
          if (!input.focused) return
          if (promptMode() === "shell") {
            setPromptMode("normal")
            return
          }
          setStore("interrupt", store_.interrupt + 1)
          setTimeout(() => setStore("interrupt", 0), 5000)
          if (store_.interrupt >= 2) {
            void session.interrupt()
            setStore("interrupt", 0)
          }
          dialog.clear()
        },
      },
    ],
    handler: (event          ) => {
      if (auto.visible) {
        if (event.name === "up" || (event.ctrl && event.name === "p")) {
          setAuto("selected", (auto.selected - 1 + auto.options.length) % Math.max(1, auto.options.length))
          return true
        }
        if (event.name === "down" || (event.ctrl && event.name === "n")) {
          setAuto("selected", (auto.selected + 1) % Math.max(1, auto.options.length))
          return true
        }
        if (event.name === "tab") {
          acceptAutocomplete(false)
          return true
        }
        if (event.name === "return" && !event.shift) {
          acceptAutocomplete(true)
          return true
        }
        if (event.name === "escape") {
          setAuto("visible", false)
          return true
        }
      }
      if (promptMode() === "normal" && event.sequence === "!" && input.plainText === "" && !event.ctrl) {
        setPromptMode("shell")
        return true
      }
      if (promptMode() === "shell" && event.name === "backspace" && input.plainText === "") {
        setPromptMode("normal")
        return true
      }
      if (event.name === "right" && !input.plainText && store.suggestion && !props.home) {
        setText(store.suggestion)
        return true
      }
      // Up/down browse prompt history only from the very end of the prompt; anywhere else they move inside the text.
      const previous = matchesId(event, "prompt.history.previous")
      if (input.focused && (previous || matchesId(event, "prompt.history.next"))) {
        const cursor = input.logicalCursor
        const lastRow = cursor.row === input.lineCount - 1
        const atEnd = lastRow && cursor.col === input.editBuffer.getEOL().col
        if (previous) {
          if (atEnd && history().length) {
            if (store_.historyIndex === -1) setStore("saved", input.plainText)
            const next = Math.min(history().length - 1, store_.historyIndex + 1)
            if (next === store_.historyIndex) return true
            setStore("historyIndex", next)
            input.setText(history()[next])
            input.gotoBufferEnd()
            return true
          }
          if (!input.plainText) return false
          input.moveCursorUp()
          return true
        }
        if (atEnd && store_.historyIndex >= 0) {
          const next = store_.historyIndex - 1
          setStore("historyIndex", next)
          input.setText(next < 0 ? store_.saved : history()[next])
          input.gotoBufferEnd()
          return true
        }
        if (!input.plainText) return false
        // From the last line, down goes back to the first one.
        const view = input.editorView
        if (lastRow && view.getVisualEOL().logicalCol === view.getEOL().logicalCol) input.gotoBufferHome()
        else input.moveCursorDown()
        return true
      }
      if (matchesId(event, "prompt.paste")) {
        return pasteClipboard()
      }
      if (event.ctrl && event.name === "d" && !input.plainText) {
        exit()
        return true
      }
      return false
    },
  })

  createEffect(
    on(
      () => store.status,
      () => setStore("interrupt", 0),
    ),
  )

  onCleanup(() => {
    if (refs.prompt === input) refs.prompt = undefined
  })

  // ---------------------------------------------------------------------------
  // Footer pieces
  // ---------------------------------------------------------------------------

  const location = createMemo(() => {
    const home = os.homedir()
    const dir = home && store.cwd.startsWith(home) ? "~" + store.cwd.slice(home.length) : store.cwd
    return store.branch ? `${dir}:${store.branch}` : dir
  })

  const usage = createMemo(() => {
    const parts           = []
    if (store.context?.tokens && showDetails()) {
      parts.push(
        `${store.context.tokens.toLocaleString()}${store.context.percent ? ` (${store.context.percent}%)` : ""}`,
      )
    }
    return parts
  })

  // One warning per kind of model:
  //  - a price tier by prompt length (Claude Haiku 5.5: 5× above 100K): "!!!" near it, "!!! 5×" past it
  //  - otherwise the context window filling up (quality drops, compaction is near): "!! ctx"
  //  - local models: past the loaded context Ollama drops the oldest tokens ("⚠ ctx full"), and a model
  //    that no longer fits in VRAM runs partly on the CPU ("⚠ CPU", slow)
  const warning = createMemo(()                                            => {
    const tokens = store.context?.tokens ?? 0
    const meta = modelMeta(store.model, store.modelId)
    if (meta.kind === "local") {
      const state = local[store.model]
      if (state?.vram !== undefined && state.vram < 0.97) return { text: `⚠ CPU ${Math.round((1 - state.vram) * 100)}%`, color: theme.warning }
      if (!state?.context || !tokens) return undefined
      if (tokens > state.context) return { text: "⚠ ctx full", color: theme.error }
      return tokens >= state.context * 0.8 ? { text: "⚠ ctx", color: theme.warning } : undefined
    }
    if (!tokens) return undefined
    const tier = meta.tiers?.[0]
    const limit = config.contextWarnAt ?? tier?.above
    if (limit) {
      const times = tier && meta.price?.input ? Math.round(tier.input / meta.price.input) : 0
      if (tokens > limit) return { text: times > 1 ? `!!! ${times}×` : "!!!", color: theme.error }
      if (tokens >= limit * 0.8) return { text: "!!!", color: theme.warning }
    }
    const max = meta.context ?? store.context?.max
    if (!max) return undefined
    if (tokens >= max * 0.9) return { text: "!! ctx", color: theme.error }
    return tokens >= max * 0.7 ? { text: "!! ctx", color: theme.warning } : undefined
  })
  // Local models: watch the loaded context and VRAM share while the tab is on one.
  createEffect(() => {
    if (kind() !== "local") return
    const value = store.model
    const split = splitModel(value)
    const baseURL = providers.list.find((item) => item.id === split?.provider.id)?.baseURL
    if (!split || !baseURL) return
    const tick = () => void pollLocal(baseURL, split.model, value)
    tick()
    const timer = setInterval(tick, 10_000)
    onCleanup(() => clearInterval(timer))
  })

  // Claude Code prices every token at Claude rates, which is meaningless for other providers.
  const cost = createMemo(() =>
    store.cost > 0 && !splitModel(store.model) ? (store.cost < 0.01 ? "<$0.01" : money.format(store.cost)) : undefined,
  )

  const subagents = createMemo(() => {
    const count = Object.keys(store.tasks).length
    return count ? `${count} task${count === 1 ? "" : "s"}` : undefined
  })

  // Width the prompt actually gets (the docked sidebar takes 42 columns).
  const width = createMemo(() => {
    const total = props.home ? Math.min(75, dimensions().width - 4) : dimensions().width - 4
    return !props.home && dimensions().width > SIDEBAR_DOCK_WIDTH && sidebarShown(dimensions().width) ? total - 42 : total
  })
  // Usage stays in the footer even beside the sidebar; the row wraps instead of dropping it.
  // Meters belong to whoever pays: Claude plan bars on Claude models, Go meters on OpenCode Go, none elsewhere.
  const kind = createMemo(() => providerKind(store.model))
  const roomForLimits = () => (props.home ? width() >= 70 : dimensions().width >= 60)
  const showLimits = createMemo(() => kind() === "anthropic" && !!limits.available && !!(limits.fiveHour || limits.week) && roomForLimits())
  const showGo = createMemo(() => kind() === "go" && !!catalog.go && roomForLimits())

  const metadata = createMemo(() => {
    const narrow = dimensions().width < 44
    const model = modelLabel()
    return {
      agent: promptMode() === "shell" ? "Shell" : agent().name,
      model: promptMode() === "shell" ? "" : model,
      provider: narrow ? "" : providerName(store.model),
      variant: promptMode() === "shell" ? undefined : store.effort,
      variants: !!(modelVariants(store.model) ?? session.currentModel()?.supportedEffortLevels)?.length,
    }
  })

  const autoHeight = createMemo(() => Math.min(10, Math.max(1, auto.options.length)))
  const narrowFooter = createMemo(() => dimensions().width < 70)

  return (
    <>
      <box ref={(r               ) => (anchor = r)} width="100%" position="relative">
        <Show when={auto.visible}>
          <box
            position="absolute"
            top={-autoHeight()}
            left={0}
            width="100%"
            zIndex={100}
            {...SplitBorder}
            borderColor={theme.border}
          >
            <scrollbox backgroundColor={theme.backgroundElement} height={autoHeight()} scrollbarOptions={{ visible: false }}>
              <Show
                when={auto.options.length}
                fallback={
                  <box paddingLeft={1} paddingRight={1}>
                    <text fg={theme.textMuted}>{auto.visible === "/" ? "No matching commands" : "No matching files"}</text>
                  </box>
                }
              >
                <For each={auto.options.slice(Math.max(0, auto.selected - 9), Math.max(0, auto.selected - 9) + 10)}>
                  {(option) => {
                    const active = () => auto.options[auto.selected] === option
                    return (
                      <box
                        paddingLeft={1}
                        paddingRight={1}
                        flexDirection="row"
                        backgroundColor={active() ? theme.primary : undefined}
                        onMouseMove={() => setAuto("selected", auto.options.indexOf(option))}
                        onMouseUp={() => {
                          setAuto("selected", auto.options.indexOf(option))
                          acceptAutocomplete(true)
                        }}
                      >
                        <text fg={active() ? theme.selectedListItemText : theme.text} flexShrink={0} wrapMode="none">
                          {option.display}
                        </text>
                        <Show when={option.description}>
                          <text
                            fg={active() ? theme.selectedListItemText : theme.textMuted}
                            wrapMode="none"
                            flexShrink={1}
                            minWidth={0}
                          >
                            {" " + option.description .replace(/\s+/g, " ").trim()}
                          </text>
                        </Show>
                      </box>
                    )
                  }}
                </For>
              </Show>
            </scrollbox>
          </box>
        </Show>
        <box
          width="100%"
          border={["left"]}
          borderColor={borderColor()}
          customBorderChars={{ ...SplitBorder.customBorderChars, bottomLeft: "╹" }}
        >
          <box
            paddingLeft={dimensions().width < 44 ? 1 : 2}
            paddingRight={dimensions().width < 44 ? 1 : 2}
            paddingTop={1}
            flexShrink={0}
            backgroundColor={promptBg()}
            flexGrow={1}
            width="100%"
          >
            <Show when={store_.attached.some((token) => store_.text.includes(token)) || store_.pasted.some((token) => store_.text.includes(token))}>
              <box flexDirection="row" flexWrap="wrap" gap={1} paddingBottom={1}>
                <For each={store_.pasted.filter((token) => store_.text.includes(token))}>
                  {(token) => (
                    <text fg={theme.text} wrapMode="none" onMouseUp={() => expandPaste(token)}>
                      <span style={{ bg: theme.warning, fg: theme.backgroundPanel, bold: true }}> txt </span>
                      <span style={{ bg: theme.backgroundElement, fg: theme.text }}> {token.slice(1, -1)} </span>
                      <span style={{ bg: theme.backgroundElement, fg: theme.textMuted }}>click to expand </span>
                    </text>
                  )}
                </For>
                <For each={store_.attached.filter((token) => store_.text.includes(token))}>
                  {(token) => {
                    const item = draft.attachments.get(token)
                    return item ? <AttachmentChip item={{ ...item, token }} onRemove={() => detach(token)} /> : null
                  }}
                </For>
              </box>
            </Show>
            <textarea
              width="100%"
              initialValue={draft.text}
              placeholder={placeholderText()}
              placeholderColor={theme.textMuted}
              textColor={muted() ? theme.textMuted : theme.text}
              focusedTextColor={muted() ? theme.textMuted : theme.text}
              minHeight={1}
              maxHeight={Math.max(6, Math.floor(dimensions().height / 3))}
              focusedBackgroundColor="transparent"
              cursorColor={theme.text}
              syntaxStyle={syntax()}
              keyBindings={[
                { name: "return", action: "submit" },
                { name: "return", shift: true, action: "newline" },
                { name: "return", ctrl: true, action: "newline" },
                { name: "return", meta: true, action: "newline" },
                { name: "j", ctrl: true, action: "newline" },
                // Like any text field: home/end act on the current line, ctrl+home/end on the whole prompt.
                { name: "home", action: "visual-line-home" },
                { name: "end", action: "visual-line-end" },
                { name: "home", shift: true, action: "select-visual-line-home" },
                { name: "end", shift: true, action: "select-visual-line-end" },
                { name: "home", ctrl: true, action: "buffer-home" },
                { name: "end", ctrl: true, action: "buffer-end" },
                { name: "home", ctrl: true, shift: true, action: "select-buffer-home" },
                { name: "end", ctrl: true, shift: true, action: "select-buffer-end" },
              ]}
              onContentChange={() => {
                const value = input.plainText
                setStore("text", value)
                draft.text = value
                if (draft.pastes.size) markPastes()
                void updateAutocomplete()
              }}
              onCursorChange={() => {
                if (auto.visible) void updateAutocomplete()
              }}
              onMouseUp={() => setTimeout(expandAtCursor, 0)}
              onSubmit={() => setTimeout(() => setTimeout(() => submit(), 0), 0)}
              onPaste={(event            ) => {
                const text = new TextDecoder().decode(event.bytes).replace(/\r\n/g, "\n").replace(/\r/g, "\n")
                if (event.bytes.byteLength === 0) {
                  // Some terminals send an empty bracketed paste for image-only clipboards.
                  event.preventDefault()
                  pasteClipboard()
                  return
                }
                event.preventDefault()
                void pasteFiles(text).then((done) => {
                  if (!done && !input.isDestroyed) insertPaste(text)
                })
              }}
              ref={(r                    ) => {
                input = r
                refs.prompt = r
                setTimeout(() => {
                  if (!r.isDestroyed && !dialog.open) {
                    r.focus()
                    r.gotoBufferEnd()
                  }
                }, 1)
              }}
            />
            <box flexDirection="row" flexShrink={0} paddingTop={1} gap={1}>
              {/* Click the agent, model or effort to change it. */}
              <box flexShrink={0} onMouseUp={() => runCommand("agent.list")}>
                <text fg={highlight()} wrapMode="none">
                  {metadata().agent}
                </text>
              </box>
              <Show when={promptMode() === "normal" && autoLabel()}>
                <text fg={theme.textMuted}>{autoLabel()}</text>
              </Show>
              <Show when={metadata().model}>
                <text fg={theme.textMuted}>·</text>
                <text
                  flexShrink={1}
                  minWidth={0}
                  wrapMode="none"
                  truncate
                  fg={muted() ? theme.textMuted : theme.text}
                  onMouseUp={() => runCommand("model.list")}
                >
                  {metadata().model}
                </text>
                <Show when={metadata().provider}>
                  <text flexShrink={0} fg={theme.textMuted} onMouseUp={() => runCommand("model.list")}>
                    {metadata().provider}
                  </text>
                </Show>
                <Show when={metadata().variant}>
                  <text fg={theme.textMuted}>·</text>
                  <text fg={theme.warning} attributes={TextAttributes.BOLD} onMouseUp={() => runCommand("variant.list")}>
                    {metadata().variant}
                  </text>
                </Show>
                <Show when={!metadata().variant && metadata().variants && promptMode() === "normal" && !narrowFooter()}>
                  <text fg={theme.textMuted}>·</text>
                  <text fg={theme.textMuted} onMouseUp={() => runCommand("variant.list")}>
                    default
                  </text>
                </Show>
                <Show when={config.autoModel && promptMode() === "normal" && !session.store.messages.some((m) => m.type === "user")}>
                  <text fg={theme.textMuted}>·</text>
                  <text fg={theme.accent}>auto</text>
                </Show>
                <Show when={store.fast && promptMode() === "normal"}>
                  <text fg={theme.textMuted}>·</text>
                  <text fg={theme.primary} attributes={TextAttributes.BOLD}>
                    fast
                  </text>
                </Show>
              </Show>
            </box>
          </box>
        </box>
        <box
          height={1}
          border={["left"]}
          borderColor={borderColor()}
          customBorderChars={{ ...EmptyBorder, vertical: "╹" }}
        >
          <box height={1} border={["bottom"]} borderColor={promptBg()} customBorderChars={{ ...EmptyBorder, horizontal: "▀" }} />
        </box>
        <box width="100%" flexDirection="row" justifyContent="space-between" gap={2}>
          <box flexGrow={1} flexShrink={1} minWidth={Math.min(28, Math.floor(width() / 3))}>
            <Switch>
              <Match when={store_.routing}>
                <box flexDirection="row" gap={1} flexGrow={1}>
                  <box marginLeft={1}>
                    <Scanner color={color()} />
                  </box>
                  <text fg={theme.textMuted} wrapMode="none" truncate>
                    choosing model…
                  </text>
                </box>
              </Match>
              <Match when={running()}>
                <box flexDirection="row" gap={1} flexGrow={1}>
                  <box marginLeft={1}>
                    <Scanner color={color()} />
                  </box>
                  <Show when={store.compacting}>
                    <text fg={theme.textMuted}>compacting…</text>
                  </Show>
                  <text fg={store_.interrupt > 0 ? theme.warning : theme.text} wrapMode="none" truncate flexShrink={1}>
                    esc{" "}
                    <span style={{ fg: store_.interrupt > 0 ? theme.warning : theme.textMuted }}>
                      {store_.interrupt > 0 ? "again to interrupt" : "interrupt"}
                    </span>
                  </text>
                </box>
              </Match>
              <Match when={store.booting}>
                <text fg={theme.textMuted} wrapMode="none" truncate>
                  starting {engineName().toLowerCase()}…
                </text>
              </Match>
              <Match when={store.fatal}>
                <text fg={theme.error} wrapMode="none" truncate>
                  {store.fatal}
                </text>
              </Match>
              <Match when={true}>
                <text fg={theme.textMuted} wrapMode="none" truncate flexGrow={1} flexShrink={1}>
                  {location()}
                </text>
              </Match>
            </Switch>
          </box>
          <Switch>
            <Match when={promptMode() === "shell"}>
              <text fg={theme.text} flexShrink={0}>
                esc <span style={{ fg: theme.textMuted }}>exit shell mode</span>
              </text>
            </Match>
            <Match when={true}>
              {/* One line: the key hints sit left of the plan meters instead of wrapping below them. */}
              <box flexDirection="row" justifyContent="flex-end" columnGap={2} flexShrink={0}>
                {props.right}
                <Show when={subagents()}>
                  <text fg={theme.textMuted} wrapMode="none" onMouseUp={() => runCommand("tasks.list")}>
                    {subagents()}
                  </text>
                </Show>
                <Show when={width() >= 44 && !(props.home && showLimits()) && (props.home || (!usage().length && !cost()) || width() >= 110)}>
                  <text fg={theme.text} flexShrink={0}>
                    {shortcut("agent.cycle").replace("shift+tab", "tab")}{" "}
                    <span style={{ fg: theme.textMuted }}>agents</span>
                  </text>
                </Show>
                <Show when={width() >= (showLimits() ? 100 : 60) || props.home || usage().length === 0}>
                  <text fg={theme.text} wrapMode="none" flexShrink={0}>
                    {shortcut("command.palette.show")} <span style={{ fg: theme.textMuted }}>commands</span>
                  </text>
                </Show>
                <Show when={showLimits()}>
                  <box flexDirection="row" gap={2} flexShrink={0}>
                    <Show when={limits.fiveHour}>{(w                       ) => <UsageBar label="5h" window={w()} />}</Show>
                    <Show when={limits.week}>{(w                       ) => <UsageBar label="wk" window={w()} />}</Show>
                  </box>
                </Show>
                <Show when={showGo()}>
                  <box flexDirection="row" gap={2} flexShrink={0}>
                    <Show when={catalog.go?.rolling}>{(w                       ) => <UsageBar label="go" window={w()} />}</Show>
                    <Show when={catalog.go?.weekly}>{(w                       ) => <UsageBar label="wk" window={w()} />}</Show>
                    <Show when={catalog.go?.monthly}>{(w                       ) => <UsageBar label="mo" window={w()} />}</Show>
                  </box>
                </Show>
                <Show when={store.resumeAt !== undefined}>
                  <text fg={theme.warning} wrapMode="none" flexShrink={0}>
                    {store.resumeAt
                      ? `⏸ resumes ${new Date(store.resumeAt).toDateString() === new Date().toDateString() ? "" : `${new Date(store.resumeAt).toLocaleDateString([], { weekday: "short" })} `}${new Date(store.resumeAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                      : "⏸ resumes after reset"}
                  </text>
                </Show>
                <Show when={!props.home && warning()}>
                  <text fg={warning() .color} attributes={TextAttributes.BOLD} flexShrink={0} wrapMode="none">
                    {warning() .text}
                  </text>
                </Show>
                <Show when={!props.home && (usage().length > 0 || cost())}>
                  <text fg={theme.textMuted} wrapMode="none" flexShrink={0}>
                    {[...usage(), cost()].filter(Boolean).join(" · ")}
                  </text>
                </Show>
              </box>
            </Match>
          </Switch>
        </box>
      </box>
    </>
  )
}

const BAR_WIDTH = 6

/** Compact plan-usage meter for the footer: "5h ▰▰▰▱▱▱ 42%". */
/** Time until a usage window resets: "2h13m", "45m", "3d4h". */
export function shortReset(at        ) {
  const ms = at - clock()
  if (ms <= 0) return "now"
  const minutes = Math.ceil(ms / 60000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, "0")}m`
  return `${Math.floor(hours / 24)}d${hours % 24}h`
}

export function UsageBar(props                                                                             ) {
  const width = () => props.width ?? BAR_WIDTH
  // A window whose reset time has passed is empty, even before the next poll confirms it.
  const used = () => (props.window.resetsAt && props.window.resetsAt <= clock() ? 0 : props.window.utilization)
  const filled = () => Math.min(width(), Math.round((used() / 100) * width()))
  const color = () => (used() >= 90 ? theme.error : used() >= 75 ? theme.warning : theme.success)
  return (
    <text fg={theme.textMuted} wrapMode="none" flexShrink={0}>
      {props.label} <span style={{ fg: color() }}>{"▰".repeat(filled())}</span>
      <span style={{ fg: theme.border }}>{"▱".repeat(width() - filled())}</span> {Math.round(used())}%
      <Show when={props.reset !== false && props.window.resetsAt && props.window.resetsAt > clock()}>
        <span style={{ fg: theme.textMuted }}> {shortReset(props.window.resetsAt )}</span>
      </Show>
    </text>
  )
}

export function setPromptText(text        ) {
  const input = refs.prompt
  draft.text = text
  if (!input || input.isDestroyed) return
  input.setText(text)
  input.gotoBufferEnd()
  focusPrompt()
}

/** Insert at the cursor, with a space before it when needed (used for @file mentions from the sidebar). */
export function insertPromptText(text        ) {
  const input = refs.prompt
  if (!input || input.isDestroyed) return
  const before = input.plainText.slice(0, input.cursorOffset)
  input.insertText((before && !/\s$/.test(before) ? " " : "") + text)
  draft.text = input.plainText
  focusPrompt()
}

export { RGBA }
