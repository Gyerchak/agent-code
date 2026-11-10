import { findBinary, isWindows, openCommand, spawnOptions } from "./context/platform"
import { TextAttributes } from "@opentui/core"
import { authFile, harnessStatus, importFromOpencode, providerName, providers, refreshProviders, saveKey, splitModel } from "./context/providers"
import { billingLabel, catalog, contextText, modelMeta, priceText, refreshCatalog, SUBAGENT_TIERS, tierModels } from "./context/catalog"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { opencodeBinary } from "./context/acp"
import { lanAddress, phoneLink, phoneQr, phoneServerState, phoneSettings, phoneToken, setPhoneSetting, startPhoneServer, stopPhoneServer } from "./context/remote"
import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dropsBlocked, selectionWithPaths, textWithPaths } from "./context/attachments"
import { modelVariants } from "./context/variants"
import { boxDir, ownSettings, resetBox, restartBox, setOwnSettings } from "./context/box"
import { ensureMcpFile, importMcp, mcpFile } from "./context/mcp"
import { discoverMods, ensureModsDir, modEnabled, modsDir, modsEnabled, modsShows, setModEnabled, setModsSetting } from "./context/mods"
import { createEffect, createMemo, createResource, createSignal, For, Match, on, onCleanup, onMount, Show, Switch } from "solid-js"
import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { forgetPlan, planRate } from "./context/usage"
import { config, listSavedSettings, reloadConfig, resetSettings, restoreSettings, saveConfig, saveSettings } from "./context/config"
import {
  actions,
  exit,
  focusPrompt,
  refs,
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
import { AGENTS, agentIndex, claudeModelList, limits, limitWasReset, onSessionEvent, pollPlanUsage, useLimitReset } from "./context/session"
import {
  active,
  app,
  backgroundTasks,
  closeTab,
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
} from "./context/tabs"
import { agentColor, setTheme, themeName, themeList, theme } from "./context/theme"
import { logFile } from "./context/log"
import { Logo } from "./component/logo"
import { Prompt, setPromptText } from "./component/prompt"
import { ModBand, ModStatus } from "./component/mods"
import { cycleChild, openChild, Session, subagentParts, TASK_KINDS, taskEntries } from "./routes/session"
import { dialog, DialogConfirm, DialogHost, DialogPrompt, DialogSelect, setDialogRefocus } from "./ui/dialog"
import { toast, ToastHost } from "./ui/toast"
import { TabBar, tabBarVisible } from "./component/tabs"
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
  const dir = mkdtempSync(path.join(os.tmpdir(), "open-claude-code-"))
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
 * Run a harness's own interactive command (its login, exactly as the harness does it) in this terminal: occ steps
 * aside, the command takes the screen, and occ comes back after Enter.
 */
async function runInTerminal(renderer, file, args, title) {
  await renderer.suspend()
  try {
    process.stdout.write(`\n\x1b[1m${title}\x1b[0m  (${[file, ...args].join(" ")})\n\n`)
    const result = spawnSync(file, args, { stdio: "inherit", ...spawnOptions(file) })
    process.stdout.write(`\n${result.status === 0 ? "Done." : `It ended with code ${result.status ?? "?"}.`} Press Enter to go back to occ… `)
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

/** How full a plan limit window gets before "Pause before a limit" pauses (default 90 %). */
function DialogPauseAt() {
  const current = config.pauseAt ?? 90
  return (
    <DialogSelect
      title="Pause at"
      current={String(current)}
      options={[70, 75, 80, 85, 90, 95, 98, 99].map((value) => ({
        title: `${value}%`,
        value: String(value),
        description: value === 90 ? "default" : value >= 98 ? "just before the limit" : undefined,
      }))}
      onSelect={(option) => {
        config.pauseAt = Number(option.value)
        if (config.pauseNearLimit === false) config.pauseNearLimit = true
        saveConfig()
        dialog.replace(() => <DialogSettings />, undefined, "large")
        toast.show({ variant: "success", message: `Pausing at ${option.value}% of a plan limit` })
      }}
    />
  )
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
        // Anthropic exposes no public endpoint for switching it; occ re-reads the state when you come back.
        description: e.canToggle ? "opens the usage settings; occ picks up the change" : "your account can't switch it here; opens the usage settings",
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
  // The usual ones plus every provider in occ's own list (e.g. several Ollama Cloud accounts).
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
        { title: "Import from opencode", value: ":import", description: "copy providers, keys and MCP servers occ doesn't have yet", category: "Keys" },
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
                // Keys live in occ's own key store, never in config.json.
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
    // Description: intelligence + context; footer: who pays and how much ($ per million input/output tokens).
    // Claude on a plan: the API price ($ per million input/output tokens), how fast the model uses the plan next to
    // Sonnet, and (once occ has measured the plan's worth, see planRate) what its tokens cost on the plan.
    const rate = catalog.plan ? planRate(catalog.planLabel ?? catalog.plan, config.planPrice) : undefined
    const sonnet = modelMeta("sonnet").price?.input
    const claudeFacts = (model, meta) => {
      if (meta.kind !== "anthropic" || !meta.price) return { facts: [], footer: undefined }
      const facts = [`API ${priceText(meta.price)}`]
      if (meta.billing !== "plan") return { facts, footer: undefined }
      if (sonnet && meta.price.input !== sonnet) facts.push(`${Math.round((meta.price.input / sonnet) * 10) / 10}× Sonnet usage`)
      const scoped = (limits.scoped ?? []).find((w) => [model.value, model.displayName, model.resolvedModel].some((v) => String(v ?? "").toLowerCase().includes(w.name.toLowerCase())))
      if (scoped?.allowance) facts.push(`≤${scoped.allowance}% of weekly`)
      if (!rate?.factor) return { facts, footer: undefined }
      const plan = { input: meta.price.input * rate.factor, output: meta.price.output * rate.factor }
      facts.push(`plan ≈${Math.max(1, Math.round(1 / rate.factor))}× cheaper`)
      return { facts, footer: `${billingLabel(meta, model.provider)} ≈${priceText(plan)}` }
    }
    const option = (model                                                                          , category        ) => {
      const meta = modelMeta(model.value, (model       ).resolvedModel)
      const claude = claudeFacts(model, meta)
      const facts = [meta.context ? `${contextText(meta.context)} ctx` : "", ...claude.facts].filter(Boolean).join(" · ")
      return {
        title: model.displayName,
        value: model.value,
        description: facts + (favs.includes(model.value) && category !== "Favorites" ? (facts ? " · " : "") + "favourite" : ""),
        category,
        footer: claude.footer ?? billingLabel(meta, model.provider),
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
    const favorite = favs.map(byValue).filter(Boolean).map((model) => option(model       , "Favorites"))
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
        void setModel(option.value)
        // Like opencode: a model with variants continues to the variant picker.
        // A model with variants asks for one the first time; afterwards its stored level comes back.
        if (variantsOf(option.value).length && config.modelEffort?.[option.value] === undefined) {
          dialog.replace(() => <DialogEffort />)
          return
        }
        dialog.clear()
      }}
      actions={[
        { keybind: "model.dialog.favorite", label: "favorite", run: (option) => toggleFavorite(option.value) },
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

function DialogEffort() {
  const levels = createMemo(() => variantsOf(store.model))
  return (
    <DialogSelect
      title="Select variant"
      options={[
        { title: "default", value: "default", description: "model default" },
        ...levels().map((level) => ({ title: level, value: level, description: EFFORT_HINTS[level] })),
      ]}
      current={store.effort ?? "default"}
      onSelect={(option) => {
        void setEffort(option.value === "default" ? undefined : (option.value               ))
        dialog.clear()
      }}
    />
  )
}

function DialogAgents() {
  return (
    <DialogSelect
      title="Select agent"
      options={[
        ...AGENTS.map((agent, index) => ({
          title: agent.name,
          value: agent.id,
          description: agent.id === "build" ? "Default agent, executes tools per your permissions" : "Plan mode, read-only exploration",
          category: "Primary",
          gutter: <text fg={agentColor(index)}>●</text>,
        })),
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
        const agent = AGENTS.find((item) => item.id === option.value)
        if (agent) void setMode(agent.mode)
        dialog.clear()
      }}
    />
  )
}

function DialogPermissionMode() {
  const modes                                                                  = [
    { value: "default", title: "Default", description: "ask before edits and commands" },
    { value: "acceptEdits", title: "Accept edits", description: "auto-approve file edits" },
    { value: "plan", title: "Plan", description: "read-only planning" },
    { value: "auto", title: "Auto", description: "classifier approves safe actions" },
    { value: "dontAsk", title: "Don't ask", description: "deny anything not pre-approved" },
    { value: "bypassPermissions", title: "Bypass permissions", description: "skip all permission checks" },
  ]
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

function DialogSessions() {
  onMount(() => void refreshSessions())
  const options = createMemo(() =>
    app.sessions.map((session) => ({
      title: (session.customTitle ?? session.summary ?? session.firstPrompt ?? session.sessionId).replace(/\s+/g, " "),
      value: session.sessionId,
      category: dayCategory(session.lastModified),
      footer: (findTab(session.sessionId) ? "open · " : "") + relativeTime(session.lastModified),
    })),
  )
  return (
    <DialogSelect
      title="Sessions"
      options={options()}
      current={store.sessionID}
      emptyText="No sessions yet in this directory"
      onSelect={(option) => {
        dialog.clear()
        setRoute("session")
        void openSession(option.value, option.title)
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
      emptyText="No MCP servers yet — ctrl+e opens occ's MCP file"
      onSelect={(option) => {
        const server = store.mcp.find((item) => item.name === option.value)
        if (!server) return
        void toggleMcp(server.name, server.status === "disabled")
      }}
      actions={[
        { keybind: "ctrl+r", label: "reconnect", run: (option) => void reconnectMcp(option.value) },
        // occ's own servers live in its secrets file, auth.json (restart the tab after editing it).
        { keybind: "ctrl+e", label: "edit occ servers", run: () => (ensureMcpFile(), openURL(mcpFile)) },
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
          Claude Code <span style={{ fg: theme.textMuted }}>{store.version ?? "starting…"}</span>
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

function DialogTasks() {
  const options = createMemo(() => {
    const entries = taskEntries()
    const order = (entry           ) => TASK_KINDS.findIndex((kind) => kind.id === entry.kind) * 2 + (entry.running ? 0 : 1)
    return [...entries]
      .sort((a, b) => order(a) - order(b))
      .map((entry) => ({
        title: entry.title,
        value: entry.key,
        category: `${TASK_KINDS.find((kind) => kind.id === entry.kind) .title}${entry.running ? "" : " · finished"}`,
        footer: entry.failed ? "failed" : entry.detail,
      }))
  })
  return (
    <DialogSelect
      title="Tasks"
      options={options()}
      emptyText="No subagents, shells or other tasks in this session"
      onSelect={(option) => {
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



/** Claude Code mods: which load, and what of them occ draws. */
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
        footer: `${mod.source === "occ" ? "occ" : mod.source === "env" ? "CLAUDE_CODE_PLUGIN_DIRS" : "Claude Code"}${mod.version ? ` · ${mod.version}` : ""}`,
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

/** `/update`: fast-forward occ's own repository; the launcher rebuilds it on the next start. */
async function updateOcc() {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
  const git = (...args) =>
    new Promise((resolve) =>
      execFile("git", ["-C", dir, ...args], { timeout: 60_000 }, (error, stdout, stderr) => resolve({ ok: !error, out: String(stdout).trim(), err: String(stderr || error?.message || "").trim() })),
    )
  toast.show({ variant: "info", message: "Checking for occ updates…", duration: 2000 })
  if (!(await git("rev-parse", "--git-dir")).ok) return toast.show({ variant: "warning", message: `${dir} is not a git checkout: update it by hand`, duration: 6000 })
  const fetched = await git("fetch", "--quiet", "--tags")
  if (!fetched.ok) return toast.show({ variant: "error", message: `Could not reach the occ repository: ${fetched.err.split("\n").at(-1)}`, duration: 8000 })
  const behind = Number((await git("rev-list", "--count", "HEAD..@{u}")).out || 0)
  if (!behind) return toast.show({ variant: "success", message: `occ is up to date (${(await git("describe", "--tags")).out})`, duration: 4000 })
  if ((await git("status", "--porcelain", "--untracked-files=no")).out)
    return toast.show({ variant: "warning", message: "occ has local changes: commit them first, then /update", duration: 8000 })
  const pulled = await git("pull", "--ff-only", "--quiet")
  if (!pulled.ok) return toast.show({ variant: "error", message: `Update failed: ${pulled.err.split("\n").at(-1)}`, duration: 8000 })
  toast.show({ variant: "success", title: "occ updated", message: `${(await git("describe", "--tags")).out} (${behind} new commit${behind === 1 ? "" : "s"}). Restart occ to use it; it rebuilds on start.`, duration: 10000 })
}

/** After the settings changed under occ (reload, restore, reset): apply what can change while running. */
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

/** occ on a phone: the server, its address and how phones pair. */
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

// Every session's text, read once per occ run (transcripts only change in open tabs, which are searched live).
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
      for (const item of items) {
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
  const next = direction > 0 ? (indexes.find((index) => index > lastFind.at) ?? indexes[0]) : (indexes.findLast((index) => index < lastFind.at) ?? indexes.at(-1))
  lastFind.at = next
  jumpTo(store.messages[next].id)
  toast.show({ variant: "info", message: `${indexes.indexOf(next) + 1} / ${indexes.length}: "${lastFind.query}"`, duration: 1500 })
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
 * Reset the 5-hour limit: an offer occ can see is used directly; otherwise Claude Code's own /limit-reset runs in
 * this terminal (Anthropic may offer it only there), and occ reads the usage again afterwards.
 */
let appRenderer
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
        description: "uses the DeepSeek key from occ (DEEPSEEK_API_KEY)",
        footer: "set key",
        category: "Harnesses",
      },
      { title: "Provider keys…", value: "connect", description: "OpenAI, DeepSeek, OpenCode Zen/Go, Ollama keys for occ (/connect)", category: "occ" },
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

/** How long to pause the focused tab: by hand, for a while, at a time, or until the 5-hour window resets. */
function DialogPause() {
  const fiveHour = limits.fiveHour?.resetsAt && limits.fiveHour.resetsAt > Date.now() ? limits.fiveHour.resetsAt : undefined
  const at = (minutes) => Date.now() + minutes * 60_000
  const options = [
    { title: "Until I resume", value: "manual", description: "click the bar, /resume or ctrl+x p again" },
    { title: "15 minutes", value: "15" },
    { title: "30 minutes", value: "30" },
    { title: "1 hour", value: "60" },
    { title: "2 hours", value: "120" },
    ...(fiveHour ? [{ title: "Until the 5-hour limit resets", value: "reset", footer: new Date(fiveHour + 30_000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }] : []),
    { title: "Until a time…", value: "time", description: "HH:MM, or a number of minutes" },
  ]
  return (
    <DialogSelect
      title="Pause"
      flatten
      options={options}
      onSelect={(option) => {
        const session = active()
        if (option.value === "time") {
          dialog.replace(() => (
            <DialogPrompt
              title="Resume at (HH:MM) or after N minutes"
              placeholder="e.g. 14:30 or 45"
              onConfirm={(value) => {
                const text = value.trim()
                const clock = text.match(/^(\d{1,2}):(\d{2})$/)
                let until
                if (clock) {
                  const date = new Date()
                  date.setHours(Number(clock[1]), Number(clock[2]), 0, 0)
                  if (date.getTime() <= Date.now()) date.setDate(date.getDate() + 1)
                  until = date.getTime()
                } else if (/^\d+$/.test(text)) until = at(Number(text))
                dialog.clear()
                if (!until) return toast.show({ variant: "warning", message: "Write a time like 14:30 or a number of minutes" })
                session.pause(until)
                toast.show({ variant: "info", message: `Paused until ${new Date(until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` })
              }}
            />
          ))
          return
        }
        const until = option.value === "manual" ? undefined : option.value === "reset" ? fiveHour + 30_000 : at(Number(option.value))
        session.pause(until)
        dialog.clear()
        toast.show({
          variant: "info",
          message: session.engine || session.store.engine ? "Paused: stopped now, a short continue on resume" : "Paused: the work stops at its next step; nothing is sent until it resumes",
          duration: 4000,
        })
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
    // Only inside an occ-box: tied to occ's settings by default, or its own copy.
    ...(boxDir
      ? [
          {
            key: "box.own",
            title: "Box: own settings",
            description: ownSettings() ? "this box keeps its own settings" : "uses occ's settings (shared)",
            get: () => ownSettings(),
            set: (value         ) => setOwnSettings(value),
          },
          { key: "box.reset", title: "Box: reset to factory default", description: "back to occ's settings (own copy kept as a backup)", get: () => !ownSettings(), set: () => {} },
        ]
      : []),
    { key: "autoAllow", title: "Allow everything", description: "approve every tool without asking", get: flag("autoAllow", false), set: write("autoAllow") },
    { key: "askQuestions", title: "Clarifying questions", description: "Claude may ask you questions", get: flag("askQuestions", true), set: write("askQuestions"), restart: true },
    { key: "runTests", title: "Run tests", description: "Claude may run tests and checks", get: flag("runTests", true), set: write("runTests"), restart: true },
    { key: "preferTools", title: "Prefer tools", description: "use installed tools instead of spending tokens", get: flag("preferTools", true), set: write("preferTools"), restart: true },
    { key: "installTools", title: "Install tools", description: "Claude may download and set up new tools", get: flag("installTools", false), set: write("installTools"), restart: true },
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
    { key: "autoResume", title: "Auto resume", description: "continue after a 5-hour/weekly limit resets", get: flag("autoResume", false), set: write("autoResume") },
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
        ? "this Alacritty window can't receive drops on Wayland: open occ with occ-window"
        : "files dragged or pasted into the prompt are attached",
      get: flag("dropFiles", true),
      set: write("dropFiles"),
    },
    { key: "pauseNearLimit", title: "Pause before a limit", description: "near a plan limit, pause until it resets (resume to go on up to 100%)", get: flag("pauseNearLimit", true), set: write("pauseNearLimit") },
    { key: "pauseAt", title: "  Pause at", description: "how full a limit window gets before the pause", get: () => config.pauseNearLimit !== false, set: () => {} },
    { key: "scrollOnSend", title: "Scroll on send", description: "jump to the end of the chat when you send a prompt", get: flag("scrollOnSend", true), set: write("scrollOnSend") },
    { key: "attachmentPreviews", title: "Attachment previews", description: "image thumbnails and file heads in the chat", get: flag("attachmentPreviews", true), set: write("attachmentPreviews") },
    { key: "mods.dialog", title: "Mods…", description: "Claude Code mods: which load, what occ draws", get: () => modsEnabled(), set: () => {} },
    { key: "settings.save", title: "Save settings…", description: "keep these settings under a name, to bring back later", get: () => false, set: () => {} },
    { key: "settings.restore", title: "Restore saved settings…", description: "put a saved set of settings back", get: () => false, set: () => {} },
    { key: "settings.reset", title: "Reset to defaults", description: "every setting back to default (saved first; tabs, history and keys stay)", get: () => false, set: () => {} },
  ]
  const options = createMemo(() => {
    tick()
    return settings.map((setting) => ({
      title: setting.title,
      value: setting.key,
      description: setting.description,
      footer: (setting.get() ? "on" : "off") + (setting.tier && config.subagentPriority?.[setting.tier]?.length ? ` · ${config.subagentPriority[setting.tier] .length} first` : ""),
      gutter: <text fg={setting.get() ? theme.success : theme.textMuted}>{setting.get() ? "[x]" : "[ ]"}</text>,
      // Saving, restoring and resetting the settings are actions, not switches.
      ...(setting.key === "pauseAt" ? { footer: `${config.pauseAt ?? 90}%`, gutter: <text fg={theme.textMuted}>{" % "}</text> } : {}),
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
      options={options()}
      flatten
      onSelect={(option) => {
        if (option.value === "mods.dialog") {
          dialog.replace(() => <DialogMods />, undefined, "large")
          return
        }
        if (option.value === "pauseAt") {
          dialog.replace(() => <DialogPauseAt />)
          return
        }
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
          toast.show({ variant: "info", message: ownSettings() ? "Box: own settings, restarting…" : "Box: occ's settings, restarting…", duration: 2000 })
          setTimeout(() => restartBox(), 600)
          return
        }
        if (option.value === "box.reset") {
          dialog.replace(() => (
            <DialogConfirm
              title="Reset this box"
              message="The box goes back to occ's settings. Its own settings are kept as a dated backup in cfg/open-claude-code. occ restarts."
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
        if (setting.restart) {
          // These change Claude Code's system prompt / tools: restart idle tabs so they apply now.
          for (const tab of tabs()) if (tab.live && tab.store.status === "idle") void tab.restart()
          toast.show({ variant: "info", message: "Applied to idle sessions; running ones pick it up when restarted", duration: 3000 })
        }
      }}
      actions={[
        {
          keybind: "ctrl+o",
          label: "prioritise (subagent tiers)",
          run: (option) => {
            const setting = settings.find((item) => item.key === option.value)
            if (setting?.tier) dialog.push(() => <DialogPriority tier={setting.tier } onClose={() => setTick((value) => value + 1)} />)
          },
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
          message: "Alacritty on Wayland can't receive dropped files. Start occ with `occ-window` (or the Open Claude Code launcher) to drag files straight in.",
          duration: 15000,
        }),
      1500,
    )
  })
  useKeyboard((event          ) => dispatchKey(event))
  actions.pause = () => dialog.replace(() => <DialogPause />)
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
      (title) => renderer.setTerminalTitle(title ? `${title} · claude` : "claude code"),
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
      enabled: () => !!store.sessionID,
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
      title: store.pause ? "Resume" : "Pause",
      category: "Session",
      slash: "pause",
      run: () => (store.pause ? active().resume() : actions.pause()),
    },
    { id: "session.resume", title: "Resume", category: "Session", slash: "resume", enabled: () => !!store.pause, run: () => active().resume() },
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
    { id: "app.update", title: "Update occ", category: "System", slash: "update", run: () => void updateOcc() },
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

  // Copy-on-select, like opencode.
  const onMouseUp = () => {
    const selected = renderer.getSelection()?.getSelectedText()
    if (!selected) return
    // A copied prompt carries its files' paths, not their placeholders.
    const text = selectionWithPaths(selected, store.messages)
    if (copyText(renderer, text)) toast.show({ variant: "info", message: "Copied to clipboard", duration: 1500 })
    renderer.clearSelection()
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
