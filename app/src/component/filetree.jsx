import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { execFile } from "node:child_process"
import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import { createEffect, createMemo, createSignal, For, on, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { listFiles } from "../context/files"
import { useLayer } from "../context/keymap"
import { store } from "../context/tabs"
import { syntax, theme } from "../context/theme"
import { dialog } from "../ui/dialog"
import { toast } from "../ui/toast"
import { filetype } from "../routes/tools"
import { insertPromptText } from "./prompt"

// ---------------------------------------------------------------------------
// Project file tree: a collapsible sidebar section and a keyboard-driven dialog.
// Files come from git (so .gitignore is respected) or a plain walk outside a repo.
// Click a folder to expand it, a file to preview it; right-click (or `a`) attaches it as @file.
// ---------------------------------------------------------------------------





// Expanded folders and the tree itself are per project, shared by the sidebar and the dialog.
const [tree, setTree] = createStore                                                                                                                  ({
  root: { name: "", path: "", dir: true, children: [] },
  git: {},
  expanded: {},
  loading: false,
})
const [sectionOpen, setSectionOpen] = createSignal(false)

function build(paths          )       {
  const root       = { name: "", path: "", dir: true, children: [] }
  const dirs = new Map              ([["", root]])
  const ensure = (dir        )       => {
    const found = dirs.get(dir)
    if (found) return found
    const parent = ensure(path.posix.dirname(dir) === "." ? "" : path.posix.dirname(dir))
    const node       = { name: path.posix.basename(dir), path: dir, dir: true, children: [] }
    parent.children.push(node)
    dirs.set(dir, node)
    return node
  }
  for (const entry of paths) {
    if (entry.endsWith("/")) {
      ensure(entry.slice(0, -1))
      continue
    }
    const parent = path.posix.dirname(entry)
    ensure(parent === "." ? "" : parent).children.push({ name: path.posix.basename(entry), path: entry, dir: false, children: [] })
  }
  const sort = (node      ) => {
    node.children.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.dir ? -1 : 1))
    node.children.forEach(sort)
  }
  sort(root)
  return root
}

function gitStatus(cwd        ) {
  return new Promise                          ((resolve) => {
    execFile("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) return resolve({})
      const out                           = {}
      const entries = stdout.split("\0")
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]
        if (entry.length < 4) continue
        const code = entry.slice(0, 2)
        const file = entry.slice(3)
        if (code[0] === "R") i++ // the next entry is the rename source
        out[file] = code === "??" ? "?" : code.includes("D") ? "D" : code.includes("A") ? "A" : code[0] === "R" ? "R" : "M"
      }
      resolve(out)
    })
  })
}

export async function refreshTree(force = false) {
  const cwd = store.cwd
  if (tree.loading) return
  setTree("loading", true)
  try {
    const [files, git] = await Promise.all([listFiles(cwd, force), gitStatus(cwd)])
    if (tree.cwd !== cwd) setTree("expanded", {})
    setTree({ cwd, root: build(files), git })
  } finally {
    setTree("loading", false)
  }
}

/** Git state of a file, or the "strongest" state below a folder. */
function stateOf(node      )                       {
  if (!node.dir) return tree.git[node.path]
  const prefix = node.path + "/"
  let found
  for (const [file, state] of Object.entries(tree.git)) {
    if (!file.startsWith(prefix)) continue
    if (state === "M" || state === "D") return state
    found = state
  }
  return found
}

const stateColor = (state                      ) =>
  state === "M" || state === "R" ? theme.warning : state === "A" || state === "?" ? theme.success : state === "D" ? theme.error : undefined

const EXT_COLOR                            = {
  ts: () => theme.info,
  tsx: () => theme.info,
  js: () => theme.warning,
  mjs: () => theme.warning,
  json: () => theme.accent,
  md: () => theme.textMuted,
  py: () => theme.secondary,
  rs: () => theme.error,
  go: () => theme.info,
  css: () => theme.accent,
  html: () => theme.error,
  sh: () => theme.success,
}
const extColor = (name        ) => EXT_COLOR[name.split(".").pop()?.toLowerCase() ?? ""]?.() ?? theme.textMuted

function rows()        {
  const out        = []
  const visit = (node      , depth        , guides        ) => {
    node.children.forEach((child, index) => {
      const last = index === node.children.length - 1
      out.push({ node: child, depth, guides, last })
      if (child.dir && tree.expanded[child.path]) visit(child, depth + 1, guides + (last ? "  " : "│ "))
    })
  }
  visit(tree.root, 0, "")
  return out
}

function toggle(node      ) {
  setTree("expanded", node.path, !tree.expanded[node.path])
}

function attach(node      ) {
  insertPromptText(`@${node.path}${node.dir ? "/" : ""} `)
  toast.show({ variant: "info", message: `Attached @${node.path}${node.dir ? "/" : ""}`, duration: 1500 })
}

function TreeRow(props                                                                        ) {
  const [hover, setHover] = createSignal(false)
  const node = () => props.row.node
  const state = createMemo(() => stateOf(node()))
  const edited = createMemo(() => !node().dir && !!store.files[node().path])
  const open = () => !!tree.expanded[node().path]
  const label = () => {
    const room = props.width - props.row.guides.length - 4 - (state() ? 2 : 0)
    const name = node().name + (node().dir ? "/" : "")
    return name.length > room ? name.slice(0, Math.max(1, room - 1)) + "…" : name
  }
  return (
    <box
      flexDirection="row"
      backgroundColor={props.selected ? theme.backgroundElement : hover() ? theme.backgroundElement : undefined}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={(event     ) => {
        props.onSelect?.()
        // Right/middle click attaches; left click opens folders and previews files.
        if (event?.button === 2 || event?.button === 1) attach(node())
        else if (node().dir) toggle(node())
        else previewFile(node().path)
      }}
    >
      <text flexShrink={0} wrapMode="none" fg={theme.borderSubtle}>
        {props.row.guides}
        {props.row.last ? "└" : "├"}
      </text>
      <text flexShrink={0} wrapMode="none" fg={node().dir ? theme.primary : extColor(node().name)}>
        {node().dir ? (open() ? "▾ " : "▸ ") : "• "}
      </text>
      <text
        flexGrow={1}
        flexShrink={1}
        wrapMode="none"
        fg={stateColor(state()) ?? (node().dir ? theme.text : theme.textMuted)}
        attributes={node().dir || edited() ? TextAttributes.BOLD : undefined}
      >
        {label()}
      </text>
      <Show when={state()}>
        <text flexShrink={0} fg={stateColor(state())}>
          {" "}
          {state() === "?" ? "U" : state()}
        </text>
      </Show>
    </box>
  )
}

/** Sidebar section: collapsed by default, tree loads when opened. */
export function FileTreeSection() {
  const list = createMemo(() => (sectionOpen() ? rows() : []))
  const changed = createMemo(() => Object.keys(tree.git).length)
  // Pick up edits Claude makes and anything that changed while a turn ran.
  createEffect(
    on(
      () => [sectionOpen(), store.cwd, Object.keys(store.files).length, store.status]         ,
      ([open, cwd, , status]) => {
        // Collapsed: only the first load, for the "N changed" count.
        if (status !== "running" && (open || tree.cwd !== cwd)) void refreshTree(true)
      },
    ),
  )
  return (
    <box>
      <box flexDirection="row" gap={1}>
        <text fg={theme.text} onMouseUp={() => setSectionOpen((value) => !value)}>
          {sectionOpen() ? "▼" : "▶"}
        </text>
        <text fg={theme.text} flexGrow={1} onMouseUp={() => setSectionOpen((value) => !value)}>
          <b>Files</b>
          <Show when={changed()}>
            <span style={{ fg: theme.warning }}> {changed()} changed</span>
          </Show>
        </text>
        <Show when={sectionOpen()}>
          <text fg={theme.textMuted} onMouseUp={() => setTree("expanded", {})}>
            ⊟
          </text>
          <text fg={tree.loading ? theme.accent : theme.textMuted} onMouseUp={() => void refreshTree(true)}>
            ↻
          </text>
          <text fg={theme.textMuted} onMouseUp={() => openFileTree()}>
            ⤢
          </text>
        </Show>
      </box>
      <Show when={sectionOpen()}>
        <Show when={list().length} fallback={<text fg={theme.textMuted}>{tree.loading ? "Loading…" : "No files"}</text>}>
          <For each={list()}>{(row) => <TreeRow row={row} width={36} />}</For>
        </Show>
        <text fg={theme.textMuted}>click open · right-click @attach</text>
      </Show>
    </box>
  )
}

/** Full-height tree with keyboard navigation (↑↓ move, →← open/close, enter preview, a attach). */
export function DialogFileTree() {
  const dimensions = useTerminalDimensions()
  const [selected, setSelected] = createSignal(0)
  const [filter, setFilter] = createSignal("")
  const list = createMemo(() => {
    const query = filter().toLowerCase()
    if (!query) return rows()
    // Filtering flattens the tree to matching paths.
    const out        = []
    const visit = (node      ) => {
      for (const child of node.children) {
        if (child.path.toLowerCase().includes(query)) out.push({ node: { ...child, name: child.path }, depth: 0, guides: "", last: false })
        if (child.dir) visit(child)
      }
    }
    visit(tree.root)
    return out.slice(0, 500)
  })
  const height = () => Math.max(4, dimensions().height - Math.floor(dimensions().height / 4) - 10)
  const [offset, setOffset] = createSignal(0)
  const visible = createMemo(() => list().slice(offset(), offset() + height()))
  const move = (index        ) => {
    const next = Math.max(0, Math.min(list().length - 1, index))
    setSelected(next)
    if (next < offset()) setOffset(next)
    if (next >= offset() + height()) setOffset(next - height() + 1)
  }
  createEffect(on(filter, () => (setSelected(0), setOffset(0))))
  onMount(() => void refreshTree(true))
  const current = () => list()[selected()]?.node
  const reveal = (target      ) => {
    // From a filtered result back into the tree: expand its parents.
    if (!filter()) return
    const parts = target.path.split("/")
    for (let i = 1; i < parts.length; i++) setTree("expanded", parts.slice(0, i).join("/"), true)
  }
  useLayer({
    priority: 101,
    commands: () => [],
    handler: (event) => {
      const node = current()
      if (event.name === "up" || (event.ctrl && event.name === "p")) return move(selected() - 1), true
      if (event.name === "down" || (event.ctrl && event.name === "n")) return move(selected() + 1), true
      if (event.name === "pageup") return move(selected() - height()), true
      if (event.name === "pagedown") return move(selected() + height()), true
      if (event.name === "home") return move(0), true
      if (event.name === "end") return move(list().length - 1), true
      if (event.name === "right" && node?.dir && !filter()) return setTree("expanded", node.path, true), true
      if (event.name === "left" && node && !filter()) {
        if (node.dir && tree.expanded[node.path]) setTree("expanded", node.path, false)
        else {
          const parent = path.posix.dirname(node.path)
          const index = list().findIndex((row) => row.node.path === parent)
          if (index >= 0) move(index)
        }
        return true
      }
      if (event.name === "return" && node) {
        if (node.dir && !filter()) toggle(node)
        else if (node.dir) {
          reveal(node)
          setTree("expanded", node.path, true)
          setFilter("")
        } else previewFile(node.path)
        return true
      }
      if (event.name === "tab" && node) {
        attach(node)
        dialog.clear()
        return true
      }
      if (event.name === "backspace") return setFilter((value) => value.slice(0, -1)), true
      if (event.sequence && event.sequence.length === 1 && event.sequence >= " " && !event.ctrl && !event.meta) {
        setFilter((value) => value + event.sequence)
        return true
      }
      return false
    },
  })
  return (
    <box paddingLeft={4} paddingRight={4} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Project files <span style={{ fg: theme.textMuted }}>{path.basename(store.cwd)}</span>
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.pop()}>
          esc
        </text>
      </box>
      <text fg={filter() ? theme.text : theme.textMuted}>{filter() ? `⌕ ${filter()}▏` : "⌕ type to filter"}</text>
      <box height={height()}>
        <For each={visible()}>
          {(row, index) => <TreeRow row={row} width={100} selected={index() + offset() === selected()} onSelect={() => setSelected(index() + offset())} />}
        </For>
      </box>
      <text fg={theme.textMuted}>
        ↑↓ move · →← open/close · enter preview · tab attach @file · right-click attach
      </text>
    </box>
  )
}

export function openFileTree() {
  dialog.replace(() => <DialogFileTree />, undefined, "large")
}

/** Read-only preview with syntax highlighting; `a` attaches the file to the prompt. */
export async function previewFile(file        ) {
  const full = path.resolve(store.cwd, file)
  let content
  try {
    const info = await stat(full)
    if (info.size > 2 * 1024 * 1024) throw new Error("file is larger than 2 MB")
    const buffer = await readFile(full)
    if (buffer.subarray(0, 8000).includes(0)) throw new Error("binary file")
    content = buffer.toString("utf8")
  } catch (error) {
    toast.show({ variant: "warning", message: `${file}: ${error instanceof Error ? error.message : error}` })
    return
  }
  const lines = content.split("\n")
  const fromTree = dialog.open
  dialog.push(
    () => <FilePreview file={file} content={lines.slice(0, 3000).join("\n")} total={lines.length} />,
    () => fromTree && dialog.setSize("large"),
  )
  dialog.setSize("xlarge")
}

function FilePreview(props                                                  ) {
  const dimensions = useTerminalDimensions()
  const node = ()       => ({ name: path.basename(props.file), path: props.file, dir: false, children: [] })
  useLayer({
    priority: 102,
    commands: () => [],
    handler: (event) => {
      if (event.name === "a" || event.name === "tab") {
        attach(node())
        dialog.clear()
        return true
      }
      return false
    },
  })
  return (
    <box paddingLeft={4} paddingRight={4} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between" gap={2}>
        <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none" truncate flexShrink={1}>
          {props.file} <span style={{ fg: theme.textMuted }}>{props.total} lines</span>
        </text>
        <box flexDirection="row" gap={2} flexShrink={0}>
          <text
            fg={theme.primary}
            onMouseUp={() => {
              attach(node())
              dialog.clear()
            }}
          >
            a attach
          </text>
          <text fg={theme.textMuted} onMouseUp={() => dialog.pop()}>
            esc
          </text>
        </box>
      </box>
      <scrollbox height={Math.max(6, dimensions().height - Math.floor(dimensions().height / 4) - 6)} scrollbarOptions={{ visible: false }} focused>
        <line_number fg={theme.textMuted} minWidth={3} paddingRight={1}>
          <code conceal={false} fg={theme.text} filetype={filetype(props.file)} syntaxStyle={syntax()} content={props.content} />
        </line_number>
      </scrollbox>
    </box>
  )
}
