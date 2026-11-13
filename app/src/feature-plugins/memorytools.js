// Memory as tools, kept small in the context. What is always in the conversation is only an index: each memory's
// name and one line about it (for Claude models Claude Code itself loads MEMORY.md, in an acode-box Agent Code adds
// the box's own list). A memory's text enters a session only when Claude opens it with memory_open; the session
// keeps a list of what it has open, closes what it no longer needs with memory_close, and after a compaction only
// what is still open is added back.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createSignal } from "solid-js"
import { config, saveConfig } from "../context/config"
import { providerKind } from "../context/providers"
import { boxDir } from "../context/box"

const [openVersion, setOpenVersion] = createSignal(0)
export const openMemoriesChanged = openVersion

/** Claude Code's auto-memory folder for a working directory. */
export const autoMemoryDir = (cwd) => path.join(os.homedir(), ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), "memory")
const modelSlug = (model) => model.replace(/[^a-zA-Z0-9.]+/g, "-").replace(/^-|-$/g, "")

/** The store a session uses: an acode-box's own memory/ folder, else the project's auto-memory (or a model's own). */
export function sessionStore(store) {
  if (boxDir) return { dir: path.join(boxDir, "memory"), box: true }
  const full = providerKind(store.model) === "anthropic" || (config.memoryFullAccess ?? []).includes(store.model)
  return { dir: full ? autoMemoryDir(store.cwd) : path.join(path.dirname(autoMemoryDir(store.cwd)), "memory-models", modelSlug(store.model)), box: false }
}

/** One memory file: name, type and a one-line description (front matter, else the file's first real line). */
export function readMemory(file) {
  try {
    const text = readFileSync(file, "utf8")
    const match = text.match(/^---\n([\s\S]*?)\n---\n?/)
    const meta = {}
    for (const line of match?.[1].split("\n") ?? []) {
      const found = line.match(/^\s*(\w+):\s*(.*)$/)
      if (found) meta[found[1]] = found[2].replace(/^["']|["']$/g, "")
    }
    const body = (match ? text.slice(match[0].length) : text).trim()
    const first = body
      .split("\n")
      .map((line) => line.replace(/^[#>*\-\s]+/, "").trim())
      .find((line) => line.length > 8)
    return {
      file,
      name: meta.name || path.basename(file, ".md"),
      type: meta.type ?? "project",
      description: (meta.description || first || "").slice(0, 140),
      body,
      size: text.length,
      time: statSync(file).mtimeMs,
    }
  } catch {
    return undefined
  }
}

/** The memories of a store, newest first. In an auto-memory store MEMORY.md is the index, not a memory. */
export function listMemories({ dir, box }) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((file) => file.endsWith(".md") && (box || file !== "MEMORY.md"))
    .map((file) => readMemory(path.join(dir, file)))
    .filter(Boolean)
    .sort((a, b) => b.time - a.time)
}

const key = (name) => String(name).toLowerCase().replace(/\.md$/, "")

function find(list, name) {
  const wanted = key(name)
  return list.find((memory) => key(memory.name) === wanted || key(path.basename(memory.file)) === wanted)
}

/** The memories a session has open (names), kept per session in the config so they survive restarts. */
export function openMemories(sessionID) {
  openVersion()
  return sessionID ? (config.sessionMemories?.[sessionID] ?? []) : []
}

function setOpen(sessionID, names) {
  if (!sessionID) return
  const all = { ...(config.sessionMemories ?? {}) }
  if (names.length) all[sessionID] = names
  else delete all[sessionID]
  const keys = Object.keys(all)
  for (const old of keys.slice(0, Math.max(0, keys.length - 300))) delete all[old]
  config.sessionMemories = all
  saveConfig()
  setOpenVersion((n) => n + 1)
}

const MAX_OPEN = 24_000

function render(memory) {
  const body = memory.body.length > MAX_OPEN ? `${memory.body.slice(0, MAX_OPEN)}\n\n[… cut at ${MAX_OPEN} characters; the file is ${memory.file}]` : memory.body
  return `## ${memory.name} (${memory.type})\n${body}`
}

/** The index line set an acode-box adds to the system prompt (Claude Code's own index is off there). */
export function boxIndex() {
  const list = listMemories({ dir: path.join(boxDir, "memory"), box: true })
  if (!list.length) return ""
  return list.map((memory) => `- ${path.basename(memory.file, ".md")} — ${memory.description} (${Math.round(memory.size / 1000)}K chars)`).join("\n")
}

/** The text re-added to a session after a compaction: the memories it still has open. */
export function reopenText(session) {
  const names = openMemories(session.store.sessionID)
  if (!names.length) return undefined
  const list = listMemories(sessionStore(session.store))
  const parts = names.map((name) => find(list, name)).filter(Boolean).map(render)
  if (!parts.length) return undefined
  return `Memories this session still has open (added again after the conversation was compacted; close one with memory_close when it is no longer needed):\n\n${parts.join("\n\n")}`
}

const today = () => new Date().toISOString().slice(0, 10)
const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "note"

/** Write or extend a memory. Auto-memory stores keep Claude Code's format (front matter + a line in MEMORY.md). */
function save(store, { name, type, description, content, mode }) {
  mkdirSync(store.dir, { recursive: true })
  const list = listMemories(store)
  const existing = find(list, name)
  if (store.box) {
    // The box's files are dated logs: a fact goes in as one dated line (append), unless asked to replace.
    const file = existing?.file ?? path.join(store.dir, `${slug(name)}.md`)
    // The date is added here: one the model wrote itself ("- 2026-11-13 · …") is dropped, not doubled.
    const fact = content.trim().replace(/\n+/g, " ").replace(/^[-*]\s*/, "").replace(/^\d{4}-\d{2}-\d{2}\s*[·:-]\s*/, "")
    const line = `- ${today()} · ${fact}`
    if (mode === "replace" || !existsSync(file)) writeFileSync(file, mode === "replace" ? `${content.trim()}\n` : `# ${name}\n\n${line}\n`)
    else writeFileSync(file, `${readFileSync(file, "utf8").replace(/\n*$/, "\n")}${line}\n`)
    return `Saved to ${path.relative(path.dirname(store.dir), file)}.`
  }
  const kind = ["user", "feedback", "project", "reference"].includes(type) ? type : existing?.type ?? "project"
  const about = (description || content).replace(/\s+/g, " ").slice(0, 140)
  if (existing && mode !== "new") {
    const body = mode === "append" ? `${existing.body}\n\n${content.trim()}` : content.trim()
    writeFileSync(existing.file, `---\nname: ${existing.name}\ndescription: ${about}\nmetadata:\n  type: ${kind}\n---\n\n${body}\n`)
    return `Updated memory ${existing.name}.`
  }
  let file = path.join(store.dir, `${slug(name)}.md`)
  for (let n = 2; existsSync(file); n++) file = path.join(store.dir, `${slug(name)}-${n}.md`)
  const id = path.basename(file, ".md")
  writeFileSync(file, `---\nname: ${id}\ndescription: ${about}\nmetadata:\n  type: ${kind}\n---\n\n${content.trim()}\n`)
  const index = path.join(store.dir, "MEMORY.md")
  const old = existsSync(index) ? readFileSync(index, "utf8") : ""
  writeFileSync(index, `${old.replace(/\n*$/, old ? "\n" : "")}- [${id}](${id}.md) — ${about.slice(0, 90)}\n`)
  return `Saved new memory ${id}.`
}

const text = (value) => ({ content: [{ type: "text", text: value }] })

/** The memory tools for one session (registered as a tool part of Agent Code's MCP server). */
export function memoryTools(session, { tool, z }) {
  if (config.memoryUse === false) return []
  const store = () => sessionStore(session.store)
  const sid = () => session.store.sessionID
  return [
    tool(
      "memory_list",
      "List this project's memories: name, type, one line about each, and which this session has open. Cheap; the text itself is not included.",
      {},
      async () => {
        const list = listMemories(store())
        if (!list.length) return text("No memories saved yet.")
        const open = new Set(openMemories(sid()).map(key))
        return text(list.map((m) => `- ${path.basename(m.file, ".md")} (${m.type}) — ${m.description}${open.has(key(m.name)) || open.has(key(path.basename(m.file))) ? " [open]" : ""}`).join("\n"))
      },
      { alwaysLoad: true },
    ),
    tool(
      "memory_search",
      "Search the text of every memory for words; returns the matching memories with their matching lines (not the whole text).",
      { query: z.string().describe("Words to look for (all of them, any order, case-insensitive)") },
      async ({ query }) => {
        const words = query.toLowerCase().split(/\s+/).filter(Boolean)
        const hits = []
        for (const memory of listMemories(store())) {
          const all = `${memory.name}\n${memory.description}\n${memory.body}`.toLowerCase()
          if (!words.every((word) => all.includes(word))) continue
          const lines = memory.body.split("\n").filter((line) => words.some((word) => line.toLowerCase().includes(word))).slice(0, 3)
          hits.push(`- ${path.basename(memory.file, ".md")} — ${memory.description}${lines.length ? `\n  ${lines.map((line) => line.trim().slice(0, 180)).join("\n  ")}` : ""}`)
          if (hits.length >= 20) break
        }
        return text(hits.length ? hits.join("\n") : `Nothing in memory matches "${query}".`)
      },
      { alwaysLoad: true },
    ),
    tool(
      "memory_open",
      "Read memories into this conversation because the current step needs their text. Open only what it needs (usually one; memory_search shows where something is). They stay open for this session, and come back after a compaction, until closed with memory_close.",
      { names: z.array(z.string()).min(1).describe("Memory names as listed by memory_list (or the index)") },
      async ({ names }) => {
        const list = listMemories(store())
        const found = names.map((name) => find(list, name))
        const missing = names.filter((_, index) => !found[index])
        const open = new Set(openMemories(sid()))
        for (const memory of found) if (memory) open.add(path.basename(memory.file, ".md"))
        setOpen(sid(), [...open])
        const parts = found.filter(Boolean).map(render)
        return text([...parts, missing.length ? `Not found: ${missing.join(", ")} (see memory_list).` : ""].filter(Boolean).join("\n\n"))
      },
      { alwaysLoad: true },
    ),
    tool(
      "memory_close",
      "Close memories this session no longer needs, so they are not added back after the next compaction.",
      { names: z.array(z.string()).min(1) },
      async ({ names }) => {
        const drop = new Set(names.map(key))
        const left = openMemories(sid()).filter((name) => !drop.has(key(name)))
        setOpen(sid(), left)
        return text(left.length ? `Closed. Still open: ${left.join(", ")}.` : "Closed. No memories open in this session.")
      },
    ),
    tool(
      "memory_save",
      store().box
        ? "Save to this box's memory/ folder: a fact is appended as one dated line to the named file (MEMORY for facts, learned for failures and lessons, progress for progress, sources for how a source is best read)."
        : "Save a memory for future sessions: one memory per topic. type: user (about the user), feedback (how to work, with why), project (ongoing work and its constraints), reference (where to find things). Updates the named memory if it exists.",
      {
        name: z.string().describe("Memory name (short, kebab-case); in a box: MEMORY, learned, progress or sources"),
        content: z.string().describe("The memory text (in a box: just the fact; the date is added)"),
        description: z.string().optional().describe("One line for the index"),
        type: z.enum(["user", "feedback", "project", "reference"]).optional(),
        mode: z.enum(["new", "replace", "append"]).optional().describe("Default: replace an existing memory of that name (a box: append)"),
      },
      async (input) => text(save(store(), input)),
    ),
  ]
}

/** What memory tells the model in the system prompt: how to use the tools (and, in a box, the index itself). */
export function memoryPrompt() {
  if (config.memoryUse === false) return undefined
  const index = boxDir ? boxIndex() : ""
  return `# Memory (Agent Code)
Only the index of memories is in your context: names and one line each${boxDir ? " (listed below)" : " (MEMORY.md)"}. Do not read memory files in bulk. When the current task needs one, open it with mcp__acode__memory_open; find candidates with memory_list or memory_search. Close memories the session no longer needs with memory_close (only open ones are restored after a compaction). Save what is worth keeping for later sessions with memory_save instead of editing memory files by hand.${index ? `\n\nMemories in this box (memory/):\n${index}` : ""}`
}
