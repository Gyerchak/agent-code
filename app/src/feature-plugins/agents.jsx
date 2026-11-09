// occ-agents: a layered "working profile" for Claude, after OpenCodeBox's AgentMixer.
// Pick options per layer (who you are, Claude's role, character, how to think, how to work, …); occ composes
// them into one organised section of Claude's system prompt. Only prompt layers are kept: everything here
// genuinely reaches the model. Library: <occ>/agents/<layer>/<NN-name>.md; your own: ~/.config/open-claude-code/agents.
import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createMemo, createSignal, For, Show } from "solid-js"
import { config, configDir, saveConfig } from "../context/config"
import { registerPromptPart } from "../context/session"
import { tabs } from "../context/tabs"
import { syntax, theme } from "../context/theme"

import { dialog, DialogSelect } from "../ui/dialog"
import { toast } from "../ui/toast"




// Order = order in the composed prompt (broad context first, reference material last).
const LAYERS          = [
  { id: "1-profile", key: "profile", title: "About you", heading: "The user", hint: "who Claude is working with", single: true },
  { id: "2-role", key: "role", title: "Role", heading: "Your role", hint: "what Claude is here to be" },
  { id: "3-character", key: "character", title: "Character", heading: "Character and tone", hint: "personality and voice" },
  { id: "4-logic", key: "logic", title: "Thinking style", heading: "How to think", hint: "reasoning approach" },
  { id: "5-interpretation", key: "interpretation", title: "Reading requests", heading: "How to read requests", hint: "how literally to take you" },
  { id: "6-workflow", key: "workflow", title: "Workflow", heading: "How to work", hint: "working method" },
  { id: "7-rules", key: "rules", title: "Rules", heading: "Rules", hint: "short hard rules", list: true },
  { id: "8-preferences", key: "preferences", title: "Preferences", heading: "Preferences", hint: "technical taste" },
  { id: "9-knowledge", key: "knowledge", title: "Knowledge", heading: "Reference knowledge", hint: "domain notes to keep in mind" },
]

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOTS = [path.resolve(here, "..", "agents"), path.join(configDir, "agents")]

function parse(file        )         {
  const text = readFileSync(file, "utf8")
  const match = text.match(/^---\n([\s\S]*?)\n---\n?/)
  const meta                         = {}
  for (const line of match?.[1].split("\n") ?? []) {
    const index = line.indexOf(":")
    if (index > 0) meta[line.slice(0, index).trim()] = line.slice(index + 1).trim()
  }
  const slug = path.basename(file, ".md").replace(/^\d+-/, "")
  const body = (match ? text.slice(match[0].length) : text).trim()
  const summary = (meta.summary ?? "").replace(/[:…\s]+$/, "")
  return { slug, title: meta.title || slug.replace(/-/g, " "), summary: summary.length > 64 ? summary.slice(0, 63).trimEnd() + "…" : summary, body }
}

/** Options of a layer; files in ~/.config/open-claude-code/agents override the bundled ones by name. */
function options(layer       )           {
  const byName = new Map                ()
  for (const root of ROOTS) {
    const dir = path.join(root, layer.id)
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir).filter((file) => file.endsWith(".md")).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
      try {
        byName.set(name.replace(/^\d+-/, ""), parse(path.join(dir, name)))
      } catch {}
    }
  }
  return [...byName.values()]
}

const [version, setVersion] = createSignal(0)
// v2.6.0 renamed options whose names only made sense in OpenCodeBox; saved picks follow them.
const RENAMED                         = {
  "the-owl": "deep-and-methodical",
  "the-hummingbird": "fast-and-associative",
  "the-griffin": "dive-then-zoom-out",
  daedalus: "structural",
  "the-oracle": "connect-the-dots",
  "the-phoenix": "rebuild-boldly",
  janus: "best-and-worst-case",
  "karpathy-principles": "think-simplify-verify",
  ponytail: "laziest-solution",
  grilling: "interview-first",
  wayfinder: "map-a-foggy-goal",
  maxxim: "bold-creative-work",
  default: "calm-professional",
  elder: "veteran",
  imp: "playful",
  genie: "ambitious",
  executioner: "clean-up",
  "grey-archivist": "historian",
  "trickster-spark": "lateral-thinker",
  "zen-wizard": "calm-minimalist",
  "noir-detective": "detective",
  polyglot: "bridge-builder",
  "api-maestro": "api-designer",
  "migration-surgeon": "migration-specialist",
  "legacy-resurrector": "legacy-revival",
  "bug-bounty": "bug-bounty-hunter",
  "web-dev": "web-developer",
  "game-dev": "game-developer",
  eliteballknowledge: "satirical-ai-art",
  "cachyos-backup": "arch-backup",
  "local-llms": "local-models",
  speed: "fast-reading",
  "user-style-mirror": "mirror-style",
  aiintegration: "agent-practices",
  "typescript-standard": "javascript-standard",
}
const picked = (layer       ) => (version(), (config.agentMix?.[layer.key] ?? []).map((slug) => RENAMED[slug] ?? slug))

function setPicked(layer       , slugs          ) {
  config.agentMix = { ...(config.agentMix ?? {}), [layer.key]: slugs }
  if (!slugs.length) delete config.agentMix[layer.key]
  saveConfig()
  setVersion((value) => value + 1)
  dirty = true
}

function toggle(layer       , slug        ) {
  const current = picked(layer)
  if (current.includes(slug)) setPicked(layer, current.filter((item) => item !== slug))
  else setPicked(layer, layer.single ? [slug] : [...current, slug])
}

// Headings inside an option sit below its own "###" title.
const demote = (body        ) => body.replace(/^(#{1,4}) /gm, (_, hashes        ) => "#".repeat(Math.min(6, hashes.length + 3)) + " ")

/** The composed prompt section, or undefined when nothing is picked. */
export function compose() {
  version()
  const sections           = []
  for (const layer of LAYERS) {
    const chosen = picked(layer)
    if (!chosen.length) continue
    const all = options(layer)
    const items = chosen.map((slug) => all.find((option) => option.slug === slug)).filter(Boolean)
    if (!items.length) continue
    const body = layer.list
      ? items.map((item) => `- **${item.title}.** ${item.body.replace(/\s*\n\s*/g, " ")}`).join("\n")
      : items.map((item) => (items.length > 1 || !layer.single ? `### ${item.title}\n\n${demote(item.body)}` : demote(item.body))).join("\n\n")
    sections.push(`## ${layer.heading}\n\n${body}`)
  }
  if (!sections.length) return undefined
  return [
    "# Working profile",
    "The user chose this profile in occ's Agents panel. Treat it as their standing preferences for how you work; anything they ask in the conversation takes precedence.",
    ...sections,
  ].join("\n\n")
}

// ---------------------------------------------------------------------------
// Where the mix goes. The two .md files are read differently:
//  - System prompt: appended to Claude Code's system prompt in occ's Claude Code tabs (only there).
//  - CLAUDE.md: a marked block in ~/.claude/CLAUDE.md. Claude Code loads it as user memory in every
//    project (also outside occ), as a context message rather than the system prompt. opencode reads that
//    file only when it has no global AGENTS.md.
//  - AGENTS.md: a marked block in opencode's global AGENTS.md (~/.config/opencode/AGENTS.md), which
//    opencode (and occ's opencode tabs) load. Claude Code has no global AGENTS.md, so ~/.claude/CLAUDE.md
//    gets an `@` import of that file instead (the whole file, your own text in it included).
// ---------------------------------------------------------------------------


const home = os.homedir()
const CLAUDE_MD = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude"), "CLAUDE.md")
const AGENTS_MD = path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "opencode", "AGENTS.md")
const tilde = (file        ) => (file.startsWith(home + path.sep) ? "~" + file.slice(home.length) : file)
const TARGETS                                                = [
  { id: "prompt", title: "System prompt", hint: "occ's Claude Code tabs only" },
  { id: "claude", title: "CLAUDE.md", hint: `${tilde(CLAUDE_MD)} · Claude Code everywhere` },
  { id: "agents", title: "AGENTS.md", hint: `${tilde(AGENTS_MD)} · opencode, imported by CLAUDE.md` },
]
const target = ()         => (version(), config.agentMixFile ?? "prompt")

const BLOCK = /\n*<!-- occ-agents:start[^>]*-->[\s\S]*?<!-- occ-agents:end -->\n*/
/** Put `text` in occ's marked block at the end of `file` (or take the block out); the rest is left alone. */
function writeBlock(file        , text                    ) {
  let current = ""
  try {
    current = readFileSync(file, "utf8")
  } catch {}
  const rest = current.replace(BLOCK, "\n").trim()
  const next = text
    ? `${rest ? rest + "\n\n" : ""}<!-- occ-agents:start · written by Open Claude Code (/mix); edit it there -->\n${text}\n<!-- occ-agents:end -->\n`
    : rest
      ? rest + "\n"
      : ""
  if (next === current || (!text && !BLOCK.test(current))) return
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, next)
  } catch (error) {
    toast.show({ variant: "error", message: `Could not write ${tilde(file)}: ${error instanceof Error ? error.message : error}` })
  }
}

/** Bring both files in line with the mix and the chosen target. */
function syncFiles() {
  const mix = compose()
  const where = target()
  writeBlock(AGENTS_MD, where === "agents" ? mix : undefined)
  writeBlock(CLAUDE_MD, where === "claude" ? mix : where === "agents" && mix ? `@${tilde(AGENTS_MD)}` : undefined)
}

function setTarget(value        ) {
  config.agentMixFile = value
  saveConfig()
  setVersion((n) => n + 1)
  dirty = true
}

const tokens = (text                    ) => (text ? Math.ceil(text.length / 4) : 0)
const short = (n        ) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n))

let dirty = false
function applyChanges() {
  if (!dirty) return
  dirty = false
  syncFiles()
  let restarted = 0
  for (const tab of tabs()) if (tab.live && tab.store.status === "idle") (void tab.restart(), restarted++)
  toast.show({ variant: "success", message: restarted ? "Agent mix applied" : "Agent mix applies from the next message", duration: 2500 })
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

function titlesOf(layer       ) {
  const all = options(layer)
  return picked(layer).map((slug) => all.find((option) => option.slug === slug)?.title ?? slug)
}

export function DialogAgents() {
  const options_ = createMemo(() => {
    version()
    const total = tokens(compose())
    return [
      ...LAYERS.map((layer) => {
        const names = titlesOf(layer)
        return {
          title: layer.title,
          value: layer.key,
          description: names.length ? (names.join(", ").length > 52 ? names.join(", ").slice(0, 51) + "…" : names.join(", ")) : layer.hint,
          footer: names.length ? String(names.length) : undefined,
          category: "Layers",
          gutter: <text fg={names.length ? theme.primary : theme.textMuted}>{names.length ? "●" : "○"}</text>,
        }
      }),
      {
        title: "Preview composed prompt",
        value: "preview",
        description: total ? `≈${short(total)} tokens added to every request` : "nothing selected",
        category: "Mix",
      },
      ...(existsSync(OPENCODEBOX) ? [{ title: "Import my OpenCodeBox mix", value: "import", description: "the layers you had selected in AgentMixer", category: "Mix" }] : []),
      {
        title: "Written to",
        value: "target",
        description: TARGETS.find((item) => item.id === target()) .hint,
        footer: TARGETS.find((item) => item.id === target()) .title,
        category: "Mix",
      },
      { title: "Clear everything", value: "clear", description: "Claude goes back to plain Claude Code", category: "Mix" },
    ]
  })
  return (
    <DialogSelect
      title="Agents"
      options={options_()}
      flatten
      onSelect={(option) => {
        if (option.value === "preview") return dialog.push(() => <PreviewDialog title="Composed prompt" text={compose() ?? "_Nothing selected._"} />)
        if (option.value === "clear") {
          for (const layer of LAYERS) if (picked(layer).length) setPicked(layer, [])
          return
        }
        if (option.value === "import") return importOpenCodeBox()
        if (option.value === "target") return dialog.push(() => <DialogTarget />)
        const layer = LAYERS.find((item) => item.key === option.value)
        if (layer) dialog.push(() => <DialogLayer layer={layer} />)
      }}
      footer={
        <text fg={theme.text}>
          enter <span style={{ fg: theme.textMuted }}>open</span>
        </text>
      }
    />
  )
}

function DialogTarget() {
  return (
    <DialogSelect
      title="Write the mix to"
      options={TARGETS.map((item) => ({ title: item.title, value: item.id, description: item.hint }))}
      current={target()}
      onSelect={(option) => {
        setTarget(option.value          )
        dialog.pop()
      }}
    />
  )
}

function DialogLayer(props                  ) {
  const all = options(props.layer)
  const items = createMemo(() => {
    const chosen = picked(props.layer)
    return all.map((option) => {
      const index = chosen.indexOf(option.slug)
      const on = index >= 0
      return {
        title: option.title,
        value: option.slug,
        description: option.summary,
        // Click order is prompt order; show it when several are picked.
        footer: on && chosen.length > 1 && !props.layer.single ? `#${index + 1}` : undefined,
        gutter: (
          <text fg={on ? theme.primary : theme.textMuted}>{props.layer.single ? (on ? "(•)" : "( )") : on ? "[x]" : "[ ]"}</text>
        ),
      }
    })
  })
  return (
    <DialogSelect
      title={`${props.layer.title} · ${props.layer.hint}`}
      options={items()}
      onSelect={(option) => toggle(props.layer, option.value)}
      actions={[
        {
          keybind: "ctrl+o",
          label: "preview",
          run: (option) => {
            const item = all.find((entry) => entry.slug === option.value)
            if (item) dialog.push(() => <PreviewDialog title={item.title} text={item.body} />)
          },
        },
      ]}
      footer={
        <text fg={theme.text}>
          enter <span style={{ fg: theme.textMuted }}>{props.layer.single ? "choose" : "toggle"}</span>
        </text>
      }
    />
  )
}

function PreviewDialog(props                                 ) {
  const dimensions = useTerminalDimensions()
  return (
    <box paddingLeft={4} paddingRight={4} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          {props.title} <span style={{ fg: theme.textMuted }}>≈{short(tokens(props.text))} tokens</span>
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.pop()}>
          esc
        </text>
      </box>
      <scrollbox height={Math.max(6, dimensions().height - Math.floor(dimensions().height / 4) - 6)} scrollbarOptions={{ visible: false }} focused>
        <markdown syntaxStyle={syntax()} content={props.text} fg={theme.markdownText} bg={theme.backgroundPanel} conceal={true} />
      </scrollbox>
    </box>
  )
}

export function AgentsSection() {
  const rows = createMemo(() => {
    version()
    return LAYERS.map((layer) => ({ layer, names: titlesOf(layer) })).filter((row) => row.names.length)
  })
  const total = createMemo(() => tokens(compose()))
  return (
    <box onMouseUp={() => openAgents()}>
      <box flexDirection="row" gap={1}>
        <text fg={theme.text} flexGrow={1}>
          <b>Agents</b>
        </text>
        <Show when={total()}>
          <text fg={theme.textMuted}>
            {target() === "prompt" ? "" : TARGETS.find((item) => item.id === target()) .title + " · "}≈{short(total())} tok
          </text>
        </Show>
      </box>
      <Show when={rows().length} fallback={<text fg={theme.textMuted}>plain Claude · click to mix</text>}>
        <For each={rows()}>
          {(row) => (
            <box flexDirection="row" gap={1}>
              <text fg={theme.textMuted} flexShrink={0} width={11} wrapMode="none">
                {row.layer.title.split(" ")[0]}
              </text>
              <text fg={theme.text} wrapMode="none" flexShrink={1}>
                {row.names.join(", ").length > 26 ? row.names.join(", ").slice(0, 25).trimEnd() + "…" : row.names.join(", ")}
              </text>
            </box>
          )}
        </For>
      </Show>
    </box>
  )
}

export function openAgents() {
  dialog.replace(() => <DialogAgents />, applyChanges, "large")
}

// ---------------------------------------------------------------------------
// Import from OpenCodeBox (its multi layers keep the click order in ORDER files)
// ---------------------------------------------------------------------------

// Optional: set "openCodeBox" in config.json to an OpenCodeBox folder to offer importing its AgentMixer mix.
const OPENCODEBOX = config.openCodeBox ? path.join(config.openCodeBox, "box", "agents") : ""
const BOX_LAYERS                         = {
  profile: "profiles",
  role: "job",
  character: "4characters",
  logic: "1logics",
  interpretation: "interpretation",
  workflow: "3instructions",
  rules: "rules",
  preferences: "preferences",
  knowledge: "2knowledges",
}

function importOpenCodeBox() {
  let count = 0
  for (const layer of LAYERS) {
    const read = (file        ) => {
      try {
        return readFileSync(path.join(OPENCODEBOX, BOX_LAYERS[layer.key], file), "utf8").trim()
      } catch {
        return ""
      }
    }
    const names = (read("ORDER") || read("ACTIVE")).split(/\s+/).filter((name) => name && name !== "0-empty")
    const available = new Set(options(layer).map((option) => option.slug))
    const slugs = names.map((name) => name.replace(/^\d+-/, "").toLowerCase()).filter((slug) => available.has(slug))
    if (layer.key === "rules") {
      const flag = (dir        ) => readFileSync(path.join(OPENCODEBOX, dir, "ON"), "utf8").trim() === "1"
      try {
        if (flag("freewill")) slugs.push("act-on-initiative")
        if (flag("guessing")) slugs.push("guess-when-unsure")
      } catch {}
    }
    setPicked(layer, layer.single ? slugs.slice(0, 1) : slugs)
    count += slugs.length
  }
  toast.show({ variant: "success", message: `Imported ${count} options from OpenCodeBox` })
}

export const agentsPlugin         = (api) => {
  api.lifecycle.onDispose(registerPromptPart("occ-agents", () => (target() === "prompt" ? compose() : undefined)))
  syncFiles()
  api.slots.register({ id: "occ-agents", order: 160, slots: { sidebar_content: () => <AgentsSection /> } })
  api.keymap.registerLayer({
    commands: [{ name: "agents.mix", title: "Agents (working profile)", category: "Agent", slashName: "mix", run: () => openAgents() }],
  })
}
