// occ-memory: a view onto Claude Code's own auto-memory (~/.claude/projects/<project>/memory), after
// OpenCodeBox's memory layer. Browse, add, edit and forget memories; turn memory off per Agent Code; and have Claude
// save a lesson whenever something fails (OpenCodeBox's learned.md habit, written as normal memories).
import { TextAttributes } from "@opentui/core"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js"
import { config, saveConfig } from "../context/config"
import { registerAutoAllow, registerPromptPart, registerSettingsPart } from "../context/session"
import { appendContext, store, tabs } from "../context/tabs"
import { providerKind, splitModel } from "../context/providers"
import { syntax, theme } from "../context/theme"

import { dialog, DialogConfirm, DialogPrompt, DialogSelect } from "../ui/dialog"
import { toast } from "../ui/toast"
import { boxDir } from "../context/box"



const TYPES = ["user", "feedback", "project", "reference"]
const TYPE_TITLE                         = { user: "About you", feedback: "How to work", project: "Project", reference: "References" }
const typeColor = (type        ) =>
  type === "user" ? theme.primary : type === "feedback" ? theme.warning : type === "project" ? theme.success : type === "reference" ? theme.info : theme.textMuted

/** Claude Code's auto-memory folder for a working directory (the shared store Claude models use). */
export function memoryDir(cwd = store.cwd) {
  return path.join(os.homedir(), ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), "memory")
}

const modelSlug = (model        ) => model.replace(/[^a-zA-Z0-9.]+/g, "-").replace(/^-|-$/g, "")

/** Folder of a non-Claude model's own memory store, next to the shared one. */
export function modelMemoryDir(model        , cwd = store.cwd) {
  return path.join(path.dirname(memoryDir(cwd)), "memory-models", modelSlug(model))
}

/** Claude models, and models given full access, use the shared memory; every other model keeps its own. */
export const hasFullMemory = (model        ) => providerKind(model) === "anthropic" || (config.memoryFullAccess ?? []).includes(model)
export const storeOf = (model        ) => (hasFullMemory(model) ? memoryDir() : modelMemoryDir(model))
const storeName = (model        ) => (hasFullMemory(model) ? "shared" : splitModel(model)?.model ?? model)

const [version, setVersion] = createSignal(0)
const bump = () => setVersion((value) => value + 1)

function parse(file        )                     {
  try {
    const text = readFileSync(file, "utf8")
    const match = text.match(/^---\n([\s\S]*?)\n---\n?/)
    const meta                         = {}
    for (const line of match?.[1].split("\n") ?? []) {
      const found = line.match(/^\s*(\w+):\s*(.*)$/)
      if (found) meta[found[1]] = found[2].replace(/^["']|["']$/g, "")
    }
    return {
      file,
      name: meta.name || path.basename(file, ".md"),
      description: meta.description ?? "",
      type: meta.type ?? "project",
      body: (match ? text.slice(match[0].length) : text).trim(),
      time: statSync(file).mtimeMs,
    }
  } catch {
    return undefined
  }
}

export function memories(dir = storeOf(store.model))           {
  version()
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((file) => file.endsWith(".md") && file !== "MEMORY.md")
    .map((file) => parse(path.join(dir, file)))
    .filter(Boolean)
    .sort((a, b) => b .time - a .time)
}

/**
 * What memory adds to every conversation: only the index (MEMORY.md: one line per memory, its name and a hook) is
 * loaded; a memory's own text is read when it is relevant. Estimated at about 3.5 characters a token.
 */
export function memoryTokens(dir = storeOf(store.model)) {
  version()
  try {
    return Math.ceil(readFileSync(path.join(dir, "MEMORY.md"), "utf8").length / 3.5)
  } catch {
    return 0
  }
}

/** Every store of this project: the shared one and one per model that has written anything. */
export function allStores()                                                  {
  version()
  const root = path.join(path.dirname(memoryDir()), "memory-models")
  const models = existsSync(root) ? readdirSync(root).filter((name) => existsSync(path.join(root, name))) : []
  return [{ name: "shared (Claude)", dir: memoryDir() }, ...models.map((name) => ({ name, dir: path.join(root, name), model: name }))]
}

/** Put every store's memories into the focused tab's context once (a deliberate, one-off read). */
function readAllMemory() {
  const parts           = []
  for (const s of allStores()) {
    const list = memories(s.dir)
    if (!list.length) continue
    parts.push(`## Memory store: ${s.name}\n` + list.map((m) => `### ${m.name} (${m.type})\n${m.description ? m.description + "\n" : ""}${m.body}`).join("\n\n"))
  }
  if (!parts.length) return toast.show({ variant: "info", message: "No memories in any store yet" })
  appendContext(`The user chose to share every memory store of this project with you for this conversation (read-only; keep writing to your own store):\n\n${parts.join("\n\n")}`)
  toast.show({ variant: "success", message: `Added ${parts.length} memory store(s) to this tab's context` })
}

function setFullAccess(model        , on         ) {
  const list = new Set(config.memoryFullAccess ?? [])
  if (on) list.add(model)
  else list.delete(model)
  config.memoryFullAccess = [...list]
  saveConfig()
  bump()
  for (const tab of tabs()) if (tab.live && tab.store.status === "idle" && tab.store.model === model) void tab.restart()
}

const slugify = (text        ) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "note"

/** Write a memory the same way Claude Code does: one file with front matter, plus a line in MEMORY.md. */
function remember(text        , type                         = "user", name = slugify(text.split(/[.\n]/)[0]), dir = storeOf(store.model)) {
  mkdirSync(dir, { recursive: true })
  let file = path.join(dir, `${name}.md`)
  for (let n = 2; existsSync(file); n++) file = path.join(dir, `${name}-${n}.md`)
  const slug = path.basename(file, ".md")
  const description = text.replace(/\s+/g, " ").slice(0, 110)
  writeFileSync(file, `---\nname: ${slug}\ndescription: ${description}\nmetadata:\n  type: ${type}\n---\n\n${text.trim()}\n`)
  const index = path.join(dir, "MEMORY.md")
  const existing = existsSync(index) ? readFileSync(index, "utf8") : ""
  writeFileSync(index, `${existing.replace(/\n*$/, existing ? "\n" : "")}- [${slug}](${slug}.md) — ${description.slice(0, 80)}\n`)
  bump()
}

function forget(memory        ) {
  rmSync(memory.file, { force: true })
  const index = path.join(path.dirname(memory.file), "MEMORY.md")
  if (existsSync(index)) {
    const base = path.basename(memory.file)
    writeFileSync(index, readFileSync(index, "utf8").split("\n").filter((line) => !line.includes(`(${base})`)).join("\n"))
  }
  bump()
}

function setFlag(key                             , value         ) {
  config[key] = value
  saveConfig()
  bump()
  for (const tab of tabs()) if (tab.live && tab.store.status === "idle") void tab.restart()
}
const useOn = () => (version(), config.memoryUse !== false)
const learnOn = () => (version(), config.memoryLearn !== false)

const LEARN_PROMPT = `# Learning from failures
When something fails and you find out why (a command or tool errors, a model or API refuses, an assumption turns out wrong, a limit is hit), save it to your auto-memory before moving on: one feedback memory per lesson, stating what failed, why, and what to do next time. Update an existing memory instead of adding a near-duplicate. Skip one-off typos and anything already in the code or git history.`

const age = (time        ) => {
  const minutes = Math.round((Date.now() - time) / 60000)
  if (minutes < 60) return `${Math.max(1, minutes)}m`
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`
  return `${Math.round(minutes / 1440)}d`
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

export function DialogMemory() {
  const renderer = useRenderer()
  const options = createMemo(() => {
    const list = memories()
    const check = (on         ) => <text fg={on ? theme.success : theme.textMuted}>{on ? "[x]" : "[ ]"}</text>
    return [
      { title: "Remember something…", value: "add", description: `save a note in the ${storeName(store.model)} store`, category: "Memory" },
      ...(providerKind(store.model) !== "anthropic"
        ? [{
            title: "Full memory for this model",
            value: "full",
            description: `${splitModel(store.model)?.model ?? store.model} uses the shared memory instead of its own`,
            category: "Memory",
            gutter: check(hasFullMemory(store.model)),
          }]
        : []),
      { title: "Read all memory now", value: "readall", description: "add every store (all models) to this tab's context once", category: "Memory" },
      { title: "Show all stores", value: "stores", description: "browse the shared store and each model's own", category: "Memory" },
      { title: "Use memory", value: "use", description: "Claude reads and writes its memory", category: "Memory", gutter: check(useOn()) },
      { title: "Learn from failures", value: "learn", description: "save a lesson whenever something fails", category: "Memory", gutter: check(learnOn()) },
      ...(existsSync(OPENCODEBOX) && !list.some((memory) => memory.name === "opencodebox-memories")
        ? [{ title: "Link my OpenCodeBox memories", value: "link", description: "learned lessons + subscriptions, read when relevant", category: "Memory" }]
        : []),
      ...TYPES.flatMap((type) =>
        list
          .filter((memory) => memory.type === type || (type === "project" && !TYPES.includes(memory.type       )))
          .map((memory) => ({
            title: memory.name,
            value: memory.file,
            description: memory.description,
            footer: age(memory.time),
            category: TYPE_TITLE[type],
            gutter: <text fg={typeColor(memory.type)}>●</text>,
          })),
      ),
    ]
  })
  const find = (file        ) => memories().find((memory) => memory.file === file)
  const edit = async (memory        ) => {
    const editor = process.env.VISUAL || process.env.EDITOR
    if (!editor) return toast.show({ variant: "warning", message: "Set $EDITOR to edit memories" })
    await renderer.suspend()
    try {
      spawnSync(editor, [memory.file], { stdio: "inherit", shell: true })
    } finally {
      await renderer.resume()
    }
    bump()
  }
  const confirmForget = (memory        ) =>
    dialog.push(() => (
      <DialogConfirm
        title="Forget memory"
        message={`Delete "${memory.name}"? Claude won't see it again.`}
        onConfirm={() => {
          forget(memory)
          dialog.pop()
        }}
      />
    ))
  return (
    <DialogSelect
      title={`Memory · ${path.basename(store.cwd)} · ${storeName(store.model)} store`}
      options={options()}
      emptyText="Nothing remembered yet"
      onSelect={(option) => {
        if (option.value === "use") return setFlag("memoryUse", !useOn())
        if (option.value === "learn") return setFlag("memoryLearn", !learnOn())
        if (option.value === "link") return linkOpenCodeBox()
        if (option.value === "full") return setFullAccess(store.model, !hasFullMemory(store.model))
        if (option.value === "readall") return readAllMemory()
        if (option.value === "stores") return dialog.push(() => <DialogStores />)
        if (option.value === "add")
          return dialog.push(() => (
            <DialogPrompt
              title="Remember"
              placeholder="e.g. I prefer pnpm over npm in this project"
              onConfirm={(value) => {
                if (value.trim()) {
                  remember(value.trim())
                  toast.show({ variant: "success", message: "Remembered" })
                }
                dialog.pop()
              }}
            />
          ))
        const memory = find(option.value)
        if (memory) dialog.push(() => <MemoryPreview memory={memory} onEdit={() => edit(memory)} onForget={() => confirmForget(memory)} />)
      }}
      actions={[
        { keybind: "ctrl+e", label: "edit", run: (option) => void (find(option.value) && edit(find(option.value) )) },
        { keybind: "ctrl+d", label: "forget", run: (option) => void (find(option.value) && confirmForget(find(option.value) )) },
      ]}
    />
  )
}

function DialogStores() {
  const options = createMemo(() =>
    allStores().flatMap((s) =>
      memories(s.dir).map((memory) => ({
        title: memory.name,
        value: memory.file,
        description: memory.description,
        footer: age(memory.time),
        category: s.name,
        gutter: <text fg={typeColor(memory.type)}>●</text>,
      })),
    ),
  )
  return (
    <DialogSelect
      title="All memory stores"
      options={options()}
      emptyText="No memories in any store yet"
      onSelect={(option) => {
        const memory = allStores().flatMap((s) => memories(s.dir)).find((item) => item.file === option.value)
        if (memory) dialog.push(() => <MemoryPreview memory={memory} onEdit={() => {}} onForget={() => {}} />)
      }}
    />
  )
}

function MemoryPreview(props                                                              ) {
  const dimensions = useTerminalDimensions()
  return (
    <box paddingLeft={4} paddingRight={4} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between" gap={2}>
        <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none" truncate flexShrink={1}>
          <span style={{ fg: typeColor(props.memory.type) }}>● </span>
          {props.memory.name} <span style={{ fg: theme.textMuted }}>{TYPE_TITLE[props.memory.type] ?? props.memory.type}</span>
        </text>
        <box flexDirection="row" gap={2} flexShrink={0}>
          <text fg={theme.primary} onMouseUp={() => props.onEdit()}>
            edit
          </text>
          <text fg={theme.error} onMouseUp={() => props.onForget()}>
            forget
          </text>
          <text fg={theme.textMuted} onMouseUp={() => dialog.pop()}>
            esc
          </text>
        </box>
      </box>
      <Show when={props.memory.description}>
        <text fg={theme.textMuted} wrapMode="word">
          {props.memory.description}
        </text>
      </Show>
      <scrollbox height={Math.max(6, dimensions().height - Math.floor(dimensions().height / 4) - 9)} scrollbarOptions={{ visible: false }} focused>
        <markdown syntaxStyle={syntax()} content={props.memory.body} fg={theme.markdownText} bg={theme.backgroundPanel} conceal={true} />
      </scrollbox>
    </box>
  )
}

export function MemorySection() {
  // Claude writes memories during a turn: re-read when it finishes.
  createEffect(on(() => store.status, () => bump(), { defer: true }))
  const list = createMemo(() => memories())
  const shown = createMemo(() => list().slice(0, 4))
  return (
    <box onMouseUp={() => openMemory()}>
      <box flexDirection="row" gap={1}>
        <text fg={theme.text} flexGrow={1} wrapMode="none">
          <b>Memory</b>
          <Show when={!hasFullMemory(store.model)}>
            <span style={{ fg: theme.textMuted }}> · {storeName(store.model)}</span>
          </Show>
        </text>
        <text fg={useOn() ? theme.textMuted : theme.warning}>{useOn() ? (list().length ? String(list().length) : "") : "off"}</text>
      </box>
      <Show when={useOn() && memoryTokens() > 0}>
        <text fg={theme.textMuted} wrapMode="none" truncate>
          names only in context · ≈{memoryTokens().toLocaleString()} tok
        </text>
      </Show>
      <Show when={list().length} fallback={<text fg={theme.textMuted}>{useOn() ? "nothing yet · click to add" : "memory is off"}</text>}>
        <For each={shown()}>
          {(memory) => (
            <text fg={theme.text} wrapMode="none" truncate>
              <span style={{ fg: typeColor(memory.type) }}>•</span> {memory.name}
            </text>
          )}
        </For>
        <Show when={list().length > shown().length}>
          <text fg={theme.textMuted}>+{list().length - shown().length} more</text>
        </Show>
      </Show>
    </box>
  )
}

export function openMemory() {
  bump()
  dialog.replace(() => <DialogMemory />, undefined, "large")
}

// ---------------------------------------------------------------------------
// OpenCodeBox: its memories are large, so link them as a reference memory instead of copying them in.
// ---------------------------------------------------------------------------

// Optional: set "openCodeBox" in config.json to an OpenCodeBox folder to offer linking its memories.
const OPENCODEBOX = config.openCodeBox ? path.join(config.openCodeBox, "box", "agents", "memories") : ""

function linkOpenCodeBox() {
  const files = ["learned.md", "subscriptions.md", "aitools.md"].filter((file) => existsSync(path.join(OPENCODEBOX, file)))
  remember(
    `Memories from OpenCodeBox (the user's previous opencode setup), kept as files to read when relevant:\n\n` +
      files.map((file) => `- \`${path.join(OPENCODEBOX, file)}\``).join("\n") +
      `\n\nlearned.md holds dated lessons (what failed, why, what to do instead) about this machine: GPU/VRAM limits, ComfyUI, Ollama, voice tools, model access. subscriptions.md lists which paid and free model services work. Check them before local-AI, GPU or provider work.`,
    "reference",
    "opencodebox-memories",
  )
  toast.show({ variant: "success", message: "Linked OpenCodeBox memories" })
}

export const memoryPlugin         = (api) => {
  api.lifecycle.onDispose(
    registerSettingsPart("occ-memory", (model) => {
      // An agentcode-box keeps its own memory/ folder (its CLAUDE.md protocol): Claude's auto-memory stays off there.
      if (config.memoryUse === false || boxDir) return { autoMemoryEnabled: false }
      // Non-Claude models remember into their own folder unless given full access.
      return hasFullMemory(model) ? undefined : { autoMemoryDirectory: modelMemoryDir(model) }
    }),
  )
  api.lifecycle.onDispose(registerPromptPart("occ-memory", () => (config.memoryUse !== false && config.memoryLearn !== false && !boxDir ? LEARN_PROMPT : undefined)))
  // Claude may write its own memory folder without asking.
  api.lifecycle.onDispose(
    registerAutoAllow("occ-memory", (tool, input) => {
      const file = typeof input.file_path === "string" ? input.file_path : undefined
      return (tool === "Write" || tool === "Edit" || tool === "Read") && !!file && (path.resolve(file).startsWith(memoryDir() + path.sep) || path.resolve(file).startsWith(path.join(path.dirname(memoryDir()), "memory-models") + path.sep))
    }),
  )
  api.slots.register({ id: "occ-memory", order: 170, slots: { sidebar_content: () => <MemorySection /> } })
  api.keymap.registerLayer({
    commands: [{ name: "memory.list", title: "Memory", category: "Agent", slashName: "memories", run: () => openMemory() }],
  })
}
