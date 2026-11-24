import { findBinary, isWindows, openCommand, spawnOptions } from "./context/platform"
import { ACCESS, ACCESS_ENGINES, accessEngine, accessFor, setAccess, syncAccess } from "./context/access"
import { TextAttributes } from "@opentui/core"
import { authFile, harnessStatus, importFromOpencode, providerKind, providerName, providers, refreshProviders, saveKey, splitModel } from "./context/providers"
import { knownSessionSpend, scanAllSpend } from "./context/spendhistory"
import { otherWindows, sendTabs } from "./context/windows"
import { billingLabel, catalog, CLAUDE_IDS, contextText, modelMeta, priceText, refreshCatalog, SUBAGENT_TIERS, tierModels } from "./context/catalog"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { opencodeBinary } from "./context/acp"
import { desktopState, lanAddress, phoneLink, phoneQr, phoneServerState, phoneSettings, phoneToken, setPhoneSetting, setupDesktop, startPhoneServer, stopDesktop, stopPhoneServer } from "./context/remote"
import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dropsBlocked, selectionWithPaths, textWithPaths } from "./context/attachments"
import { modelVariants } from "./context/variants"
import { boxDir, ownSettings, resetBox, restartBox, setOwnSettings } from "./context/box"
import { ensureMcpFile, importMcp, mcpFile } from "./context/mcp"
import { discoverMods, ensureModsDir, modEnabled, modsDir, modsEnabled, modsShows, setModEnabled, setModsSetting } from "./context/mods"
import { createEffect, createMemo, createResource, createSignal, For, Match, on, onCleanup, onMount, Show, Switch } from "solid-js"
import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { forgetPlan, planRate } from "./context/usage"
import { effortCost, effortStats, refreshEffortStats } from "./context/effortstats"
import { APP_NAME, appVersion } from "./context/version"
import { config, configRevision, listSavedSettings, reloadConfig, resetSettings, restoreSettings, saveConfig, saveSettings } from "./context/config"
import {
  actions,
  exit,
  focusPrompt,
  cycleTranscriptDetail,
  promptMode,
  refs,
  transcriptDetail,
  setPromptMode,
  route,
  setRoute,
  setSidebarOpen,
  showScrollbar,
  sidebarShown,
  toggleDetails,
  toggleScrollbar,
  toggleThinking,
} from "./context/app"
import { allCommands, dispatchKey, leaderActive, onCommandError, runCommand, shortcut, useLayer } from "./context/keymap"
import { AGENTS, agentIndex, agentList, autoResumeChanged, claudeModelList, FABLE_FAMILIES, fableFallback, fableUpgrade, limits, limitWasReset, onSessionEvent, ORCH_DELEGATION, ORCH_POOLS, ORCH_STRATEGIES, orchestrator, describeEntry, guardFor, hasFableWindow, newEntryId, scheduleOf, setSchedule, stopLevel, untilText, whenText, pollPlanUsage, ROUTE_KINDS, ROUTE_LEVELS, strongerModel, subagentRouting, useLimitReset } from "./context/session"
import {
  active,
  app,
  backgroundTasks,
  closeTab,
  closeTabsRight,
  releaseTab,
  reopenTab,
  toggleUnread,
  currentAgent,
  cycleAgent,
  findTab,
  forkSession,
  gotoTab,
  redo,
  revert,
  modelLabel,
  newSession,
  nextTab,
  openSession,
  reconnectMcp,
  refreshMcp,
  refreshSessions,
  send,
  setEffort,
  setFast,
  setMode,
  setModel,
  store,
  tabs,
  toggleMcp,
  undo,
  app as folderApp,
} from "./context/tabs"
import { agentColor, setTheme, themeName, themeList, theme } from "./context/theme"
import { log, logFile } from "./context/log"
import { Logo } from "./component/logo"
import { Prompt, setPromptText } from "./component/prompt"
import { ModBand, ModStatus } from "./component/mods"
import { cycleChild, openChild, Session, subagentParts, TASK_KINDS, taskEntries } from "./routes/session"
import { dialog, DialogConfirm, DialogHost, DialogPrompt, DialogSelect, setDialogRefocus } from "./ui/dialog"
import { toast, ToastHost } from "./ui/toast"
import { TabBar, tabBarVisible } from "./component/tabs"
import { nextSideTab } from "./routes/sidebar"
import { Slot } from "./plugin/slots"
import { pluginRoute, routeRender, showPluginRoute } from "./plugin/routes"
import { deleteSession, getSessionMessages, renameSession } from "@anthropic-ai/claude-agent-sdk"

const EFFORTS                = ["low", "medium", "high", "xhigh", "max"]
const EFFORT_HINTS                         = {
  none: "no reasoning",
  minimal: "barely any reasoning",
  low: "fastest, fewest tokens",
  medium: "balanced",
  high: "deeper reasoning",
  xhigh: "best for most coding",
  max: "maximum effort",
}

/** A model's variants: provider models have their own; Claude models the levels Claude Code reports. */
const variantsOf = (value        ) => modelVariants(value) ?? store.models.find((item) => item.value === value)?.supportedEffortLevels ?? EFFORTS

function lastAssistantText() {
  const turn = store.messages.findLast((m)                        => m.type === "assistant")
  if (!turn) return undefined
  return turn.parts
    .filter((part) => part.type === "text")
    .map((part) => (part                    ).text)
    .join("\n\n")
}

function transcript() {
  const lines           = [`# ${store.title ?? "Session"}`, ""]
  for (const message of store.messages) {
    if (message.type === "user") lines.push(`## User`, "", textWithPaths(message.text, message.attachments), "")
    if (message.type === "assistant") {
      lines.push(`## Assistant (${message.model})`, "")
      for (const part of message.parts) {
        if (part.type === "text") lines.push(part.text, "")
        if (part.type === "tool") lines.push(`> ${part.name} ${JSON.stringify(part.input).slice(0, 300)}`, "")
      }
    }
    if (message.type === "notice") lines.push(`> ${message.text}`, "")
    if (message.type === "shell") lines.push("```", `$ ${message.command}`, message.output, "```", "")
  }
  return lines.join("\n")
}

export function copyText(renderer                                , text        ) {
  let copied = false
  for (const [cmd, args] of [
    ["wl-copy", []],
    ["xclip", ["-selection", "clipboard"]],
    ["xsel", ["--clipboard", "--input"]],
    ["pbcopy", []],
    ...(isWindows ? [["clip", []]] : []),
  ]                        ) {
    try {
      const result = spawnSync(cmd, args, { input: text, stdio: ["pipe", "ignore", "ignore"], timeout: 2000 })
      if (result.status === 0) {
        copied = true
        break
      }
    } catch {}
  }
  if (!copied) copied = renderer.copyToClipboardOSC52(text)
  return copied
}

async function openEditor(renderer                                , initial        , ext = ".md") {
  const editor = process.env.VISUAL || process.env.EDITOR
  if (!editor) {
    toast.show({ variant: "warning", message: "Set $EDITOR to use the external editor" })
    return undefined
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), "agent-code-"))
  const file = path.join(dir, `prompt${ext}`)
  writeFileSync(file, initial)
  await renderer.suspend()
  try {
    spawnSync(editor, [file], { stdio: "inherit", shell: true })
  } finally {
    await renderer.resume()
  }
  return readFileSync(file, "utf8")
}

/**
 * Run a harness's own interactive command (its login, exactly as the harness does it) in this terminal: Agent Code steps
 * aside, the command takes the screen, and Agent Code comes back after Enter.
 */
async function runInTerminal(renderer, file, args, title) {
  await renderer.suspend()
  try {
    process.stdout.write(`\n\x1b[1m${title}\x1b[0m  (${[file, ...args].join(" ")})\n\n`)
    const result = spawnSync(file, args, { stdio: "inherit", ...spawnOptions(file) })
    process.stdout.write(`\n${result.status === 0 ? "Done." : `It ended with code ${result.status ?? "?"}.`} Press Enter to go back to Agent Code… `)
    if (isWindows) spawnSync("cmd", ["/c", "pause >nul"], { stdio: "inherit" })
    else spawnSync("sh", ["-c", "read _"], { stdio: "inherit" })
    return result.status === 0
  } finally {
    await renderer.resume()
  }
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

function DialogCommands() {
  const options = createMemo(() =>
    allCommands()
      .filter((command) => command.palette !== false && (!command.enabled || command.enabled()))
      .map((command) => ({
        title: command.title,
        value: command.id,
        category: command.category ?? "System",
        footer: command.keybind === false ? undefined : shortcut(command.keybind ?? command.id) || undefined,
        description: undefined,
      })),
  )
  return (
    <DialogSelect
      title="Commands"
      options={options()}
      onSelect={(option) => {
        dialog.clear()
        setTimeout(() => runCommand(option.value), 1)
      }}
    />
  )
}

const [favorites, setFavorites] = createSignal          (config.favoriteModels ?? [])

function toggleFavorite(value        ) {
  const list = favorites()
  const next = list.includes(value) ? list.filter((item) => item !== value) : [value, ...list]
  setFavorites(next)
  config.favoriteModels = next
  saveConfig()
}

const [recentTick, setRecentTick] = createSignal(0)
/** Take a model off the Recent list (it stays in its provider's list). */
function forgetRecent(value        ) {
  if (!(config.recentModels ?? []).includes(value)) return false
  config.recentModels = (config.recentModels ?? []).filter((item) => item !== value)
  saveConfig()
  setRecentTick((n) => n + 1)
  return true
}

/**
 * What a model costs: its API price ($ per million input/output tokens) and, for a model paid by a plan, the
 * estimated price on that plan (Claude: from the plan's measured worth, see planRate; OpenCode Go: its listed price).
 */
function priceFacts(value, resolved, providerLabel, names = []) {
  const meta = modelMeta(value, resolved)
  const facts = []
  let footer = billingLabel(meta, providerLabel)
  if (meta.price && (meta.billing === "plan" || meta.billing === "api")) facts.push(`API ${priceText(meta.price)}`)
  if (meta.kind === "anthropic" && meta.billing === "plan" && meta.price) {
    const scoped = (limits.scoped ?? []).find((w) => [value, resolved, ...names].some((v) => String(v ?? "").toLowerCase().includes(w.name.toLowerCase())))
    if (scoped?.allowance) facts.push(`≤${scoped.allowance}% of weekly`)
    const rate = planRate(catalog.planLabel ?? catalog.plan, config.planPrice)
    if (rate?.factor) footer = `${footer} ≈${priceText({ input: meta.price.input * rate.factor, output: meta.price.output * rate.factor })}`
  }
  return { meta, facts, footer }
}

/** Favourite rows for chosen variants carry the variant in their value. */
const FAV_VARIANT = "::variant::"

function moveFavorite(value, to) {
  const list = [...favorites()]
  const from = list.indexOf(value)
  const index = typeof to === "number" ? from + to : list.indexOf(to)
  if (from < 0 || index < 0 || index >= list.length || from === index) return false
  list.splice(from, 1)
  list.splice(index, 0, value)
  setFavorites(list)
  config.favoriteModels = list
  saveConfig()
  return true
}

/** Which variants of a favourite model get their own row under Favorites (none: just the model). */
function DialogFavoriteVariants(props) {
  const [tick, setTick] = createSignal(0)
  const chosen = () => (tick(), config.favoriteVariants?.[props.model] ?? [])
  return (
    <DialogSelect
      title={`Variants to show for ${props.title}`}
      options={[
        ...variantsOf(props.model).map((level) => ({
          title: level,
          value: level,

          gutter: <text fg={chosen().includes(level) ? theme.success : theme.textMuted}>{chosen().includes(level) ? "[x]" : "[ ]"}</text>,
        })),
        { title: "Done", value: "", description: chosen().length ? `${chosen().length} variant row${chosen().length === 1 ? "" : "s"} under Favorites` : "one row: the model with its last variant" },
      ]}
      onSelect={(option) => {
        if (!option.value) return dialog.replace(() => <DialogModels />, undefined, "large")
        const order = variantsOf(props.model)
        const next = chosen().includes(option.value) ? chosen().filter((item) => item !== option.value) : [...chosen(), option.value]
        config.favoriteVariants = { ...(config.favoriteVariants ?? {}), [props.model]: order.filter((item) => next.includes(item)) }
        saveConfig()
        setTick((n) => n + 1)
      }}
    />
  )
}

function cycleFavorite(direction        ) {
  // Provider favourites aren't in Claude Code's list: keep those whose provider is still configured.
  const list = favorites().filter((value) => !!splitModel(value) || !store.models.length || store.models.some((model) => model.value === value))
  if (!list.length) {
    toast.show({ variant: "info", message: "Add a favorite model to use this shortcut", duration: 3000 })
    return
  }
  const index = list.indexOf(store.model)
  const next = index < 0 ? (direction === 1 ? list[0] : list[list.length - 1]) : list[(index + direction + list.length) % list.length]
  void setModel(next)
}

/** The only Claude models offered, in this order; the names are used until a Claude tab has reported its list. */
// Claude models as Claude Code lists them (its newest ones included, e.g. Fable), in this order, others after.
const CLAUDE_ORDER = ["opus", "fable", "sonnet", "haiku"]
const CLAUDE_FALLBACK = [
  { value: "opus", displayName: "Opus", resolvedModel: "claude-opus-5-5" },
  { value: "claude-fable-5-1[1m]", displayName: "Fable", resolvedModel: "claude-fable-5-1" },
  { value: "sonnet", displayName: "Sonnet", resolvedModel: "claude-sonnet-5-5" },
  { value: "haiku", displayName: "Haiku", resolvedModel: "claude-haiku-5-5" },
]
const family = (model) => (model.resolvedModel ?? model.value).match(/opus|fable|sonnet|haiku/i)?.[0]?.toLowerCase()

/** "5.2" from claude-fable-5-2, "5" from claude-opus-5, "4.5" from claude-haiku-4-5-20251001. */
const versionOf = (model) => (model.resolvedModel ?? model.value).match(/-(\d+)(?:-(\d{1,2}))?(?=$|\[|-\d{8})/)
const versionNumber = (model) => {
  const match = versionOf(model)
  return match ? Number(match[1]) + Number(match[2] ?? 0) / 100 : 0
}

/**
 * Every Claude model Claude Code offers ("default" left out), named with its version ("Fable 5.1"). Current ones —
 * Claude Code's aliases (opus, sonnet, haiku, fable) and each family's newest — come first; earlier versions are
 * marked `older`. New models appear here as soon as Claude Code offers them.
 */
function claudeModels() {
  const listed = (store.models.length ? store.models : claudeModelList()).filter((model) => model.value !== "default")
  const list = listed.length ? listed : CLAUDE_FALLBACK
  const newest = {}
  for (const model of list) {
    const key = family(model) ?? model.value
    newest[key] = Math.max(newest[key] ?? 0, versionNumber(model))
  }
  const rank = (model) => {
    const index = CLAUDE_ORDER.indexOf(family(model) ?? "")
    return (index < 0 ? CLAUDE_ORDER.length : index) * 1000 - versionNumber(model)
  }
  return [...list]
    .sort((a, b) => rank(a) - rank(b))
    .map((model) => {
      const version = versionOf(model)
      const name = model.displayName.replace(/\s*\(.*\)$/, "")
      const label = version && !/\d/.test(name) ? `${name} ${version[1]}${version[2] ? `.${version[2]}` : ""}` : name
      const alias = CLAUDE_ORDER.includes(model.value)
      const older = !alias && versionNumber(model) < (newest[family(model) ?? model.value] ?? 0)
      return { ...model, displayName: label, older }
    })
}

const FAMILY_TITLE = { opus: "Opus", sonnet: "Sonnet", haiku: "Haiku" }
const nextIn = (list, value) => list[(list.indexOf(value) + 1) % list.length]

/** Fable fallback settings: on/off, the model it falls back to, how many levels its reasoning goes up. */
function DialogFableFallback() {
  const rule = () => (configRevision(), fableFallback())
  const save = (change) => {
    config.fableFallback = { ...fableFallback(), ...change }
    saveConfig()
  }
  return (
    <DialogSelect
      title="Fable fallback"
      options={[
        { title: "Fable fallback", value: "enabled", description: "at the Fable limit a Fable tab goes on with another model", footer: rule().enabled ? "on" : "off" },
        { title: "Fall back to", value: "model", description: "enter: next model", footer: FAMILY_TITLE[rule().model] },
        { title: "Reasoning", value: "step", description: "levels above the Fable tab's own (enter: next)", footer: `+${rule().step}` },
      ]}
      onSelect={(option) => {
        if (option.value === "enabled") save({ enabled: !rule().enabled })
        if (option.value === "model") save({ model: nextIn(FABLE_FAMILIES, rule().model) })
        if (option.value === "step") save({ step: (rule().step + 1) % 4 })
      }}
    />
  )
}

/** Back to Fable settings: on/off, and for Opus, Sonnet and Haiku whether they return and how many levels lower. */
function DialogFableUpgrade() {
  const rule = () => (configRevision(), fableUpgrade())
  const save = (change) => {
    const now = fableUpgrade()
    config.fableUpgrade = { enabled: now.enabled, models: now.models, ...change }
    saveConfig()
  }
  const setModel = (family, change) => save({ models: { ...rule().models, [family]: { ...rule().models[family], ...change } } })
  return (
    <DialogSelect
      title="Back to Fable"
      options={[
        {
          title: "Back to Fable",
          value: "enabled",
          description: "after a used-up Fable limit resets, these tabs return to Fable",
          footer: rule().enabled ? "on" : "off",
        },
        ...FABLE_FAMILIES.flatMap((family) => [
          { title: FAMILY_TITLE[family], value: `on:${family}`, description: `${FAMILY_TITLE[family]} tabs return to Fable`, footer: rule().models[family].on ? "on" : "off", category: FAMILY_TITLE[family] },
          { title: `${FAMILY_TITLE[family]} reasoning`, value: `step:${family}`, description: "levels lower on Fable (enter: next)", footer: `-${rule().models[family].step}`, category: FAMILY_TITLE[family] },
        ]),
      ]}
      onSelect={(option) => {
        const [kind, family] = option.value.split(":")
        if (kind === "enabled") save({ enabled: !rule().enabled })
        if (kind === "on") setModel(family, { on: !rule().models[family].on })
        if (kind === "step") setModel(family, { step: (rule().models[family].step + 1) % 4 })
      }}
    />
  )
}

/**
 * Select all: the whole chat goes to the clipboard, and the part of it on screen is highlighted (a terminal app can
 * only mark what is drawn).
 */
function selectAll(renderer) {
  const scroll = refs.scroll
  if (copyText(renderer, transcript())) toast.show({ variant: "success", message: "Whole chat selected and copied", duration: 2000 })
  if (!scroll || scroll.isDestroyed) return
  try {
    const first = (function find(node) {
      for (const child of node.getChildren?.() ?? []) {
        if (child.selectable) return child
        const found = find(child)
        if (found) return found
      }
    })(scroll)
    if (!first) return
    renderer.startSelection(first, scroll.x, scroll.y)
    // Widen the selection to the whole chat column, one container up at a time.
    const inside = (node) => {
      for (let at = scroll; at; at = at.parent) if (at === node) return true
      return false
    }
    for (let i = 0; i < 40 && !inside(renderer.getSelectionContainer?.()); i++) renderer.updateSelection(undefined, scroll.x + scroll.width - 1, scroll.y + scroll.height - 1)
    renderer.updateSelection(undefined, scroll.x + scroll.width - 1, scroll.y + scroll.height - 1, { finishDragging: true })
  } catch (error) {
    log("select all", error)
  }
}

/** "HH:MM" or a number of minutes → a time (ms), or undefined. */
function parseWhen(text, from = Date.now()) {
  const value = text.trim()
  const clock = value.match(/^(\d{1,2}):(\d{2})$/)
  if (clock) {
    const date = new Date(from)
    date.setHours(Number(clock[1]), Number(clock[2]), 0, 0)
    if (date.getTime() <= from) date.setDate(date.getDate() + 1)
    return date.getTime()
  }
  if (/^\d+$/.test(value)) return from + Number(value) * 60_000
  return undefined
}

const WINDOW_TITLES = { fiveHour: "5-hour limit", week: "weekly limit", fable: "Fable limit" }

// ---------------------------------------------------------------------------
// Schedules (sidebar rows above Access: Schedules, Resume at, Stop at, Break)
// ---------------------------------------------------------------------------

/** "stop", "resume" or "break" (a break's stop and resume share a group). */
const kindOf = (entry) => (entry.group ? "break" : entry.kind)
/** Planned times first, then limit levels, then the near-any-limit stop. */
const entryOrder = (a, b) => (a.at ?? Infinity) - (b.at ?? Infinity) || (a.guard ? 1 : 0) - (b.guard ? 1 : 0)

/** Add entries to the focused tab's schedule (`replace`: entry ids that go). */
function addToSchedule(entries, replace = []) {
  const sid = store.sessionID
  setSchedule(sid, [...scheduleOf(sid).filter((entry) => !replace.includes(entry.id)), ...entries])
}

/** A time typed in a prompt (HH:MM, or minutes after `from`), handed to `then`. */
function askTime(title, then, from) {
  dialog.push(() => (
    <DialogPrompt
      title={title}
      placeholder="e.g. 23:30, or 90 (minutes)"
      onConfirm={(text) => {
        const time = parseWhen(text, from)
        if (!time) return toast.show({ variant: "warning", message: "Write a time like 23:30 or a number of minutes" })
        dialog.pop()
        then(time)
      }}
    />
  ))
}

/** Freeze (or, when all are frozen, unfreeze) the planned entries of one kind ("all" for everything). */
function freezeKind(kind) {
  const sid = store.sessionID
  const list = scheduleOf(sid)
  const hit = (entry) => kind === "all" || kindOf(entry) === kind
  const chosen = list.filter(hit)
  if (!chosen.length) return toast.show({ variant: "info", message: "Nothing planned there yet" })
  const freeze = chosen.some((entry) => !entry.frozen)
  setSchedule(sid, list.map((entry) => (hit(entry) ? { ...entry, frozen: freeze || undefined } : entry)))
  toast.show({ variant: "info", message: `${freeze ? "Frozen (kept, not acted on)" : "Active again"}: ${chosen.length} planned ${kind === "all" ? "" : `${kind} `}entr${chosen.length === 1 ? "y" : "ies"}` })
}

const openSchedules = () => dialog.push(() => <DialogSchedules />, undefined, "large")

/**
 * Everything planned for this tab: stops, resumes, breaks. Enter freezes or unfreezes one (kept, not acted on);
 * ctrl+e (or a right click) edits it, ctrl+d deletes it; below, add more, or push them to other sessions.
 */
function DialogSchedules() {
  const [tick, setTick] = createSignal(0)
  const refresh = () => setTick((n) => n + 1)
  const list = () => (tick(), configRevision(), scheduleOf(store.sessionID))
  const options = createMemo(() => {
    const all = list()
    const rows = []
    const seen = new Set()
    for (const entry of [...all].sort(entryOrder)) {
      if (entry.group) {
        if (seen.has(entry.group)) continue
        seen.add(entry.group)
        const parts = all.filter((item) => item.group === entry.group)
        const stop = parts.find((item) => item.kind === "stop")
        const back = parts.find((item) => item.kind === "resume")
        const frozen = parts.every((item) => item.frozen)
        rows.push({
          title: `Break ${stop ? whenText(stop.at) : "(on now)"} → ${back ? whenText(back.at) : "until you resume"}`,
          value: `group:${entry.group}`,
          category: "Breaks",
          footer: frozen ? "frozen" : untilText((stop ?? back).at),
          gutter: <text fg={frozen ? theme.textMuted : theme.success}>{frozen ? "[ ]" : "[x]"}</text>,
        })
        continue
      }
      rows.push({
        title: describeEntry(entry),
        value: `entry:${entry.id}`,
        category: entry.kind === "resume" ? "Resume at" : "Stops",
        description: entry.guard ? "each time" : entry.window ? "once" : undefined,
        footer: entry.frozen ? "frozen" : entry.at ? untilText(entry.at) : "",
        gutter: <text fg={entry.frozen ? theme.textMuted : theme.success}>{entry.frozen ? "[ ]" : "[x]"}</text>,
      })
    }
    return [
      ...rows,
      { title: "Plan a stop…", value: "add:stop", category: "Add", description: "a time, a limit level, or near any limit each time", gutter: <text fg={theme.textMuted}>{" + "}</text> },
      { title: "Plan a resume…", value: "add:resume", category: "Add", description: "automatic continues wait for it, never earlier", gutter: <text fg={theme.textMuted}>{" + "}</text> },
      { title: "Plan a break…", value: "add:break", category: "Add", description: "stop now or later, then resume (or not)", gutter: <text fg={theme.textMuted}>{" + "}</text> },
      { title: "Push to other sessions…", value: "push", category: "Other sessions", description: "open tabs, all sessions, new ones — all or one kind", gutter: <text fg={theme.textMuted}>{" ⇉ "}</text> },
      ...(all.length ? [{ title: "Delete everything planned here", value: "clear", category: "Other sessions", gutter: <text fg={theme.textMuted}>{" ✕ "}</text> }] : []),
    ]
  })
  const idsOf = (value) => {
    const [type, id] = value.split(":")
    if (type === "group") return list().filter((entry) => entry.group === id).map((entry) => entry.id)
    if (type === "entry") return [id]
    return []
  }
  const remove = (value) => {
    const ids = idsOf(value)
    if (!ids.length) return false
    setSchedule(store.sessionID, list().filter((entry) => !ids.includes(entry.id)))
    refresh()
  }
  const editRow = (value) => {
    const ids = idsOf(value)
    if (!ids.length) return false
    const entry = list().find((item) => item.id === ids[0])
    if (entry.group) dialog.push(() => <DialogBreak edit={entry.group} onDone={refresh} />)
    else if (entry.kind === "resume") dialog.push(() => <DialogAddResume edit={entry} onDone={refresh} />)
    else dialog.push(() => <DialogAddStop edit={entry} onDone={refresh} />)
  }
  return (
    <DialogSelect
      title="Schedules · this tab"
      memoryKey="schedules"
      options={options()}
      emptyText="Nothing planned"
      onSelect={(option) => {
        const [type, id] = option.value.split(":")
        if (type === "add") {
          if (id === "stop") return dialog.push(() => <DialogAddStop onDone={refresh} />)
          if (id === "resume") return dialog.push(() => <DialogAddResume onDone={refresh} />)
          return dialog.push(() => <DialogBreak onDone={refresh} />)
        }
        if (type === "push") return dialog.push(() => <DialogPushSchedules />)
        if (type === "clear") {
          setSchedule(store.sessionID, [])
          toast.show({ variant: "info", message: "Nothing planned for this tab now" })
          return refresh()
        }
        const ids = idsOf(option.value)
        const freeze = list().some((entry) => ids.includes(entry.id) && !entry.frozen)
        setSchedule(store.sessionID, list().map((entry) => (ids.includes(entry.id) ? { ...entry, frozen: freeze || undefined } : entry)))
        refresh()
      }}
      onRightClick={(option) => editRow(option.value)}
      actions={[
        { keybind: "ctrl+e", label: "edit", run: (option) => editRow(option.value) },
        { keybind: "ctrl+d", label: "delete", run: (option) => remove(option.value) },
      ]}
      footer={
        <text fg={theme.text}>
          enter <span style={{ fg: theme.textMuted }}>freeze / unfreeze · right click: edit</span>
        </text>
      }
    />
  )
}

/**
 * Plan a stop: near any limit each time (one per tab), once at an exact limit level, or at a time. `edit`: the entry
 * it replaces.
 */
function DialogAddStop(props) {
  const sid = store.sessionID
  const known = (key) => stopLevel(key) !== undefined
  const used = (key) => Math.round(stopLevel(key) ?? 0)
  const guard = guardFor(sid)
  const done = (entries, message, replace = []) => {
    addToSchedule(entries, [...(props.edit ? [props.edit.id] : []), ...replace])
    toast.show({ variant: "info", message })
    props.onDone?.()
    dialog.pop()
  }
  const setGuard = (level) => {
    const old = scheduleOf(sid).filter((entry) => entry.kind === "stop" && entry.guard).map((entry) => entry.id)
    done(level ? [{ id: newEntryId(), kind: "stop", guard: level }] : [], level ? `Stop near any limit at ${level}% · each time` : "No stop near the limits", old)
  }
  const exact = (key) =>
    dialog.push(() => (
      <DialogPrompt
        title={`Stop once at what % of the ${WINDOW_TITLES[key]}?`}
        placeholder={known(key) ? `now ${used(key)}% · e.g. ${Math.min(100, used(key) + 15)}, or +10 for 10% more` : "e.g. 85"}
        onConfirm={(value) => {
          const text = value.trim()
          const more = text.match(/^\+\s*(\d+(?:\.\d+)?)\s*%?$/)
          if (more && !known(key)) return toast.show({ variant: "warning", message: "The level now isn't read yet: write the % to stop at" })
          const level = more ? used(key) + Number(more[1]) : Number(text.replace("%", ""))
          if (!Number.isFinite(level) || level <= used(key) || level > 100) return toast.show({ variant: "warning", message: `Write a level above the ${used(key)}% used now (up to 100), or +N` })
          dialog.pop()
          done([{ id: newEntryId(), kind: "stop", window: key, percent: Math.round(level * 10) / 10 }], `Stop once at ${WINDOW_TITLES[key]} ${Math.round(level * 10) / 10}%`)
        }}
      />
    ))
  const nearExact = () =>
    dialog.push(() => (
      <DialogPrompt
        title="Stop near any limit at what %?"
        placeholder="e.g. 93 (from 50 to 100)"
        onConfirm={(value) => {
          const level = Number(value.trim().replace("%", ""))
          if (!Number.isFinite(level) || level < 50 || level > 100) return toast.show({ variant: "warning", message: "Write a level from 50 to 100" })
          dialog.pop()
          setGuard(Math.round(level * 10) / 10)
        }}
      />
    ))
  const atTime = (time) => done([{ id: newEntryId(), kind: "stop", at: time }], `Stop at ${whenText(time)} (${untilText(time)})`)
  const options = []
  const near = "Near any limit · each time (5-hour, weekly, Fable)"
  for (const level of [80, 90, 95, 98, 99])
    options.push({ title: `At ${level}%`, value: `guard:${level}`, category: near, description: level === 95 ? "default" : undefined, gutter: <text fg={guard.on && guard.at === level ? theme.primary : theme.textMuted}>{guard.on && guard.at === level ? "(•)" : "( )"}</text> })
  options.push({ title: "At an exact %…", value: "guard:exact", category: near, description: guard.on && ![80, 90, 95, 98, 99].includes(guard.at) ? `now ${guard.at}%` : "from 50 to 100" })
  options.push({ title: "Off", value: "guard:off", category: near, gutter: <text fg={!guard.on ? theme.primary : theme.textMuted}>{!guard.on ? "(•)" : "( )"}</text> })
  const windows = [...(limits.rolling === false ? [] : ["fiveHour"]), "week", ...(hasFableWindow() ? ["fable"] : [])]
  for (const key of windows) {
    const now = used(key)
    const title = `Once · ${WINDOW_TITLES[key]} ${known(key) ? `(now ${now}%)` : "(not read yet)"}`
    options.push({ title: "At an exact %…", value: `exact:${key}`, category: title, description: known(key) ? "any level, or +N from now" : "any level" })
    for (const level of (key === "fiveHour" ? [70, 80, 90, 95] : [50, 75, 90]).filter((level) => level > now)) options.push({ title: `At ${level}%`, value: `level:${key}:${level}`, category: title })
    if (key === "fiveHour" && known(key)) for (const more of [5, 10, 20].filter((more) => now + more <= 100)) options.push({ title: `${more}% more from now`, value: `level:${key}:${now + more}`, category: title, description: `at ${now + more}%` })
  }
  for (const [minutes, label] of [[15, "In 15 minutes"], [30, "In 30 minutes"], [60, "In 1 hour"], [120, "In 2 hours"]]) options.push({ title: label, value: `in:${minutes}`, category: "At a time" })
  options.push({ title: "At a time…", value: "time", category: "At a time", description: "HH:MM, or a number of minutes" })
  return (
    <DialogSelect
      title={props.edit ? `Change: ${describeEntry(props.edit)}` : "Plan a stop"}
      options={options}
      onSelect={(option) => {
        const [kind, key, value] = option.value.split(":")
        if (kind === "guard") return key === "exact" ? nearExact() : setGuard(key === "off" ? 0 : Number(key))
        if (kind === "exact") return exact(key)
        if (kind === "level") return done([{ id: newEntryId(), kind: "stop", window: key, percent: Number(value) }], `Stop once at ${WINDOW_TITLES[key]} ${value}%`)
        if (kind === "in") return atTime(Date.now() + Number(key) * 60_000)
        if (kind === "time") askTime("Stop at (HH:MM) or after N minutes", atTime)
      }}
      footer={
        <text fg={theme.text}>
          enter <span style={{ fg: theme.textMuted }}>plan it · a limit stop goes on when that limit resets</span>
        </text>
      }
    />
  )
}

/** Plan a resume (a time). It also holds back automatic continues after a limit until then — never earlier. */
function DialogAddResume(props) {
  const done = (time) => {
    addToSchedule([{ id: newEntryId(), kind: "resume", at: time }], props.edit ? [props.edit.id] : [])
    toast.show({ variant: "info", message: `Resume at ${whenText(time)} (${untilText(time)})` })
    props.onDone?.()
    dialog.pop()
  }
  const paused = store.pause
  return (
    <DialogSelect
      title={props.edit ? `Change: ${describeEntry(props.edit)}` : `Plan a resume${paused ? ` · now ${paused.until ? `paused until ${whenText(paused.until)}` : "paused until you resume"}` : ""}`}
      options={[
        ...[[15, "In 15 minutes"], [30, "In 30 minutes"], [60, "In 1 hour"], [120, "In 2 hours"], [240, "In 4 hours"]].map(([minutes, label]) => ({ title: label, value: String(minutes), category: "Resume" })),
        { title: "At a time…", value: "time", category: "Resume", description: "HH:MM, or a number of minutes" },
      ]}
      onSelect={(option) => (option.value === "time" ? askTime("Resume at (HH:MM) or after N minutes", done) : done(Date.now() + Number(option.value) * 60_000))}
      footer={
        <text fg={theme.text}>
          <span style={{ fg: theme.textMuted }}>it ends a stop or pause then; a continue after a limit waits for it (never earlier)</span>
        </text>
      }
    />
  )
}

/**
 * A break: first when to stop (now, unless a time is picked), then when to go on (or not: until you resume).
 * `edit`: the group it replaces.
 */
function DialogBreak(props) {
  // `stopAt` given (0: now): this is the second step, when to go on.
  const stopAt = () => props.stopAt || undefined
  const step = () => (props.stopAt === undefined ? 1 : 2)
  const finish = (back) => {
    const group = newEntryId()
    const replace = props.edit ? scheduleOf(store.sessionID).filter((entry) => entry.group === props.edit).map((entry) => entry.id) : []
    const start = stopAt()
    const entries = [...(start ? [{ id: newEntryId(), kind: "stop", at: start, group }] : []), ...(back ? [{ id: newEntryId(), kind: "resume", at: back, group }] : [])]
    addToSchedule(entries, replace)
    if (!start) active().pause(back, "break", undefined, group)
    toast.show({ variant: "info", message: `Break ${start ? `at ${whenText(start)}` : "now"}${back ? `, back at ${whenText(back)}` : ", until you resume"}` })
    props.onDone?.()
    dialog.pop()
  }
  const from = () => stopAt() ?? Date.now()
  const options = createMemo(() =>
    step() === 1
      ? [
          { title: "Now", value: "now", category: "Stop when?", description: "ctrl+click on Break does this at once" },
          ...[[15, "In 15 minutes"], [30, "In 30 minutes"], [60, "In 1 hour"]].map(([minutes, label]) => ({ title: label, value: String(minutes), category: "Stop when?" })),
          { title: "At a time…", value: "time", category: "Stop when?", description: "HH:MM, or a number of minutes" },
        ]
      : [
          { title: "Not set: until I resume", value: "none", category: `Resume when? (stop ${stopAt() ? whenText(stopAt()) : "now"})` },
          ...[[15, "15 minutes later"], [30, "30 minutes later"], [60, "1 hour later"], [120, "2 hours later"]].map(([minutes, label]) => ({ title: label, value: String(minutes), category: `Resume when? (stop ${stopAt() ? whenText(stopAt()) : "now"})` })),
          { title: "At a time…", value: "time", category: `Resume when? (stop ${stopAt() ? whenText(stopAt()) : "now"})`, description: "HH:MM, or minutes after the stop" },
        ],
  )
  return (
    <DialogSelect
      title={props.edit ? "Change the break" : "Break (stop, then resume)"}
      options={options()}
      onSelect={(option) => {
        if (step() === 1) {
          // The second step is a dialog of its own (a fresh search line: what was typed for the first doesn't stay).
          const next = (time) => {
            dialog.pop()
            dialog.push(() => <DialogBreak edit={props.edit} onDone={props.onDone} stopAt={time ?? 0} />)
          }
          if (option.value === "now") return next(undefined)
          if (option.value === "time") return askTime("Stop at (HH:MM) or after N minutes", next)
          return next(Date.now() + Number(option.value) * 60_000)
        }
        if (option.value === "none") return finish(undefined)
        if (option.value === "time") return askTime("Resume at (HH:MM) or N minutes after the stop", finish, from())
        finish(from() + Number(option.value) * 60_000)
      }}
    />
  )
}

/**
 * Push this tab's schedule to other sessions: what (everything, or only stops, resumes or breaks), how (added to
 * theirs, or replacing theirs of those kinds), to whom (open tabs, every session in this folder, new sessions), then
 * yes or no.
 */
function DialogPushSchedules() {
  const sid = store.sessionID
  const [what, setWhat] = createSignal("all")
  const [how, setHow] = createSignal("add")
  const [to, setTo] = createSignal(new Set(["open"]))
  const openIds = () => [...new Set(tabs().map((tab) => tab.store.sessionID).filter((id) => id && id !== sid))]
  const folderIds = () => [...new Set([...openIds(), ...(folderApp.sessions ?? []).map((item) => item.sessionId)].filter((id) => id && id !== sid))]
  const dot = (on) => <text fg={on ? theme.primary : theme.textMuted}>{on ? "(•)" : "( )"}</text>
  const box = (on) => <text fg={on ? theme.success : theme.textMuted}>{on ? "[x]" : "[ ]"}</text>
  const options = createMemo(() => [
    ...[["all", "Everything planned"], ["stop", "Only stops"], ["resume", "Only resumes"], ["break", "Only breaks"]].map(([key, title]) => ({ title, value: `what:${key}`, category: "What", gutter: dot(what() === key) })),
    { title: "Add to theirs", value: "how:add", category: "How", gutter: dot(how() === "add") },
    { title: "Replace theirs (of those kinds)", value: "how:replace", category: "How", gutter: dot(how() === "replace") },
    { title: `Open tabs (${openIds().length})`, value: "to:open", category: "To", gutter: box(to().has("open")) },
    { title: `Every session in this folder (${folderIds().length})`, value: "to:all", category: "To", description: "closed ones too", gutter: box(to().has("all")) },
    { title: "New sessions", value: "to:new", category: "To", description: "what they start with", gutter: box(to().has("new")) },
    { title: "Yes, push", value: "yes", category: "Are you sure?" },
    { title: "No, cancel", value: "no", category: "Are you sure?" },
  ])
  const push = () => {
    const pick = (entry) => what() === "all" || kindOf(entry) === what()
    const mine = scheduleOf(sid).filter(pick)
    const targets = [...new Set([...(to().has("open") ? openIds() : []), ...(to().has("all") ? folderIds() : [])])]
    if (!targets.length && !to().has("new")) return toast.show({ variant: "warning", message: "Tick where to push it, or choose No" })
    const copies = () => {
      const groups = new Map()
      return mine.map((entry) => ({ ...entry, id: newEntryId(), ...(entry.group ? { group: groups.get(entry.group) ?? groups.set(entry.group, newEntryId()).get(entry.group) } : {}) }))
    }
    const apply = (id) => {
      let theirs = scheduleOf(id)
      if (how() === "replace") theirs = theirs.filter((entry) => !pick(entry))
      // One near-any-limit stop per tab: a pushed one replaces theirs.
      if (mine.some((entry) => entry.guard)) theirs = theirs.filter((entry) => !entry.guard)
      setSchedule(id, [...theirs, ...copies()])
    }
    for (const id of targets) apply(id)
    if (to().has("new")) apply(undefined)
    toast.show({ variant: "success", message: `Pushed ${mine.length} planned entr${mine.length === 1 ? "y" : "ies"} to ${targets.length} session${targets.length === 1 ? "" : "s"}${to().has("new") ? " and new sessions" : ""}` })
    dialog.pop()
  }
  return (
    <DialogSelect
      title="Push this tab's schedule"
      options={options()}
      onSelect={(option) => {
        const [type, key] = option.value.split(":")
        if (type === "what") return setWhat(key)
        if (type === "how") return setHow(key)
        if (type === "to")
          return setTo((now) => {
            const next = new Set(now)
            if (next.has(key)) next.delete(key)
            else next.add(key)
            return next
          })
        if (type === "no") return dialog.pop()
        if (type === "yes") push()
      }}
    />
  )
}

// ---------------------------------------------------------------------------
// Worktrees and the session terminal (opencode's desktop has both; here each opens in its own window)
// ---------------------------------------------------------------------------

const gitOut = (cwd, ...args) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 15_000 })
  return result.status === 0 ? String(result.stdout).trim() : undefined
}

/** A new terminal window running `command` in `cwd` (acode-window finds the terminal app). */
/** A new terminal window running `command`; false (with a note) where none can be opened from here. */
function openWindow(cwd, command, title) {
  const launcher = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "acode-window")
  if (isWindows || !existsSync(launcher)) {
    toast.show({ variant: "warning", message: `Open a terminal in ${cwd} and run: ${command.join(" ")}`, duration: 8000 })
    return false
  }
  try {
    spawn(launcher, ["--title", title, ...command], { cwd, detached: true, stdio: "ignore" }).unref()
    return true
  } catch (error) {
    log("open window", error)
    return false
  }
}

/** A tab can change windows once it has a conversation; a running turn has to end first (its engine restarts there). */
const tabHasChat = () => !!store.sessionID && store.messages.some((m) => m.type === "user")
function tabMovable() {
  if (!tabHasChat()) return false
  if (store.status === "running") {
    toast.show({ variant: "warning", message: "Wait for the turn to end (or interrupt it) before moving the tab" })
    return false
  }
  return true
}

const openWorktree = (dir) => openWindow(dir, [path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "acode"), dir], APP_NAME)

/** Git worktrees of this project: pick one to open Agent Code there in a new window, or make a new one. */
function DialogWorktrees() {
  const list = () =>
    (gitOut(store.cwd, "worktree", "list", "--porcelain") ?? "")
      .split("\n\n")
      .map((block) => ({ dir: block.match(/^worktree (.+)$/m)?.[1], branch: block.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? "(detached)" }))
      .filter((item) => item.dir)
  return (
    <DialogSelect
      title="Worktrees"
      emptyText="Not a git repository"
      options={[
        ...list().map((item) => ({ title: item.branch, value: item.dir, description: item.dir, footer: item.dir === store.cwd ? "here" : "open in a new window" })),
        ...(gitOut(store.cwd, "rev-parse", "--show-toplevel") ? [{ title: "New worktree…", value: "new", description: "a new branch in its own folder, from a base branch you choose" }] : []),
      ]}
      onSelect={(option) => {
        if (option.value === "new") return newWorktree()
        dialog.clear()
        if (option.value !== store.cwd) openWorktree(option.value)
      }}
    />
  )
}

/** New worktree: a name, then the base branch (opencode's "Choose base branch"), then it opens in a new window. */
function newWorktree() {
  const root = gitOut(store.cwd, "rev-parse", "--show-toplevel")
  if (!root) return toast.show({ variant: "warning", message: "Not a git repository" })
  dialog.replace(() => (
    <DialogPrompt
      title="New worktree: branch name"
      placeholder="e.g. fix-login"
      onConfirm={(name) => {
        name = name.trim().replace(/\s+/g, "-")
        if (!name) return dialog.clear()
        const branches = (gitOut(root, "for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads") ?? "").split("\n").filter(Boolean)
        const current = gitOut(root, "branch", "--show-current")
        dialog.replace(() => (
          <DialogSelect
            title={`Base branch for ${name}`}
            current={current}
            options={branches.map((branch) => ({ title: branch, value: branch, description: branch === current ? "current" : undefined }))}
            onSelect={(base) => {
              const dir = path.join(path.dirname(root), `${path.basename(root)}-${name}`)
              const made = spawnSync("git", ["worktree", "add", "-b", name, dir, base.value], { cwd: root, encoding: "utf8", timeout: 60_000 })
              dialog.clear()
              if (made.status !== 0) return toast.show({ variant: "error", title: "Worktree not created", message: String(made.stderr || made.stdout).trim().slice(0, 300), duration: 8000 })
              toast.show({ variant: "success", message: `Worktree ${name} (from ${base.value}) at ${dir}`, duration: 5000 })
              openWorktree(dir)
            }}
          />
        ))
      }}
    />
  ))
}

/**
 * The session's own terminal: a window in the tab's folder. With zellij or tmux installed it is a named session that
 * keeps running (and its scrollback) when the window or Agent Code closes; opening it again attaches to it.
 */
function openTerminal() {
  const name = `acode-${(store.sessionID ?? path.basename(store.cwd)).replace(/[^a-zA-Z0-9]/g, "").slice(0, 12)}`
  const zellij = findBinary("zellij")
  const tmux = findBinary("tmux")
  const command = zellij ? [zellij, "attach", "--create", name] : tmux ? [tmux, "new-session", "-A", "-s", name] : [process.env.SHELL || "sh"]
  openWindow(store.cwd, command, `${store.title?.slice(0, 40) ?? "Terminal"} · terminal`)
  if (!zellij && !tmux) toast.show({ variant: "info", message: "Opened a plain shell. Install zellij or tmux and the session's terminal will survive closing its window.", duration: 6000 })
}

function DialogStash() {
  const [list, setList] = createSignal(config.stash ?? [])
  return (
    <DialogSelect
      title="Stash"
      options={list().map((text, index) => ({ title: text.replace(/\s+/g, " ").slice(0, 100), value: String(index) }))}
      emptyText="Nothing stashed"
      onSelect={(option) => {
        const index = Number(option.value)
        const text = list()[index]
        config.stash = list().filter((_, i) => i !== index)
        saveConfig()
        dialog.clear()
        setPromptText(text)
      }}
      actions={[
        {
          keybind: "ctrl+d",
          label: "delete",
          run: (option) => {
            config.stash = list().filter((_, i) => i !== Number(option.value))
            saveConfig()
            setList(config.stash)
          },
        },
      ]}
    />
  )
}

function DialogSkills() {
  return (
    <DialogSelect
      title="Skills and commands"
      options={store.commands.map((command) => ({
        title: "/" + command.name,
        value: command.name,
        description: command.description?.replace(/\s+/g, " ").slice(0, 90) || undefined,
      }))}
      onSelect={(option) => {
        dialog.clear()
        setPromptText(`/${option.value} `)
      }}
    />
  )
}

const CONNECTABLE = [
  { id: "opencode-go", name: "OpenCode Go", hint: "API key from opencode.ai (Go plan)" },
  { id: "opencode-zen", name: "OpenCode Zen", hint: "API key from opencode.ai (Zen)" },
  { id: "ollama", name: "Ollama", hint: "server URL, e.g. http://127.0.0.1:11434" },
  { id: "ollama-cloud", name: "Ollama Cloud", hint: "API key from ollama.com" },
  { id: "deepseek", name: "DeepSeek", hint: "API key from platform.deepseek.com (DeepSeek models, and DeepSeek Harness)" },
  { id: "openai", name: "OpenAI", hint: "API key from platform.openai.com (OpenAI models, and Codex)" },
]

const CLAUDE_USAGE_URL = "https://claude.ai/settings/usage"

function openURL(url        ) {
  const [command, openArgs] = openCommand(url)
  try {
    spawn(command, openArgs, { detached: true, stdio: "ignore", windowsHide: true }).unref()
    toast.show({ variant: "info", message: `Opened ${url}`, duration: 2500 })
  } catch {
    toast.show({ variant: "warning", message: url, duration: 8000 })
  }
}

/** Claude's extra usage: live status and exact spend from Anthropic; switching it happens on claude.ai. */
function DialogExtraUsage() {
  onMount(() => void pollPlanUsage(true))
  const extra = () => limits.extra
  const money = (minor        ) => {
    const e = extra()
    return e ? new Intl.NumberFormat("en-US", { style: "currency", currency: e.currency }).format(minor / 10 ** e.exponent) : ""
  }
  const options = createMemo(() => {
    const e = extra()
    if (!e)
      return [
        { title: "Not available", value: "none", description: "extra usage is reported for claude.ai plans logged in through Claude Code" },
        { title: "Open claude.ai usage settings", value: "open", description: CLAUDE_USAGE_URL },
      ]
    return [
      { title: "Status", value: "status", description: e.enabled ? "on: usage credits cover you past the plan limits" : "off: requests stop at the plan limits", footer: e.enabled ? "on" : "off" },
      { title: "Spent", value: "spent", description: "extra usage charged this month, exactly as Anthropic reports it", footer: money(e.used) },
      ...(e.limit ? [{ title: "Monthly limit", value: "limit", description: "spending stops here", footer: money(e.limit) }] : []),
      {
        title: e.enabled ? "Turn off on claude.ai" : "Turn on on claude.ai",
        value: "open",
        // Anthropic exposes no public endpoint for switching it; Agent Code re-reads the state when you come back.
        description: e.canToggle ? "opens the usage settings; Agent Code picks up the change" : "your account can't switch it here; opens the usage settings",
      },
      { title: "Refresh", value: "refresh", description: "read the current state from Anthropic" },
    ]
  })
  return (
    <DialogSelect
      title="Claude extra usage"
      options={options()}
      onSelect={(option) => {
        if (option.value === "open") openURL(CLAUDE_USAGE_URL)
        if (option.value === "refresh" || option.value === "open") void pollPlanUsage(true)
      }}
    />
  )
}

function DialogConnect() {
  // The usual ones plus every provider in Agent Code's own list (e.g. several Ollama Cloud accounts).
  const own = Object.entries(config.providers ?? {})
    .filter(([id]) => !CONNECTABLE.some((item) => item.id === id))
    .map(([id, entry]) => ({ id, name: entry.name ?? id, hint: entry.baseURL ?? "" }))
  return (
    <DialogSelect
      title="Connect provider"
      options={[
        ...[...CONNECTABLE, ...own].map((item) => ({
          title: item.name,
          value: item.id,
          description: item.hint,
          footer: providers.list.some((provider) => provider.id === item.id) ? "connected" : undefined,
          category: "Providers",
        })),
        { title: "Edit keys file", value: ":keys", description: authFile.replace(os.homedir(), "~"), category: "Keys" },
        { title: "Import from opencode", value: ":import", description: "copy providers, keys and MCP servers Agent Code doesn't have yet", category: "Keys" },
      ]}
      onSelect={(option) => {
        if (option.value === ":keys") {
          if (!existsSync(authFile)) saveKey("", undefined)
          return openURL(authFile)
        }
        if (option.value === ":import") {
          const done = importFromOpencode(true)
          const servers = importMcp(true)
          void refreshProviders()
          return toast.show({ variant: "success", message: `Imported ${done.providers} providers, ${done.keys} keys and ${servers} MCP servers` })
        }
        dialog.replace(() => (
          <DialogPrompt
            title={option.value === "ollama" ? "Ollama server URL" : `${option.title} API key`}
            placeholder={option.value === "ollama" ? "http://127.0.0.1:11434" : "sk-…"}
            onConfirm={(value) => {
              const entry = { ...(config.providers?.[option.value] ?? {}) }
              if (option.value === "ollama") entry.baseURL = value.trim() || undefined
              else {
                // Keys live in Agent Code's own key store, never in config.json.
                saveKey(option.value, value.trim() || undefined)
                delete entry.apiKey
              }
              config.providers = { ...(config.providers ?? {}), [option.value]: entry }
              saveConfig()
              void refreshProviders().then((list) => {
                const ok = list.some((provider) => provider.id === option.value)
                toast.show({ variant: ok ? "success" : "warning", message: ok ? `${option.title} connected` : `${option.title} not reachable` })
              })
              dialog.replace(() => <DialogModels />, undefined, "large")
            }}
          />
        ))
      }}
    />
  )
}

function DialogModels() {
  const renderer = useRenderer()
  // The live provider list: harnesses add their models in the background once they answer.
  const external = () => providers.list
  onMount(() => {
    void refreshProviders()
    void refreshCatalog()
  })
  const options = createMemo(() => {
    recentTick()
    const recent = config.recentModels ?? []
    const favs = favorites()
    // Description: context and the API price; footer: who pays and, on a plan, the estimated price there.
    const option = (model                                                                          , category        ) => {
      const price = priceFacts(model.value, model.resolvedModel, model.provider, [model.displayName])
      const facts = [price.meta.context ? `${contextText(price.meta.context)} ctx` : "", ...(price.meta.kind === "anthropic" ? price.facts : [])].filter(Boolean).join(" · ")
      return {
        title: model.displayName,
        value: model.value,
        description: facts + (favs.includes(model.value) && category !== "Favorites" ? (facts ? " · " : "") + "favourite" : ""),
        category,
        footer: price.footer,
      }
    }
    // Provider models look like Anthropic ones to the picker: "<provider>/<model>".
    const models = [
      ...claudeModels().filter((model) => !model.older).map((model) => ({ ...model, provider: "Anthropic" })),
      ...external().flatMap((provider) =>
        provider.models.map((model) => ({
          value: `${provider.id}/${model.id}`,
          displayName: model.label ?? model.id,
          description: "",
          provider: provider.name,
          appOnly: model.appOnly,
        })),
      ),
    ]
    // Earlier Claude versions last, in their own group.
    models.push(...claudeModels().filter((model) => model.older).map((model) => ({ ...model, provider: "Anthropic · older" })))
    const byValue = (value        ) => models.find((model) => model.value === value)
    // A favourite with chosen variants gets one row for each of them.
    const favorite = favs
      .map(byValue)
      .filter(Boolean)
      .flatMap((model) => {
        const row = option(model, "Favorites")
        const levels = (config.favoriteVariants?.[model.value] ?? []).filter((level) => variantsOf(model.value).includes(level))
        if (!levels.length) return [row]
        return levels.map((level) => ({ ...row, title: `${row.title} · ${level}`, value: `${model.value}${FAV_VARIANT}${level}` }))
      })
    // A favourite or recent model shows in each list it belongs to, its provider's included.
    const recents = recent
      .map(byValue)
      .filter(Boolean)
      .map((model) => option(model       , "Recent"))
    const rest = models.map((model) => option(model       , model.provider))
    // Harnesses that aren't installed yet: one row each saying how to get them.
    const missing = harnessStatus()
      .filter((harness) => !harness.installed)
      .map((harness) => ({ title: `${harness.name} — not installed`, value: `install:${harness.id}`, description: harness.install, category: "More harnesses", footer: "install" }))
    return [...favorite, ...recents, ...rest, ...missing].map((item) => ({ ...item, description: item.description || undefined }))
  })
  return (
    <DialogSelect
      title="Select model"
      options={options()}
      current={store.model}
      onSelect={(option) => {
        if (option.value.startsWith("install:")) {
          const harness = harnessStatus().find((item) => `install:${item.id}` === option.value)
          if (harness && copyText(renderer, harness.install.split("   ")[0]))
            toast.show({ variant: "info", title: `Install ${harness.name}`, message: `Copied: ${harness.install}`, duration: 10000 })
          return
        }
        if (modelMeta(option.value).billing === "app-only" && !opencodeBinary()) {
          toast.show({ variant: "warning", message: "OpenCode Zen's free models run through opencode itself: install opencode (https://opencode.ai) first.", duration: 6000 })
          return
        }
        if (option.value.includes(FAV_VARIANT)) {
          const [model, level] = option.value.split(FAV_VARIANT)
          void Promise.resolve(setModel(model)).then(() => setEffort(level))
          dialog.clear()
          return
        }
        void setModel(option.value)
        // Like opencode: a model with variants continues to the variant picker.
        // A model with variants asks for one the first time; afterwards its stored level comes back.
        if (variantsOf(option.value).length && config.modelEffort?.[option.value] === undefined) {
          dialog.replace(() => <DialogEffort />)
          return
        }
        dialog.clear()
      }}
      onReorder={(from, to) => {
        // Only favourites move, and only among themselves.
        const a = from.split(FAV_VARIANT)[0]
        const b = to.split(FAV_VARIANT)[0]
        return favorites().includes(a) && favorites().includes(b) && a !== b ? moveFavorite(a, b) : false
      }}
      actions={[
        {
          keybind: "model.dialog.favorite",
          label: "favorite",
          run: (option) => {
            const value = option.value.split(FAV_VARIANT)[0]
            if (value.startsWith("install:")) return
            const adding = !favorites().includes(value)
            toggleFavorite(value)
            // A new favourite with variants: pick which of them get a row.
            if (adding && variantsOf(value).length) dialog.replace(() => <DialogFavoriteVariants model={value} title={option.title} />)
          },
        },
        { keybind: "ctrl+v", label: "variants shown", run: (option) => { const value = option.value.split(FAV_VARIANT)[0]; if (!favorites().includes(value) || !variantsOf(value).length) return false; dialog.replace(() => <DialogFavoriteVariants model={value} title={option.title.split(" · ")[0]} />) } },
        { keybind: "ctrl+up", label: "move up", run: (option) => void moveFavorite(option.value.split(FAV_VARIANT)[0], -1) },
        { keybind: "ctrl+down", label: "move down", run: (option) => void moveFavorite(option.value.split(FAV_VARIANT)[0], 1) },
        {
          keybind: "model.dialog.forget",
          label: "remove from recent",
          run: (option) => {
            if (!forgetRecent(option.value)) toast.show({ variant: "info", message: "Not on the Recent list", duration: 2000 })
          },
        },
      ]}
    />
  )
}

/**
 * Variants with what each really costs: the price per token is the same at every level, the tokens are not. Each
 * row shows the measured average of one request at that level (price and output tokens), from Claude Code's own
 * transcripts of your past work; a level never used shows nothing.
 */
function DialogEffort() {
  const levels = createMemo(() => variantsOf(store.model))
  onMount(() => void refreshEffortStats())
  // The model's full id (an alias like "haiku" may not be resolved yet before its first reply).
  const modelId = () =>
    store.modelId ?? store.models.find((item) => item.value === store.model)?.resolvedModel ?? CLAUDE_IDS[store.model] ?? String(store.model).replace(/\[.*$/, "")
  const price = () => modelMeta(store.model, modelId()).price
  const measured = (level) => {
    if (splitModel(store.model)) return undefined
    const cost = effortCost(modelId(), level === "default" ? undefined : level, price())
    if (!cost) return undefined
    const tokens = cost.output >= 1000 ? `${(cost.output / 1000).toFixed(1)}K` : String(cost.output)
    return `${cost.dollars !== undefined ? `≈$${cost.dollars < 0.1 ? cost.dollars.toFixed(3) : cost.dollars.toFixed(2)} a request · ` : ""}${tokens} out · ${cost.requests.toLocaleString()} measured`
  }
  return (
    <DialogSelect
      title={`Variant · ${modelLabel()}${price() ? ` · API ${priceText(price())}/M` : ""}`}
      options={[
        { title: "default", value: "default", footer: (effortStats(), measured("default")) },
        ...levels().map((level) => ({ title: level, value: level, footer: (effortStats(), measured(level)) })),
      ]}
      current={store.effort ?? "default"}
      onSelect={(option) => {
        void setEffort(option.value === "default" ? undefined : (option.value               ))
        dialog.clear()
      }}
    />
  )
}

const PERMISSION_MODES = [
  { value: "default", title: "Default", description: "ask before edits and commands" },
  { value: "acceptEdits", title: "Accept edits", description: "auto-approve file edits" },
  { value: "plan", title: "Plan", description: "read-only planning" },
  { value: "auto", title: "Auto", description: "classifier approves safe actions" },
  { value: "dontAsk", title: "Don't ask", description: "deny anything not pre-approved" },
  { value: "bypassPermissions", title: "Bypass permissions", description: "skip all permission checks" },
]

/** A new mode in three steps: its name, how it asks for permission, what the model is told while it is on. */
function addAgentMode() {
  dialog.replace(() => (
    <DialogPrompt
      title="New mode: name"
      placeholder="e.g. Review, Docs, Careful"
      onConfirm={(name) => {
        name = name.trim()
        if (!name) return dialog.replace(() => <DialogAgents />)
        dialog.replace(() => (
          <DialogSelect
            title={`${name}: permissions`}
            options={PERMISSION_MODES}
            onSelect={(mode) =>
              dialog.replace(() => (
                <DialogPrompt
                  title={`${name}: instruction for the model (empty: none)`}
                  placeholder="e.g. Only review and comment; change nothing unless asked"
                  onConfirm={(prompt) => {
                    const id = `mode-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now().toString(36)}`
                    config.agentModes = [...(config.agentModes ?? []), { id, name, mode: mode.value, prompt: prompt.trim() }]
                    saveConfig()
                    active().setAgent(id)
                    dialog.clear()
                    toast.show({ variant: "success", message: `Mode "${name}" added; this session is on it now` })
                  }}
                />
              ))
            }
          />
        ))
      }}
    />
  ))
}

/** Modes: Build, Plan and your own (click "agents" in the footer, or ctrl+tab). The chosen one is kept per session. */
function DialogAgents() {
  const [tick, setTick] = createSignal(0)
  return (
    <DialogSelect
      title="Modes"
      options={[
        ...(tick(), agentList()).map((agent, index) => ({
          title: agent.name,
          value: agent.id,
          description:
            agent.id === "build"
              ? "Default agent, executes tools per your permissions"
              : agent.id === "plan"
                ? "Plan mode, read-only exploration"
                : `${PERMISSION_MODES.find((item) => item.value === agent.mode)?.title ?? agent.mode}${agent.prompt ? ` · ${agent.prompt.slice(0, 60)}` : ""}`,
          category: index < AGENTS.length ? "Primary" : "Your modes (kept per session)",
          gutter: <text fg={agentColor(index)}>●</text>,
        })),
        { title: "Add a mode…", value: "mode:add", description: "a name, its permissions and an instruction for the model", category: "Your modes (kept per session)" },
        ...store.agents.map((agent) => ({
          title: agent.name,
          value: `subagent:${agent.name}`,
          description: agent.description.slice(0, 80),
          category: "Subagents (mention with @)",
        })),
      ]}
      current={currentAgent().id}
      onSelect={(option) => {
        if (option.value.startsWith("subagent:")) {
          setPromptText(`@agent-${option.value.slice(9)} `)
          dialog.clear()
          return
        }
        if (option.value === "mode:add") return addAgentMode()
        active().setAgent(option.value)
        dialog.clear()
      }}
      actions={[
        {
          keybind: "ctrl+d",
          label: "delete your mode",
          run: (option) => {
            if (!(config.agentModes ?? []).some((mode) => mode.id === option.value)) return
            if (currentAgent().id === option.value) active().setAgent("build")
            config.agentModes = config.agentModes.filter((mode) => mode.id !== option.value)
            saveConfig()
            setTick((n) => n + 1)
          },
        },
      ]}
    />
  )
}

function DialogPermissionMode() {
  const modes = PERMISSION_MODES
  return (
    <DialogSelect
      title="Permission mode"
      options={modes}
      current={store.mode}
      onSelect={(option) => {
        void setMode(option.value)
        dialog.clear()
      }}
    />
  )
}

function relativeTime(ms        ) {
  const diff = Date.now() - ms
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(ms).toLocaleDateString()
}

function dayCategory(ms        ) {
  const date = new Date(ms)
  const today = new Date()
  if (date.toDateString() === today.toDateString()) return "Today"
  const yesterday = new Date(Date.now() - 86_400_000)
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday"
  return date.toDateString()
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The folder a Claude Code session was started in, from its transcript (first line with a cwd), if it is anywhere. */
function sessionFolder(id) {
  const root = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"), "projects")
  try {
    for (const project of readdirSync(root)) {
      const file = path.join(root, project, `${id}.jsonl`)
      if (!existsSync(file)) continue
      for (const line of readFileSync(file, "utf8").split("\n", 50)) {
        const cwd = line.match(/"cwd":"((?:[^"\\]|\\.)*)"/)?.[1]
        if (cwd) return JSON.parse(`"${cwd}"`)
      }
      return undefined
    }
  } catch {}
  return undefined
}

function DialogSessions() {
  onMount(() => void refreshSessions())
  const [typed, setTyped] = createSignal("")
  const options = createMemo(() => {
    const list = app.sessions.map((session) => ({
      title: (session.customTitle ?? session.summary ?? session.firstPrompt ?? session.sessionId).replace(/\s+/g, " "),
      value: session.sessionId,
      category: dayCategory(session.lastModified),
      footer: (() => {
        // What the session has cost (its subagents included), as last counted.
        const spent = knownSessionSpend(app.cwd, session.sessionId)
        const money = spent ? ` · $${(spent.main + spent.sub).toFixed(2)}` : ""
        return (findTab(session.sessionId) ? "open · " : "") + relativeTime(session.lastModified) + money
      })(),
      // A session can be found by its id (or the start of it), as in opencode 2.3.
      keywords: session.sessionId,
    }))
    // A full session id that isn't listed (a child session of this folder, or one from another folder).
    const id = typed().trim()
    if (SESSION_ID.test(id) && !list.some((item) => item.value === id)) {
      const where = sessionFolder(id)
      if (where === store.cwd) list.unshift({ title: `Open session ${id}`, value: id, category: "By id", footer: "open", keywords: id, byId: true })
      else if (where) list.unshift({ title: `Session ${id}`, value: `elsewhere:${where}`, category: "By id", description: `in ${where}: open Agent Code there`, keywords: id })
    }
    return list
  })
  return (
    <DialogSelect
      title="Sessions"
      options={options()}
      current={store.sessionID}
      startAtTop
      onFilter={setTyped}
      emptyText="No sessions yet in this directory"
      onSelect={(option) => {
        if (option.value.startsWith("elsewhere:")) return toast.show({ variant: "info", message: `That session belongs to ${option.value.slice(10)}: open Agent Code in that folder to continue it`, duration: 6000 })
        dialog.clear()
        setRoute("session")
        void openSession(option.value, option.byId ? undefined : option.title)
      }}
      actions={[
        {
          keybind: "ctrl+d",
          label: "delete",
          run: (option) => {
            if (findTab(option.value)) {
              toast.show({ variant: "warning", message: "Close its tab before deleting this session" })
              return
            }
            void deleteSession(option.value, { dir: app.cwd }).then(() => refreshSessions())
          },
        },
        {
          keybind: "ctrl+r",
          label: "rename",
          run: (option) =>
            dialog.replace(() => (
              <DialogPrompt
                title="Rename session"
                value={option.title}
                onConfirm={(value) => {
                  void renameSession(option.value, value, { dir: app.cwd }).then(() => refreshSessions())
                  findTab(option.value)?.rename(value)
                  dialog.replace(() => <DialogSessions />, undefined, "large")
                }}
              />
            )),
        },
      ]}
    />
  )
}

function DialogThemes() {
  const initial = themeName()
  let confirmed = false
  return (
    <DialogSelect
      title="Themes"
      options={[...themeList()]
        .sort()
        .map((name) => ({ title: name, value: name }))}
      current={initial}
      onMove={(option) => setTheme(option.value, false)}
      onSelect={(option) => {
        confirmed = true
        setTheme(option.value)
        dialog.clear()
      }}
    />
  )
  void confirmed
}

function DialogMcp() {
  onMount(() => void refreshMcp())
  return (
    <DialogSelect
      title="MCP servers"
      options={store.mcp.map((server) => ({
        title: server.name,
        value: server.name,
        description: server.scope ? `(${server.scope})` : undefined,
        footer: server.status,
        gutter: (
          <text
            fg={
              server.status === "connected"
                ? theme.success
                : server.status === "failed"
                  ? theme.error
                  : server.status === "disabled"
                    ? theme.textMuted
                    : theme.warning
            }
          >
            ⊙
          </text>
        ),
      }))}
      emptyText="No MCP servers yet — ctrl+e opens Agent Code's MCP file"
      onSelect={(option) => {
        const server = store.mcp.find((item) => item.name === option.value)
        if (!server) return
        void toggleMcp(server.name, server.status === "disabled")
      }}
      actions={[
        { keybind: "ctrl+r", label: "reconnect", run: (option) => void reconnectMcp(option.value) },
        // Agent Code's own servers live in its secrets file, auth.json (restart the tab after editing it).
        { keybind: "ctrl+e", label: "edit Agent Code servers", run: () => (ensureMcpFile(), openURL(mcpFile)) },
      ]}
      footer={<text fg={theme.text}>enter <span style={{ fg: theme.textMuted }}>toggle</span></text>}
    />
  )
}

function DialogStatus() {
  return (
    <box gap={1} paddingBottom={1} paddingLeft={4} paddingRight={4}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Status
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.pop()}>
          esc
        </text>
      </box>
      <box>
        <text fg={theme.text}>
          {APP_NAME} <span style={{ fg: theme.textMuted }}>{appVersion()}</span>
        </text>
        <text fg={theme.text}>
          {store.engine ? (harnessStatus().find((item) => item.id === store.engine)?.name ?? store.engine) : "Claude Code"}{" "}
          <span style={{ fg: theme.textMuted }}>{store.engine ? (store.engineVersion ?? "") : (store.version ?? "starting…")}</span>
        </text>
        <text fg={theme.textMuted}>Account: {store.account?.email ?? "unknown"}</text>
        <Show when={store.account?.subscriptionType}>
          <text fg={theme.textMuted}>Plan: {store.account .subscriptionType}</text>
        </Show>
        <text fg={theme.textMuted}>Model: {modelLabel()} ({store.modelId ?? store.model})</text>
        <text fg={theme.textMuted}>Permission mode: {store.mode}</text>
        <Show when={store.outputStyle}>
          <text fg={theme.textMuted}>Output style: {store.outputStyle}</text>
        </Show>
        <text fg={theme.textMuted}>Session: {store.sessionID ?? "(new)"}</text>
        <text fg={theme.textMuted}>Directory: {store.cwd}</text>
        <text fg={theme.textMuted}>Log: {logFile}</text>
      </box>
      <Show when={store.mcp.length}>
        <box>
          <text fg={theme.text}>
            <b>MCP</b>
          </text>
          <For each={store.mcp}>
            {(server) => (
              <text fg={theme.textMuted}>
                <span style={{ fg: server.status === "connected" ? theme.success : server.status === "failed" ? theme.error : theme.textMuted }}>
                  •
                </span>{" "}
                {server.name} <span>{server.status}</span>
              </text>
            )}
          </For>
        </box>
      </Show>
    </box>
  )
}

const clock = (time         ) => (time ? new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : undefined)

/** Port of opencode's timeline: moving scrolls to the prompt, choosing opens its actions. */
function DialogTimeline() {
  onMount(() => dialog.setSize("large"))
  const options = createMemo(() =>
    store.messages
      .filter((m)                   => m.type === "user" && !!m.text.trim())
      .map((m) => ({ title: m.text.replace(/\n/g, " "), value: m.id, footer: clock(m.time) }))
      .reverse(),
  )
  return (
    <DialogSelect
      title="Timeline"
      options={options()}
      flatten
      emptyText="No messages yet"
      onMove={(option) => actions.reveal(option.value)}
      onSelect={(option) => dialog.replace(() => <DialogMessage messageID={option.value} />)}
    />
  )
}

/** Port of opencode's message actions (dialog-message.tsx): Jump to, Revert, Copy, Fork. */
function DialogMessage(props                       ) {
  const renderer = useRenderer()
  const message = () => store.messages.find((m)                   => m.type === "user" && m.id === props.messageID)
  // A queued message isn't in the conversation yet: it can only be viewed and copied.
  const delivered = () => !message()?.queued
  return (
    <DialogSelect
      title="Message Actions"
      flatten
      options={[
        { title: "Jump to", value: "message.jump", description: "view message in session" },
        ...(delivered() ? [{ title: "Revert", value: "session.revert", description: "undo messages and file changes" }] : []),
        { title: "Copy", value: "message.copy", description: "message text to clipboard" },
        ...(delivered() ? [{ title: "Fork", value: "session.fork", description: "create a new session" }] : []),
      ]}
      onSelect={async (option) => {
        const msg = message()
        dialog.clear()
        if (!msg) return
        if (option.value === "message.jump") {
          actions.reveal(msg.id)
          return
        }
        if (option.value === "session.revert") {
          if (await revert(msg.id)) setPromptText(msg.text)
          return
        }
        if (option.value === "message.copy") {
          if (copyText(renderer, textWithPaths(msg.text, msg.attachments))) toast.show({ variant: "success", message: "Copied to clipboard" })
          return
        }
        const forked = await forkSession(msg.id)
        if (!forked) {
          toast.show({ variant: "error", message: "Could not fork this conversation" })
          return
        }
        setPromptText(msg.text)
      }}
    />
  )
}

/**
 * Tasks of this tab by type (subagents, shells, terminals, monitors…), running first, finished below. The "Show"
 * rows filter by type: Enter adds or removes a type, "only" (or right-click) shows that type alone.
 */
function DialogTasks() {
  const [tick, setTick] = createSignal(0)
  const shown = () => (tick(), configRevision(), config.taskKinds?.length ? config.taskKinds : undefined)
  const setShown = (kinds) => {
    config.taskKinds = kinds && kinds.length && kinds.length < TASK_KINDS.length ? kinds : undefined
    saveConfig()
    setTick((value) => value + 1)
  }
  const options = createMemo(() => {
    const entries = taskEntries()
    const present = TASK_KINDS.filter((kind) => entries.some((entry) => entry.kind === kind.id))
    const filter = shown()
    const visible = filter ? entries.filter((entry) => filter.includes(entry.kind)) : entries
    const order = (entry           ) => TASK_KINDS.findIndex((kind) => kind.id === entry.kind) * 2 + (entry.running ? 0 : 1)
    const rows = visible
      .sort((a, b) => order(a) - order(b))
      .map((entry) => ({
        title: entry.title,
        value: entry.key,
        category: `${TASK_KINDS.find((kind) => kind.id === entry.kind).title}${entry.running ? " · running" : " · finished"}`,
        footer: entry.failed ? "failed" : entry.detail,
        gutter: <text fg={entry.running ? theme.secondary : entry.failed ? theme.error : theme.textMuted}>{entry.running ? "●" : entry.failed ? "✗" : "✓"}</text>,
        side: false,
      }))
    // The type filter, only when there is more than one type to choose from.
    const filters =
      present.length > 1
        ? [
            ...present.map((kind) => {
              const items = entries.filter((entry) => entry.kind === kind.id)
              const on = !filter || filter.includes(kind.id)
              const running = items.filter((entry) => entry.running).length
              return {
                title: kind.title,
                value: `kind:${kind.id}`,
                category: "Show",
                footer: `${items.length}${running ? ` · ${running} running` : ""}`,
                gutter: <text fg={on ? theme.success : theme.textMuted}>{on ? "[x]" : "[ ]"}</text>,
              }
            }),
            ...(filter ? [{ title: "All types", value: "kind:all", category: "Show", side: false, gutter: <text fg={theme.textMuted}>{" ↺ "}</text> }] : []),
          ]
        : []
    return [...filters, ...rows]
  })
  const only = (option) => {
    if (!option.value.startsWith("kind:") || option.value === "kind:all") return
    setShown([option.value.slice(5)])
  }
  return (
    <DialogSelect
      title="Tasks"
      memoryKey="tasks"
      options={options()}
      emptyText="No subagents, shells or other tasks in this session"
      side={{ label: "only", run: only }}
      onSelect={(option) => {
        if (option.value === "kind:all") return setShown(undefined)
        if (option.value.startsWith("kind:")) {
          const kind = option.value.slice(5)
          const present = TASK_KINDS.filter((item) => taskEntries().some((entry) => entry.kind === item.id)).map((item) => item.id)
          const now = shown() ?? present
          const next = now.includes(kind) ? now.filter((item) => item !== kind) : [...now, kind]
          return setShown(next.length ? next : undefined)
        }
        dialog.clear()
        if (option.value.startsWith("agent:")) openChild(option.value.slice(6))
      }}
      actions={[
        {
          keybind: "ctrl+s",
          label: "stop",
          run: (option) => {
            if (!option.value.startsWith("task:")) return
            void active()
              .stopTask(option.value.slice(5))
              .then((ok) => toast.show({ variant: ok ? "success" : "warning", message: ok ? "Stopped task" : "Couldn't stop task" }))
          },
        },
      ]}
    />
  )
}



/** Claude Code mods: which load, and what of them Agent Code draws. */
function DialogMods() {
  onMount(() => dialog.setSize("large"))
  const [tick, setTick] = createSignal(0)
  const restartIdle = () => {
    for (const tab of tabs()) if (tab.live && tab.store.status === "idle" && !tab.store.engine) void tab.restart()
    toast.show({ variant: "info", message: "Mods reloaded in idle sessions; running ones pick them up when they finish", duration: 3000 })
  }
  const PARTS                                                          = [
    { key: "band", title: "  Band above the prompt", description: "what mods draw above the prompt" },
    { key: "panes", title: "  Panes", description: "mod panels, docked beside the chat on wide screens" },
    { key: "toasts", title: "  Toasts", description: "short notifications from mods" },
    { key: "status", title: "  Status lines", description: "lines mods pin under the prompt" },
    { key: "logs", title: "  Log lines", description: "mod messages in the transcript" },
  ]
  const options = createMemo(() => {
    tick()
    const box = (on         ) => <text fg={on ? theme.success : theme.textMuted}>{on ? "[x]" : "[ ]"}</text>
    const mods = discoverMods(true)
    return [
      { title: "Mods", value: "enabled", description: "load Claude Code mods into sessions", category: "Mods", footer: modsEnabled() ? "on" : "off", gutter: box(modsEnabled()) },
      ...PARTS.map((part) => ({
        title: part.title,
        value: `part:${part.key}`,
        description: part.description,
        category: "Mods",
        footer: modsShows(part.key) ? "on" : "off",
        gutter: box(modsShows(part.key)),
      })),
      ...mods.map((mod) => ({
        title: mod.name,
        value: `mod:${mod.name}`,
        description: mod.description ?? mod.path,
        category: "Installed mods",
        footer: `${mod.source === "acode" ? "Agent Code" : mod.source === "env" ? "CLAUDE_CODE_PLUGIN_DIRS" : "Claude Code"}${mod.version ? ` · ${mod.version}` : ""}`,
        gutter: box(modsEnabled() && modEnabled(mod.name)),
      })),
      { title: "Reload", value: "reload", description: "look for new or changed mods and reload them", category: "Actions" },
      { title: "Mods folder", value: "folder", description: `put a mod folder in ${modsDir}`, category: "Actions" },
      { title: "Make a mod", value: "make", description: "ask Claude to write one (plugin-authoring skill)", category: "Actions" },
    ]
  })
  return (
    <DialogSelect
      title="Mods"
      options={options()}
      emptyText="No mods found"
      onSelect={(option) => {
        const value = option.value
        if (value === "enabled") {
          setModsSetting("enabled", !modsEnabled())
          restartIdle()
        } else if (value.startsWith("part:")) {
          const key = value.slice(5)
          setModsSetting(key, !modsShows(key))
        } else if (value.startsWith("mod:")) {
          const name = value.slice(4)
          setModEnabled(name, !modEnabled(name))
          restartIdle()
        } else if (value === "reload") {
          discoverMods(true)
          restartIdle()
        } else if (value === "folder") {
          ensureModsDir()
          toast.show({ variant: "info", message: `Mods folder: ${modsDir}`, duration: 6000 })
        } else if (value === "make") {
          dialog.clear()
          setPromptText("Make a Claude Code mod that ")
          return
        }
        setTick((n) => n + 1)
      }}
    />
  )
}

/** `/update`: fast-forward Agent Code's own repository; the launcher rebuilds it on the next start. */
async function updateAcode() {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
  const git = (...args) =>
    new Promise((resolve) =>
      execFile("git", ["-C", dir, ...args], { timeout: 60_000 }, (error, stdout, stderr) => resolve({ ok: !error, out: String(stdout).trim(), err: String(stderr || error?.message || "").trim() })),
    )
  toast.show({ variant: "info", message: "Checking for Agent Code updates…", duration: 2000 })
  if (!(await git("rev-parse", "--git-dir")).ok) return toast.show({ variant: "warning", message: `${dir} is not a git checkout: update it by hand`, duration: 6000 })
  const fetched = await git("fetch", "--quiet", "--tags")
  if (!fetched.ok) return toast.show({ variant: "error", message: `Could not reach the Agent Code repository: ${fetched.err.split("\n").at(-1)}`, duration: 8000 })
  const behind = Number((await git("rev-list", "--count", "HEAD..@{u}")).out || 0)
  if (!behind) return toast.show({ variant: "success", message: `acode is up to date (${(await git("describe", "--tags")).out})`, duration: 4000 })
  if ((await git("status", "--porcelain", "--untracked-files=no")).out)
    return toast.show({ variant: "warning", message: "Agent Code has local changes: commit them first, then /update", duration: 8000 })
  const pulled = await git("pull", "--ff-only", "--quiet")
  if (!pulled.ok) return toast.show({ variant: "error", message: `Update failed: ${pulled.err.split("\n").at(-1)}`, duration: 8000 })
  toast.show({ variant: "success", title: "Agent Code updated", message: `${(await git("describe", "--tags")).out} (${behind} new commit${behind === 1 ? "" : "s"}). Restart Agent Code to use it; it rebuilds on start.`, duration: 10000 })
}

/** After the settings changed under Agent Code (reload, restore, reset): apply what can change while running. */
function applyConfigChange() {
  setFavorites(config.favoriteModels ?? [])
  setRecentTick((n) => n + 1)
  setTheme(config.theme ?? "opencode", false)
  void refreshProviders()
  discoverMods(true)
  // Settings, MCP servers, mods and prompt parts reach Claude Code when its process starts.
  for (const tab of tabs()) if (tab.live && tab.store.status === "idle") void tab.restart()
}

/** Saved sets of settings: pick one to put it back. */
/** The phone link as a QR code (and the link itself) for pairing a phone. */
function DialogPhoneQr() {
  onMount(() => dialog.setSize("large"))
  const qr = phoneQr()
  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <text fg={theme.text} attributes={TextAttributes.BOLD}>
        Pair a phone
      </text>
      <Show when={qr} fallback={<text fg={theme.textMuted}>(install qrencode to see a QR code here)</text>}>
        <text fg="#ffffff" bg="#000000">
          {qr}
        </text>
      </Show>
      <text fg={theme.textMuted}>Scan it with the phone's camera, or open this link on the phone:</text>
      <text fg={theme.accent}>{phoneLink()}</text>
      <text fg={theme.textMuted}>Then add the page to the home screen (Android: menu → Install app; iPhone: Share → Add to Home Screen).</text>
    </box>
  )
}

/** Agent Code on a phone: the server, its address and how phones pair. */
function DialogPhone() {
  onMount(() => dialog.setSize("large"))
  const [tick, setTick] = createSignal(0)
  const restart = () => {
    if (!phoneSettings().enabled) return stopPhoneServer()
    startPhoneServer()
      .then(() => setTick((n) => n + 1))
      .catch((error) => toast.show({ variant: "error", title: "Phone server", message: String(error?.message ?? error), duration: 8000 }))
  }
  const HOSTS = ["lan", "all", "localhost"]
  const hostLabel = (host) => (host === "lan" ? `local network (${lanAddress()})` : host === "all" ? "all addresses (public IP, port forwarding)" : host === "localhost" ? "this computer only" : host)
  const options = createMemo(() => {
    tick()
    const s = phoneSettings()
    const live = phoneServerState()
    const box = (on) => <text fg={on ? theme.success : theme.textMuted}>{on ? "[x]" : "[ ]"}</text>
    return [
      { title: "Phone server", value: "enabled", description: live.running ? `running · ${live.clients} phone${live.clients === 1 ? "" : "s"} connected` : "off", gutter: box(s.enabled), category: "Server" },
      { title: "Pair a phone…", value: "qr", description: "QR code and link to open on the phone", category: "Server", disabled: !s.enabled },
      { title: "Listen on", value: "host", description: hostLabel(s.host), footer: "change", category: "Address" },
      { title: "Port", value: "port", description: String(s.port), footer: "change", category: "Address" },
      { title: "Public address", value: "address", description: s.address || "none (the link uses the local address)", footer: "set", category: "Address" },
      { title: "HTTPS", value: "tls", description: s.tls === "off" ? "off (fine on a home network)" : "self-signed certificate (accept it once on the phone)", gutter: box(s.tls !== "off"), category: "Address" },
      { title: "Files to the phone", value: "files", description: "phones may download the files a chat attached, wrote or edited", gutter: box(s.files), category: "Phone" },
      { title: "Remote desktop", value: "desktop.on", description: s.tls === "off" ? "screen, sound, mouse and keys on the phone (needs HTTPS)" : "screen, sound, mouse and keys on the phone, on demand", gutter: box(s.desktop), category: "Remote desktop" },
      {
        title: "Approve on this PC…",
        value: "desktop",
        description: desktopState().running ? `sharing now · ${desktopState().viewers} viewer${desktopState().viewers === 1 ? "" : "s"}` : "starts screen sharing once so KDE asks here, not when you're away",
        category: "Remote desktop",
        disabled: !s.enabled || !s.desktop,
      },
      { title: "New pairing token", value: "token", description: "unpairs every phone", category: "Phone" },
    ]
  })
  return (
    <DialogSelect
      title="Phone"
      options={options()}
      onSelect={(option) => {
        const s = phoneSettings()
        if (option.value === "enabled") {
          setPhoneSetting("enabled", !s.enabled)
          restart()
          if (!s.enabled) setTimeout(() => dialog.replace(() => <DialogPhoneQr />, undefined, "large"), 300)
        } else if (option.value === "qr") return dialog.replace(() => <DialogPhoneQr />, undefined, "large")
        else if (option.value === "host") {
          setPhoneSetting("host", HOSTS[(HOSTS.indexOf(s.host) + 1) % HOSTS.length])
          restart()
        } else if (option.value === "tls") {
          setPhoneSetting("tls", s.tls === "off" ? "self-signed" : "off")
          restart()
        } else if (option.value === "files") setPhoneSetting("files", !s.files)
        else if (option.value === "desktop.on") {
          setPhoneSetting("desktop", !s.desktop)
          if (s.desktop) stopDesktop(true)
        } else if (option.value === "desktop") {
          try {
            setupDesktop()
            toast.show({ variant: "info", title: "Remote desktop", message: "KDE asks which screens to share and to allow remote control: choose both screens and tick \"remember\". It stops by itself after a minute.", duration: 12000 })
          } catch (error) {
            toast.show({ variant: "error", title: "Remote desktop", message: String(error?.message ?? error), duration: 8000 })
          }
        }
        else if (option.value === "token") {
          phoneToken(true)
          toast.show({ variant: "info", message: "New token: pair your phones again", duration: 4000 })
        } else if (option.value === "port" || option.value === "address")
          return dialog.replace(() => (
            <DialogPrompt
              title={option.value === "port" ? "Port" : "Public address (IP or name phones use; empty: none)"}
              value={option.value === "port" ? String(s.port) : (s.address ?? "")}
              onConfirm={(value) => {
                const text = value.trim()
                if (option.value === "port") {
                  const port = Number(text)
                  if (!Number.isInteger(port) || port < 1 || port > 65535) return toast.show({ variant: "warning", message: "A port is a number from 1 to 65535" })
                  setPhoneSetting("port", port)
                } else setPhoneSetting("address", text || undefined)
                restart()
                dialog.replace(() => <DialogPhone />, undefined, "large")
              }}
            />
          ))
        setTick((n) => n + 1)
      }}
    />
  )
}

// ---------------------------------------------------------------------------
// Find: search the chat (this session or every session here) for words you or the AI wrote, and jump there.
// ---------------------------------------------------------------------------

const WHO = ["both", "me", "ai"]
const WHO_LABEL = { both: "me + AI", me: "me", ai: "AI" }
/** The last search, for F3 / shift+F3 (find next / previous in the focused session). */
const lastFind = { query: "", who: "both", at: -1 }

/** Plain text of a message as the chat shows it (the user's words, or the AI's replies). */
function messageText(message) {
  if (message.type === "user") return message.text
  if (message.type === "assistant") return message.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n")
  return ""
}

function snippet(text, query) {
  const flat = text.replace(/\s+/g, " ")
  const at = flat.toLowerCase().indexOf(query.toLowerCase())
  const start = Math.max(0, at - 36)
  return (start > 0 ? "…" : "") + flat.slice(start, start + 110) + (start + 110 < flat.length ? "…" : "")
}

/** Matches of `query` in the focused session's messages, in chat order. */
function sessionMatches(query, who) {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  return store.messages.filter(
    (message) =>
      (message.type === "user" ? who !== "ai" : message.type === "assistant" ? who !== "me" : false) && messageText(message).toLowerCase().includes(needle),
  )
}

// Every session's text, read once per Agent Code run (transcripts only change in open tabs, which are searched live).
const transcriptCache = new Map()
async function transcriptOf(sessionId) {
  if (!transcriptCache.has(sessionId))
    transcriptCache.set(
      sessionId,
      getSessionMessages(sessionId, { dir: app.cwd })
        .then((entries) =>
          entries
            .filter((entry) => (entry.type === "user" || entry.type === "assistant") && !entry.parent_tool_use_id && !entry.isMeta)
            .map((entry) => {
              const content = entry.message?.content
              const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter((block) => block?.type === "text").map((block) => block.text).join("\n") : ""
              return { uuid: entry.uuid, role: entry.type, text: text.startsWith("<attachment ") ? "" : text }
            })
            .filter((item) => item.text.trim()),
        )
        .catch(() => []),
    )
  return transcriptCache.get(sessionId)
}

/** Jump to a message of the focused session and light it up. */
function jumpTo(id) {
  setRoute("session")
  active().setStore("view", "session")
  setTimeout(() => actions.reveal(id, true), 30)
}

function DialogFind() {
  onMount(() => dialog.setSize("large"))
  const [query, setQuery] = createSignal(lastFind.query)
  const [who, setWho] = createSignal(lastFind.who)
  const [everywhere, setEverywhere] = createSignal(false)
  const [found, setFound] = createSignal([])
  const [busy, setBusy] = createSignal(false)
  let run = 0
  const search = async () => {
    const text = query().trim()
    const mine = ++run
    if (!text) return setFound([])
    const here = sessionMatches(text, who()).map((message) => ({
      title: snippet(messageText(message), text),
      value: `here:${message.id}`,
      category: everywhere() ? `This session · ${store.title ?? "untitled"}` : undefined,
      footer: message.type === "user" ? "me" : "AI",
    }))
    if (!everywhere()) return setFound(here.reverse())
    setFound(here.reverse())
    setBusy(true)
    const others = []
    for (const info of app.sessions) {
      if (info.sessionId === store.sessionID) continue
      const items = await transcriptOf(info.sessionId)
      if (mine !== run) return
      for (const item of [...items].reverse()) {
        if (who() === "me" && item.role !== "user") continue
        if (who() === "ai" && item.role !== "assistant") continue
        if (!item.text.toLowerCase().includes(text.toLowerCase())) continue
        others.push({
          title: snippet(item.text, text),
          value: `other:${info.sessionId}:${item.role}:${item.uuid}`,
          category: info.customTitle ?? info.summary ?? info.sessionId.slice(0, 8),
          footer: item.role === "user" ? "me" : "AI",
        })
      }
    }
    if (mine !== run) return
    setFound([...here, ...others])
    setBusy(false)
  }
  createEffect(on([query, who, everywhere], () => void search()))
  return (
    <DialogSelect
      title={`Find · ${WHO_LABEL[who()]} · ${everywhere() ? "all sessions here" : "this session"}${busy() ? " · searching…" : query().trim() ? ` · ${found().length} found` : ""}`}
      placeholder="words to find"
      search={setQuery}
      options={found()}
      flatten={!everywhere()}
      emptyText={query().trim() ? "Not found" : "Type the words to find"}
      onSelect={async (option) => {
        lastFind.query = query()
        lastFind.who = who()
        dialog.clear()
        const value = option.value
        if (value.startsWith("here:")) {
          const id = value.slice(5)
          lastFind.at = store.messages.findIndex((message) => message.id === id)
          return jumpTo(id)
        }
        const [, sessionId, role, uuid] = value.split(":")
        const session = await openSession(sessionId)
        // A user message keeps its transcript id; an AI reply is found again by its words.
        const target =
          (role === "user" && session.store.messages.find((message) => message.id === uuid)) ||
          session.store.messages.findLast((message) => message.type === (role === "user" ? "user" : "assistant") && messageText(message).toLowerCase().includes(query().trim().toLowerCase()))
        if (target) {
          lastFind.at = session.store.messages.indexOf(target)
          setTimeout(() => jumpTo(target.id), 150)
        }
      }}
      actions={[
        { keybind: "tab", label: `who: ${WHO_LABEL[who()]}`, run: () => setWho(WHO[(WHO.indexOf(who()) + 1) % WHO.length]) },
        { keybind: "ctrl+s", label: everywhere() ? "this session" : "all sessions", run: () => setEverywhere(!everywhere()) },
      ]}
    />
  )
}

/** F3 / shift+F3: the next / previous match of the last search in the focused session. */
function findAgain(direction) {
  if (!lastFind.query.trim()) return dialog.replace(() => <DialogFind />, undefined, "large")
  const matches = sessionMatches(lastFind.query, lastFind.who)
  if (!matches.length) return toast.show({ variant: "info", message: `"${lastFind.query}" not found in this session`, duration: 2500 })
  const indexes = matches.map((message) => store.messages.indexOf(message))
  // Newest first, like the list: "next" is the match above (older), "previous" the one below (newer).
  const at = lastFind.at ?? Infinity
  const next = direction > 0 ? (indexes.findLast((index) => index < at) ?? indexes.at(-1)) : (indexes.find((index) => index > at) ?? indexes[0])
  lastFind.at = next
  jumpTo(store.messages[next].id)
  toast.show({ variant: "info", message: `${indexes.length - indexes.indexOf(next)} / ${indexes.length} (newest first): "${lastFind.query}"`, duration: 1500 })
}

// ---------------------------------------------------------------------------
// Log in: each harness's own login (Claude Code, opencode, Codex) run as-is, keys for the rest.
// ---------------------------------------------------------------------------

/** A command's output lines, without blocking the UI (opencode's auth list starts its service: seconds). */
function outputLines(file, args) {
  return new Promise((resolve) =>
    execFile(file, args, { encoding: "utf8", timeout: 20_000, ...spawnOptions(file) }, (_error, stdout, stderr) =>
      resolve(String(stdout || "").replace(/\x1b\[[0-9;]*m/g, "").split("\n").map((line) => line.trim()).filter(Boolean)),
    ),
  )
}

async function claudeStatus() {
  const claude = findBinary("claude")
  if (!claude) return { installed: false }
  try {
    return { installed: true, ...JSON.parse((await outputLines(claude, ["auth", "status"])).join("\n") || "{}") }
  } catch {
    return { installed: true }
  }
}

/**
 * Reset the 5-hour limit: an offer Agent Code can see is used directly; otherwise Claude Code's own /limit-reset runs in
 * this terminal (Anthropic may offer it only there), and Agent Code reads the usage again afterwards.
 */
let appRenderer
/**
 * Code Mode (Claude Code 2.1.323+, experimental): Claude writes JavaScript that calls its tools, many calls per turn.
 * Claude Code allows it only in its own interactive terminal (not under the Agent SDK Agent Code drives), on Opus 5.5+
 * or Fable 5.2+, with Anthropic's own switch on for the account. So this hands the conversation to an interactive
 * `claude --resume` with CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1 in this terminal and takes it back when it exits.
 */
function openCodeMode() {
  const tab = active()
  if (store.codeMode) return
  if (store.status === "running") return toast.show({ variant: "warning", message: "Wait for the turn to end (or interrupt it) first" })
  if (!/opus|fable/i.test(`${store.modelId ?? ""} ${store.model}`))
    toast.show({ variant: "info", message: "Code Mode needs Opus 5.5+ or Fable 5.2+: it opens on Opus", duration: 5000 })
  // One process at a time on a conversation: the chat's goes quiet while Code Mode has it.
  tab.stop()
  tab.setStore("codeMode", true)
  tab.setStore("view", "session")
}

const CLAUDE_ALIAS = /^(opus|sonnet|haiku|fable)$|^claude-/

export async function resetLimit() {
  if (limits.offer) {
    const message = await useLimitReset(false)
    return toast.show({ variant: /^5-hour limit reset/.test(message) ? "success" : "warning", message })
  }
  const claude = findBinary("claude")
  if (!claude) return toast.show({ variant: "warning", message: "No limit reset is offered right now" })
  const before = limits.fiveHour?.utilization ?? 0
  await runInTerminal(appRenderer, claude, ["/limit-reset"], "Claude Code /limit-reset (quit Claude Code with /exit when done)")
  await pollPlanUsage(true)
  const after = limits.fiveHour?.utilization ?? 0
  if (before >= 90 && after < before - 20) {
    limitWasReset()
    toast.show({ variant: "success", message: "5-hour limit reset" })
  } else toast.show({ variant: "info", message: "The 5-hour limit wasn't reset" })
}

/** After a Claude Code login or logout: the plan and usage may be another account's; idle tabs pick it up now. */
function afterClaudeLogin() {
  forgetPlan()
  void refreshCatalog()
  void pollPlanUsage(true)
  for (const tab of tabs()) {
    if (tab.store.engine) continue
    // Tabs held by the expired login (and their unsent prompts) come back now; other idle tabs restart.
    if (tab.store.authRequired || tab.store.fatal) void tab.loggedIn()
    else if (tab.live && tab.store.status === "idle") void tab.restart()
  }
}

function DialogLogin() {
  onMount(() => dialog.setSize("large"))
  const renderer = useRenderer()
  const [tick, setTick] = createSignal(0)
  const opencode = findBinary("opencode")
  const codex = findBinary("codex")
  // Each status arrives on its own; the dialog shows at once.
  const [claudeInfo] = createResource(() => tick() + 1, () => claudeStatus())
  const [opencodeInfo] = createResource(() => tick() + 1, async () => (opencode ? (await outputLines(opencode, ["auth", "list"])).filter((line) => /\S\s{2,}\S/.test(line) && !/^(usage|description|warn|error)/i.test(line)) : []))
  const [codexInfo] = createResource(() => tick() + 1, async () => (codex ? (await outputLines(codex, ["login", "status"]))[0] : undefined))
  const options = createMemo(() => {
    const claude = claudeInfo() ?? { installed: !!findBinary("claude"), checking: true }
    const date = (iso) => (iso ? new Date(iso).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" }) : "")
    const opencodeAccounts = opencodeInfo() ?? []
    const codexStatus = codexInfo()
    return [
      {
        title: "Claude Code",
        value: "claude",
        description: !claude.installed
          ? "not installed: npm i -g @anthropic-ai/claude-code"
          : claude.checking
            ? "checking…"
            : claude.loggedIn
            ? `${claude.email ?? "logged in"} · ${claude.authMethod ?? ""}${claude.loginExpiresAt ? ` · until ${date(claude.loginExpiresAt)}` : ""}`
            : "not logged in — log in to use Claude models",
        footer: claude.loggedIn ? "switch account" : "log in",
        category: "Harnesses",
        gutter: <text fg={claude.loggedIn ? theme.success : theme.error}>●</text>,
      },
      ...(claude.loggedIn ? [{ title: "Log out of Claude Code", value: "claude-logout", description: "claude auth logout", category: "Harnesses" }] : []),
      {
        title: "opencode",
        value: "opencode",
        description: opencode ? (opencodeInfo.loading ? "checking…" : opencodeAccounts.length ? `${opencodeAccounts.length} connected: ${opencodeAccounts.map((line) => line.split(/\s{2,}/)[0]).join(", ").slice(0, 60)}` : "no integrations yet") : "not installed: npm i -g opencode-ai",
        footer: opencode ? "opencode auth login" : undefined,
        category: "Harnesses",
        gutter: <text fg={opencodeAccounts.length ? theme.success : theme.textMuted}>●</text>,
      },
      {
        title: "Codex (OpenAI)",
        value: "codex",
        description: codex ? (codexInfo.loading ? "checking…" : (codexStatus ?? "status unknown")) : "not installed: npm i -g @openai/codex @agentclientprotocol/codex-acp",
        footer: codex ? "codex login" : undefined,
        category: "Harnesses",
        gutter: <text fg={codexStatus && !/not logged/i.test(codexStatus) ? theme.success : theme.textMuted}>●</text>,
      },
      {
        title: "DeepSeek Harness",
        value: "deepseek",
        description: "uses the DeepSeek key from Agent Code (DEEPSEEK_API_KEY)",
        footer: "set key",
        category: "Harnesses",
      },
      { title: "Provider keys…", value: "connect", description: "OpenAI, DeepSeek, OpenCode Zen/Go, Ollama keys for Agent Code (/connect)", category: "Agent Code" },
    ]
  })
  const run = async (file, args, title) => {
    dialog.clear()
    const ok = await runInTerminal(renderer, file, args, title)
    return ok
  }
  return (
    <DialogSelect
      title="Log in"
      options={options()}
      onSelect={async (option) => {
        if (option.value === "claude" || option.value === "claude-logout") {
          const claude = findBinary("claude")
          if (!claude) return toast.show({ variant: "warning", message: "Install Claude Code first: npm i -g @anthropic-ai/claude-code" })
          const ok = await run(claude, ["auth", option.value === "claude" ? "login" : "logout"], option.value === "claude" ? "Claude Code login" : "Claude Code logout")
          afterClaudeLogin()
          toast.show({ variant: ok ? "success" : "warning", message: ok ? (option.value === "claude" ? "Logged in to Claude Code" : "Logged out of Claude Code") : "The login didn't finish" })
          return
        }
        if (option.value === "opencode" && findBinary("opencode")) {
          await run(findBinary("opencode"), ["auth", "login"], "opencode login")
          void refreshProviders()
          return
        }
        if (option.value === "codex" && findBinary("codex")) {
          await run(findBinary("codex"), ["login"], "Codex login")
          return
        }
        if (option.value === "deepseek" || option.value === "connect") return dialog.replace(() => <DialogConnect />)
        setTick((n) => n + 1)
      }}
    />
  )
}


function DialogSavedSettings() {
  const list = listSavedSettings()
  return (
    <DialogSelect
      title="Restore saved settings"
      emptyText="No saved settings yet (Settings → Save settings…)"
      options={list.map((item) => ({
        title: item.name,
        value: item.file,
        description: `${item.count} settings`,
        footer: new Date(item.savedAt).toLocaleString([], { dateStyle: "short", timeStyle: "short" }),
      }))}
      onSelect={(option) => {
        try {
          restoreSettings(option.value)
          applyConfigChange()
          dialog.clear()
          toast.show({ variant: "success", message: `Settings "${option.title}" restored (the previous ones saved as before-restore)`, duration: 5000 })
        } catch (error) {
          toast.show({ variant: "error", message: `Could not restore: ${error instanceof Error ? error.message : error}` })
        }
      }}
    />
  )
}

function DialogSettings() {
  const [tick, setTick] = createSignal(0)
  const flag = (key                     , fallback         ) => () => ((config[key]                       ) ?? fallback)
  const write = (key                     ) => (value         ) => {
    ;(config       )[key] = value
    saveConfig()
  }
  const settings            = [
    // Only inside an acode-box: tied to Agent Code's settings by default, or its own copy.
    ...(boxDir
      ? [
          {
            key: "box.own",
            title: "Box: own settings",
            description: ownSettings() ? "this box keeps its own settings" : "uses Agent Code's settings (shared)",
            get: () => ownSettings(),
            set: (value         ) => setOwnSettings(value),
          },
          { key: "box.reset", title: "Box: reset to factory default", description: "back to Agent Code's settings (own copy kept as a backup)", get: () => !ownSettings(), set: () => {} },
        ]
      : []),
    { key: "access", title: "Access (per harness)…", description: "permission prompts, installing, downloads, web, tests, questions — for each harness on its own", get: () => true, set: () => {} },
    { key: "chatByDefault", title: "New chats start in Chat mode", description: "a plain conversation, no tools unless asked (tab switches to Build or Plan)", get: flag("chatByDefault", true), set: write("chatByDefault") },
    { key: "planning", title: "Planning checklist", description: "Claude keeps a plan with checkboxes", get: flag("planning", false), set: write("planning"), restart: true },
    { key: "subagents", title: "Subagents", description: "Claude may delegate work to subagents", get: flag("subagents", true), set: write("subagents"), restart: true },
    { key: "subagentModels", title: "  Different models", description: "subagents may use another model", get: flag("subagentModels", true), set: write("subagentModels"), restart: true },
    { key: "subagentEffort", title: "  Different effort", description: "subagents may use another reasoning level", get: flag("subagentEffort", true), set: write("subagentEffort"), restart: true },
    ...SUBAGENT_TIERS.map(({ tier, title, hint }) => ({
      key: `tier:${tier}`,
      title: `    ${title}`,
      description: hint,
      get: () => !!config.subagentTiers?.[tier],
      set: (value         ) => {
        config.subagentTiers = { ...(config.subagentTiers ?? {}), [tier]: value }
        saveConfig()
      },
      restart: true,
      tier,
    })),
    { key: "subagentPick", title: "  Claude picks", description: "Claude chooses each subagent's model + effort", get: flag("subagentPick", true), set: write("subagentPick"), restart: true },
    { key: "subagentSame", title: "  Same as session", description: "always this session's model + effort", get: flag("subagentSame", false), set: write("subagentSame"), restart: true },
    { key: "autoResume", title: "Auto resume", description: "continue after a 5-hour/weekly limit resets", get: flag("autoResume", true), set: (value         ) => (write("autoResume")(value), autoResumeChanged()) },
    {
      key: "autoResumeMode",
      title: "  Resume",
      description: "when several tabs wait for a limit: all at once, or one after another",
      get: () => config.autoResume !== false,
      set: () => {},
    },
    { key: "autoLimitReset", title: "  Use limit resets", description: "with auto resume: use a 5-hour reset Anthropic offers at the limit", get: flag("autoLimitReset", true), set: write("autoLimitReset") },
    { key: "autoModel", title: "Auto model", description: "Haiku picks model + effort for new sessions", get: flag("autoModel", false), set: write("autoModel") },
    {
      key: "smallSessions",
      title: "Small sessions",
      description: `auto-compact past ${Math.round((config.compactAt ?? 90_000) / 1000)}K tokens`,
      get: flag("smallSessions", true),
      set: write("smallSessions"),
    },
    {
      key: "backgroundCompaction",
      title: "Background compaction",
      description: "prepare the summary early so compaction doesn't wait (unused ones still cost tokens)",
      get: flag("backgroundCompaction", false),
      set: write("backgroundCompaction"),
      restart: true,
    },
    { key: "scrollbar", title: "Scrollbar", description: "show the transcript scrollbar", get: () => showScrollbar(), set: () => toggleScrollbar() },
    { key: "thinking", title: "Thinking blocks", description: "show reasoning in the transcript", get: () => config.thinking !== "hide", set: () => toggleThinking() },
    { key: "details", title: "Usage details", description: "token count in the footer", get: () => config.showDetails !== false, set: () => toggleDetails() },
    {
      key: "dropFiles",
      title: "Attach dropped files",
      description: dropsBlocked()
        ? "this Alacritty window can't receive drops on Wayland: open Agent Code with acode-window"
        : "files dragged or pasted into the prompt are attached",
      get: flag("dropFiles", true),
      set: write("dropFiles"),
    },
    { key: "schedules", title: "Schedules…", description: "this tab's planned stops, resumes and breaks; push them to other sessions", get: () => scheduleOf(store.sessionID).some((entry) => !entry.frozen), set: () => {} },
    { key: "fable.fallback", title: "Fable fallback…", description: "at the Fable limit, go on with another model (reasoning raised)", get: () => fableFallback().enabled, set: () => {} },
    { key: "fable.upgrade", title: "Back to Fable…", description: "after a used-up Fable limit resets, return tabs to Fable (reasoning lowered)", get: () => fableUpgrade().enabled, set: () => {} },
    {
      key: "orchestrator",
      title: "Orchestrator mode…",
      description: "how it uses subagents (max numbers too), and Subagent routing (second tab)",
      get: () => orchestrator().enabled || subagentRouting().enabled,
      set: () => {},
    },
    { key: "transcriptDetail", title: "Transcript detail", description: "low: each run of steps is one row · medium: every step · high: thoughts open too", get: () => true, set: () => {} },
    { key: "scrollOnSend", title: "Scroll on send", description: "jump to the end of the chat when you send a prompt", get: flag("scrollOnSend", true), set: write("scrollOnSend") },
    { key: "attachmentPreviews", title: "Attachment previews", description: "image thumbnails and file heads in the chat", get: flag("attachmentPreviews", true), set: write("attachmentPreviews") },
    { key: "mods.dialog", title: "Mods…", description: "Claude Code mods: which load, what Agent Code draws", get: () => modsEnabled(), set: () => {} },
    { key: "settings.save", title: "Save settings…", description: "keep these settings under a name, to bring back later", get: () => false, set: () => {} },
    { key: "settings.restore", title: "Restore saved settings…", description: "put a saved set of settings back", get: () => false, set: () => {} },
    { key: "settings.reset", title: "Reset to defaults", description: "every setting back to default (saved first; tabs, history and keys stay)", get: () => false, set: () => {} },
  ]
  // Right-click (or ctrl+o) on a row: its own settings, where it has some.
  const configure = (key) => {
    const setting = settings.find((item) => item.key === key)
    const back = () => setTick((value) => value + 1)
    if (setting?.tier) return dialog.push(() => <DialogPriority tier={setting.tier} onClose={back} />)
    if (key === "orchestrator") return openOrchestrator(back)
    if (key === "fable.fallback") return dialog.push(() => <DialogFableFallback />)
    if (key === "fable.upgrade") return dialog.push(() => <DialogFableUpgrade />)
    if (key === "schedules") return openSchedules()
  }
  const options = createMemo(() => {
    tick()
    return settings.map((setting) => ({
      title: setting.title,
      value: setting.key,
      description: setting.description,
      footer: (setting.get() ? "on" : "off") + (setting.tier && config.subagentPriority?.[setting.tier]?.length ? ` · ${config.subagentPriority[setting.tier] .length} first` : ""),
      gutter: <text fg={setting.get() ? theme.success : theme.textMuted}>{setting.get() ? "[x]" : "[ ]"}</text>,
      // Saving, restoring and resetting the settings are actions, not switches.
      ...(setting.key === "transcriptDetail" ? { footer: transcriptDetail(), gutter: <text fg={theme.textMuted}>{" ≡ "}</text> } : {}),
      ...(setting.key === "autoResumeMode" ? { footer: config.autoResumeMode === "one" ? "one at a time" : "all at once", gutter: <text fg={theme.textMuted}>{" ⇄ "}</text> } : {}),
      ...(setting.key === "access" ? { footer: accessEngine(store.engine) === "claude" ? "Claude Code" : store.engine, gutter: <text fg={theme.textMuted}>{" › "}</text> } : {}),
      ...(setting.key === "orchestrator" ? { footer: `${orchestrator().enabled ? "on" : "off"} · routing ${subagentRouting().enabled ? "on" : "off"}` } : {}),
      ...(setting.key === "settings.save" ? { footer: "save", gutter: <text fg={theme.textMuted}>{" ⇩ "}</text> } : {}),
      ...(setting.key === "settings.restore" ? { footer: `${listSavedSettings().length} saved`, gutter: <text fg={theme.textMuted}>{" ⇧ "}</text> } : {}),
      ...(setting.key === "settings.reset" ? { footer: "reset", gutter: <text fg={theme.textMuted}>{" ↺ "}</text> } : {}),
      // The reset row is an action, not a switch.
      ...(setting.key === "box.reset" ? { footer: ownSettings() ? "press to reset" : "already default", gutter: <text fg={theme.textMuted}>{" ↺ "}</text> } : {}),
    }))
  })
  return (
    <DialogSelect
      title="Settings"
      memoryKey="settings"
      options={options()}
      flatten
      onSelect={(option) => {
        if (option.value === "mods.dialog") {
          dialog.replace(() => <DialogMods />, undefined, "large")
          return
        }
        if (option.value === "orchestrator") return openOrchestrator(() => setTick((n) => n + 1))
        if (option.value === "access") return openAccess(undefined, "push")
        if (option.value === "schedules") return openSchedules()
        if (option.value === "transcriptDetail") {
          cycleTranscriptDetail()
          setTick((n) => n + 1)
          return
        }
        if (option.value === "autoResumeMode") {
          config.autoResumeMode = config.autoResumeMode === "one" ? "all" : "one"
          saveConfig()
          setTick((n) => n + 1)
          return
        }
        if (option.value === "fable.fallback") return dialog.replace(() => <DialogFableFallback />)
        if (option.value === "fable.upgrade") return dialog.replace(() => <DialogFableUpgrade />, undefined, "large")

        if (option.value === "settings.save") {
          dialog.replace(() => (
            <DialogPrompt
              title="Save settings as"
              placeholder="a name (empty: today's date)"
              onConfirm={(name) => {
                const file = saveSettings(name.trim())
                dialog.clear()
                toast.show({ variant: "success", title: "Settings saved", message: file, duration: 6000 })
              }}
            />
          ))
          return
        }
        if (option.value === "settings.restore") {
          dialog.replace(() => <DialogSavedSettings />, undefined, "large")
          return
        }
        if (option.value === "settings.reset") {
          dialog.replace(() => (
            <DialogConfirm
              title="Reset settings"
              message="Every setting goes back to its default. The current ones are saved first (Restore saved settings… → before-reset). Tabs, prompt history, providers and keys stay."
              onConfirm={() => {
                resetSettings()
                applyConfigChange()
                dialog.clear()
                toast.show({ variant: "success", message: "Settings reset to defaults (saved as before-reset)", duration: 5000 })
              }}
              onCancel={() => dialog.replace(() => <DialogSettings />, undefined, "large")}
            />
          ))
          return
        }
        if (option.value === "box.own") {
          setOwnSettings(!ownSettings())
          toast.show({ variant: "info", message: ownSettings() ? "Box: own settings, restarting…" : "Box: Agent Code's settings, restarting…", duration: 2000 })
          setTimeout(() => restartBox(), 600)
          return
        }
        if (option.value === "box.reset") {
          dialog.replace(() => (
            <DialogConfirm
              title="Reset this box"
              message="The box goes back to Agent Code's settings. Its own settings are kept as a dated backup in cfg/agent-code. Agent Code restarts."
              onConfirm={() => {
                resetBox()
                dialog.clear()
                setTimeout(() => restartBox(), 300)
              }}
            />
          ))
          return
        }
        const setting = settings.find((item) => item.key === option.value)
        if (!setting) return
        setting.set(!setting.get())
        setTick((value) => value + 1)
        // Orchestrator mode turned on for the first time: open its setup right away.
        if (setting.key === "orchestrator" && setting.get() && !config.orchestrator?.configured) {
          config.orchestrator = { ...config.orchestrator, configured: true }
          saveConfig()
          openOrchestrator()
        }
        if (setting.restart) {
          // These change Claude Code's system prompt / tools: restart idle tabs so they apply now.
          for (const tab of tabs()) if (tab.live && tab.store.status === "idle") void tab.restart()
          toast.show({ variant: "info", message: "Applied to idle sessions; running ones pick it up when restarted", duration: 3000 })
        }
      }}
      onRightClick={(option) => configure(option.value)}
      actions={[
        {
          keybind: "ctrl+o",
          label: "configure (or right-click)",
          run: (option) => configure(option.value),
        },
      ]}
      footer={
        <text fg={theme.text}>
          enter <span style={{ fg: theme.textMuted }}>toggle</span>
        </text>
      }
    />
  )
}

// ---------------------------------------------------------------------------
// Access settings per harness (sidebar row above the harness line; Settings → Access…)
// ---------------------------------------------------------------------------

/** Harnesses whose access settings changed while the dialog was open: their idle tabs start again. */
const accessChanged = new Set()
function restartForAccess(ids) {
  for (const tab of tabs()) if (tab.live && tab.store.status === "idle" && ids.has(accessEngine(tab.store.engine))) void tab.restart()
}

/** Open the access settings on the focused tab's harness (or `engine`). */
let accessTab
function openAccess(engine, how = "replace") {
  accessTab = accessEngine(engine ?? store.engine)
  const close = () => {
    if (!accessChanged.size) return
    restartForAccess(new Set(accessChanged))
    accessChanged.clear()
  }
  if (how === "push") dialog.push(() => <DialogAccess engine={engine} />, close)
  else dialog.replace(() => <DialogAccess engine={engine} />, close, "large")
}

const ACCESS_NOTES = {
  claude: "Claude Code: instructions, plus permission checks and its web tools",
  opencode: "opencode: the instructions go with each conversation's first message (later, what changed)",
  dsh: "DeepSeek Harness: Agent Code's instructions in its AGENTS.md folder",
  codex: "Codex: the instructions go with each conversation's first message (later, what changed)",
}

/**
 * What the agent may do, for each harness on its own: one tab per harness (the focused tab's first). Enter switches
 * a setting; "Sync to the other harnesses…" copies this harness's settings to the others you pick.
 */
function DialogAccess(props) {
  const [engine, setEngineNow] = createSignal(accessTab ?? accessEngine(props.engine ?? store.engine))
  const setEngine = (value) => {
    accessTab = value
    setEngineNow(value)
  }
  const [tick, setTick] = createSignal(0)
  const installed = (id) => id === "claude" || !!harnessStatus().find((item) => item.id === id)?.installed
  const options = createMemo(() => {
    tick()
    configRevision()
    const access = accessFor(engine())
    const note = `${installed(engine()) ? "" : "Not installed · "}${ACCESS_NOTES[engine()] ?? "Access"}`
    return [
      ...ACCESS.map((item) => ({
        title: item.title,
        value: item.key,
        description: item.description,
        category: note,
        footer: access[item.key] ? "on" : "off",
        gutter: <text fg={access[item.key] ? theme.success : theme.textMuted}>{access[item.key] ? "[x]" : "[ ]"}</text>,
      })),
      { title: "Sync to the other harnesses…", value: "sync", category: "All harnesses", description: "copy these settings to the ones you pick", gutter: <text fg={theme.textMuted}>{" ⇉ "}</text> },
    ]
  })
  return (
    <DialogSelect
      title="Access"
      memoryKey="access"
      tabs={ACCESS_ENGINES.map((item) => ({ key: item.id, title: item.name }))}
      tab={engine()}
      onTab={setEngine}
      options={options()}
      onSelect={(option) => {
        if (option.value === "sync") return dialog.push(() => <DialogAccessSync from={engine()} onDone={() => setTick((n) => n + 1)} />)
        setAccess(engine(), option.value, !accessFor(engine())[option.value])
        accessChanged.add(engine())
        setTick((n) => n + 1)
      }}
      footer={
        <text fg={theme.text}>
          enter <span style={{ fg: theme.textMuted }}>on/off · each harness keeps its own · idle tabs restart on close</span>
        </text>
      }
    />
  )
}

/**
 * "Sync to the other harnesses": which ones (all ticked at first; enter or a click unticks one), then Yes or No.
 */
function DialogAccessSync(props) {
  const from = accessEngine(props.from)
  const others = ACCESS_ENGINES.filter((item) => item.id !== from)
  const [picked, setPicked] = createSignal(new Set(others.map((item) => item.id)))
  const name = ACCESS_ENGINES.find((item) => item.id === from)?.name ?? from
  const options = createMemo(() => {
    const chosen = picked()
    return [
      ...others.map((item) => ({
        title: item.name,
        value: `pick:${item.id}`,
        category: "Copy to",
        footer: chosen.has(item.id) ? "yes" : "no",
        gutter: <text fg={chosen.has(item.id) ? theme.success : theme.textMuted}>{chosen.has(item.id) ? "[x]" : "[ ]"}</text>,
      })),
      { title: chosen.size ? `Yes, sync to ${chosen.size} harness${chosen.size === 1 ? "" : "es"}` : "Yes (nothing ticked)", value: "yes", category: "Are you sure? Their own settings are replaced" },
      { title: "No, cancel", value: "no", category: "Are you sure? Their own settings are replaced" },
    ]
  })
  return (
    <DialogSelect
      title={`Sync ${name}'s access settings to other harnesses?`}
      options={options()}
      onSelect={(option) => {
        if (option.value === "no") return dialog.pop()
        if (option.value === "yes") {
          const targets = [...picked()]
          if (!targets.length) return toast.show({ variant: "warning", message: "Tick at least one harness, or choose No" })
          syncAccess(from, targets)
          for (const id of targets) accessChanged.add(id)
          toast.show({ variant: "success", message: `${name}'s access settings copied to ${targets.map((id) => ACCESS_ENGINES.find((item) => item.id === id)?.name ?? id).join(", ")}` })
          props.onDone?.()
          return dialog.pop()
        }
        const id = option.value.slice(5)
        setPicked((now) => {
          const next = new Set(now)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      }}
      footer={
        <text fg={theme.text}>
          enter <span style={{ fg: theme.textMuted }}>tick / untick · then Yes or No</span>
        </text>
      }
    />
  )
}

let orchestratorChanged = false
let routingChanged = false

/**
 * Open orchestrator mode's settings on top of the current dialog, on its "Usage" tab or its "Subagent routing" tab;
 * idle tabs restart once it closes, if anything changed (subagent types and the prompt live in the start options).
 */
let orchestratorTab = "usage"
function openOrchestrator(back, tab = "usage") {
  orchestratorTab = tab
  dialog.push(
    () => <DialogOrchestrator tab={tab} />,
    () => {
      back?.()
      if (!orchestratorChanged && !routingChanged) return
      orchestratorChanged = routingChanged = false
      for (const item of tabs()) if (item.live && item.store.status === "idle") void item.restart()
    },
  )
}

function saveOrchestrator(change) {
  config.orchestrator = { ...(config.orchestrator ?? {}), configured: true, ...change }
  if (change.enabled && config.subagents === false) config.subagents = true
  saveConfig()
  orchestratorChanged = true
}

const AT_ONCE = [0, 1, 2, 3, 4, 5, 6, 8, 10]
const PER_MESSAGE = [0, 3, 5, 8, 10, 15, 20, 30, 50]
const limitText = (value, one) => (!value ? "no limit" : value === 1 && one ? one : `up to ${value}`)

/** A max number for orchestrator mode: a list of common values, or any number. */
function DialogOrchestratorLimit(props) {
  const current = orchestrator()[props.field]
  const write = (value) => {
    saveOrchestrator({ [props.field]: value, ...(props.field === "maxAtOnce" ? { parallel: value !== 1 } : {}) })
    props.onDone()
  }
  return (
    <DialogSelect
      title={props.title}
      current={String(current)}
      options={[
        ...props.values.map((value) => ({ title: limitText(value, props.one), value: String(value), description: value === 0 ? "default" : undefined })),
        { title: "A number…", value: "exact", description: props.values.includes(current) ? undefined : `now ${current}` },
      ]}
      onSelect={(option) => {
        dialog.pop()
        if (option.value !== "exact") return write(Number(option.value))
        dialog.push(() => (
          <DialogPrompt
            title={`${props.title} (0: no limit)`}
            placeholder="e.g. 7"
            onConfirm={(text) => {
              const value = Number(text.trim())
              if (!Number.isInteger(value) || value < 0 || value > 500) return toast.show({ variant: "warning", message: "Write a whole number from 0 to 500" })
              write(value)
              dialog.pop()
            }}
          />
        ))
      }}
    />
  )
}

/**
 * Orchestrator mode's settings, in two tabs. "Usage": on/off and how it uses subagents — what they may differ in
 * (reasoning, model or both), the reasoning and models sections, the way of working with the max numbers of
 * subagents (at once, per message). "Subagent routing": its on/off and, under it, the exact model and variant for
 * each kind of task and each complexity level (routing works with or without orchestrator mode).
 */
function DialogOrchestrator(props) {
  // The tab outlives this instance: a dialog pushed on top (a model, a number) draws this one anew when it closes.
  const [tab, setTabNow] = createSignal(orchestratorTab === "routing" ? "routing" : "usage")
  const setTab = (value) => {
    orchestratorTab = value
    setTabNow(value)
  }
  const [tick, setTick] = createSignal(0)
  const refresh = () => setTick((value) => value + 1)
  const bump = (change) => {
    saveOrchestrator(change)
    refresh()
  }
  const box = (on) => <text fg={on ? theme.success : theme.textMuted}>{on ? "[x]" : "[ ]"}</text>
  const dot = (on) => <text fg={on ? theme.primary : theme.textMuted}>{on ? "(•)" : "( )"}</text>
  const usage = () => {
    const rule = orchestrator()
    const own = store.effort ? `yours: ${store.effort}` : "yours: default"
    const usesLevels = rule.strategy !== "model"
    const usesModels = rule.strategy !== "effort"
    const counts = `${rule.selected.length} selected · ${rule.excluded.length} excluded`
    return [
      { title: "Orchestrator mode", value: "enabled", description: "the main chat plans and delegates to subagents", footer: rule.enabled ? "on" : "off", gutter: box(rule.enabled) },
      ...ORCH_STRATEGIES.map((item) => ({ title: item.title, value: `strategy:${item.key}`, category: "Subagents use", gutter: dot(rule.strategy === item.key) })),
      ...(usesLevels
        ? [{ title: "Higher reasoning than the orchestrator", value: "higherEffort", description: own, category: "Reasoning", footer: rule.higherEffort ? "allowed" : "off", gutter: box(rule.higherEffort) }]
        : []),
      ...(usesModels
        ? [
            { title: "Stronger models than the orchestrator", value: "strongerModels", category: "Models", footer: rule.strongerModels ? "allowed" : "off", gutter: box(rule.strongerModels) },
            { title: "Models from", value: "pool", category: "Models", description: "enter: next", footer: ORCH_POOLS.find((item) => item.key === rule.pool).title, gutter: <text fg={theme.textMuted}>{" ⇄ "}</text> },
            { title: "Choose models…", value: "models", category: "Models", description: "select, exclude, whole providers at once", footer: counts, gutter: <text fg={theme.textMuted}>{" › "}</text> },
          ]
        : []),
      { title: "Delegation", value: "delegation", category: "Way of working", description: "enter: next", footer: ORCH_DELEGATION.find((item) => item.key === rule.delegation).title, gutter: <text fg={theme.textMuted}>{" ⇄ "}</text> },
      { title: "Max subagents at once", value: "maxAtOnce", category: "Way of working", description: "more wait for a free place", footer: limitText(rule.maxAtOnce, "one at a time"), gutter: <text fg={theme.textMuted}>{" # "}</text> },
      { title: "Max subagents per message", value: "maxPerMessage", category: "Way of working", description: "after that it does the rest itself", footer: limitText(rule.maxPerMessage), gutter: <text fg={theme.textMuted}>{" # "}</text> },
      { title: "Check results", value: "review", category: "Way of working", description: "the orchestrator verifies each result", footer: rule.review ? "on" : "off", gutter: box(rule.review) },
    ]
  }
  const routing = () => {
    const rule = subagentRouting()
    return [
      { title: "Subagent routing", value: "routing", description: "exact model and variant per kind of task (with or without orchestrator mode)", footer: rule.enabled ? "on" : "off", gutter: box(rule.enabled) },
      ...ROUTE_KINDS.map((item) => ({
        title: item.title,
        value: `kind:${item.key}`,
        category: "Task types (off: complexity decides)",
        footer: rule.kinds[item.key].on ? routeLabel(rule.kinds[item.key]) : "off",
        gutter: box(rule.kinds[item.key].on),
      })),
      ...ROUTE_LEVELS.map((item) => ({
        title: item.title,
        value: `level:${item.key}`,
        category: "By complexity (everything else)",
        footer: routeLabel(rule.levels[item.key]),
        gutter: <text fg={theme.textMuted}>{" › "}</text>,
      })),
    ]
  }
  const options = createMemo(() => {
    tick()
    configRevision()
    return tab() === "routing" ? routing() : usage()
  })
  const routed = () => {
    routingChanged = true
    refresh()
  }
  // A routed slot: its model, then its variant.
  const pickRoute = (value) => {
    if (!value.startsWith("kind:") && !value.startsWith("level:")) return
    dialog.push(() => <DialogRouteModel slot={value} onDone={routed} />)
  }
  const next = (list, key) => list[(list.findIndex((item) => item.key === key) + 1) % list.length].key
  const limit = (field) =>
    dialog.push(() => (
      <DialogOrchestratorLimit
        field={field}
        title={field === "maxAtOnce" ? "Max subagents at once" : "Max subagents per message"}
        values={field === "maxAtOnce" ? AT_ONCE : PER_MESSAGE}
        one={field === "maxAtOnce" ? "one at a time" : undefined}
        onDone={refresh}
      />
    ))
  return (
    <DialogSelect
      title="Orchestrator mode"
      memoryKey="orchestrator"
      tabs={[
        { key: "usage", title: "Usage" },
        { key: "routing", title: "Subagent routing" },
      ]}
      tab={tab()}
      onTab={setTab}
      options={options()}
      onSelect={(option) => {
        const rule = orchestrator()
        const [kind, value] = option.value.split(":")
        if (kind === "routing") {
          const on = !subagentRouting().enabled
          config.subagentRouting = { ...(config.subagentRouting ?? {}), enabled: on }
          if (on && config.subagents === false) config.subagents = true
          saveConfig()
          return routed()
        }
        if (kind === "kind") {
          saveRoute(option.value, { on: !subagentRouting().kinds[value].on })
          return routed()
        }
        if (kind === "level") return pickRoute(option.value)
        if (kind === "enabled") return bump({ enabled: !rule.enabled })
        if (kind === "strategy") return bump({ strategy: value })
        if (kind === "higherEffort") return bump({ higherEffort: !rule.higherEffort })
        if (kind === "strongerModels") return bump({ strongerModels: !rule.strongerModels })
        if (kind === "pool") return bump({ pool: next(ORCH_POOLS, rule.pool) })
        if (kind === "delegation") return bump({ delegation: next(ORCH_DELEGATION, rule.delegation) })
        if (kind === "maxAtOnce" || kind === "maxPerMessage") return limit(kind)
        if (kind === "review") return bump({ review: !rule.review })
        if (kind === "models") dialog.push(() => <DialogOrchestratorModels onDone={refresh} />)
      }}
      onRightClick={(option) => pickRoute(option.value)}
      actions={tab() === "routing" ? [{ keybind: "ctrl+o", label: "model and variant", run: (option) => pickRoute(option.value) }] : []}
      footer={
        <text fg={theme.text}>
          {tab() === "routing" ? (
            <>
              enter <span style={{ fg: theme.textMuted }}>on/off</span> · right-click <span style={{ fg: theme.textMuted }}>model</span>
            </>
          ) : (
            <>
              enter <span style={{ fg: theme.textMuted }}>change</span>
            </>
          )}
        </text>
      }
    />
  )
}

/**
 * The models orchestrator mode may consider: Enter selects (for "Only selected"), right-click or ctrl+x excludes a
 * model from consideration altogether; whole providers, or everything, at once.
 */
function DialogOrchestratorModels(props) {
  const [tick, setTick] = createSignal(0)
  onMount(() => void refreshProviders().then(() => setTick((value) => value + 1)))
  const groups = createMemo(() => {
    tick()
    const out = [{ id: "anthropic", name: "Anthropic", models: claudeModels().map((model) => ({ value: model.value, title: model.displayName })) }]
    for (const provider of providers.list) {
      const models = provider.models
        .filter((model) => !model.appOnly)
        .map((model) => ({ value: `${provider.id}/${model.id}`, title: model.label ?? model.id }))
        .filter((item) => providerKind(item.value) !== "harness")
      if (models.length) out.push({ id: provider.id, name: provider.name, models })
    }
    return out
  })
  const save = (change) => {
    saveOrchestrator(change)
    props.onDone?.()
    setTick((value) => value + 1)
  }
  const options = createMemo(() => {
    tick()
    const rule = orchestrator()
    const selected = new Set(rule.selected)
    const excluded = new Set(rule.excluded)
    const mark = (value) =>
      excluded.has(value) ? <text fg={theme.error}>[-]</text> : <text fg={selected.has(value) ? theme.success : theme.textMuted}>{selected.has(value) ? "[x]" : "[ ]"}</text>
    const rows = [
      { title: "Select all models (any provider)", value: "all", category: "All", gutter: <text fg={theme.textMuted}>{" + "}</text> },
      { title: "Unselect all", value: "none", category: "All", footer: `${selected.size} selected`, gutter: <text fg={theme.textMuted}>{" − "}</text> },
      { title: "Clear exclusions", value: "clear", category: "All", footer: `${excluded.size} excluded`, gutter: <text fg={theme.textMuted}>{" ↺ "}</text> },
    ]
    for (const group of groups()) {
      const all = group.models.every((model) => selected.has(model.value))
      rows.push({ title: `All ${group.name}`, value: `group:${group.id}`, category: group.name, footer: all ? "unselect group" : "select group", gutter: <text fg={theme.textMuted}>{all ? " − " : " + "}</text> })
      for (const model of group.models) {
        const stronger = !rule.strongerModels && strongerModel(model.value, store.model)
        rows.push({
          title: model.title,
          value: `model:${model.value}`,
          category: group.name,
          description: model.value === store.model ? "this tab's model" : stronger ? "stronger than this tab's model: not used" : undefined,
          gutter: mark(model.value),
        })
      }
    }
    return rows
  })
  const toggleExcluded = (value) => {
    if (!value.startsWith("model:")) return
    const id = value.slice(6)
    const rule = orchestrator()
    const excluded = rule.excluded.includes(id) ? rule.excluded.filter((item) => item !== id) : [...rule.excluded, id]
    save({ excluded, selected: rule.selected.filter((item) => item !== id) })
  }
  return (
    <DialogSelect
      title="Orchestrator: models"
      options={options()}
      onSelect={(option) => {
        const rule = orchestrator()
        const [kind, ...rest] = option.value.split(":")
        const id = rest.join(":")
        if (kind === "all") return save({ selected: groups().flatMap((group) => group.models.map((model) => model.value)).filter((value) => !rule.excluded.includes(value)) })
        if (kind === "none") return save({ selected: [] })
        if (kind === "clear") return save({ excluded: [] })
        if (kind === "group") {
          const group = groups().find((item) => item.id === id)
          const values = group.models.map((model) => model.value)
          const all = values.every((value) => rule.selected.includes(value))
          return save({ selected: all ? rule.selected.filter((value) => !values.includes(value)) : [...new Set([...rule.selected, ...values.filter((value) => !rule.excluded.includes(value))])] })
        }
        if (kind === "model") {
          const selected = rule.selected.includes(id) ? rule.selected.filter((item) => item !== id) : [...rule.selected, id]
          save({ selected, excluded: rule.excluded.filter((item) => item !== id) })
        }
      }}
      onRightClick={(option) => toggleExcluded(option.value)}
      actions={[{ keybind: "ctrl+x", label: "exclude", run: (option) => toggleExcluded(option.value) }]}
      footer={
        <text fg={theme.text}>
          enter <span style={{ fg: theme.textMuted }}>select</span> · right-click <span style={{ fg: theme.textMuted }}>exclude from consideration</span>
        </text>
      }
    />
  )
}

/** A routed slot's model and variant in a few words ("Sonnet 5.5 · high"). */
function routeLabel(slot) {
  const model =
    slot.model === "same"
      ? "session's model"
      : (claudeModels().find((item) => item.value === slot.model)?.displayName ?? (splitModel(slot.model) ? `${splitModel(slot.model).model} (${providerName(slot.model)})` : slot.model))
  return slot.effort ? `${model} · ${slot.effort}` : model
}

function saveRoute(slot, change) {
  const [group, key] = slot.split(":")
  const field = group === "kind" ? "kinds" : "levels"
  const own = config.subagentRouting ?? {}
  config.subagentRouting = { ...own, configured: true, [field]: { ...(own[field] ?? {}), [key]: { ...(own[field]?.[key] ?? {}), ...change } } }
  saveConfig()
}

/** Subagent routing's settings: the second tab of orchestrator mode's settings. */
function openRouting(back) {
  openOrchestrator(back, "routing")
}

/** Any model for one routed slot: the session's own, every Claude model, or a provider model (not harness ones). */
function DialogRouteModel(props) {
  const [tick, setTick] = createSignal(0)
  onMount(() => void refreshProviders().then(() => setTick((value) => value + 1)))
  const [group, key] = props.slot.split(":")
  const current = () => subagentRouting()[group === "kind" ? "kinds" : "levels"][key]
  const title = [...ROUTE_KINDS, ...ROUTE_LEVELS].find((item) => item.key === key)?.title ?? key
  const options = createMemo(() => {
    tick()
    const favs = favorites()
    const claude = claudeModels().map((model) => ({
      title: model.displayName,
      value: model.value,
      category: model.older ? "Anthropic · older" : "Anthropic",
      description: favs.includes(model.value) ? "favourite" : undefined,
    }))
    const external = providers.list.flatMap((provider) =>
      provider.models
        .filter((model) => !model.appOnly)
        .map((model) => ({ value: `${provider.id}/${model.id}`, title: model.label ?? model.id, category: provider.name }))
        .filter((item) => providerKind(item.value) !== "harness")
        .map((item) => ({ ...item, description: favs.includes(item.value) ? "favourite" : undefined, footer: billingLabel(modelMeta(item.value), providerName(item.value)) })),
    )
    return [{ title: "Session's model", value: "same", category: "Session", description: "whatever model the tab runs" }, ...claude.filter((item) => item.category === "Anthropic"), ...external, ...claude.filter((item) => item.category !== "Anthropic")]
  })
  return (
    <DialogSelect
      title={`${title}: model`}
      options={options()}
      current={current().model}
      onSelect={(option) => {
        const levels = option.value === "same" ? variantsOf(store.model) : variantsOf(option.value)
        if (!levels.length) {
          saveRoute(props.slot, { model: option.value, effort: null })
          props.onDone()
          return dialog.pop()
        }
        dialog.pop()
        dialog.push(() => <DialogRouteVariant slot={props.slot} model={option.value} title={`${title}: ${option.title}`} levels={levels} onDone={props.onDone} />)
      }}
    />
  )
}

/** The variant (reasoning level) for a routed slot's model. */
function DialogRouteVariant(props) {
  const [group, key] = props.slot.split(":")
  const now = subagentRouting()[group === "kind" ? "kinds" : "levels"][key]
  return (
    <DialogSelect
      title={`${props.title} · variant`}
      current={now.model === props.model ? (now.effort ?? "default") : undefined}
      options={[{ title: "Default", value: "default", description: "the model's own default" }, ...props.levels.map((level) => ({ title: level, value: level }))]}
      onSelect={(option) => {
        saveRoute(props.slot, { model: props.model, effort: option.value === "default" ? null : option.value })
        props.onDone()
        dialog.pop()
      }}
    />
  )
}

/** Models to try first for one subagent tier, in click order. */
function DialogPriority(props                                             ) {
  const [tick, setTick] = createSignal(0)
  onMount(() => void refreshProviders().then(() => setTick((value) => value + 1)))
  onCleanup(() => props.onClose())
  const info = SUBAGENT_TIERS.find((item) => item.tier === props.tier)
  const options = createMemo(() => {
    tick()
    const chosen = config.subagentPriority?.[props.tier] ?? []
    return tierModels(props.tier).map((value) => {
      const index = chosen.indexOf(value)
      const meta = modelMeta(value)
      return {
        title: splitModel(value)?.model ?? value,
        value,
        description: providerName(value),
        footer: (index >= 0 ? `#${index + 1}  ` : "") + billingLabel(meta, providerName(value)),
        gutter: <text fg={index >= 0 ? theme.primary : theme.textMuted}>{index >= 0 ? "[x]" : "[ ]"}</text>,
      }
    })
  })
  return (
    <DialogSelect
      title={`${info.title}: prefer these`}
      options={options()}
      emptyText="No models of this kind are connected (see /connect)"
      onSelect={(option) => {
        const chosen = config.subagentPriority?.[props.tier] ?? []
        const next = chosen.includes(option.value) ? chosen.filter((value) => value !== option.value) : [...chosen, option.value]
        config.subagentPriority = { ...(config.subagentPriority ?? {}), [props.tier]: next }
        saveConfig()
        setTick((value) => value + 1)
      }}
      footer={
        <text fg={theme.text}>
          enter <span style={{ fg: theme.textMuted }}>toggle · none picked = your favourite/recent ones</span>
        </text>
      }
    />
  )
}

function DialogHelp() {
  const rows = createMemo(() =>
    allCommands()
      .filter((command) => command.keybind !== false && shortcut((command.keybind || command.id)          ))
      .map((command) => ({ title: command.title, value: command.id, footer: shortcut((command.keybind || command.id)          ), category: command.category })),
  )
  return <DialogSelect title="Keybinds" options={rows()} onSelect={(option) => { dialog.clear(); setTimeout(() => runCommand(option.value), 1) }} />
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

function Home() {
  const dimensions = useTerminalDimensions()
  return (
    <>
      <box flexGrow={1} alignItems="center" paddingLeft={dimensions().width < 44 ? 1 : 2} paddingRight={dimensions().width < 44 ? 1 : 2}>
        <box flexGrow={1} minHeight={0} />
        <box height={3} minHeight={0} flexShrink={1} />
        <box flexShrink={0}>
          <Slot name="home_logo" mode="replace">
            <Logo />
          </Slot>
        </box>
        <box height={1} flexShrink={0} />
        <box width="100%" maxWidth={75} zIndex={1000} paddingTop={1} flexShrink={0}>
          <Slot name="home_prompt" mode="replace">
            <ModBand columns={Math.min(dimensions().width - 4, 75)} />
            <Prompt home right={<Slot name="home_prompt_right" />} />
            <ModStatus />
          </Slot>
        </box>
        <Slot name="home_bottom" />
        <box flexGrow={1} minHeight={0} />
      </box>
      <Show when={dimensions().height >= 14 && dimensions().width >= 44}>
        <Slot name="home_footer" mode="single_winner" />
      </Show>
    </>
  )
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export function App() {
  const renderer = useRenderer()
  appRenderer = renderer
  const dimensions = useTerminalDimensions()

  setDialogRefocus(() => focusPrompt())
  // Once: say why dragging files onto this window does nothing, and what opens one where it works.
  onMount(() => {
    if (!dropsBlocked() || config.dropTipShown) return
    config.dropTipShown = true
    saveConfig()
    setTimeout(
      () =>
        toast.show({
          variant: "info",
          title: "Dropping files",
          message: "Alacritty on Wayland can't receive dropped files. Start Agent Code with `acode-window` (or the Agent Code launcher) to drag files straight in.",
          duration: 15000,
        }),
      1500,
    )
  })
  useKeyboard((event          ) => dispatchKey(event))
  actions.pause = () => dialog.push(() => <DialogBreak />)
  actions.message = (id) => dialog.replace(() => <DialogMessage messageID={id} />)
  actions.redo = () =>
    dialog.replace(() => (
      <DialogConfirm
        title="Confirm Redo"
        message="Are you sure you want to restore the reverted messages?"
        onConfirm={() => {
          dialog.clear()
          void runCommand("session.redo")
        }}
        onCancel={() => dialog.clear()}
      />
    ))

  // Bell + background-tab toasts live in the system.notifications built-in plugin.
  // Like opencode's "Scroll on send": a sent prompt brings the transcript to its end (unless switched off).
  onSessionEvent((event) => {
    if (event.type !== "sent" || event.session !== active() || config.scrollOnSend === false) return
    setTimeout(() => refs.scroll?.scrollTo(refs.scroll.scrollHeight), 10)
  })
  onSessionEvent((event) => {
    if (event.type !== "toast") return
    const prefix = event.session === active() ? "" : `${event.session.store.title ?? "Session"}: `
    toast.show({ variant: event.variant, message: prefix + event.message, duration: event.duration })
  })
  onCommandError((command, error) => {
    toast.show({ variant: "error", title: command.title, message: error instanceof Error ? error.message : String(error) })
  })

  createEffect(
    on(
      () => store.title,
      // The window is named after the harness, nothing else.
      () => {
        // No terminal to name when Agent Code runs for the web app.
        try {
          renderer.setTerminalTitle(APP_NAME)
        } catch {}
      },
    ),
  )

  const scroll = (fn                                              ) => () => {
    const s = refs.scroll
    if (!s || route() !== "session") return false
    fn(s)
  }

  const page = () => Math.max(1, (refs.scroll?.viewport.height ?? dimensions().height) - 2)

  const commands = ()            => [
    { id: "command.palette.show", title: "Show commands", category: "System", palette: false, run: () => dialog.replace(() => <DialogCommands />) },
    {
      id: "session.new",
      title: "New session",
      category: "Session",
      slash: "new",
      slashAliases: ["clear"],
      run: () => {
        showPluginRoute(undefined)
        void newSession()
        dialog.clear()
      },
    },
    {
      id: "session.list",
      title: "Switch session",
      category: "Session",
      slash: "sessions",
      slashAliases: ["resume", "continue"],
      run: () => dialog.replace(() => <DialogSessions />, undefined, "large"),
    },
    {
      id: "session.rename",
      title: "Rename session",
      category: "Session",
      slash: "rename",
      enabled: () => !!store.sessionID,
      run: () =>
        dialog.replace(() => (
          <DialogPrompt
            title="Rename session"
            value={store.title}
            onConfirm={(value) => {
              const id = store.sessionID
              if (id) void renameSession(id, value, { dir: store.cwd })
              active().rename(value)
              dialog.clear()
            }}
          />
        )),
    },
    {
      id: "session.fork",
      title: "Fork session",
      category: "Session",
      slash: "fork",
      keybind: false,
      enabled: () => !!store.sessionID && store.status === "idle",
      run: async () => {
        await forkSession()
        toast.show({ variant: "success", message: "Forked into a new tab" })
      },
    },
    {
      id: "session.compact",
      title: "Compact session",
      category: "Session",
      slash: "compact",
      slashAliases: ["summarize"],
      // Only once there is a conversation (Claude Code answers an empty one with an error and starts a transcript).
      enabled: () => !!store.sessionID && store.messages.some((message) => message.type === "user"),
      run: () => {
        setRoute("session")
        send("/compact")
      },
    },
    {
      id: "session.undo",
      title: "Undo previous message",
      category: "Session",
      slash: "undo",
      enabled: () => store.messages.some((m) => m.type === "user"),
      run: async () => {
        dialog.clear()
        const result = await undo()
        if (result) {
          setPromptText(result.text)
          setTimeout(() => refs.scroll?.scrollTo(refs.scroll.scrollHeight), 10)
        }
      },
    },
    {
      id: "session.redo",
      title: "Redo",
      category: "Session",
      slash: "redo",
      enabled: () => !!store.revert,
      run: async () => {
        dialog.clear()
        const result = await redo()
        if (result?.restored) setPromptText("")
      },
    },
    {
      id: "session.timeline",
      title: "Jump to message",
      category: "Session",
      slash: "timeline",
      enabled: () => route() === "session" && store.messages.some((m) => m.type === "user"),
      run: () => dialog.replace(() => <DialogTimeline />),
    },
    {
      id: "session.background",
      title: "Background running tools",
      category: "Session",
      enabled: () => store.status === "running",
      run: async () => {
        const ok = await backgroundTasks()
        toast.show({ variant: ok ? "success" : "info", message: ok ? "Moved running tools to the background" : "Nothing to background" })
      },
    },
    {
      id: "session.export",
      title: "Export session transcript",
      category: "Session",
      slash: "export",
      enabled: () => store.messages.length > 0,
      run: async () => {
        const file = path.join(store.cwd, `session-${(store.sessionID ?? "new").slice(0, 8)}.md`)
        writeFileSync(file, transcript())
        if (process.env.VISUAL || process.env.EDITOR) await openEditor(renderer, transcript())
        toast.show({ variant: "success", message: `Exported to ${file}` })
      },
    },
    {
      id: "messages.copy",
      title: "Copy last assistant message",
      category: "Session",
      slash: "copy",
      enabled: () => !!lastAssistantText(),
      run: () => {
        const text = lastAssistantText()
        if (text && copyText(renderer, text)) toast.show({ variant: "success", message: "Copied to clipboard" })
      },
    },
    {
      id: "session.copy",
      title: "Copy session transcript",
      category: "Session",
      enabled: () => store.messages.length > 0,
      run: () => {
        if (copyText(renderer, transcript())) toast.show({ variant: "success", message: "Transcript copied to clipboard" })
      },
    },
    {
      id: "terminal.suspend",
      title: "Suspend terminal",
      category: "System",
      palette: false,
      run: async () => {
        await renderer.suspend()
        process.once("SIGCONT", () => void renderer.resume())
        process.kill(process.pid, "SIGTSTP")
      },
    },
    {
      id: "prompt.stash",
      title: "Stash prompt",
      category: "Prompt",
      slash: "stash",
      enabled: () => !!refs.prompt?.plainText.trim(),
      run: () => {
        const text = refs.prompt .plainText
        config.stash = [text, ...(config.stash ?? [])].slice(0, 50)
        saveConfig()
        setPromptText("")
        toast.show({ variant: "info", message: "Prompt stashed", duration: 1500 })
      },
    },
    {
      id: "prompt.stash.pop",
      title: "Stash pop",
      category: "Prompt",
      enabled: () => !!config.stash?.length,
      run: () => {
        const [text, ...rest] = config.stash ?? []
        config.stash = rest
        saveConfig()
        if (text !== undefined) setPromptText(text)
        dialog.clear()
      },
    },
    {
      id: "prompt.stash.list",
      title: "Stash list",
      category: "Prompt",
      enabled: () => !!config.stash?.length,
      run: () => dialog.replace(() => <DialogStash />),
    },
    {
      id: "prompt.skills",
      title: "Skills",
      category: "Prompt",
      slash: "skills",
      enabled: () => store.commands.length > 0,
      run: () => dialog.replace(() => <DialogSkills />, undefined, "large"),
    },
    {
      id: "usage.reset",
      title: limits.offer ? `Use ${limits.offer.label}` : "Reset the 5-hour limit (Claude Code)",
      category: "System",
      slash: "limit-reset",
      enabled: () => limits.rolling !== false,
      run: () => void resetLimit(),
    },
    {
      id: "usage.extra",
      title: "Claude extra usage",
      category: "System",
      slash: "extra",
      run: () => dialog.replace(() => <DialogExtraUsage />, undefined, "large"),
    },
    {
      id: "provider.connect",
      title: "Connect provider",
      category: "Agent",
      slash: "connect",
      run: () => dialog.replace(() => <DialogConnect />),
    },
    {
      id: "session.sidebar.toggle",
      title: sidebarShown(dimensions().width) ? "Hide sidebar" : "Show sidebar",
      category: "Session",
      slash: "sidebar",
      enabled: () => route() === "session",
      run: () => {
        const visible = sidebarShown(dimensions().width)
        setSidebarOpen(!visible)
        config.sidebarMode = visible ? "hide" : "auto"
        saveConfig()
      },
    },
    { id: "session.toggle.thinking", title: "Toggle thinking blocks", category: "Session", slash: "thinking", run: () => toggleThinking() },
    {
      id: "session.toggle.scrollbar",
      title: showScrollbar() ? "Hide session scrollbar" : "Show session scrollbar",
      category: "Session",
      slash: "scrollbar",
      run: () => toggleScrollbar(),
    },
    {
      id: "session.child.first",
      title: "Go to first subagent",
      category: "Session",
      enabled: () => subagentParts().length > 0,
      run: () => {
        const first = subagentParts()[0]
        if (first) openChild(first.id)
      },
    },
    { id: "session.child.next", title: "Next subagent", category: "Session", palette: false, enabled: () => !!store.child && !dialog.open, run: () => cycleChild(1) },
    { id: "session.child.prev", title: "Previous subagent", category: "Session", palette: false, enabled: () => !!store.child && !dialog.open, run: () => cycleChild(-1) },
    { id: "session.parent", title: "Go to parent session", category: "Session", palette: false, enabled: () => !!store.child && !dialog.open, run: () => openChild(undefined) },
    { id: "tasks.list", title: "Tasks (subagents and background)", category: "Session", slash: "tasks", slashAliases: ["agents-running", "bashes"], run: () => dialog.replace(() => <DialogTasks />, undefined, "large") },
    {
      id: "config.reload",
      title: "Reload configuration",
      category: "System",
      slash: "reload",
      run: () => {
        reloadConfig()
        applyConfigChange()
        toast.show({ variant: "success", message: "Configuration reloaded (idle sessions restarted; running ones when they finish)", duration: 3000 })
      },
    },
    {
      id: "session.pause",
      title: store.pause ? "Resume" : "Break… (stop now or later, resume later)",
      category: "Session",
      slash: "pause",
      slashAliases: ["break"],
      run: () => (store.pause ? active().resume() : actions.pause()),
    },
    { id: "access.settings", title: "Access settings (this harness; each has its own)", category: "Session", slash: "access", run: () => openAccess() },
    { id: "access.sync", title: "Sync this harness's access settings to the others…", category: "Session", run: () => dialog.replace(() => <DialogAccessSync from={store.engine} onDone={() => { restartForAccess(new Set(accessChanged)); accessChanged.clear() }} />) },
    { id: "schedules", title: "Schedules (this tab): stops, resumes, breaks", category: "Session", slash: "schedules", slashAliases: ["stopafter", "schedule"], run: () => openSchedules() },
    { id: "schedule.stop", title: "Plan a stop…", category: "Session", slash: "stopat", run: () => dialog.push(() => <DialogAddStop />, undefined, "large") },
    { id: "schedule.resume", title: "Plan a resume…", category: "Session", slash: "resumeat", run: () => dialog.push(() => <DialogAddResume />) },
    { id: "pause.now", title: "Break now (until you resume)", category: "Session", slash: "breaknow", run: () => active().pause() },
    { id: "schedule.freeze.all", title: "Freeze / unfreeze everything planned (this tab)", category: "Session", run: () => freezeKind("all") },
    { id: "schedule.freeze.stop", title: "Freeze / unfreeze the planned stops", category: "Session", run: () => freezeKind("stop") },
    { id: "schedule.freeze.resume", title: "Freeze / unfreeze the planned resumes", category: "Session", run: () => freezeKind("resume") },
    { id: "schedule.freeze.break", title: "Freeze / unfreeze the planned breaks", category: "Session", run: () => freezeKind("break") },
    {
      id: "orchestrator.toggle",
      title: orchestrator().enabled ? "Turn off orchestrator mode" : "Turn on orchestrator mode",
      category: "Session",
      run: () => {
        const on = !orchestrator().enabled
        saveOrchestrator({ enabled: on })
        for (const tab of tabs()) if (tab.live && tab.store.status === "idle") void tab.restart()
        toast.show({ variant: "info", message: on ? "Orchestrator mode on" : "Orchestrator mode off" })
      },
    },
    { id: "orchestrator.settings", title: "Orchestrator mode settings", category: "Session", run: () => openOrchestrator() },
    {
      id: "routing.toggle",
      title: subagentRouting().enabled ? "Turn off subagent routing" : "Turn on subagent routing",
      category: "Session",
      run: () => {
        const on = !subagentRouting().enabled
        config.subagentRouting = { ...(config.subagentRouting ?? {}), enabled: on }
        if (on && config.subagents === false) config.subagents = true
        saveConfig()
        for (const tab of tabs()) if (tab.live && tab.store.status === "idle") void tab.restart()
        toast.show({ variant: "info", message: on ? "Subagent routing on" : "Subagent routing off" })
      },
    },
    { id: "routing.settings", title: "Subagent routing settings", category: "Session", run: () => openRouting() },
    {
      id: "auto.resume.toggle",
      title: config.autoResume === false ? "Turn on auto-resume after a limit" : "Turn off auto-resume after a limit",
      category: "Session",
      slash: "autoresume",
      run: () => {
        config.autoResume = config.autoResume === false
        saveConfig()
        autoResumeChanged()
        toast.show({ variant: "info", message: config.autoResume ? "Auto-resume on: work goes on when a 5-hour/weekly limit resets" : "Auto-resume off: tabs stay stopped at a limit" })
      },
    },
    {
      id: "auto.resume.mode",
      title: config.autoResumeMode === "one" ? "Auto-resume: all waiting tabs at once" : "Auto-resume: one tab at a time",
      category: "Session",
      run: () => {
        config.autoResumeMode = config.autoResumeMode === "one" ? "all" : "one"
        saveConfig()
        toast.show({ variant: "info", message: config.autoResumeMode === "one" ? "Auto-resume: one tab at a time" : "Auto-resume: all waiting tabs at once" })
      },
    },
    {
      id: "fable.fallback.toggle",
      title: fableFallback().enabled ? "Turn off Fable fallback" : "Turn on Fable fallback",
      category: "Session",
      slash: "fable-fallback",
      run: () => {
        config.fableFallback = { ...fableFallback(), enabled: !fableFallback().enabled }
        saveConfig()
        const rule = fableFallback()
        toast.show({ variant: "info", message: rule.enabled ? `Fable fallback on: at the Fable limit, ${FAMILY_TITLE[rule.model]} with reasoning +${rule.step}` : "Fable fallback off" })
      },
    },
    { id: "fable.fallback.settings", title: "Fable fallback settings", category: "Session", run: () => dialog.replace(() => <DialogFableFallback />) },
    {
      id: "fable.upgrade.toggle",
      title: fableUpgrade().enabled ? "Turn off Back to Fable" : "Turn on Back to Fable",
      category: "Session",
      slash: "fable-return",
      run: () => {
        const now = fableUpgrade()
        config.fableUpgrade = { ...now, enabled: !now.enabled }
        saveConfig()
        toast.show({ variant: "info", message: !now.enabled ? "Back to Fable on: after a used-up Fable limit resets, tabs return to Fable" : "Back to Fable off" })
      },
    },
    { id: "fable.upgrade.settings", title: "Back to Fable settings", category: "Session", run: () => dialog.replace(() => <DialogFableUpgrade />, undefined, "large") },
    { id: "chat.select_all", title: "Select all (copy the whole chat)", category: "Session", run: () => selectAll(renderer) },
    { id: "session.resume", title: "Resume", category: "Session", slash: "resume", enabled: () => !!store.pause, run: () => active().resume() },
    {
      id: "session.codemode",
      title: "Code Mode (Claude Code's own terminal, in this tab)",
      category: "Session",
      slash: "codemode",
      enabled: () => !store.engine && !splitModel(store.model),
      run: () => void openCodeMode(),
    },
    {
      id: "session.restart",
      title: "Restart this tab's engine (keeps the conversation)",
      category: "Session",
      slash: "restart",
      run: async () => {
        toast.show({ variant: "info", message: "Restarting this tab's engine…", duration: 2500 })
        await active().restart(true)
      },
    },
    { id: "session.find", title: "Find in chat", category: "Session", slash: "find", run: () => dialog.replace(() => <DialogFind />, undefined, "large") },
    { id: "session.find.next", title: "Find next", category: "Session", palette: false, run: () => findAgain(1) },
    { id: "session.find.previous", title: "Find previous", category: "Session", palette: false, run: () => findAgain(-1) },
    { id: "auth.login", title: "Log in", category: "System", slash: "login", slashAliases: ["auth"], run: () => dialog.replace(() => <DialogLogin />, undefined, "large") },
    {
      id: "auth.logout",
      title: "Log out of Claude Code",
      category: "System",
      slash: "logout",
      run: () =>
        dialog.replace(() => (
          <DialogConfirm
            title="Log out"
            message="Log out of Claude Code (claude auth logout)? Claude models stop working until you log in again with /login."
            onConfirm={async () => {
              dialog.clear()
              const claude = findBinary("claude")
              if (claude) spawnSync(claude, ["auth", "logout"], { stdio: "ignore", ...spawnOptions(claude) })
              afterClaudeLogin()
              toast.show({ variant: "info", message: "Logged out of Claude Code" })
            }}
            onCancel={() => dialog.clear()}
          />
        )),
    },
    { id: "phone.show", title: "Phone", category: "System", slash: "phone", run: () => dialog.replace(() => <DialogPhone />, undefined, "large") },
    { id: "app.update", title: "Update Agent Code", category: "System", slash: "update", run: () => void updateAcode() },
    { id: "mods.list", title: "Mods", category: "System", slash: "mods", run: () => dialog.replace(() => <DialogMods />, undefined, "large") },
    { id: "settings.show", title: "Settings", category: "System", slash: "settings", slashAliases: ["config", "options"], run: () => dialog.replace(() => <DialogSettings />, undefined, "large") },
    { id: "tab.next", title: "Next tab", category: "Tabs", enabled: () => tabs().length > 1, run: () => nextTab(1) },
    { id: "tab.prev", title: "Previous tab", category: "Tabs", enabled: () => tabs().length > 1, run: () => nextTab(-1) },
    {
      id: "tab.new",
      title: "New tab",
      category: "Tabs",
      slash: "tab",
      keybind: false,
      run: () => {
        void newSession()
        dialog.clear()
      },
    },
    { id: "sidebar.tab.next", title: "Sidebar: next tab (Session, Files, Work)", category: "Session", run: () => nextSideTab() },
    { id: "worktree.list", title: "Worktrees", category: "Session", slash: "worktree", slashAliases: ["worktrees"], run: () => dialog.replace(() => <DialogWorktrees />, undefined, "large") },
    { id: "worktree.new", title: "New worktree (choose base branch)", category: "Session", run: () => newWorktree() },
    { id: "terminal.open", title: "Session terminal", category: "Session", slash: "terminal", run: () => openTerminal() },
    {
      id: "prompt.shell.toggle",
      title: promptMode() === "shell" ? "Leave shell mode" : "Shell mode",
      category: "Prompt",
      run: () => setPromptMode(promptMode() === "shell" ? "normal" : "shell"),
    },
    {
      id: "tab.detach",
      title: "Move tab to a new window",
      category: "Tabs",
      enabled: () => tabHasChat(),
      run: () => {
        if (!tabMovable()) return
        const tab = active()
        const id = store.sessionID
        // The tab leaves this window only if the new one could be opened.
        if (openWindow(store.cwd, [path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "acode"), "-r", id], store.title?.slice(0, 40) ?? APP_NAME)) releaseTab(tab)
      },
    },
    {
      id: "tab.move",
      title: "Move tab to another window…",
      category: "Tabs",
      enabled: () => tabHasChat() && otherWindows().length > 0,
      run: () =>
        tabMovable() &&
        dialog.replace(() => (
          <DialogSelect
            title="Move tab to"
            options={otherWindows().map((window, index) => ({
              title: `Window ${index + 1}`,
              value: String(window.pid),
              description: (window.tabs ?? []).map((tab) => tab.title ?? "session").slice(0, 3).join(" · ") || "empty",
              footer: `${window.tabs?.length ?? 0} tab${window.tabs?.length === 1 ? "" : "s"}`,
            }))}
            onSelect={(option) => {
              const tab = active()
              if (sendTabs(Number(option.value), [{ id: store.sessionID, title: store.title }])) releaseTab(tab)
              dialog.clear()
            }}
          />
        )),
    },
    {
      id: "tab.reopen",
      title: "Reopen closed tab",
      category: "Tabs",
      run: async () => {
        if (!(await reopenTab())) toast.show({ variant: "info", message: "No closed tab to reopen", duration: 2000 })
      },
    },
    {
      id: "tab.close.right",
      title: "Close tabs to the right",
      category: "Tabs",
      enabled: () => tabs().indexOf(active()) < tabs().length - 1,
      run: () => {
        const count = closeTabsRight()
        toast.show({ variant: "info", message: count ? `Closed ${count} tab${count === 1 ? "" : "s"} (ctrl+shift+t reopens the last)` : "Nothing closed: those tabs are working", duration: 3000 })
      },
    },
    {
      id: "tab.unread",
      title: store.unseen ? "Mark as read" : "Mark as unread",
      category: "Tabs",
      run: () => toggleUnread(),
    },
    {
      id: "tab.close",
      title: "Close tab",
      category: "Tabs",
      slash: "close",
      run: () => {
        const session = active()
        const busy = session.store.status === "running" || session.store.permissions.length > 0 || session.store.questions.length > 0
        if (!busy) return closeTab(session)
        dialog.replace(() => (
          <DialogConfirm
            title="Close tab"
            message="This session is still running. Close the tab and interrupt it?"
            onConfirm={() => {
              dialog.clear()
              closeTab(session)
            }}
          />
        ))
      },
    },
    ...Array.from({ length: 9 }, (_, i) => ({
      id: `tab.goto.${i + 1}`,
      title: `Go to tab ${i + 1}`,
      category: "Tabs",
      palette: false,
      enabled: () => tabs().length > i,
      run: () => gotoTab(i),
    })),
    { id: "session.toggle.details", title: "Toggle usage details", category: "Session", slash: "details", run: () => toggleDetails() },
    { id: "session.page.up", title: "Page up", category: "Session", palette: false, run: scroll((s) => s.scrollBy(-page())) },
    { id: "session.page.down", title: "Page down", category: "Session", palette: false, run: scroll((s) => s.scrollBy(page())) },
    { id: "session.half.page.up", title: "Half page up", category: "Session", palette: false, run: scroll((s) => s.scrollBy(-Math.floor(page() / 2))) },
    { id: "session.half.page.down", title: "Half page down", category: "Session", palette: false, run: scroll((s) => s.scrollBy(Math.floor(page() / 2))) },
    { id: "session.line.up", title: "Line up", category: "Session", palette: false, run: scroll((s) => s.scrollBy(-1)) },
    { id: "session.line.down", title: "Line down", category: "Session", palette: false, run: scroll((s) => s.scrollBy(1)) },
    {
      id: "session.first",
      title: "Jump to first message",
      category: "Session",
      run: scroll((s) => s.scrollTo(0)),
      enabled: () => route() === "session" && !refs.prompt?.plainText,
    },
    {
      id: "session.last",
      title: "Jump to last message",
      category: "Session",
      run: scroll((s) => s.scrollTo(s.scrollHeight)),
      enabled: () => route() === "session" && !refs.prompt?.plainText,
    },
    { id: "model.list", title: "Switch model", category: "Agent", slash: "models", slashAliases: ["model"], run: () => dialog.replace(() => <DialogModels />, undefined, "large") },
    {
      id: "model.cycle_recent",
      title: "Next recent model",
      category: "Agent",
      run: () => {
        const recent = config.recentModels ?? []
        if (recent.length < 2) return
        void setModel(recent[1])
      },
    },
    {
      id: "model.cycle_recent_reverse",
      title: "Previous recent model",
      category: "Agent",
      palette: false,
      run: () => {
        const recent = config.recentModels ?? []
        if (recent.length < 2) return
        void setModel(recent[recent.length - 1])
      },
    },
    { id: "model.cycle_favorite", title: "Next favorite model", category: "Agent", run: () => cycleFavorite(1) },
    { id: "model.cycle_favorite_reverse", title: "Previous favorite model", category: "Agent", palette: false, run: () => cycleFavorite(-1) },
    {
      id: "variant.cycle",
      title: "Cycle variant (effort)",
      category: "Agent",
      run: () => {
        const all = [undefined, ...variantsOf(store.model)]
        const index = all.indexOf(store.effort)
        void setEffort(all[(index + 1) % all.length])
      },
    },
    { id: "variant.list", title: "Switch variant", category: "Agent", slash: "variants", slashAliases: ["effort", "variant"], run: () => dialog.replace(() => <DialogEffort />) },
    {
      id: "model.fast",
      title: store.fast ? "Disable fast mode" : "Enable fast mode",
      category: "Agent",
      slash: "fast",
      keybind: false,
      enabled: () => !!store.models.find((item) => item.value === store.model)?.supportsFastMode,
      run: () => void setFast(!store.fast),
    },
    { id: "agent.list", title: "Switch agent", category: "Agent", slash: "agents", run: () => dialog.replace(() => <DialogAgents />) },
    { id: "agent.cycle", title: "Next agent", category: "Agent", palette: false, run: () => cycleAgent(1) },
    { id: "agent.cycle.reverse", title: "Previous agent", category: "Agent", palette: false, run: () => cycleAgent(-1) },
    {
      id: "permission.mode.list",
      title: "Permission mode",
      category: "Agent",
      slash: "permissions",
      slashAliases: ["mode"],
      run: () => dialog.replace(() => <DialogPermissionMode />),
    },
    {
      id: "permission.autoaccept",
      title: store.mode === "acceptEdits" ? "Stop auto-accepting edits" : "Auto-accept edits",
      category: "Agent",
      keybind: false,
      run: () => void setMode(store.mode === "acceptEdits" ? "default" : "acceptEdits"),
    },
    { id: "mcp.list", title: "MCP servers", category: "Agent", slash: "mcps", slashAliases: ["mcp"], run: () => dialog.replace(() => <DialogMcp />) },
    { id: "theme.switch", title: "Switch theme", category: "System", slash: "themes", slashAliases: ["theme"], run: () => dialog.replace(() => <DialogThemes />) },
    { id: "status.show", title: "View status", category: "System", slash: "status", run: () => dialog.replace(() => <DialogStatus />) },
    { id: "help.show", title: "Help", category: "System", slash: "help", run: () => dialog.replace(() => <DialogHelp />) },
    {
      id: "prompt.editor",
      title: "Open editor",
      category: "Prompt",
      slash: "editor",
      run: async () => {
        const text = await openEditor(renderer, refs.prompt?.plainText ?? "")
        if (text !== undefined) setPromptText(text.trimEnd())
      },
    },
    {
      id: "app.toggle.animations",
      title: config.animations === false ? "Enable animations" : "Disable animations",
      category: "System",
      keybind: false,
      run: () => {
        config.animations = config.animations === false
        saveConfig()
        toast.show({ variant: "info", message: "Restart to apply animation setting" })
      },
    },
    {
      id: "app.exit",
      title: "Exit the app",
      category: "System",
      slash: "exit",
      slashAliases: ["quit", "q"],
      run: (event) => {
        // ctrl+c only exits from an empty prompt (the prompt layer clears text first).
        if (event?.ctrl && event.name === "c" && refs.prompt?.plainText) return false
        exit()
      },
    },
  ]

  useLayer({ commands })

  // Copy-on-select, like opencode. The selection stays: in the prompt it can still be typed over or deleted; it
  // goes with the next click. Each selection is copied once (a click that ends without a new one copies nothing).
  let copiedSelection
  const onMouseUp = () => {
    const selection = renderer.getSelection()
    const selected = selection?.getSelectedText()
    if (!selected || selection === copiedSelection) return
    copiedSelection = selection
    // A copied prompt carries its files' paths, not their placeholders.
    const text = selectionWithPaths(selected, store.messages)
    if (copyText(renderer, text)) toast.show({ variant: "info", message: "Copied to clipboard", duration: 1500 })
  }

  // Plugin routes: a registered name renders instead of home/session.
  const pluginView = createMemo(() => {
    const current = pluginRoute()
    if (!current) return undefined
    const render = routeRender(current.name)
    return render ? { render, params: current.params } : undefined
  })

  return (
    <box width={dimensions().width} height={dimensions().height} backgroundColor={theme.background} onMouseUp={onMouseUp}>
      <Show when={tabBarVisible()}>
        <TabBar />
      </Show>
      <box flexGrow={1} minHeight={0}>
        {/* Keyed on the focused tab: switching tabs remounts its view (prompt, scroll position, draft). */}
        {/* The child must take the tab as a parameter: Solid only re-runs keyed children with arity > 0. */}
        <Show when={active()} keyed>
          {(_tab         ) => (
            <Switch>
              <Match when={pluginView()}>{(view                                                                                                          ) => view().render({ params: view().params })}</Match>
              <Match when={route() === "home"}>
                <Home />
              </Match>
              <Match when={route() === "session"}>
                <Session />
              </Match>
            </Switch>
          )}
        </Show>
      </box>
      <Slot name="app_bottom" />
      <Slot name="app" />
      <Show when={leaderActive()}>
        <box position="absolute" bottom={0} right={2} zIndex={500}>
          <text fg={theme.textMuted}>{shortcut("leader")} …</text>
        </box>
      </Show>
      <DialogHost />
      <ToastHost />
    </box>
  )
}

export { agentIndex, currentAgent }
