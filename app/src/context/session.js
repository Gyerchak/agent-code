import os from "node:os"
import { findBinary } from "./platform"
import {
  createSdkMcpServer,
  getSessionMessages,
  query,
  tool,
} from "@anthropic-ai/claude-agent-sdk"
import { batch, createSignal } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import { execFile, execFileSync } from "node:child_process"
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { diffLines, structuredPatch } from "diff"
import path from "node:path"
import { AcpClient, acpContentText, acpToolInput, acpToolName, opencodeApi } from "./acp"
import { attachmentMeta } from "./attachments"
import { modPlugins, modsShows } from "./mods"
import { billingLabel, catalog, modelMeta, setCatalog, SUBAGENT_TIERS, tierModels } from "./catalog"
import { COMPACT_AT, config, saveConfig } from "./config"
import { VARIANT } from "./local"
import { log } from "./log"
import { stateDir } from "./paths"
import { ensureBoxTrusted } from "./box"
import { acodeMcpServers } from "./mcp"
import { apiKeyFor, harnessModel, opencodeModel, providerEnv, providerKind, providerName, providers, refreshProviders, routerEnv, splitModel } from "./providers"
import { acpEffort, acpModels, acpModes, harnessById, harnessInfo, harnessLaunch } from "./harnesses"
import { modelVariants } from "./variants"
import { sessionSpend, spendSnapshot } from "./spendhistory"
import { accessFor } from "./access"
import { blockLogin, blockedUntil, chosenLogin, loginLabel, loginsOf, loginRule } from "./logins"
import { claimResetOffer, fetchPlanUsage, fetchResetOffer, isLimitError, limitResetTime, notePlanSpend, onSharedPlanUsage, planDetails, planPerPercent, publishPlanUsage, samplePlanRate } from "./usage"

// Claude Code's model list as a Claude-login process reports it. A process pointed at another provider
// renames every Claude alias to that provider's model (and drops some), so those tabs use this list.
const claudeModelsFile = path.join(stateDir, "claude-models.json")
let claudeModels              = (() => {
  try {
    return JSON.parse(readFileSync(claudeModelsFile, "utf8"))
  } catch {
    return []
  }
})()

/** The Claude models Claude Code offers with a Claude login (cached from the last such process). */
export function claudeModelList() {
  return claudeModels
}

function rememberClaudeModels(models             ) {
  if (!models.length || JSON.stringify(models) === JSON.stringify(claudeModels)) return
  claudeModels = models
  try {
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(claudeModelsFile, JSON.stringify(models))
  } catch (error) {
    log("claude models write failed", error)
  }
}

/**
 * Each conversation keeps its own reasoning level (variant). The level remembered per model is only the starting
 * point for a new conversation: opening an older one used to take whatever that model was last set to elsewhere.
 */
function rememberSessionEffort(sessionID, effort) {
  const value = effort ?? "default"
  if (!sessionID || config.sessionEffort?.[sessionID] === value) return
  const list = { ...config.sessionEffort }
  delete list[sessionID]
  list[sessionID] = value
  const keys = Object.keys(list)
  for (const key of keys.slice(0, Math.max(0, keys.length - 300))) delete list[key]
  config.sessionEffort = list
  saveConfig()
}

/**
 * The level a conversation was on: Agent Code's own record, else the level its transcript last ran at (Claude Code
 * saves it with every request), else the one last chosen for its model. Found in the transcript, it is recorded,
 * so it is the session's own from then on.
 */
function sessionEffort(sessionID, model, history) {
  const own = sessionID ? config.sessionEffort?.[sessionID] : undefined
  if (own !== undefined) return own === "default" ? undefined : own
  const ran = history?.findLast((entry) => entry.type === "assistant" && typeof entry.effort === "string")?.effort
  if (ran && sessionID && !splitModel(model)) {
    rememberSessionEffort(sessionID, ran)
    return ran
  }
  return storedEffort(model)
}

/** Remember which model a conversation runs on (newest last, capped). */
function rememberSessionModel(sessionID                    , model        ) {
  if (!sessionID || config.sessionModels?.[sessionID] === model) return
  const list = { ...config.sessionModels }
  delete list[sessionID]
  list[sessionID] = model
  const keys = Object.keys(list)
  for (const key of keys.slice(0, Math.max(0, keys.length - 300))) delete list[key]
  config.sessionModels = list
  saveConfig()
}

/**
 * The model a saved conversation used: Agent Code's own record, else the last model in its transcript.
 * The transcript only has the bare id, so a provider model is matched against the user's recent ones.
 */
function savedModel(sessionID        , history       )                     {
  const own = config.sessionModels?.[sessionID]
  if (own) return own
  const id = history.findLast((entry) => entry.type === "assistant" && entry.message?.model && entry.message.model !== "<synthetic>")?.message.model


  if (!id) return undefined
  const known = [...(config.favoriteModels ?? []), ...(config.recentModels ?? [])]
  const provider = known.find((value) => splitModel(value)?.model.replace(VARIANT, "") === id.replace(VARIANT, ""))
  if (!id.startsWith("claude-")) return provider
  return claudeModels.find((model) => ["opus", "sonnet", "haiku"].includes(model.value) && model.resolvedModel === id)?.value ?? id
}

// ---------------------------------------------------------------------------
// Transcript model (shaped after opencode's session messages)
// ---------------------------------------------------------------------------






































/** What a prompt carries besides its text. */


const attr = (value        ) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")

/** The tag that introduces an attachment; history conversion reads it back (see attachmentsFromHistory). */
function attachmentTag(item            , close = true) {
  const fields                                          = [
    ["kind", item.kind],
    ["name", item.name],
    ["token", item.token],
    ["path", item.path],
    ["mime", item.mime],
    ["size", item.size],
    ["width", item.width],
    ["height", item.height],
    ["duration", item.duration ? Math.round(item.duration * 10) / 10 : undefined],
  ]
  const attrs = fields
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `${key}="${attr(String(value))}"`)
    .join(" ")
  return `<attachment ${attrs}${close ? " />" : ">"}`
}

/** Claude Code content blocks for attachments: images and PDFs as such, text files inline, the rest by path. */
function attachmentBlocks(attachments              )        {
  const blocks        = []
  for (const item of attachments) {
    if (item.kind === "image" && item.data) {
      blocks.push({ type: "text", text: attachmentTag(item) })
      blocks.push({ type: "image", source: { type: "base64", media_type: item.mime, data: item.data } })
    } else if (item.kind === "pdf" && item.data) {
      blocks.push({ type: "text", text: attachmentTag(item) })
      blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: item.data }, title: item.name })
    } else if (item.kind === "text" && item.text !== undefined) {
      blocks.push({ type: "text", text: `${attachmentTag(item, false)}\n${item.text}\n</attachment>` })
    } else {
      const hint =
        item.kind === "dir"
          ? "a folder: look inside it as needed"
          : item.kind === "video"
            ? "a video file: inspect it from disk as needed (e.g. ffprobe, or ffmpeg to extract frames)"
            : item.kind === "audio"
              ? "an audio file: inspect it from disk as needed (e.g. ffprobe)"
              : item.kind === "binary"
                ? "a binary file: read it from disk as needed"
                : "too large to inline: read it from disk as needed"
      blocks.push({ type: "text", text: `${attachmentTag(item, false)}${hint}</attachment>` })
    }
  }
  return blocks
}

/** Attachments of a stored prompt, rebuilt from its content blocks (tags, images, documents). */
function attachmentsFromHistory(content       )               {
  const out               = []
  for (let i = 0; i < content.length; i++) {
    const block = content[i]
    if (block?.type === "image" && !(content[i - 1]?.type === "text" && String(content[i - 1].text).startsWith("<attachment "))) {
      out.push({ kind: "image", name: "image", mime: block.source?.media_type ?? "image/png", data: block.source?.data })
      continue
    }
    if (block?.type !== "text" || !String(block.text).startsWith("<attachment ")) continue
    const text = String(block.text)
    const head = text.match(/^<attachment ([^>]*?)\s*\/?>/)
    if (!head) continue
    const fields                         = {}
    for (const match of head[1].matchAll(/(\w+)="([^"]*)"/g))
      fields[match[1]] = match[2].replace(/&lt;/g, "<").replace(/&quot;/g, '"').replace(/&amp;/g, "&")
    const item             = {
      kind: (fields.kind                      ) ?? "text",
      name: fields.name ?? "file",
      token: fields.token,
      path: fields.path,
      mime: fields.mime ?? "application/octet-stream",
      size: fields.size ? Number(fields.size) : undefined,
      width: fields.width ? Number(fields.width) : undefined,
      height: fields.height ? Number(fields.height) : undefined,
      duration: fields.duration ? Number(fields.duration) : undefined,
    }
    const next = content[i + 1]
    if (item.kind === "image" && next?.type === "image") {
      item.data = next.source?.data
      i++
    } else if (item.kind === "pdf" && next?.type === "document") i++
    else if (item.kind === "text" && !head[0].endsWith("/>")) {
      const body = text.slice(head[0].length).replace(/<\/attachment>\s*$/, "").replace(/^\n/, "").replace(/\n$/, "")
      item.text = body.split("\n").slice(0, 200).join("\n")
      item.lines = body.split("\n").length
    }
    out.push(item)
  }
  return out
}

/** The same for opencode (ACP content blocks). */
function attachmentAcp(attachments              )        {
  const blocks        = []
  for (const item of attachments) {
    const uri = item.path ? `file://${item.path}` : `attachment:${item.name}`
    if (item.kind === "image" && item.data) blocks.push({ type: "image", mimeType: item.mime, data: item.data, uri: item.path ? uri : undefined })
    else if (item.kind === "pdf" && item.data) blocks.push({ type: "resource", resource: { uri, mimeType: item.mime, blob: item.data } })
    else if (item.kind === "text" && item.text !== undefined) blocks.push({ type: "resource", resource: { uri, mimeType: "text/plain", text: item.text } })
    else blocks.push({ type: "resource_link", uri, name: item.name, mimeType: item.mime, size: item.size })
  }
  return blocks
}


























/** An MCP server's request for input, waiting for the user. */































export const AGENTS          = [
  { id: "build", name: "Build", mode: "default" },
  { id: "plan", name: "Plan", mode: "plan" },
]









































































/** Where a mod element's handler lives (stamped by the engine on each Button, Input, Select). */




/** `hit`: Anthropic refused a request on this window; it reads as full until it resets. */


// ---------------------------------------------------------------------------
// Streaming input queue for the SDK
// ---------------------------------------------------------------------------

class InputQueue                                          {
          items                   = []
          waiters                                                       = []
          closed = false
  push(message                ) {
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value: message, done: false })
    else this.items.push(message)
  }
  close() {
    this.closed = true
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true })
  }
  [Symbol.asyncIterator]()                                {
    return {
      next: () => {
        const item = this.items.shift()
        if (item) return Promise.resolve({ value: item, done: false })
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => this.waiters.push(resolve))
      },
    }
  }
}

// ---------------------------------------------------------------------------
// Events (shared by all sessions)
// ---------------------------------------------------------------------------


const listeners = new Set                               ()

export function onSessionEvent(fn                               ) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Account-wide plan usage, refreshed from whichever session talks to Claude Code last. */
export const [limits, setLimits] = createStore






  ({})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let executablePath                            = null
function claudeExecutable() {
  if (executablePath !== null) return executablePath
  executablePath = undefined
  if (process.env.CLAUDE_CODE_PATH) executablePath = process.env.CLAUDE_CODE_PATH
  else {
    executablePath = findBinary("claude")
  }
  return executablePath
}

/** Build and Plan plus the user's own modes (config.agentModes: a name, a permission mode, an instruction). */
export function agentList() {
  const own = (config.agentModes ?? []).filter((mode) => mode?.id && mode.name && !AGENTS.some((agent) => agent.id === mode.id))
  // Chat is built in (the user's own mode of that id replaces it).
  return [...AGENTS, ...(own.some((mode) => mode.id === CHAT_MODE.id) ? [] : [CHAT_MODE]), ...own]
}

/**
 * Chat: the tab behaves as a plain chat (answers from what it knows and the conversation, no tools unless asked).
 * New chats start in it unless Settings → "New chats start in Chat mode" is off.
 */
export const CHAT_MODE = {
  id: "chat",
  name: "Chat",
  mode: "default",
  prompt:
    "This is a plain conversation. Answer directly, like a chat assistant, from what you know and what is in this conversation. Do not use tools (no reading or changing files, no commands, no web, no subagents) unless the user asks for that in so many words. If something would need tools, say so in a line and let the user decide; they can switch to Build mode.",
}
export const defaultAgentMode = () => (config.chatByDefault === false ? undefined : CHAT_MODE.id)

export function agentIndex(id        ) {
  return Math.max(0, agentList().findIndex((agent) => agent.id === id))
}

export function agentName(id) {
  return agentList().find((agent) => agent.id === id)?.name ?? (id === "plan" ? "Plan" : "Build")
}

function readBranch(cwd        ) {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    return undefined
  }
}

let claudeVersion
function readVersion(executable                    , done                           ) {
  if (claudeVersion) return done(claudeVersion)
  execFile(executable ?? "claude", ["--version"], { timeout: 5000 }, (error, stdout) => {
    if (error) return
    const match = stdout.match(/(\d+\.\d+\.\d+)/)
    if (match) {
      claudeVersion = match[1]
      done(match[1])
    }
  })
}

export function errorMessage(error         ) {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

export function prettyModel(id        ) {
  const match = id.match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?/)
  // Agent Code's GPU-sized local variants ("qwen3:4b-acode88k") read as the model itself.
  if (!match) return id.replace(/-(?:acode|occ)\d+k$/, "")
  const family = match[1][0].toUpperCase() + match[1].slice(1)
  return `Claude ${family} ${match[2]}${match[3] && match[3].length < 3 ? "." + match[3] : ""}`
}

export function isSubagentTool(name        ) {
  return name === "Task" || name === "Agent"
}

function toolResultText(content     )         {
  if (typeof content === "string") return content
  if (Array.isArray(content))
    return content
      .map((block) => (block.type === "text" ? block.text : block.type === "image" ? "[image]" : ""))
      .filter(Boolean)
      .join("\n")
  return ""
}

function parseJson(raw        )                                  {
  try {
    return JSON.parse(raw)
  } catch {
    // Close an unterminated streaming object so partial input can be shown.
    for (const suffix of ['"}', "}", '"]}', "]}", '""}']) {
      try {
        return JSON.parse(raw + suffix)
      } catch {}
    }
    return undefined
  }
}

function toolTitle(name        , input                     ) {
  const target = input.file_path ?? input.path ?? input.pattern ?? input.command ?? input.url ?? input.query ?? input.description
  return target ? `${name} ${String(target).split("\n")[0]}` : name
}

function assistantError(code        , msg     ) {
  const text = (msg?.content ?? []).find((block     ) => block.type === "text")?.text
  if (text) return text
  const map                         = {
    authentication_failed: "Not logged in to Claude Code (or the login expired) — run /login",
    billing_error: "Billing error",
    rate_limit: "Rate limited",
    overloaded: "API overloaded",
    max_output_tokens: "Response hit the maximum output tokens",
  }
  return map[code] ?? code
}

function countDiff(result     ) {
  let additions = 0
  let deletions = 0
  for (const hunk of result?.structuredPatch ?? []) {
    for (const line of hunk.lines ?? []) {
      if (line.startsWith("+")) additions++
      else if (line.startsWith("-")) deletions++
    }
  }
  return { additions, deletions }
}

const ansiPattern = /\x1b\[[0-9;]*[A-Za-z]/g
export function stripAnsi(text        ) {
  return text.replace(ansiPattern, "")
}

export function relativeTo(cwd        , file        ) {
  if (!file) return file
  if (file.startsWith(cwd + "/")) return file.slice(cwd.length + 1)
  const home = os.homedir()
  if (home && file.startsWith(home + "/")) return "~/" + file.slice(home.length + 1)
  return file
}

/** Normalise SDK utilization values (0-1 fractions or 0-100 percentages) to a percentage. */
function percent(value        ) {
  return value <= 1 ? Math.round(value * 1000) / 10 : Math.round(value * 10) / 10
}

function updateLimitsFromUsage(usage     ) {
  if (!usage) return
  if (!usage.rate_limits_available || !usage.rate_limits) {
    setLimits({ available: false, updated: Date.now() })
    return
  }
  const window = (w     )                              =>
    w && typeof w.utilization === "number"
      ? { utilization: Math.round(w.utilization * 10) / 10, resetsAt: w.resets_at ? Date.parse(w.resets_at) : undefined }
      : undefined
  setLimits({
    available: true,
    // Claude Code's own reading leaves windows out now and then: keep the last known one rather than dropping it.
    fiveHour: window(usage.rate_limits.five_hour) ?? (limits.rolling === false ? undefined : limits.fiveHour),
    week: window(usage.rate_limits.seven_day) ?? limits.week,
    updated: Date.now(),
  })
}

let usageInflight = false
let usageLast = 0

// Exact plan usage straight from Anthropic, polled every 2 minutes for the whole app (with 429 backoff).
let planPoll
let planInflight = false
let planExact = false

let planLast = 0

/** Refresh the exact plan usage (throttled to one request per 15 s unless forced); true when it came from Anthropic. */
// While a turn is running the meters are read every 20 s (they climb as the work goes), otherwise every 2 minutes.
let lastWork = 0
const working = () => Date.now() - lastWork < 45_000

export async function pollPlanUsage(force = false) {
  if (planInflight || (!force && Date.now() - planLast < (working() ? 55_000 : 30_000))) {
    checkAutoResume()
    return planExact
  }
  planInflight = true
  planLast = Date.now()
  try {
    const usage = await fetchPlanUsage(force, working() ? 55_000 : 100_000)
    planExact = !!usage
    // Claude Code rewrites the plan into its credentials when the login refreshes (e.g. after a plan change).
    void planDetails().then((plan) => {
      if (plan && plan.type !== catalog.plan) setCatalog("plan", plan.type)
      if (plan && plan.label !== catalog.planLabel) setCatalog("planLabel", plan.label)
    })
    if (usage) {
      applyUsage(usage)
      checkFableReturn()
      if (catalog.plan && !usage.week?.hit) samplePlanRate(usage.week?.utilization, catalog.planLabel ?? catalog.plan, usage.fiveHour?.hit ? undefined : usage.fiveHour?.utilization)
    }
    // At the 5-hour wall Anthropic may offer a reset: look (at most once a minute).
    if (limits.rolling !== false && (limits.fiveHour?.utilization ?? 0) >= 99) void checkResetOffer()
    else if (limits.offer) setLimits("offer", undefined)
    checkAutoResume()
    return planExact
  } finally {
    planInflight = false
  }
}

/**
 * Anthropic refuses a request when it would go past the limit, so the last reading can be e.g. 97% while
 * you are already blocked. A window that refused a request stays full until its reset time while later
 * readings stay near full; a reading well below that (a changed subscription, an early reset) wins.
 */
function keepHit(current                             , next                             ) {
  const nearFull = (next?.utilization ?? 100) >= 90
  if (current?.hit && nearFull && current.resetsAt && current.resetsAt > Date.now() && (!next?.resetsAt || Math.abs(next.resetsAt - current.resetsAt) <= 60_000))
    return { ...current, utilization: Math.max(100, next?.utilization ?? 0) }
  return next
}

// Only the plan-wide windows drive the two meters; per-model weekly windows (seven_day_opus, …) have their own
// dates and used to overwrite the weekly meter's.
const windowKey = (type                    ) => (type === "five_hour" ? "fiveHour" : type === "seven_day" ? "week" : undefined)

/** A request was refused by a plan limit: show that window full (until it resets) and re-read the real numbers. */
export function markLimitHit(type         , resetsAt         ) {
  let key = windowKey(type)
  if (!key) {
    // Unknown window (e.g. only an error text): the fuller of the two.
    key = limits.fiveHour && (limits.fiveHour.utilization ?? 0) >= (limits.week?.utilization ?? 0) ? "fiveHour" : "week"
  }
  // A plan without a rolling limit (Ultra) can only be stopped by a weekly one.
  if (key === "fiveHour" && limits.rolling === false) key = "week"
  const current = limits[key                       ]
  setLimits(key                       , { utilization: 100, resetsAt: resetsAt ?? current?.resetsAt, hit: true })
  setLimits("available", true)
  shareLimits()
  void pollPlanUsage(true)
  if (key === "fiveHour") void checkResetOffer(true)
}

// ---------------------------------------------------------------------------
// Limit resets Anthropic offers at the 5-hour wall (see fetchResetOffer). Shown as a button at the bottom left;
// with auto-resume on (and "Use limit resets" not turned off) it is used by itself once the limit is reached.
// ---------------------------------------------------------------------------

const limitResetListeners = new Set()
let claiming = false

/** Re-read the offer (after a 5-hour limit hit); claim it at once when auto-resume may. */
export async function checkResetOffer(force = false) {
  if (limits.rolling === false) return
  const offer = await fetchResetOffer(force)
  if (JSON.stringify(offer) !== JSON.stringify(limits.offer)) {
    setLimits("offer", offer)
    shareLimits()
  }
  const blocked = (limits.fiveHour?.utilization ?? 0) >= 99
  if (offer && blocked && config.autoResume !== false && config.autoLimitReset !== false) await useLimitReset(true)
}

/** The 5-hour limit was reset (here or by Claude Code's own /limit-reset): waiting and paused tabs go on now. */
export function limitWasReset() {
  setLimits("fiveHour", { utilization: 0, resetsAt: undefined })
  setLimits("offer", undefined)
  shareLimits()
  void pollPlanUsage(true)
  for (const session of waitingResume) if (!session.disposed && session.store.resumeAt !== undefined) setResumeAt(session, Date.now())
  checkAutoResume()
  for (const fn of limitResetListeners) fn()
}

/** Use the offered reset. Resolves to a sentence for the user. */
export async function useLimitReset(auto = false) {
  const offer = limits.offer
  if (!offer || claiming) return claiming ? "A limit reset is already on its way" : "No limit reset is offered right now"
  claiming = true
  try {
    const result = await claimResetOffer(offer)
    setLimits("offer", undefined)
    if (result === "reset") {
      log(`limit reset used${auto ? " automatically" : ""}`)
      limitWasReset()
      return `5-hour limit reset${offer.weekly ? " · it still counts toward your weekly limit" : ""}`
    }
    void checkResetOffer(true)
    return {
      already_used: "This week's limit reset was already used",
      not_limited: "Nothing to reset: the 5-hour limit isn't reached",
      ineligible: "A limit reset isn't available for this account right now",
      auth_error: "Couldn't reset the limit with this login: run /login, then try again",
      rate_limited: "Couldn't reset the limit right now: try again in a moment",
    }[result] ?? "Couldn't reset the limit right now: try again in a moment"
  } finally {
    claiming = false
  }
}

/** Hand what this window knows to every other Agent Code window (they pick it up within ~2 s). */
function shareLimits() {
  publishPlanUsage({ fiveHour: limits.fiveHour, week: limits.week, all: limits.all, scoped: limits.scoped, rolling: limits.rolling, extra: limits.extra, offer: limits.offer })
}

/**
 * Take a reading from Anthropic (or another Agent Code window). A plan without a rolling window (Ultra) has no 5-hour
 * meter at all; a weekly window missing from one reading keeps its last value instead of vanishing.
 */
// The plan meters between readings: what this Agent Code spent on Claude since the reading last changed, turned into
// percent with the measured dollars per 1 % (plan-rate.json). Readings come once a minute while working (faster
// polling gets refused); this keeps the meters moving in between, and the next reading replaces the estimate.
const [settledSince, setSettledSince] = createSignal(0)
const liveAtReading = new WeakMap()
let readingPrint = ""
function newReading() {
  setSettledSince(0)
  for (const session of allSessions) liveAtReading.set(session, session.store.livePlanCost ?? 0)
}
function planSpendSince() {
  let live = 0
  for (const session of allSessions) live += Math.max(0, (session.store.livePlanCost ?? 0) - (liveAtReading.get(session) ?? 0))
  return settledSince() + live
}
/** A finished turn: its Claude spend counts as settled (minus what the last reading already held). */
function settlePlanSpend(session, dollars) {
  const before = liveAtReading.get(session) ?? 0
  liveAtReading.set(session, 0)
  if (dollars > before) setSettledSince((value) => value + dollars - before)
}
/** A plan window with the estimate since the last reading added (`estimated` set); the reading itself otherwise. */
export function liveWindow(window, kind) {
  if (!window || window.hit || (window.resetsAt && window.resetsAt <= Date.now())) return window
  const per = planPerPercent()[kind === "fiveHour" ? "five" : "week"]
  const spent = planSpendSince()
  if (!per || !(spent > 0)) return window
  return { ...window, utilization: Math.min(100, (window.utilization ?? 0) + spent / per), estimated: true }
}

function applyUsage(usage) {
  const print = `${usage.fiveHour?.utilization}|${usage.week?.utilization}`
  if (print !== readingPrint) {
    readingPrint = print
    newReading()
  }
  const rolling = usage.rolling ?? limits.rolling
  setLimits({
    available: true,
    rolling,
    fiveHour: rolling === false ? undefined : keepHit(limits.fiveHour, usage.fiveHour),
    week: keepHit(limits.week, usage.week) ?? (usage.week === undefined && limits.week?.resetsAt > Date.now() ? limits.week : undefined),
    all: usage.all ?? limits.all,
    scoped: usage.scoped ?? limits.scoped,
    extra: usage.extra ?? limits.extra,
    updated: Date.now(),
  })
}

// ---------------------------------------------------------------------------
// Fable fallback and return (sidebar, under the pause bar; Settings → Fable fallback… / Back to Fable…)
//  - fallback: a Fable tab that hits the Fable limit (or would pause before it) goes on at once on another model
//    (Opus by default) with its reasoning level raised (+1 by default). Off by default.
//  - return: once a Fable limit that was used up resets, tabs on Opus, Sonnet or Haiku go back to Fable with their
//    level lowered (Opus 1, Sonnet 2, Haiku 3 levels by default; each model can be left out). On by default.
// ---------------------------------------------------------------------------

export const LEVELS = ["low", "medium", "high", "xhigh", "max"]

// ---------------------------------------------------------------------------
// Schedules (sidebar: Schedules, Resume at, Stop at, Break). What each tab is planned to do, stored per session
// (config.sessionSchedules[id]); a session with none yet starts from its earlier settings, else from the schedule
// for new sessions (config.newSessionSchedule). Entries:
//   { kind: "stop", at }                  stop at a time (then paused until a resume, or by hand)
//   { kind: "stop", window, percent }     stop once when a plan limit reaches a level (goes on when it resets)
//   { kind: "stop", guard }               stop near any limit, each time (checked before each step)
//   { kind: "resume", at }                resume at a time; also holds back the automatic continue after a limit
//                                         and a limit pause's own end until then (it delays them, never earlier)
//   a break: a "stop" and a "resume" with the same `group` (stop now or at a time, then resume or not)
// `frozen`: kept, not acted on.
// ---------------------------------------------------------------------------

const PLAN_WINDOWS = { fiveHour: "5-hour", week: "weekly", fable: "Fable" }
const fableWindow = () => (limits.scoped ?? []).find((window) => /fable/i.test(window.name ?? ""))
export const planWindowOf = (key) => (key === "fable" ? fableWindow() : limits[key])
export const hasFableWindow = () => !!fableWindow()
/** How full a plan window is now, as a stop sees it: the live estimate; 0 once the window has reset; undefined
 *  before the first reading. */
export function stopLevel(key) {
  const exact = planWindowOf(key)
  if (exact?.utilization == null) return undefined
  if (exact.resetsAt && exact.resetsAt <= Date.now()) return 0
  return liveWindow(exact, key === "fable" ? "week" : key)?.utilization ?? 0
}

/** A time to show: "14:30" today, "Tue 01:00" on another day. */
export function whenText(ms) {
  const today = new Date(ms).toDateString() === new Date().toDateString()
  return new Date(ms).toLocaleString([], { ...(today ? {} : { weekday: "short" }), hour: "2-digit", minute: "2-digit" })
}

/** How long until a time: "now", "in 25 min", "in 3 h 10 min", "in 2 days". */
export function untilText(ms) {
  const minutes = Math.round((ms - Date.now()) / 60_000)
  if (minutes < 1) return "now"
  if (minutes < 60) return `in ${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `in ${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`
  return `in ${Math.round(hours / 24)} days`
}

let entryCount = 0
export const newEntryId = () => `e${Date.now().toString(36)}${(entryCount++).toString(36)}`

/** The schedule a new session starts with (by default: stop near any limit at 95%, as "Auto-pause" did). */
export function templateSchedule() {
  if (Array.isArray(config.newSessionSchedule)) return config.newSessionSchedule
  return config.pauseNearLimit === false ? [] : [{ id: "template-guard", kind: "stop", guard: config.pauseAt ?? 95 }]
}

/** A tab's schedule (undefined id: the one for new sessions). */
export function scheduleOf(sessionID) {
  if (!sessionID) return templateSchedule()
  const own = config.sessionSchedules?.[sessionID]
  if (own) return own
  // Not set up yet: its earlier settings (its own auto-pause, a Stop after rule), else the one for new sessions.
  const auto = config.sessionAutoPause?.[sessionID]
  const rule = config.stopAfter?.tabs?.[sessionID]
  if (!auto && !rule) return templateSchedule()
  const list = []
  if (auto?.on ?? config.pauseNearLimit !== false) list.push({ id: `${sessionID}-guard`, kind: "stop", guard: auto?.at ?? config.pauseAt ?? 95 })
  if (rule && !rule.off) list.push({ id: `${sessionID}-rule`, kind: "stop", ...(rule.time ? { at: rule.time } : { window: rule.window, percent: rule.percent }) })
  return list
}

/** Store a tab's schedule (no id: the one for new sessions). */
export function setSchedule(sessionID, list) {
  if (!sessionID) config.newSessionSchedule = list
  else {
    const all = { ...(config.sessionSchedules ?? {}) }
    delete all[sessionID]
    all[sessionID] = list
    const keys = Object.keys(all)
    for (const old of keys.slice(0, Math.max(0, keys.length - 500))) delete all[old]
    config.sessionSchedules = all
  }
  saveConfig()
  setTimeout(checkSchedules, 0)
}

/** What an entry does, in a few words ("Stop at 22:00", "Resume at Wed 09:00"). */
export function describeEntry(entry) {
  if (entry.kind === "resume") return `Resume at ${whenText(entry.at)}`
  if (entry.guard) return `Stop near any limit at ${entry.guard}%`
  if (entry.window) return `Stop at ${PLAN_WINDOWS[entry.window]} ${entry.percent}%`
  return `Stop at ${whenText(entry.at)}`
}

/** The near-any-limit stop of a tab ({ on, at }): its lowest active level. */
export function guardFor(sessionID) {
  const levels = scheduleOf(sessionID).filter((entry) => !entry.frozen && entry.kind === "stop" && entry.guard).map((entry) => entry.guard)
  return levels.length ? { on: true, at: Math.min(...levels) } : { on: false, at: 95 }
}

/** The next planned resume (not a break's): automatic continues wait for it. */
export function resumeHold(sessionID, now = Date.now()) {
  const times = scheduleOf(sessionID)
    .filter((entry) => !entry.frozen && entry.kind === "resume" && !entry.group && entry.at > now)
    .map((entry) => entry.at)
  return times.length ? Math.min(...times) : undefined
}

const LOGIN_SWITCH_PROMPT = "Agent Code moved this conversation to another of the user's logins after a usage limit. Continue the work from where it stopped."

/**
 * A Claude turn was refused by a limit and "next login at a limit" is on: that login is passed over until the limit
 * resets, and the work goes on at once with the next free one. False when there is none (the usual wait then).
 */
function switchLoginAfterLimit(session, resetsAt) {
  if (!loginRule("anthropic").rotate || loginsOf("anthropic").length < 2) return false
  const from = session.store.login ?? "main"
  blockLogin("anthropic", from, resetsAt && resetsAt > Date.now() ? resetsAt + 30_000 : Date.now() + 60 * 60_000)
  const next = chosenLogin("anthropic")
  if (next.id === from || blockedUntil("anthropic", next.id)) return false
  log("login switch", session.store.sessionID, from, "→", next.id)
  session.notice?.(`Limit on ${loginLabel("anthropic", from)}: going on with ${next.label}; back to ${loginLabel("anthropic", loginRule("anthropic").prefer)} when its limit resets.`, "info")
  void session.restart(true).then(() => session.send(LOGIN_SWITCH_PROMPT))
  return true
}

/** Tabs on another login than the one to use now (the preferred one is free again): back to it. */
function checkLogins() {
  if (loginsOf("anthropic").length < 2) return
  const want = chosenLogin("anthropic").id
  for (const session of allSessions) {
    const s = session.store
    if (session.disposed || s.engine || splitModel(s.model) || s.login === undefined || s.login === want || blockedUntil("anthropic", want)) continue
    if (s.status === "running") {
      session.restartLater?.()
      continue
    }
    log("login back", s.sessionID, s.login, "→", want)
    const waiting = s.resumeAt !== undefined
    void session.restart().then(() => {
      // It was waiting for a limit: on a free login it goes on now.
      if (waiting && !session.disposed) {
        setResumeAt(session, Date.now())
        waitingResume.add(session)
        startResumeClock()
      }
    })
  }
}
setInterval(checkLogins, 60_000).unref?.()

function checkSchedules() {
  const now = Date.now()
  for (const session of allSessions) {
    const id = session.store.sessionID
    if (session.disposed || !id) continue
    const list = scheduleOf(id)
    if (!list.length) continue
    let keep = list
    const drop = (entry) => (keep = keep.filter((item) => item !== entry))
    for (const entry of list) {
      if (entry.frozen) continue
      if (entry.kind === "stop" && entry.at) {
        if (now < entry.at) continue
        drop(entry)
        // Checked every 10 s while the tab is open: a time this far past was missed while it was closed.
        if (now - entry.at > 120_000 || session.store.pause) continue
        const back = entry.group ? list.find((item) => item.group === entry.group && item.kind === "resume" && !item.frozen)?.at : undefined
        session.pause(back, entry.group ? "break" : "stop", undefined, entry.group)
        session.notice?.(`${entry.group ? "Break" : "Stopped"} (schedule)${back ? `: goes on ${whenText(back)}` : ": resume when you want"}.`, "info")
      } else if (entry.kind === "stop" && entry.window && entry.percent) {
        if (splitModel(session.store.model) || session.store.pause || (session.store.login ?? "main") !== "main" || (stopLevel(entry.window) ?? 0) < entry.percent) continue
        drop(entry)
        const exact = planWindowOf(entry.window)
        const until = exact?.resetsAt && exact.resetsAt > now ? exact.resetsAt + 30_000 : undefined
        session.pause(until, "stop", [{ key: entry.window, resetsAt: exact?.resetsAt }])
        session.notice?.(`Stopped at ${PLAN_WINDOWS[entry.window]} ${entry.percent}% (schedule)${until ? `: goes on when it resets, ${whenText(until)}` : ""}.`, "info")
      } else if (entry.kind === "resume" && entry.at && now >= entry.at) {
        drop(entry)
        const pause = session.store.pause
        if (!pause || (entry.group && pause.reason !== "break")) continue
        // A limit not reset yet: a planned resume can't come earlier than the limit allows.
        if (pause.reason === "limit" && pause.until && pause.until > now) continue
        session.resume()
      }
    }
    if (keep !== list) setSchedule(id, keep)
  }
}
setInterval(checkSchedules, 10_000).unref?.()
const FABLE_RESUME_PROMPT = "The Fable limit was reached, so this session moved to another model. Continue the work from where it stopped."
const allSessions = new Set()

export const FABLE_FAMILIES = ["opus", "sonnet", "haiku"]
// Only Opus tabs go back to Fable unless Sonnet or Haiku are switched on in its settings.
const UPGRADE_DEFAULTS = { opus: { on: true, step: 1 }, sonnet: { on: false, step: 2 }, haiku: { on: false, step: 3 } }

export function fableFallback() {
  const own = config.fableFallback ?? {}
  return { enabled: own.enabled === true, model: FABLE_FAMILIES.includes(own.model) ? own.model : "opus", step: Number.isInteger(own.step) ? own.step : 1 }
}

export function fableUpgrade() {
  const own = config.fableUpgrade ?? {}
  return {
    enabled: own.enabled !== false,
    models: Object.fromEntries(FABLE_FAMILIES.map((family) => [family, { ...UPGRADE_DEFAULTS[family], ...(own.models?.[family] ?? {}) }])),
  }
}

/** opus, sonnet, haiku or fable: the Claude family a tab's model belongs to. */
export function familyOf(store) {
  return String(store.modelId ?? store.model ?? "").match(/opus|sonnet|haiku|fable/i)?.[0]?.toLowerCase()
}

const isFableLimit = (type) => type === "seven_day_overage_included"

/** A level moved by `step` (negative: lower) within what the model offers; "default" counts as high. */
function shiftEffort(effort, step, levels) {
  const list = LEVELS.filter((level) => !levels?.length || levels.includes(level))
  if (!list.length) return effort
  let index = list.indexOf(effort && list.includes(effort) ? effort : "high")
  if (index < 0) index = Math.min(list.length - 1, 2)
  return list[Math.max(0, Math.min(list.length - 1, index + step))]
}

/** The tab's own value for a family: its alias when Claude Code offers one, else the newest model of it. */
function familyModel(session, family) {
  const models = session.store.models ?? []
  if (models.some((model) => model.value === family)) return family
  const matches = models.filter((model) => String(model.resolvedModel ?? model.value).toLowerCase().includes(family))
  return matches.at(-1)?.value ?? family
}

const levelsOf = (session, value) => session.store.models?.find((model) => model.value === value)?.supportedEffortLevels

/** Move a Fable tab to the fallback model. True when it moved. */
export async function fallBackFromFable(session) {
  const rule = fableFallback()
  if (!rule.enabled || session.disposed || splitModel(session.store.model) || familyOf(session.store) !== "fable") return false
  const target = familyModel(session, rule.model)
  const effort = shiftEffort(session.store.effort, rule.step, levelsOf(session, target))
  const from = `${session.modelLabel?.() ?? "Fable"}${session.store.effort ? ` · ${session.store.effort}` : ""}`
  await session.setModel(target)
  await session.setEffort(effort)
  session.notice?.(`Fable limit reached: moved from ${from} to ${session.modelLabel?.() ?? target} · ${effort} (Fable fallback). Back to Fable when its limit resets${fableUpgrade().enabled ? "" : " is off"}.`, "warning")
  return true
}

/** Tabs on Opus, Sonnet or Haiku go (back) to Fable after its used-up limit reset. */
async function returnToFable() {
  const rule = fableUpgrade()
  if (!rule.enabled) return
  for (const session of allSessions) {
    if (session.disposed || session.store.engine || splitModel(session.store.model)) continue
    const family = familyOf(session.store)
    const own = rule.models[family]
    if (!own?.on) continue
    const target = familyModel(session, "fable")
    const effort = shiftEffort(session.store.effort, -own.step, levelsOf(session, target))
    const from = `${session.modelLabel?.() ?? family}${session.store.effort ? ` · ${session.store.effort}` : ""}`
    try {
      await session.setModel(target)
      await session.setEffort(effort)
      session.notice?.(`The Fable limit has reset: moved from ${from} back to ${session.modelLabel?.() ?? "Fable"} · ${effort} (Back to Fable).`, "info")
    } catch (error) {
      log("back to Fable failed", error)
    }
  }
}

// Whether the Fable window was used up, shared by every window and kept across restarts (only the harness's own
// readings: the usage API's Fable meter and Claude Code's refusals).
const fableFile = () => path.join(process.env.ACODE_SHARED_STATE || stateDir, "fable-limit.json")
function readFableState() {
  try {
    return JSON.parse(readFileSync(fableFile(), "utf8")) ?? {}
  } catch {
    return {}
  }
}
function writeFableState(state) {
  try {
    writeFileSync(fableFile(), JSON.stringify(state))
  } catch (error) {
    log("fable state write failed", error)
  }
}

let fableSeenFull
let fableReturned

function noteFableFull(resetsAt) {
  if (!resetsAt) return
  fableSeenFull = resetsAt
  if (readFableState().fullUntil !== resetsAt) writeFableState({ ...readFableState(), fullUntil: resetsAt })
}

/** A refusal by the Fable limit: its meter shows full until it resets. */
function markFableHit(resetsAt) {
  const list = [...(limits.scoped ?? [])]
  const index = list.findIndex((w) => /fable/i.test(w.name))
  const until = resetsAt ?? list[index]?.resetsAt
  const full = { ...(list[index] ?? { name: "Fable" }), utilization: 100, hit: true, resetsAt: until }
  if (index >= 0) list[index] = full
  else list.push(full)
  setLimits("scoped", list)
  noteFableFull(until)
  shareLimits()
  void pollPlanUsage(true)
}

/** After each reading: remember a used-up Fable window; once it has reset, bring the tabs back to Fable. */
function checkFableReturn() {
  const fable = (limits.scoped ?? []).find((w) => /fable/i.test(w.name))
  if (fable && fable.utilization >= 100 && fable.resetsAt && fable.resetsAt > Date.now()) return noteFableFull(fable.resetsAt)
  const state = readFableState()
  const until = state.fullUntil ?? (state.returnedFor === fableSeenFull ? fableSeenFull : undefined)
  if (!until || Date.now() < until || fableReturned === until) return
  fableReturned = until
  if (state.fullUntil === until) writeFableState({ returnedFor: until, returnedAt: Date.now() })
  log("Fable limit reset after it was used up: back to Fable")
  void returnToFable()
}

function applySharedUsage(usage                             ) {
  // A window from before a reset (an older Agent Code still running publishes what it last saw) doesn't replace a newer one.
  const stale = (theirs, mine) =>
    !!theirs?.resetsAt && !!mine?.resetsAt && mine.resetsAt > Date.now() && (theirs.resetsAt <= Date.now() || theirs.resetsAt < mine.resetsAt - 60_000)
  if (stale(usage.week, limits.week) || stale(usage.fiveHour, limits.fiveHour))
    usage = { ...usage, week: stale(usage.week, limits.week) ? limits.week : usage.week, fiveHour: stale(usage.fiveHour, limits.fiveHour) ? limits.fiveHour : usage.fiveHour }
  applyUsage(usage)
  if ("offer" in usage) setLimits("offer", usage.offer)
  checkFableReturn()
  checkAutoResume()
}

function startPlanPoll() {
  if (planPoll) return
  onSharedPlanUsage(applySharedUsage)
  void pollPlanUsage()
  // Not forced: forcing skips the shared cache, so every open window hit the endpoint itself and earned 429s.
  let ticks = 0
  // Every minute while work is running, every 2 minutes otherwise (shared by all windows: one asks, all read).
  planPoll = setInterval(() => (working() || ++ticks % 2 === 0) && void pollPlanUsage(), 60_000)
  planPoll.unref?.()
}

// Tabs waiting for a plan limit to reset (auto-resume setting).
const RESUME_PROMPT = "The plan usage limit has reset. Continue the work from where it stopped."
const waitingResume = new Set         ()
/** The reset time the refusal itself gave (the event or its text): that is the window actually blocking this tab. */
const refusedUntil = new WeakMap                 ()
const resumeTries = new WeakMap                 ()

// Waits survive a restart of Agent Code (crash, reboot, update): session id → resume time.
const resumeFile = path.join(stateDir, "auto-resume.json")
/** A wait this long overdue when Agent Code starts again is stale: leave that session alone. */
const RESUME_KEEP = 12 * 3_600_000

function readPendingResumes() {
  try {
    return JSON.parse(readFileSync(resumeFile, "utf8")) ?? {}
  } catch {
    return {}
  }
}

function writePendingResumes(pending     ) {
  try {
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(resumeFile, JSON.stringify(pending))
  } catch (error) {
    log("auto-resume file write failed", error)
  }
}

function setResumeAt(session         , value                    ) {
  session.setStore("resumeAt", value)
  const id = session.store.sessionID
  if (!id) return
  const pending = readPendingResumes()
  if (value) pending[id] = value
  else if (id in pending) delete pending[id]
  else return
  writePendingResumes(pending)
}

// The usage poll runs only while a tab's process is up and every 2 minutes; a wait needs neither.
let resumeClock
function startResumeClock() {
  if (resumeClock) return
  resumeClock = setInterval(checkAutoResume, 15_000)
  resumeClock.unref?.()
}

/**
 * When a session hit by a limit may continue, from the harness's own data: the latest reset among the windows
 * that are full (≥ 99 %, so rounding can't hide the blocking one); if none reads full, the reset of the
 * fullest window. Claude tabs look at every Claude window Anthropic reports, OpenCode Go tabs at the Go meters;
 * other providers have no windows here, so they back off instead of waiting for a Claude window.
 */
function resumeTime(session         )                     {
  const go = providerKind(session.store.model) === "go"
  if (!go && splitModel(session.store.model)) return undefined
  const windows = (go ? [catalog.go?.rolling, catalog.go?.weekly, catalog.go?.monthly] : [limits.fiveHour, limits.week, ...(limits.all ?? [])]).filter(
    (w)                       => !!w && !!w.resetsAt && w.resetsAt > Date.now() && (!w.model || onModel(session.store, w.model)),
  )
  if (!windows.length) return undefined
  const full = windows.filter((w) => w.utilization >= 99)
  if (full.length) return Math.max(...full.map((w) => w.resetsAt ))
  return windows.reduce((a, b) => (b.utilization > a.utilization ? b : a)).resetsAt
}

// Limit windows whose pause the user resumed: no pause before them again until they reset (key → reset time).
const waivedPauses = new Map()
function waivePause(w) {
  waivedPauses.set(w.key, w.resetsAt)
}
function waivedPause(w) {
  const at = waivedPauses.get(w.key)
  return at !== undefined && Math.abs(at - w.resetsAt) <= 60_000
}

/** True when a tab's model is the one a per-model limit ("Fable") is for. */
export function onModel(store, name) {
  const needle = String(name).toLowerCase()
  return [store.modelId, store.model].some((m) => typeof m === "string" && m.toLowerCase().includes(needle))
}

/** A turn was refused by a limit: wait for the reset, then continue on our own. */
function armAutoResume(session         , resetsAt         ) {
  if (config.autoResume === false) return
  log("auto-resume armed", session.store.sessionID, resetsAt ? new Date(resetsAt).toISOString() : "no reset time")
  if (resetsAt) refusedUntil.set(session, resetsAt)
  else refusedUntil.delete(session)
  session.setStore("resumeAt", 0)
  waitingResume.add(session)
  startResumeClock()
  void pollPlanUsage(true)
    .catch((error) => log("auto-resume usage poll failed", error))
    .then(() => checkAutoResume())
}

/** "all" (default): every waiting tab goes on together; "one": one after another, each once the previous is done. */
const resumeMode = () => (config.autoResumeMode === "one" ? "one" : "all")
// Tabs continued by auto-resume whose turn is still going (for "one at a time").
const resumingNow = new Map()

/** Continue a tab whose wait is over, booting or reviving its process first (a bare send would be dropped). */
async function fireAutoResume(session         ) {
  // Paused meanwhile (by the user or Stop after): the continue waits for the pause to end instead of ending it.
  if (session.store.pause && session.store.pause.reason !== "limit") {
    setResumeAt(session, Date.now())
    waitingResume.add(session)
    return
  }
  const hold = !session.heldResume ? resumeHold(session.store.sessionID) : undefined
  if (hold) {
    session.heldResume = hold
    log("auto-resume held by a planned resume", session.store.sessionID, new Date(hold).toISOString())
    setResumeAt(session, hold)
    waitingResume.add(session)
    return
  }
  session.heldResume = undefined
  // Another login is free now (or the main one is back): the process starts on it first.
  if (!session.store.engine && !splitModel(session.store.model) && (session.store.login ?? "main") !== chosenLogin("anthropic").id) await session.restart(true)
  log("auto-resume fires", session.store.sessionID, session.store.model)
  resumingNow.set(session, { fired: Date.now(), ran: false })
  try {
    if (session.store.fatal && session.store.sessionID) await session.start({ resume: session.store.sessionID })
    else await session.ensureStarted()
    session.send(RESUME_PROMPT)
  } catch (error) {
    log("auto-resume failed, trying again in 5 minutes", error)
    resumingNow.delete(session)
    if (session.disposed) return
    setResumeAt(session, Date.now() + 5 * 60_000)
    waitingResume.add(session)
  }
}

function checkAutoResume() {
  for (const session of waitingResume) {
    try {
      if (session.disposed || config.autoResume === false || session.store.resumeAt === undefined) {
        waitingResume.delete(session)
        if (!session.disposed && session.store.resumeAt !== undefined) setResumeAt(session, undefined)
        continue
      }
      // First check after the error: fix the time from the refusal or the limit data, or back off 5 → 10 → 20 → 40 min without data.
      if (!session.store.resumeAt) {
        const tries = resumeTries.get(session) ?? 0
        const stated = refusedUntil.get(session)
        // Another engine's limit with no reset time (e.g. opencode's free tier): three tries, then it is the user's call.
        if (!stated && (session.store.engine || splitModel(session.store.model)) && tries >= 3) {
          waitingResume.delete(session)
          setResumeAt(session, undefined)
          resumeTries.delete(session)
          session.notice?.("Auto-resume stopped after 3 tries: this limit gives no reset time. Send a message when you want to try again.", "info")
          continue
        }
        const when = (stated && stated > Date.now() ? stated : resumeTime(session)) ?? Date.now() + Math.min(40, 5 * 2 ** tries) * 60_000
        setResumeAt(session, when + 20_000)
        continue
      }
      if (Date.now() < session.store.resumeAt) continue
      // A turn is going (e.g. a background task reported in) or the process is booting: continue once it is free.
      if (session.store.status === "running" || session.store.booting) continue
      // Paused by the user (or Stop after): auto-resume waits until the tab is resumed; it must not un-pause it.
      if (session.store.pause && session.store.pause.reason !== "limit") continue
      // One at a time: wait while another tab continued by auto-resume is still working.
      for (const [other, state] of resumingNow) {
        if (other.store.status === "running") state.ran = true
        // Done once its turn ran and ended; a tab that never got going counts for at most 10 minutes.
        if (other.disposed || (state.ran && other.store.status !== "running") || Date.now() - state.fired > 10 * 60_000) resumingNow.delete(other)
      }
      if (resumeMode() === "one" && resumingNow.size) continue
      waitingResume.delete(session)
      resumeTries.set(session, (resumeTries.get(session) ?? 0) + 1)
      setResumeAt(session, undefined)
      void fireAutoResume(session)
      if (resumeMode() === "one") break
      // All together: a limit that let this tab go lets the other Claude tabs on the plan go too, even those whose
      // own time was a guess (a backoff, or a reading the usage endpoint refused to refresh).
      if (!splitModel(session.store.model)) {
        for (const other of waitingResume) {
          if (other === session || other.disposed || splitModel(other.store.model) || !other.store.resumeAt) continue
          if ((refusedUntil.get(other) ?? 0) > Date.now()) continue
          if (other.store.resumeAt > Date.now()) setResumeAt(other, Date.now())
        }
      }
    } catch (error) {
      log("auto-resume check failed", error)
    }
  }
}

/** A turn finished without a limit error: the next limit starts the backoff afresh. */
export function resumeSucceeded(session         ) {
  resumeTries.delete(session)
  // One at a time: this tab is done, the next one may go.
  if (resumingNow.delete(session) && waitingResume.size) checkAutoResume()
}

/** The auto-resume switch changed: turned off, every pending wait ends now instead of at the next 15 s check. */
export function autoResumeChanged() {
  if (config.autoResume === false) checkAutoResume()
}

/** Cancel a pending auto-resume (the user typed something or turned the setting off). */
export function cancelAutoResume(session         ) {
  waitingResume.delete(session)
  if (session.store.resumeAt !== undefined) setResumeAt(session, undefined)
}

/** A tab came back after Agent Code restarted: pick up the wait it was in (the time may already have passed). */
function restoreAutoResume(session         , id        ) {
  const pending = readPendingResumes()
  const at = pending[id]
  if (!at) return
  if (config.autoResume === false || at < Date.now() - RESUME_KEEP) {
    delete pending[id]
    writePendingResumes(pending)
    return
  }
  session.setStore("resumeAt", at)
  waitingResume.add(session)
  startResumeClock()
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/** New sessions use Haiku until the user picks another model. */
export const DEFAULT_MODEL = "haiku"












const REJECT_MESSAGE =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed."

const NO_TESTS_PROMPT =
  "The user has turned off running tests. Do not run test suites, test commands, or type/lint checks unless the user explicitly asks for it in this conversation; describe how to verify instead."
const NO_QUESTIONS_PROMPT =
  "The user has turned off clarifying questions. Do not ask the user questions; make reasonable assumptions, state them briefly, and proceed."

const PLANNING_PROMPT =
  "For any task with three or more steps, keep a checklist with the mcp__acode__todowrite tool: write the plan before starting, mark exactly one item in_progress while working on it, and mark items completed as soon as they are done. The user sees it as a checklist."

/** Agent Code's own checklist tool (this Claude Code build ships no TodoWrite); lives in the in-process "acode" MCP server. */
export const ACODE_MCP = "acode"
export const TODO_TOOL = "mcp__acode__todowrite"
export const isTodoTool = (name        ) => name === "TodoWrite" || name === TODO_TOOL

function planningTools() {
  return [
      tool(
        "todowrite",
        "Create or replace the task checklist shown to the user. Send the full list every time.",
        {
          todos: z.array(
            z.object({
              content: z.string().describe("Imperative description of the step"),
              status: z.enum(["pending", "in_progress", "completed"]),
              activeForm: z.string().optional().describe("Present-continuous form shown while in progress"),
            }),
          ),
        },
        async (args) => {
          const done = args.todos.filter((todo) => todo.status === "completed").length
          return { content: [{ type: "text", text: `Checklist updated (${done}/${args.todos.length} done).` }] }
        },
        // Keep it in the prompt instead of behind tool search, or the model rarely reaches for it.
        { alwaysLoad: true },
      ),
  ]
}

// Built-in plugins add tools to Agent Code's own MCP server ("acode"). A part is called once per Claude Code start with
// that session and { tool, z }, and returns the tools to offer (or nothing); they are allowed without asking.
const toolParts = new Map()
export function registerToolPart(id, part) {
  toolParts.set(id, part)
  return () => void toolParts.delete(id)
}

/** Agent Code's own MCP server for one session: the checklist (when planning is on) and the plugins' tools. */
function acodeServer(session) {
  const own = []
  for (const part of toolParts.values()) {
    try {
      own.push(...(part(session, { tool, z }) ?? []))
    } catch (error) {
      log("tool part failed", error)
    }
  }
  if (!config.planning && !own.length) return undefined
  const all = [...(config.planning ? planningTools() : []), ...own]
  return { server: createSdkMcpServer({ name: ACODE_MCP, tools: all }), allowed: all.map((item) => `mcp__${ACODE_MCP}__${item.name}`) }
}

// Built-in plugins (acode-agents, acode-memory) add to Claude's system prompt and pre-approve their own tool calls.
const promptParts = new Map                                  ()
const autoAllows = new Map                                                                   ()

/** Add a system-prompt section; returns the unregister function. Applies from the next Claude Code start. */
export function registerPromptPart(id        , part                          ) {
  promptParts.set(id, part)
  return () => void promptParts.delete(id)
}

const settingsParts = new Map                                                                ()

/** Extra Claude Code settings for new processes (e.g. autoMemoryEnabled), per session model; returns the unregister function. */
export function registerSettingsPart(id        , part                                                        ) {
  settingsParts.set(id, part)
  return () => void settingsParts.delete(id)
}

function extraSettings(model        ) {
  const out                          = {}
  for (const part of settingsParts.values()) Object.assign(out, part(model) ?? {})
  // opencode's experimental.background_compaction: the summary is prepared before the threshold is reached.
  if (config.backgroundCompaction) out.precomputeCompactionEnabled = true
  return Object.keys(out).length ? out : undefined
}

export function registerAutoAllow(id        , check                                                           ) {
  autoAllows.set(id, check)
  return () => void autoAllows.delete(id)
}

function contextEnv(value        , sent         )                         {
  const local = Number(sent?.match(/-(?:acode|occ)(\d+)k$/)?.[1]) * 1024
  const context = local || modelMeta(value).context
  return context ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(context) } : {}
}

/**
 * Agent Code's instructions for one session, each with an id (so a resumed conversation can be told what changed):
 * the registered parts, the planning checklist, the access switches, then `extra` ({ id, text } or plain text).
 * `context`: the session the prompt is for ({ sessionId, session }), so a part can differ per session.
 */
export function behaviourParts(extra           = [], context = {}, skip = new Set()) {
  const parts = []
  const add = (id, text) => {
    const value = typeof text === "string" ? text.trim() : ""
    if (value) parts.push({ id, text: value })
  }
  for (const [id, part] of promptParts) {
    if (skip.has(id)) continue
    try {
      add(id, part(context))
    } catch (error) {
      log("prompt part failed", error)
    }
  }
  if (config.planning && !skip.has("planning")) add("planning", PLANNING_PROMPT)
  // The tab's harness decides (each has its own access settings).
  const access = accessFor(context.session?.store?.engine)
  if (!access.runTests) add("noTests", NO_TESTS_PROMPT)
  if (!access.askQuestions) add("noQuestions", NO_QUESTIONS_PROMPT)
  extra.forEach((item, index) => (typeof item === "string" ? add(`extra-${index}`, item) : add(item.id, item.text)))
  return parts
}

/** The same instructions as one text. */
export function behaviourPrompt(extra           = [], context = {}, skip = new Set()) {
  const parts = behaviourParts(extra, context, skip)
  return parts.length ? parts.map((part) => part.text).join("\n\n") : undefined
}

// ---------------------------------------------------------------------------
// Subagent policy (Settings → Subagents). Enforced by rewriting each Agent call's model/effort in a
// PreToolUse hook; other providers need Agent Code's router so one Claude Code process can reach several APIs.
// ---------------------------------------------------------------------------

const CLAUDE_ALIASES = ["opus", "sonnet", "haiku", "fable"]

export function subagentPolicy() {
  const same = config.subagentSame === true
  const enabled = config.subagents !== false
  const models = enabled && !same && config.subagentModels !== false
  return {
    enabled,
    models,
    effort: enabled && !same && config.subagentEffort !== false,
    pick: enabled && config.subagentPick !== false,
    providers: models && Object.values(config.subagentTiers ?? {}).some(Boolean),
  }
}

/**
 * Non-Claude subagents, per enabled tier: the user's prioritised models first, else their favourite or
 * recent ones in that tier, else the first two the provider lists. A few per tier keeps the choice clear.
 */
function providerAgents(main        )                                                               {
  const agents                                  = {}
  const lines           = []
  const used = [...(config.favoriteModels ?? []), ...(config.recentModels ?? [])]
  for (const { tier, title } of SUBAGENT_TIERS) {
    if (!config.subagentTiers?.[tier]) continue
    const all = tierModels(tier).filter((value) => value !== main)
    const priority = (config.subagentPriority?.[tier] ?? []).filter((value) => all.includes(value))
    const picked = priority.length ? priority : used.filter((value) => all.includes(value)).length ? [...new Set(used.filter((value) => all.includes(value)))] : all.slice(0, 2)
    const names           = []
    for (const value of picked.slice(0, 4)) {
      const split = splitModel(value)
      const name = `${tier}-${split.model.replace(/[^a-zA-Z0-9]+/g, "-").replace(/-+$/, "")}`.toLowerCase()
      const meta = modelMeta(value)
      agents[name] = {
        description: `General-purpose agent on ${split.model} (${providerName(value)}, ${billingLabel(meta, providerName(value))}) instead of Claude. ${tier === "local" ? "Runs on this machine: free and private, but slower and weaker." : "Cheaper than Claude; fine for searches, reading, summaries and routine edits."}`,
        prompt: "You are a capable software engineering agent. Complete the task you are given using the available tools, then report the result concisely.",
        model: value,
      }
      names.push(name + (priority.includes(value) ? " (preferred)" : ""))
    }
    if (names.length) lines.push(`- ${title}: ${names.join(", ")}`)
  }
  return { agents, lines }
}

// ---------------------------------------------------------------------------
// Subagent routing (Settings → Subagent routing, right-click to set up): the user fixes the exact model and
// variant of every delegated task, by kind of work and otherwise by complexity. Each slot becomes a subagent type;
// a PreToolUse hook sends every delegation to one of them, so Claude can't pick another model.
// ---------------------------------------------------------------------------

/** Kinds of work that get their own subagent (each can be switched off; then complexity decides). */
export const ROUTE_KINDS = [
  { key: "browsing", title: "Browsing", agent: "browsing", use: "web searches, fetching and reading pages", model: "haiku", effort: "low" },
  { key: "advanced-browsing", title: "Advanced browsing", agent: "advanced-browsing", use: "multi-step web research: comparing many sources, digging through docs, checking facts", model: "sonnet", effort: "medium" },
  { key: "testing", title: "Testing", agent: "testing", use: "writing and running tests, checking that something works", model: "haiku", effort: "medium" },
  { key: "bugfixing", title: "Bugfixing", agent: "bugfixing", use: "finding the cause of a bug and fixing it", model: "sonnet", effort: "high" },
  { key: "optimisation", title: "Optimisation", agent: "optimisation", use: "making code faster, smaller or cheaper; profiling", model: "opus", effort: "high" },
  { key: "orchestrator-code", title: "Code for the orchestrator", agent: "orchestrator-code", use: "writing code that you, the orchestrator, will review and integrate", model: "sonnet", effort: "high" },
]

/** Complexity levels: everything that isn't one of the kinds above (or all of it, with the kinds off). */
export const ROUTE_LEVELS = [
  { key: "simple", title: "Simple tasks", agent: "simple-task", use: "lookups, file searches, reading, summaries, mechanical edits", model: "haiku", effort: "low" },
  { key: "average", title: "Average tasks", agent: "average-task", use: "ordinary implementation and analysis", model: "sonnet", effort: "medium" },
  { key: "hard", title: "Hard tasks", agent: "hard-task", use: "tricky problems that need careful reasoning", model: "opus", effort: "high" },
  { key: "complex", title: "Complex tasks", agent: "complex-task", use: "large multi-part work, architecture, deep debugging", model: "opus", effort: "xhigh" },
  { key: "highest", title: "Highest intelligence tasks", agent: "highest-task", use: "the hardest problems, where the best possible answer matters most", model: "fable", effort: "max" },
]

/** Claude Code's own subagent types and the level they go to while routing is on (custom agents and forks stay). */
const BUILTIN_ROUTES = {
  Explore: "simple-task",
  "claude-code-guide": "simple-task",
  "statusline-setup": "simple-task",
  "web-fetch": "browsing",
  "general-purpose": "average-task",
  claude: "average-task",
  Plan: "hard-task",
}

/** The routing settings with defaults filled in. A slot's model "same" is the session's own model. */
export function subagentRouting() {
  const own = config.subagentRouting ?? {}
  const slot = (item, saved) => ({ model: saved?.model ?? item.model, effort: saved?.effort === undefined ? item.effort : saved.effort })
  return {
    enabled: own.enabled === true,
    kinds: Object.fromEntries(ROUTE_KINDS.map((item) => [item.key, { on: own.kinds?.[item.key]?.on !== false, ...slot(item, own.kinds?.[item.key]) }])),
    levels: Object.fromEntries(ROUTE_LEVELS.map((item) => [item.key, slot(item, own.levels?.[item.key])])),
  }
}

/** Every slot in use: the kinds that are on, then all complexity levels. */
function routeSlots(rule = subagentRouting()) {
  return [
    ...ROUTE_KINDS.filter((item) => rule.kinds[item.key].on).map((item) => ({ ...item, ...rule.kinds[item.key] })),
    ...ROUTE_LEVELS.map((item) => ({ ...item, ...rule.levels[item.key] })),
  ]
}

/** Whether routing needs Agent Code's router: a slot on another provider, or a Claude slot under a provider tab. */
function routingNeedsRouter(main) {
  const rule = subagentRouting()
  if (!rule.enabled || config.subagents === false) return false
  return routeSlots(rule).some((slot) => (slot.model === "same" ? false : splitModel(slot.model) ? true : !!splitModel(main)))
}

/** Whether orchestrator mode's pool reaches beyond what the session's own connection can call. */
function orchestratorNeedsRouter(main) {
  const rule = orchestrator()
  if (rule.strategy === "effort") return false
  return orchestratorCandidates(main, rule).some((value) => (splitModel(value) ? value !== main : !!splitModel(main)))
}

/** The routed subagent types for one Claude Code start, and the lines telling Claude when to use which. */
function routingAgents(main, mainEffort) {
  const rule = subagentRouting()
  const agents = {}
  const kinds = []
  const levels = []
  for (const slot of routeSlots(rule)) {
    const external = slot.model !== "same" && !!splitModel(slot.model)
    // A provider model carries its variant in the name ("<provider>/<model>#<variant>"); the router applies it.
    const model = slot.model === "same" ? "inherit" : external && slot.effort ? `${slot.model}#${slot.effort}` : slot.model
    const effort = external ? undefined : slot.model === "same" ? (slot.effort ?? mainEffort) : slot.effort
    agents[slot.agent] = {
      description: `Delegated ${slot.title.toLowerCase()}: ${slot.use}.`,
      prompt: `You are a capable software engineering agent doing ${slot.title.toLowerCase()} (${slot.use}). Complete the task you are given using the available tools, then report the result concisely.`,
      model,
      ...(effort ? { effort } : {}),
    }
    ;(ROUTE_KINDS.some((item) => item.agent === slot.agent) ? kinds : levels).push(`- ${slot.agent}: ${slot.use}`)
  }
  return { agents, kinds, levels, names: new Set(Object.keys(agents)) }
}

const routingPrompt = ({ kinds, levels }) =>
  `# Subagents (routed)
Every task you delegate with the Agent tool goes to a subagent whose model and reasoning level the user has fixed. Always set subagent_type to the one that fits, and do not set model or effort.${kinds.length ? `\n\nBy kind of work:\n${kinds.join("\n")}` : ""}

${kinds.length ? "Anything else, by complexity" : "By complexity"}:
${levels.join("\n")}`

// ---------------------------------------------------------------------------
// Orchestrator mode (Settings, under Back to Fable; off by default; right-click to set up): the main chat, on its
// own model and variant, plans and delegates the work to subagents and checks what comes back. Which subagents it
// may use: its own model at other reasoning levels, other models at its own level, or both; a pool of models (same
// provider, any provider, or only selected ones, minus exclusions); nothing stronger than itself unless allowed.
// Off, it adds nothing to the context.
// ---------------------------------------------------------------------------

export const ORCH_STRATEGIES = [
  { key: "effort", title: "Same model, other reasoning levels" },
  { key: "model", title: "Same reasoning, other models" },
  { key: "both", title: "Other models and reasoning levels" },
]
export const ORCH_POOLS = [
  { key: "same", title: "Same provider" },
  { key: "any", title: "Any provider" },
  { key: "selected", title: "Only selected" },
]
export const ORCH_DELEGATION = [
  { key: "mostly", title: "Mostly delegate", text: "Do small, quick things yourself; delegate the rest." },
  { key: "all", title: "Delegate everything", text: "Do not do the work yourself, not even small edits: you plan, delegate, check and integrate." },
  { key: "helps", title: "When it helps", text: "Delegate when a subtask is large, can run in parallel, or would fill your context; otherwise do it yourself." },
]
const MAX_POOL = 10

export function orchestrator() {
  const own = config.orchestrator ?? {}
  return {
    enabled: own.enabled === true,
    strategy: ORCH_STRATEGIES.some((item) => item.key === own.strategy) ? own.strategy : "effort",
    higherEffort: own.higherEffort === true,
    strongerModels: own.strongerModels === true,
    pool: ORCH_POOLS.some((item) => item.key === own.pool) ? own.pool : "same",
    selected: own.selected ?? [],
    excluded: own.excluded ?? [],
    delegation: ORCH_DELEGATION.some((item) => item.key === own.delegation) ? own.delegation : "mostly",
    // How many subagents may run at once (0: no limit; 1: one at a time — the old "Parallel subagents" off) and how
    // many it may start for one message from the user (0: no limit).
    maxAtOnce: Number.isInteger(own.maxAtOnce) && own.maxAtOnce >= 0 ? own.maxAtOnce : own.parallel === false ? 1 : 0,
    maxPerMessage: Number.isInteger(own.maxPerMessage) && own.maxPerMessage >= 0 ? own.maxPerMessage : 0,
    review: own.review !== false,
  }
}

/**
 * Orchestrator mode's limits for one tab: subagents at once (a call over the limit waits for a free place) and per
 * message from the user (a call over it is refused, with the reason). Counted from the hooks: a call is "pending"
 * from its PreToolUse until a subagent starts (or the call fails), then running until that subagent stops; whatever
 * is still pending when the turn ends is dropped, and stale entries let go after a while (a missed stop can't hold
 * the limit for ever).
 */
function makeAgentLimits() {
  const pending = new Map()
  const running = new Map()
  let sinceMessage = 0
  const waiters = []
  const wake = () => {
    for (const release of waiters.splice(0)) release()
  }
  const count = () => {
    const now = Date.now()
    for (const [id, since] of pending) if (now - since > 10 * 60_000) pending.delete(id)
    for (const [id, since] of running) if (now - since > 3 * 3_600_000) running.delete(id)
    return pending.size + running.size
  }
  return {
    /** Undefined: go on (after waiting for a place); a string: refused, the reason for the model. */
    async admit(id, signal) {
      const begun = Date.now()
      for (;;) {
        const rule = orchestrator()
        if (rule.maxPerMessage && sinceMessage >= rule.maxPerMessage)
          return `The user allows at most ${rule.maxPerMessage} subagent${rule.maxPerMessage === 1 ? "" : "s"} per message in orchestrator mode, and this message has used them. Do the rest yourself, or stop and tell the user what is left.`
        if (!rule.maxAtOnce || count() < rule.maxAtOnce || signal?.aborted || Date.now() - begun > 30 * 60_000) break
        await new Promise((resolve) => {
          waiters.push(resolve)
          setTimeout(resolve, 5000)
        })
      }
      sinceMessage++
      pending.set(id ?? `call-${begun}-${Math.random()}`, Date.now())
      return undefined
    },
    started(agentId) {
      const first = pending.keys().next()
      if (!first.done) pending.delete(first.value)
      if (agentId) running.set(agentId, Date.now())
    },
    stopped(agentId) {
      running.delete(agentId)
      wake()
    },
    finished(toolUseId) {
      if (pending.delete(toolUseId)) wake()
    },
    turnEnded() {
      pending.clear()
      wake()
    },
    userMessage() {
      sinceMessage = 0
    },
    reset() {
      pending.clear()
      running.clear()
      wake()
    },
  }
}

/** The hooks that keep the limits' count (only while orchestrator mode is on in this tab's process). */
function agentLimitHooks(limits) {
  const done = async (input) => {
    if (/^(Agent|Task)$/.test(input.tool_name ?? "")) limits.finished(input.tool_use_id)
    return {}
  }
  return {
    SubagentStart: [{ hooks: [async (input) => (limits.started(input.agent_id), {})] }],
    SubagentStop: [{ hooks: [async (input) => (limits.stopped(input.agent_id), {})] }],
    PostToolUse: [{ matcher: "Agent|Task", hooks: [done] }],
    PostToolUseFailure: [{ matcher: "Agent|Task", hooks: [done] }],
  }
}

const FAMILY_RANK = { haiku: 1, sonnet: 2, opus: 3, fable: 4 }
const familyName = (value) => Object.keys(FAMILY_RANK).find((family) => String(value).toLowerCase().includes(family))

/** Whether `value` is a stronger model than `main`: Claude by family, otherwise by output price. */
export function strongerModel(value, main) {
  if (value === main) return false
  const a = familyName(value)
  const b = familyName(main)
  if (!splitModel(value) && !splitModel(main) && a && b) return FAMILY_RANK[a] > FAMILY_RANK[b]
  const pa = modelMeta(value).price?.output
  const pb = modelMeta(main).price?.output
  return pa !== undefined && pb !== undefined && pa > pb
}

/** The reasoning levels a model offers (Claude: Claude Code's list; providers: their variants). */
function modelLevels(value) {
  if (splitModel(value)) return (modelVariants(value) ?? []).filter((level) => LEVELS.includes(level))
  const listed = claudeModels.find((model) => model.value === value)?.supportedEffortLevels
  return (listed?.length ? listed : LEVELS).filter((level) => LEVELS.includes(level))
}

const poolLabel = (value) => (splitModel(value) ? `${splitModel(value).model} (${providerName(value)})` : (claudeModels.find((model) => model.value === value)?.displayName?.replace(/\s*\(.*\)$/, "") ?? value))

/** Every model the pool may draw from: Claude aliases (and any Claude version the user selected), provider models. */
export function orchestratorCandidates(main, rule = orchestrator()) {
  const claude = claudeModels
    .filter((model) => model.value !== "default" && (CLAUDE_ALIASES.includes(model.value) || rule.selected.includes(model.value)))
    .map((model) => ({ value: model.value, provider: "anthropic" }))
  const external = providers.list.flatMap((provider) =>
    provider.models
      .filter((model) => !model.appOnly)
      .map((model) => ({ value: `${provider.id}/${model.id}`, provider: provider.id }))
      .filter((item) => providerKind(item.value) !== "harness"),
  )
  const home = splitModel(main)?.provider.id ?? "anthropic"
  let list = [...claude, ...external]
  if (rule.pool === "same") list = list.filter((item) => item.provider === home)
  if (rule.pool === "selected") list = list.filter((item) => rule.selected.includes(item.value))
  list = list.filter((item) => !rule.excluded.includes(item.value))
  if (!rule.strongerModels) list = list.filter((item) => !strongerModel(item.value, main))
  return list.map((item) => item.value)
}

/** The subagent types orchestrator mode offers for one Claude Code start (empty while routing decides the models). */
function orchestratorAgents(main, mainEffort, routingOn) {
  const rule = orchestrator()
  if (routingOn) return { rule, types: new Map(), agents: {}, self: undefined }
  const level = mainEffort && LEVELS.includes(mainEffort) ? mainEffort : undefined
  let pool = rule.strategy === "effort" ? [main] : orchestratorCandidates(main, rule)
  // The orchestrator's own model first, then what the user chose, their favourites and recent ones; a short list.
  const rank = (value) =>
    value === main ? 0 : rule.selected.includes(value) ? 1 : (config.favoriteModels ?? []).includes(value) ? 2 : (config.recentModels ?? []).includes(value) ? 3 : 4
  if (!rule.excluded.includes(main) && !pool.includes(main)) pool.unshift(main)
  pool = [...new Set(pool)].sort((a, b) => rank(a) - rank(b)).slice(0, MAX_POOL)
  const types = new Map()
  const agents = {}
  for (const value of pool) {
    let name = value === main ? "orchestrated" : `on-${(splitModel(value)?.model ?? value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`
    if (types.has(name)) name = `${name}-${(splitModel(value)?.provider.id ?? "claude").toLowerCase().replace(/[^a-z0-9]+/g, "-")}`
    const external = !!splitModel(value)
    // A provider model runs at the orchestrator's level when it has one of that name ("<provider>/<model>#<level>").
    const variant = external && level && modelLevels(value).includes(level) && rule.strategy !== "effort" ? level : undefined
    const meta = modelMeta(value)
    types.set(name, { value, external, levels: modelLevels(value), price: meta.price })
    agents[name] = {
      description: `Subagent on ${poolLabel(value)}${value === main ? " (your own model)" : ""}.`,
      prompt: "You are a capable software engineering agent working for an orchestrator. Complete the subtask you are given using the available tools, then report the result concisely: what you did, what you found, anything left open.",
      model: value === main ? "inherit" : variant ? `${value}#${variant}` : value,
    }
  }
  // Searches and other quick looks go to the cheapest model in the pool.
  const cheapest = [...types].sort((a, b) => (a[1].price?.output ?? 0) - (b[1].price?.output ?? 0))[0]?.[0]
  return { rule, types, agents, self: types.has("orchestrated") ? "orchestrated" : [...types.keys()][0], cheapest, level, main }
}

function orchestratorPrompt(orch, routingOn) {
  const { rule } = orch
  const lines = [
    "# Orchestrator mode",
    `You are the orchestrator of this session: understand the goal, plan, split the work into clear self-contained subtasks, delegate them with the Agent tool, check what comes back and integrate it. ${ORCH_DELEGATION.find((item) => item.key === rule.delegation).text}${rule.maxAtOnce === 1 ? " Run one subagent at a time." : ` Run independent subtasks in parallel (several Agent calls in one message)${rule.maxAtOnce ? `, at most ${rule.maxAtOnce} at once (more wait for a free place)` : ""}.`}${rule.maxPerMessage ? ` Use at most ${rule.maxPerMessage} subagent${rule.maxPerMessage === 1 ? "" : "s"} for each message from the user: plan with that in mind.` : ""}${rule.review ? " Check each result before relying on it, and send the subtask back or redo it when it falls short." : ""} Give every subagent all it needs in its prompt: the goal, the files, the constraints and what to report.`,
  ]
  if (routingOn) {
    lines.push("Which model runs each subtask is fixed by the routed subagent types below.")
    return lines.join("\n")
  }
  const mine = orch.level ?? "default"
  const allowed = (orch.types.get(orch.self)?.levels ?? LEVELS).filter((level) => rule.higherEffort || !orch.level || LEVELS.indexOf(level) <= LEVELS.indexOf(orch.level))
  if (rule.strategy === "effort") {
    lines.push(
      `Every subagent runs on your own model: use subagent_type ${orch.self}. Choose its reasoning with the Agent tool's effort parameter by how hard the subtask is (the lowest that will do it well): ${allowed.join(", ")}${rule.higherEffort ? "" : ` (not above your own, ${mine})`}.`,
    )
    return lines.join("\n")
  }
  const entries = [...orch.types].map(([name, info]) => {
    const price = info.price ? ` · $${info.price.input}/$${info.price.output} per M` : ""
    return `- ${name}: ${poolLabel(info.value)}${info.value === orch.main ? " (your own model)" : ""}${price}`
  })
  lines.push(`Choose the model for each subtask with subagent_type, the cheapest that will do it well:\n${entries.join("\n")}`)
  if (rule.strategy === "model") lines.push(`Subagents run at your reasoning level (${mine}); do not set effort.`)
  else lines.push(`Choose the reasoning of Claude subagents with the effort parameter: ${allowed.join(", ")}${rule.higherEffort ? "" : ` (not above your own, ${mine})`}.`)
  return lines.join("\n")
}

/** The Agent call rewritten for orchestrator mode: one of its types, with an allowed reasoning level. */
function orchestrateCall(orch, next, currentLevel) {
  const type = next.subagent_type || "general-purpose"
  let target = orch.types.has(type) ? type : undefined
  if (!target && type in BUILTIN_ROUTES) target = ["Explore", "claude-code-guide", "statusline-setup", "web-fetch"].includes(type) ? (orch.cheapest ?? orch.self) : orch.self
  delete next.model
  // The user's own agents and forks run as defined; Claude doesn't get to raise their reasoning either.
  if (!target) {
    delete next.effort
    return next
  }
  next.subagent_type = target
  const info = orch.types.get(target)
  if (info.external) {
    delete next.effort
    return next
  }
  const { rule } = orch
  // The orchestrator's reasoning now (it may have changed since the process started).
  const level = LEVELS.includes(currentLevel) ? currentLevel : orch.level
  if (rule.strategy === "model") {
    if (level && info.levels.includes(level)) next.effort = level
    else delete next.effort
    return next
  }
  let wanted = LEVELS.includes(next.effort) ? next.effort : level
  if (!wanted) {
    delete next.effort
    return next
  }
  if (!rule.higherEffort && level && LEVELS.indexOf(wanted) > LEVELS.indexOf(level)) wanted = level
  // The model's own nearest level at or below the wanted one.
  const own = info.levels.filter((item) => LEVELS.indexOf(item) <= LEVELS.indexOf(wanted))
  if (own.length) next.effort = own.at(-1)
  else delete next.effort
  return next
}

// What each session started with, so switching something off can tell the conversation once that it's gone.
// Claude Code records a conversation's system prompt on its first request and sends that record again on every later
// request and resume (until a compaction), whatever a later start passes: a setting changed afterwards would never
// reach the conversation. So Agent Code remembers which of its instruction parts each conversation's record holds,
// and when a resumed conversation's differ, it adds one note to the conversation with what changed.
// Parts whose text moves on its own (the memory note counts memories) count only as there or not.
const PROMPT_VOLATILE = new Set(["acode-memory-tools", "providers"])
const textHash = (text) => {
  let hash = 5381
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0
  return (hash >>> 0).toString(36)
}
const partHeading = (text) => text.split("\n")[0].replace(/^#+\s*/, "").slice(0, 80)

function promptRecord(parts) {
  return Object.fromEntries(parts.map((part) => [part.id, { h: PROMPT_VOLATILE.has(part.id) ? "" : textHash(part.text), title: partHeading(part.text) }]))
}

function rememberPromptParts(sessionId, parts) {
  if (!sessionId) return
  const all = { ...(config.sessionPrompt ?? {}) }
  delete all[sessionId]
  all[sessionId] = promptRecord(parts)
  const keys = Object.keys(all)
  for (const old of keys.slice(0, Math.max(0, keys.length - 300))) delete all[old]
  config.sessionPrompt = all
  saveConfig()
}

/**
 * The note for a resumed conversation whose recorded instructions differ from Agent Code's current ones (undefined
 * when they match, or when nothing is known about the conversation yet); remembers the current ones as told.
 */
function promptChange(sessionId, parts, from) {
  if (!sessionId) return undefined
  const before = config.sessionPrompt?.[sessionId] ?? (from ? config.sessionPrompt?.[from] : undefined)
  if (!before) return undefined
  const now = promptRecord(parts)
  const changed = parts.filter((part) => !before[part.id] || before[part.id].h !== now[part.id].h)
  const removed = Object.keys(before).filter((id) => !now[id])
  if (!changed.length && !removed.length) return undefined
  const lines = ["[Agent Code] The user changed Agent Code's settings since this conversation began. Your system prompt may still show the earlier instructions; where they differ, these replace them."]
  if (changed.length) lines.push("", ...changed.map((part) => part.text))
  if (removed.length) lines.push("", `No longer applies (ignore these parts of your system prompt): ${removed.map((id) => `"${before[id].title || id}"`).join(", ")}.`)
  return lines.join("\n")
}

// Claude Code's reply to a background task's note when there is nothing to say: not shown in the chat.
const NO_REPLY = /^\s*No response requested\.?\s*$/i

/** A background task's failure in a few words ("Agent "Review" failed: 5-hour limit, resets 22:40"). */
function shortFailure(summary) {
  return String(summary)
    .replace(/Agent terminated early due to an API error:\s*/i, "")
    .replace(/\s*\(error type [^)]*\)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200)
}

/** From a <task-notification> note: one short line if the task failed, else nothing. */
function taskFailure(text) {
  const status = text.match(/<status>([^<]*)<\/status>/)?.[1]
  if (!status || status === "completed" || status === "stopped") return undefined
  return shortFailure(text.match(/<summary>([\s\S]*?)<\/summary>/)?.[1] ?? "A background task failed")
}

const PICK_PROMPT =
  "When delegating to subagents (the Agent tool), choose each subagent's model and effort to fit the task: haiku with low effort for searches, file reading and mechanical edits; sonnet for ordinary implementation; opus with higher effort only for hard reasoning. You may set the Agent tool's model and effort parameters for this without being asked."
const providerPrompt = (lines          ) =>
  `Subagents on other models are available as subagent_type values, by kind:\n${lines.join("\n")}\nUse them for routine delegated work (searches, reading, summaries, mechanical edits), the ones marked preferred first; keep Claude models for anything that needs careful judgment. They don't count against the user's Claude limits.`

function subagentHooks(main              , effort                               , routes, orch, limits)                        {
  return [
    {
      matcher: "Agent|Task",
      // A call over orchestrator mode's "at once" limit waits here for a free place.
      timeout: 86_400,
      hooks: [
        async (input     , toolUseId, options) => {
          // Orchestrator mode's limits: per message (refused, with the reason) and at once (waits).
          if (orch && limits && orchestrator().enabled) {
            const refused = await limits.admit(input.tool_use_id ?? toolUseId, options?.signal)
            if (refused) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: refused } }
          }
          const policy = subagentPolicy()
          const next = { ...(input.tool_input ?? {}) }
          // Routing: every delegation goes to one of the user's routed types, with exactly its model and variant.
          if (routes?.size) {
            const type = next.subagent_type || "general-purpose"
            let target = routes.has(type) ? type : BUILTIN_ROUTES[type]
            // web-fetch goes to browsing when that kind is on, else to the simple level.
            if (target && !routes.has(target)) target = "simple-task"
            if (target) next.subagent_type = target
            // Every other type (the user's own agents, fork) keeps its definition, but Claude can't pick a model for it.
            delete next.model
            delete next.effort
            if (JSON.stringify(next) === JSON.stringify(input.tool_input ?? {})) return {}
            return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: next } }
          }
          // Orchestrator mode: its own subagent types, reasoning kept within what the user allows.
          if (orch?.types.size) {
            orchestrateCall(orch, next, effort())
            if (JSON.stringify(next) === JSON.stringify(input.tool_input ?? {})) return {}
            return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: next } }
          }
          if (!policy.pick) {
            delete next.model
            delete next.effort
          }
          if (!policy.models) {
            // Same model as the session: a Claude alias pins it; provider sessions map every alias to their model.
            if (CLAUDE_ALIASES.includes(main())) next.model = main()
            else delete next.model
          }
          if (!policy.effort) {
            const level = effort() ?? input.effort
            if (level) next.effort = level
            else delete next.effort
          }
          if (JSON.stringify(next) === JSON.stringify(input.tool_input ?? {})) return {}
          return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: next } }
        },
      ],
    },
  ]
}

/**
 * The reasoning level stored for a model; undefined is the model's own default.
 * The old single setting (`effort`) becomes the stored level of the model it was used with.
 */
/** The harness a stored conversation belongs to (by the model it was saved with), or undefined for Claude Code. */
export function harnessSession(id                    ) {
  if (!id) return undefined
  const made = config.sessionEngines?.[id]
  if (made) return made === "claude" ? undefined : made
  if (id.startsWith("ses_")) return "opencode"
  // Older sessions have no record: one Claude Code wrote a transcript for is Claude Code's, whatever its model now.
  if (claudeTranscriptExists(id)) return undefined
  return harnessModel(config.sessionModels?.[id])?.harness.id
}

/** Remember which engine made a session ("claude" or a harness id): only that engine can reopen it. */
function rememberSessionEngine(id, engine) {
  if (!id || config.sessionEngines?.[id] === engine) return
  const all = { ...(config.sessionEngines ?? {}), [id]: engine }
  const keys = Object.keys(all)
  for (const old of keys.slice(0, Math.max(0, keys.length - 600))) delete all[old]
  config.sessionEngines = all
  saveConfig()
}

function claudeTranscriptExists(id) {
  try {
    const root = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"), "projects")
    return readdirSync(root).some((project) => existsSync(path.join(root, project, `${id}.jsonl`)))
  } catch {
    return false
  }
}

/** Whether Claude Code's credentials were written after `time` (a login since). */
function credentialsChangedSince(time) {
  try {
    return statSync(path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"), ".credentials.json")).mtimeMs > time
  } catch {
    return false
  }
}

/** An error that means the Claude Code login has to be renewed. */
const LOGIN_ERROR = /authenticat|not logged in|log ?in again|login (has )?expired|time limit and cannot be renewed|oauth token has expired|\b401\b/i

// One tab is one conversation, whatever engine runs it. Switching engine (Claude Code ↔ opencode, DeepSeek Harness,
// Codex) starts a session of that engine; Agent Code keeps the earlier part (a copy of its messages) and the chain of
// sessions (config.sessionChains[latest] = earlier ones, oldest first), shows them all in the tab, and gives the
// new engine the conversation so far with the first message. Copies also serve harnesses that can't replay.
const acpHistoryDir = path.join(stateDir, "harness-chats")

/** What the user typed, without Agent Code's notes in front of it (the earlier conversation, a mode's rule). */
const HARNESS_INSTRUCTIONS_START = "[Agent Code instructions — from the app this chat runs in; follow them like system instructions]"
const HARNESS_INSTRUCTIONS_END = "[End of Agent Code instructions]"

export function cleanUserText(text) {
  let value = String(text ?? "")
  value = value.replace(/^\[Agent Code instructions[^\]]*\][\s\S]*?\[End of Agent Code instructions\]\s*/, "")
  value = value.replace(/^\[Agent Code\] This conversation went on with [\s\S]*?\[End of the earlier conversation\.\]\s*/, "")
  // A mode's note can run over several lines; it ends at "]" before the message's blank line.
  value = value.replace(/^(\[Mode "[^"]*": [\s\S]*?\](?:\n\n|\s*$))+/, "")
  return value
}

/** The sessions before this one in the tab's conversation, oldest first. */
export const sessionChain = (id) => (id ? (config.sessionChains?.[id] ?? []) : [])
function linkSessions(previous, next) {
  if (!previous || !next || previous === next) return
  const all = { ...(config.sessionChains ?? {}) }
  all[next] = [...(all[previous] ?? []), previous].filter((id, index, list) => list.indexOf(id) === index && id !== next)
  config.sessionChains = all
  // What was kept for the old session belongs to the conversation, so to the new session now (held messages would
  // otherwise go out again when the old one is opened).
  const rules = config.stopAfter?.tabs
  if (rules && previous in rules) {
    const moved = { ...rules, [next]: rules[previous] }
    delete moved[previous]
    config.stopAfter = { ...config.stopAfter, tabs: moved }
  }
  for (const key of ["sessionUnsent", "sessionPauses", "sessionDrafts", "sessionAgentMode", "sessionAutoPause", "sessionSchedules"]) {
    const record = config[key]
    if (!record || !(previous in record)) continue
    const moved = { ...record, [next]: record[previous] }
    delete moved[previous]
    config[key] = moved
  }
  saveConfig()
}

/** The conversation so far as plain text for a model that wasn't in it (newest part kept when it is long). */
function conversationText(messages, limit = 60_000) {
  const lines = []
  for (const message of messages) {
    if (message.fromChain === "marker") continue
    if (message.type === "user" && !message.unsent) lines.push(`User: ${message.text}`)
    else if (message.type === "assistant") {
      const text = message.parts
        .map((part) => {
          if (part.type === "text") return part.text
          if (part.type === "tool") return `[used ${part.name}${part.input?.file_path ? ` on ${part.input.file_path}` : part.input?.command ? `: ${String(part.input.command).split("\n")[0].slice(0, 120)}` : ""}]`
          return ""
        })
        .filter(Boolean)
        .join("\n")
      if (text.trim()) lines.push(`Assistant: ${text}`)
    }
  }
  let text = lines.join("\n\n")
  if (text.length > limit) text = `[…earlier part left out…]\n\n${text.slice(-limit)}`
  return text
}

function readAcpHistory(sessionId) {
  try {
    return JSON.parse(readFileSync(path.join(acpHistoryDir, `${sessionId.replace(/[^a-zA-Z0-9_-]/g, "")}.json`), "utf8"))
  } catch {
    return undefined
  }
}
function writeAcpHistory(sessionId, messages) {
  if (!sessionId) return
  try {
    mkdirSync(acpHistoryDir, { recursive: true })
    writeFileSync(path.join(acpHistoryDir, `${sessionId.replace(/[^a-zA-Z0-9_-]/g, "")}.json`), JSON.stringify(messages))
  } catch (error) {
    log("harness chat save", error)
  }
}

/**
 * A harness's own instructions home: AGENTS.md with Agent Code's prompt, plus the user's ~/.agents/AGENTS.md (the
 * folder this replaces) when there is one. Returns the folder.
 */
function writeHarnessInstructions(id, text, sessionId) {
  // One folder per conversation: tabs with different agent mixes don't overwrite each other's instructions.
  const root = path.join(stateDir, `${id}-agents`)
  const dir = path.join(root, String(sessionId ?? "new").replace(/[^a-zA-Z0-9_-]/g, "") || "new")
  // Prune first (never this conversation's folder, nor one written in the last day: a running tab may read it), then
  // write; the folder is touched so it counts as recent.
  try {
    const all = readdirSync(root).map((name) => ({ name, time: statSync(path.join(root, name)).mtimeMs })).sort((a, b) => b.time - a.time)
    for (const old of all.slice(60)) if (path.join(root, old.name) !== dir && Date.now() - old.time > 86_400_000) rmSync(path.join(root, old.name), { recursive: true, force: true })
  } catch {}
  mkdirSync(dir, { recursive: true })
  try {
    utimesSync(dir, new Date(), new Date())
  } catch {}
  let own = ""
  try {
    own = readFileSync(path.join(os.homedir(), ".agents", "AGENTS.md"), "utf8").trim()
  } catch {}
  const body = [own, text ? `# From Agent Code\n\n${text}` : ""].filter(Boolean).join("\n\n")
  writeFileSync(path.join(dir, "AGENTS.md"), body ? `${body}\n` : "")
  return dir
}

/** Agent Code's MCP servers in ACP's form (stdio with an absolute command, or http); others are left out. */
function acpMcpServers() {
  const out = []
  for (const [name, server] of Object.entries(acodeMcpServers())) {
    const pairs = (record) => Object.entries(record ?? {}).map(([key, value]) => ({ name: key, value: String(value) }))
    if ((server.type ?? "stdio") === "stdio" && server.command) {
      const command = path.isAbsolute(server.command) ? server.command : findBinary(server.command)
      if (command) out.push({ name, command, args: server.args ?? [], env: pairs(server.env) })
    } else if (server.type === "http" && server.url) out.push({ type: "http", name, url: server.url, headers: pairs(server.headers) })
  }
  return out
}

export function storedEffort(model        )                          {
  if (!config.modelEffort) {
    config.modelEffort = config.effort && config.model ? { [config.model]: config.effort } : {}
    saveConfig()
  }
  const value = config.modelEffort[model]
  return !value || value === "default" ? undefined : (value               )
}

export function storeEffort(model        , effort                         ) {
  storedEffort(model)
  config.modelEffort = { ...config.modelEffort, [model]: effort ?? "default" }
  saveConfig()
}

function withoutKey                                   (value   , key        )    {
  const copy = { ...value }
  delete copy[key]
  return copy
}



export function createSession(seed             ) {
  // Orchestrator mode's limits on subagents (at once, per message) for this tab.
  const agentLimits = makeAgentLimits()
  // Agent Code's instructions this tab's Claude Code process started with (recorded again at a compaction).
  let startedParts = []
  const key = randomUUID()
  const from = seed.from?.store
  const [store, setStore] = createStore              ({
    cwd: seed.cwd,
    status: "idle",
    booting: false,
    ready: false,
    dormant: false,
    messages: [],
    children: {},
    permissions: [],
    questions: [],
    elicitations: [],
    model: seed.model ?? config.model ?? DEFAULT_MODEL,
    effort: seed.effort ?? storedEffort(seed.model ?? config.model ?? DEFAULT_MODEL),
    mode: seed.mode ?? "default",
    models: from ? [...from.models] : [...claudeModels],
    commands: from ? [...from.commands] : [],
    agents: from ? [...from.agents] : [],
    skills: from ? [...from.skills] : [],
    plugins: from ? [...from.plugins] : [],
    mcp: from ? [...from.mcp] : [],
    account: from?.account,
    version: from?.version ?? claudeVersion,
    outputStyle: from?.outputStyle,
    cost: 0,
    liveCost: 0,
    livePlanCost: 0,
    historyCost: 0,
    historySubCost: 0,
    thinkingMs: 0,
    thinkingSince: undefined,
    logParts: {},
    codeMode: false,
    subThinkingMs: 0,
    subThinkingOpen: [],
    subCost: 0,
    liveSubCost: 0,
    todos: [],
    files: {},
    tasks: {},
    compacting: false,
    fast: false,
    lastResultCost: 0,
    branch: from?.branch,
    view: "home",
    promptMode: "normal",
    mods: { attached: false, status: {}, panes: [], shown: null, version: 0 },
    /** Paused: { until?: ms, reason: "user" | "limit", holding?: a turn waits at its next tool call }. */
    pause: undefined,
  })

  // What is typed in the prompt and not sent yet survives a restart too (per session, written a second after typing).
  let draftTimer
  function saveDraft(text) {
    clearTimeout(draftTimer)
    draftTimer = setTimeout(() => {
      const id = store.sessionID
      if (!id) return
      const all = { ...(config.sessionDrafts ?? {}) }
      if (text.trim()) all[id] = text
      else if (!(id in all)) return
      else delete all[id]
      const keys = Object.keys(all)
      for (const old of keys.slice(0, Math.max(0, keys.length - 200))) delete all[old]
      config.sessionDrafts = all
      saveConfig()
    }, 1000)
    draftTimer.unref?.()
  }
  function restoreDraft(id) {
    const saved = config.sessionDrafts?.[id]
    if (saved && !draft.text) {
      draft.text = saved
      // A prompt already on screen takes it now.
      emit("draft", { text: saved })
    }
  }
  /** Prompt draft that survives switching tabs. */
  const draft = {
    text: "",
    pastes: new Map                (),
    /** Files and clipboard images, by the placeholder the prompt shows for each. */
    attachments: new Map                    (),
  }

  let current
  let generation = 0
  let disposed = false
  const pending = new Map                                            ()
  const streamParts = new Map                () // `${msgId}:${index}` -> part id
  const syncedParts = new Set        () // stream parts already matched to a full assistant message
  let currentStreamMessage = ""
  let mcpPoll

  const self = {
    key,
    store,
    setStore,
    draft,
    saveDraft,
    get disposed() {
      return disposed
    },
    get live() {
      return !!current || !!oc
    },
  }

  function emit(type        , data                      = {}) {
    for (const fn of listeners) {
      try {
        fn({ type, session: api, ...data })
      } catch (error) {
        log("listener error", error)
      }
    }
  }

  function relative(file        ) {
    return relativeTo(store.cwd, file)
  }

  // The tab's own mode (kept per session); it holds while the permission mode is still the one it set.
  let modeNote
  // The conversation so far, for an engine that takes over the tab (sent once, with the first message to it).
  let carryNote
  // The session the tab is moving away from (until the new engine's session exists): never reopened by the new
  // engine, and linked to the new session once there is one.
  let handedFrom
  /** A session with earlier parts but nothing of its own yet (e.g. after a restart): its first message carries them. */
  /** `sending`: how many of the tab's own messages are the ones going out now (already in the list). */
  function pendingCarry(sending = 1) {
    if (carryNote) return carryNote
    if (!store.messages.some((m) => m.fromChain === true)) return undefined
    if (store.messages.filter((m) => m.type === "user" && !m.fromChain && !m.unsent).length > sending) return undefined
    const text = conversationText(store.messages)
    const name = store.engine ? (harnessById(store.engine)?.name ?? store.engine) : "Claude Code"
    return text ? `[Agent Code] This conversation went on with ${name} from here. Agent Code (the app this chat runs in) switched the model mid-conversation; this is the real earlier part of the same conversation with the same user, from Agent Code's own record. Treat it as what was said before, and answer the user's message that follows.\n\n${text}\n\n[End of the earlier conversation.]` : undefined
  }
  /** The tab moves to another engine: keep this part, remember what to tell the next one. */
  function handOver(toName) {
    const previous = store.sessionID
    const own = store.messages.filter((m) => !m.fromChain)
    if (!previous || !own.some((m) => m.type === "user" && !m.unsent)) return undefined
    writeAcpHistory(previous, JSON.parse(JSON.stringify(own.filter((m) => !m.unsent))))
    // In the tab, what is there now is the earlier part: it is never counted or saved as the new session's own.
    setStore("messages", (list) => [
      ...list.map((m) => (m.fromChain || m.unsent ? m : { ...m, fromChain: true })).filter((m) => !m.unsent),
      { type: "notice", id: `chain:${previous}`, text: `Continued with ${toName} · the model has this conversation`, variant: "info", fromChain: "marker" },
      ...list.filter((m) => m.unsent),
    ])
    handedFrom = previous
    const text = conversationText(store.messages)
    carryNote = text
      ? `[Agent Code] This conversation went on with ${toName} from here. Agent Code (the app this chat runs in) switched the model mid-conversation; this is the real earlier part of the same conversation with the same user, from Agent Code's own record. Treat it as what was said before, and answer the user's message that follows.\n\n${text}\n\n[End of the earlier conversation.]`
      : undefined
    return previous
  }
  /** The earlier parts of this tab's conversation (other engines' sessions), in front of what this one shows. */
  async function prependChain(id) {
    const chain = sessionChain(id)
    if (!chain.length || store.messages.some((m) => m.fromChain)) return
    const before = []
    // The line after each part names the engine that took over from it.
    const engineName = (session) => {
      const engine = harnessSession(session)
      return engine ? (harnessById(engine)?.name ?? engine) : "Claude Code"
    }
    for (const [index, earlier] of chain.entries()) {
      let messages = readAcpHistory(earlier)
      if (!messages && !harnessSession(earlier)) {
        try {
          messages = convertHistory(await getSessionMessages(earlier, { dir: store.cwd }))
        } catch {}
      }
      if (!messages?.length) continue
      before.push(...messages.map((m) => ({ ...m, fromChain: true })))
      before.push({ type: "notice", id: `chain:${earlier}`, text: `Continued with ${engineName(chain[index + 1] ?? id)} · the model has this conversation`, variant: "info", fromChain: "marker" })
    }
    if (before.length && store.sessionID === id) {
      setStore("messages", (list) => [...before, ...list])
      const first = before.find((m) => m.type === "user")
      if (first && (!store.title || /^\[Agent Code\]|^\[Mode /.test(store.title))) setStore("title", first.text.split("\n")[0].slice(0, 80))
    }
  }
  // Whether a mode's instruction is in the conversation (or about to be): leaving that mode then says so.
  let instructed = false
  /** A new conversation starts in the default mode (Chat): its instruction goes with the first message. */
  function applyDefaultMode() {
    const id = defaultAgentMode()
    const agent = id ? agentList().find((item) => item.id === id) : undefined
    setStore("agentMode", agent?.id)
    modeNote = agent?.prompt?.trim() ? `[Mode "${agent.name}": ${agent.prompt.trim()}]` : undefined
    instructed = !!modeNote
  }
  function currentAgent()        {
    const id = store.agentMode ?? (store.sessionID ? config.sessionAgentMode?.[store.sessionID] : undefined)
    const own = id ? agentList().find((agent) => agent.id === id) : undefined
    if (own && own.mode === store.mode) return own
    return store.mode === "plan" ? AGENTS[1] : AGENTS[0]
  }

  /** The tab's mode is the session's from its first message on (a new chat's default mode included). */
  function rememberAgentMode() {
    const id = store.sessionID
    if (!id || (config.sessionAgentMode?.[id] ?? undefined) === (store.agentMode ?? undefined)) return
    const all = { ...(config.sessionAgentMode ?? {}) }
    if (store.agentMode) all[id] = store.agentMode
    else delete all[id]
    config.sessionAgentMode = all
    saveConfig()
  }

  /** Switch to a mode: its permission mode now, its instruction with the next prompt. */
  function setAgent(id) {
    const agent = agentList().find((item) => item.id === id)
    if (!agent) return
    const custom = !AGENTS.includes(agent)
    // The saved mode first: what shows the mode reads it when the tab has none of its own.
    if (store.sessionID) {
      const all = { ...(config.sessionAgentMode ?? {}) }
      if (custom) all[store.sessionID] = agent.id
      else delete all[store.sessionID]
      config.sessionAgentMode = all
      saveConfig()
    }
    setStore("agentMode", custom ? agent.id : undefined)
    if (custom && agent.prompt?.trim()) {
      modeNote = `[Mode "${agent.name}": ${agent.prompt.trim()}]`
      instructed = true
    } else {
      // The earlier mode's instruction is in the conversation: tell the model it is over.
      modeNote = instructed ? `[Mode "${agent.name}": the earlier mode's instruction no longer applies; work normally, tools included.]` : undefined
      instructed = false
    }
    // A harness without a plan mode of its own (DeepSeek Harness): Plan is an instruction instead.
    if (agent.mode === "plan" && oc && !oc.caps?.modes) {
      modeNote = `[Mode "Plan": plan only. Read, search and think, but don't change files or run commands that change anything; end with a clear plan for the user to approve.]`
      instructed = true
    }
    void setMode(agent.mode)
  }

  // -------------------------------------------------------------------------
  // Process lifecycle
  // -------------------------------------------------------------------------

  async function start(options               = {}) {
    stop()
    if (disposed) return
    const pinned = options.resume ?? store.sessionID
    if (pinned && config.codeModeSessions?.[pinned] && !store.engine) {
      batch(() => {
        setStore("booting", false)
        setStore("dormant", true)
      })
      if (!store.messages.some((m) => m.type === "notice" && /Code Mode/.test(m.text)))
        pushNotice("This conversation runs in Code Mode: Claude Code continues it only there. /codemode opens it.", "info")
      return
    }
    const gen = ++generation
    const input = new InputQueue()
    startPlanPoll()
    const executable = claudeExecutable()
    batch(() => {
      setStore("dormant", false)
      setStore("booting", true)
      setStore("ready", false)
      setStore("status", "idle")
      setStore("permissions", [])
      setStore("questions", [])
      setStore("elicitations", [])
      setStore("branch", readBranch(store.cwd))
      setStore("fatal", undefined)
      // total_cost_usd restarts with every process.
      setStore("lastResultCost", 0)
      setStore("mods", { attached: false, status: {}, panes: [], shown: null, version: 0 })
    })
    if (!store.version) readVersion(executable, (version) => !store.version && setStore("version", version))
    const via = harnessModel(store.model)
    if (via) return startAcp(gen, options, via.harness, via.model)
    // Claude Code can't resume another harness's conversation: continue in a fresh Claude Code session.
    // Its session ids are UUIDs; anything else (an opencode "ses_…" id) made it exit with "Invalid session ID".
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    if (store.engine || harnessSession(options.resume) || (options.resume && !uuid.test(options.resume)) || (options.sessionId && !uuid.test(options.sessionId))) {
      const previous = handOver("Claude Code")
      batch(() => {
        setStore("engine", undefined)
        setStore("sessionID", undefined)
        setStore("revert", undefined)
      })
      options = { sessionId: randomUUID() }
      linkSessions(previous ?? handedFrom, options.sessionId)
      handedFrom = undefined
    }
    const policy = subagentPolicy()
    const external = splitModel(store.model)
    const sessionKey = options.sessionId ?? options.resume ?? store.sessionID
    // Mixing providers: Claude Code keeps its Claude login and every request goes through Agent Code's router.
    const routing = policy.enabled && subagentRouting().enabled
    const orchOn = policy.enabled && orchestrator().enabled && !routing
    const routed = routing
      ? routingNeedsRouter(store.model) || policy.providers
      : orchOn
        ? orchestratorNeedsRouter(store.model) || policy.providers
        : policy.providers
    const providerVars = routed ? await routerEnv(sessionKey, store.model) : external ? await providerEnv(store.model, sessionKey) : undefined
    if (gen !== generation) return
    if (routed && !providers.list.length) await refreshProviders()
    if (gen !== generation) return
    // Routing replaces Claude's own pick and the provider tiers: the user's slots decide every subagent's model.
    const routes = routing ? routingAgents(store.model, splitModel(store.model) ? undefined : store.effort) : undefined
    agentLimits.reset()
    const orch = policy.enabled && orchestrator().enabled ? orchestratorAgents(store.model, splitModel(store.model) ? undefined : store.effort, !!routes) : undefined
    const { agents, lines } = routes
      ? { agents: routes.agents, lines: [] }
      : orch
        ? { agents: orch.agents, lines: [] }
        : routed && policy.pick
          ? providerAgents(store.model)
          : { agents: {}, lines: []             }
    const extra           = []
    if (orch) extra.push({ id: "orchestrator", text: orchestratorPrompt(orch, !!routes) })
    if (routes) extra.push({ id: "routing", text: routingPrompt(routes) })
    else if (!orch && policy.enabled && policy.pick && (policy.models || policy.effort)) extra.push({ id: "pick", text: PICK_PROMPT })
    if (lines.length) extra.push({ id: "providers", text: providerPrompt(lines) })
    // Which Claude login this process runs on (Claude itself only: provider models have their own keys).
    const claudeLogin = !external ? chosenLogin("anthropic") : undefined
    setStore("login", claudeLogin?.id)
    const instructionParts = behaviourParts(extra, { sessionId: options.sessionId ?? options.resume ?? store.sessionID, session: api })
    const append = instructionParts.length ? instructionParts.map((part) => part.text).join("\n\n") : undefined
    // A resumed conversation keeps the instructions it began with (Claude Code's recorded prompt): what changed since
    // goes in as one note. A new conversation records the current ones.
    const goneNote = options.resume || options.continue ? promptChange(sessionKey, instructionParts, options.fork ? options.resume : undefined) : undefined
    startedParts = instructionParts
    const disallowed = [
      ...(accessFor().askQuestions ? [] : ["AskUserQuestion"]),
      ...(accessFor().web ? [] : ["WebFetch", "WebSearch"]),
      ...(policy.enabled ? [] : ["Agent", "Task"]),
    ]
    ensureBoxTrusted(store.cwd)
    const own = acodeServer(api)
    log("start", JSON.stringify({ model: store.model, resume: options.resume, resumeAt: options.resumeAt, sessionId: options.sessionId, fork: options.fork, continue: options.continue }))
    const q = query({
      prompt: input,
      options: {
        cwd: store.cwd,
        // The router reads the provider from "<provider>/<model>"; direct provider sessions want the bare id.
        model: external ? (routed ? store.model : (providerVars?.ANTHROPIC_MODEL ?? external.model)) : store.model === "default" ? undefined : store.model,
        // A provider model's variant is written into its requests by Agent Code's proxy (variants.ts).
        effort: external ? undefined : store.effort,
        permissionMode: store.mode,
        includePartialMessages: true,
        promptSuggestions: true,
        enableFileCheckpointing: true,
        agentProgressSummaries: true,
        systemPrompt: { type: "preset", preset: "claude_code", append },
        thinking: { type: "adaptive", display: "summarized" },
        disallowedTools: disallowed.length ? disallowed : undefined,
        agents: Object.keys(agents).length ? agents : undefined,
        settings: extraSettings(store.model)       ,
        hooks: {
          PreToolUse: [...(policy.enabled ? subagentHooks(() => store.model, () => (splitModel(store.model) ? undefined : store.effort), routes?.names, orch, agentLimits) : []), pauseHook()],
          ...(orch ? agentLimitHooks(agentLimits) : {}),
        },
        // Agent Code's own MCP servers (mcp.ts) win over same-named ones in ~/.claude.json.
        mcpServers: { ...acodeMcpServers(), ...(own ? { [ACODE_MCP]: own.server } : {}) },
        plugins: modPlugins(),
        allowedTools: own?.allowed.length ? own.allowed : undefined,
        resume: options.resume,
        resumeSessionAt: options.resumeAt,
        continue: options.continue,
        forkSession: options.fork,
        sessionId: options.sessionId,
        pathToClaudeCodeExecutable: executable,
        canUseTool: (toolName, toolInput, opts) =>
          requestPermission(toolName, toolInput, opts).then((answer) => {
            // A subagent refused here never starts: its place under orchestrator mode's limit is free again.
            if (answer?.behavior === "deny" && /^(Agent|Task)$/.test(toolName)) agentLimits.finished(opts.toolUseID)
            return answer
          }),
        onElicitation: (request, { signal }) => requestElicitation(request, signal),
        stderr: (data) => log("stderr", data),
        env: {
          // Agent Code passes CLAUDE_CODE_PLUGIN_DIRS mods itself (as `plugins`), so each can be switched off.
          ...withoutKey(process.env, "CLAUDE_CODE_PLUGIN_DIRS"),
          CLAUDE_AGENT_SDK_CLIENT_APP: "agent-code",
          // Claude Code 2.1.323: its "resume this session" hints name Agent Code's own command.
          CLAUDE_CODE_RESUME_HINT_COMMAND: "acode -r",
          // Another of the user's Claude logins (context/logins.js): its token, conversations stay where they are.
          ...(claudeLogin?.secret ? { CLAUDE_CODE_OAUTH_TOKEN: claudeLogin.secret } : {}),
          ...providerVars,
          // Claude Code assumes 200K for models it doesn't know: give it the real window so it compacts in time.
          ...(external && !routed ? contextEnv(store.model, providerVars?.ANTHROPIC_MODEL) : {}),
        },
      },
    })
    current = { q, input, generation: gen, shapedByModel: !!(orch || routes) }
    if (options.sessionId && !store.sessionID) setStore("sessionID", options.sessionId)
    primeSubagentRead()
    loadThinking()
    restorePause()
    const noteSent = !!goneNote && store.messages.length > 0
    if (noteSent) appendContext(goneNote)
    void pump(q, gen)
    try {
      const init = await q.initializationResult()
      if (gen !== generation) return
      // What this conversation's recorded prompt holds now (under its own id, a fork's new one included). A note that
      // couldn't go out isn't counted: the next start tries again.
      if (!goneNote || noteSent) rememberPromptParts(store.sessionID ?? sessionKey, instructionParts)
      batch(() => {
        setStore("commands", reconcile(init.commands ?? []))
        if (!external) rememberClaudeModels(init.models ?? [])
        rememberSessionModel(store.sessionID, store.model)
        rememberSessionEngine(store.sessionID, "claude")
        setStore("models", reconcile(external ? claudeModels : (init.models ?? [])))
        setStore("agents", reconcile(init.agents ?? []))
        if (init.account) setStore("account", init.account)
        if (init.output_style) setStore("outputStyle", init.output_style)
        setStore("ready", true)
        setStore("booting", false)
      })
      void refreshMcp()
      void refreshUsage()
      void attachSurface(gen)
      if (unsent.length) setTimeout(flushUnsent, 0)
      if (options.resume || options.continue) void refreshContext()
    } catch (error) {
      if (gen !== generation) return
      // The point to continue from is gone (e.g. compacted away): continue from the latest state instead.
      if (options.resumeAt && /No message found with message\.uuid/i.test(errorMessage(error))) {
        log("resume point missing, resuming without it", options.resumeAt)
        pushNotice("Couldn't continue from the undo point (it was compacted away); continuing from the latest state.", "warning")
        return start({ ...options, resumeAt: undefined })
      }
      log("init error", error)
      batch(() => {
        setStore("booting", false)
        setStore("fatal", errorMessage(error))
      })
      if (LOGIN_ERROR.test(errorMessage(error))) needLogin()
    }
  }

  async function pump(q       , gen        ) {
    try {
      for await (const message of q) {
        if (gen !== generation) break
        try {
          handle(message)
        } catch (error) {
          log("handle error", error, JSON.stringify(message).slice(0, 2000))
        }
      }
    } catch (error) {
      if (gen !== generation) return
      log("pump error", error)
      batch(() => {
        finishTurn({ error: errorMessage(error) })
        setStore("fatal", errorMessage(error))
      })
      if (LOGIN_ERROR.test(errorMessage(error))) needLogin()
      if (isLimitError(errorMessage(error))) armAutoResume(api, limitResetTime(errorMessage(error)))
    }
  }

  /** The chat of a harness that can't replay it, kept for the next time the tab opens. */
  function saveAcpHistory(target = oc) {
    if (!target?.id || !harnessById(target.harness) || store.engine !== target.harness) return
    const own = store.messages.filter((m) => !m.fromChain && !m.unsent)
    if (!own.some((m) => m.type === "user")) return
    writeAcpHistory(target.id, JSON.parse(JSON.stringify(own)))
  }

  function stop() {
    if (oc) {
      generation++
      for (const [id, resolve] of pending) resolve({ behavior: "deny", message: "Session closed", toolUseID: id })
      pending.clear()
      cancelElicitations()
      if (oc.caps?.close && oc.id) {
        try {
          void oc.client.request("session/close", { sessionId: oc.id }).catch(() => {})
        } catch {}
      }
      saveAcpHistory()
      oc.client.close()
      oc = undefined
      ocQueue.length = 0
      return
    }
    if (!current) return
    generation++
    for (const [id, resolve] of pending) resolve({ behavior: "deny", message: "Session closed", toolUseID: id })
    pending.clear()
    cancelElicitations()
    current.input.close()
    try {
      current.q.close()
    } catch {}
    current = undefined
  }

  /** Boot a dormant (restored) tab. */
  async function ensureStarted() {
    if (current || oc || disposed || store.booting) return
    if (store.sessionID && store.messages.some((m) => !m.fromChain && !m.unsent && m.type === "user")) await start({ resume: store.sessionID })
    else await start({ sessionId: store.sessionID ?? randomUUID() })
  }

  function dispose() {
    stop()
    disposed = true
    limitResetListeners.delete(onLimitReset)
    allSessions.delete(self)
    clearTimeout(mcpPoll)
    clearInterval(spendPoll)
    clearTimeout(spendTimer)
    emit("closed")
  }

  /** Restart the Claude Code process keeping the conversation (used when behaviour settings change). */
  let restartAfterTurn = false
  async function restart(force = false) {
    if (force) {
      // From any state (stuck, dead, starting forever): end the process and start again with the conversation.
      if (store.status === "running") finishTurn({})
      if (store.engine || oc) {
        await reviveHarness()
        return true
      }
    } else if (!(current || oc) || store.status === "running") return false
    restartAfterTurn = false
    if (store.sessionID && store.messages.some((m) => m.type === "user" && !m.fromChain)) await start({ resume: store.sessionID })
    // A session with no prompt yet keeps its id (and so its per-session settings, like the agent mix).
    else await start({ sessionId: store.sessionID && !store.engine ? store.sessionID : randomUUID() })
    return true
  }

  // -------------------------------------------------------------------------
  // opencode engine: OpenCode Zen's free models run inside opencode itself (`opencode acp`)
  // -------------------------------------------------------------------------

  let oc
  let ocPrompting = false
  let wakeTimer
  function wakeTurn() {
    if (store.status !== "running") setStore("status", "running")
    clearTimeout(wakeTimer)
    wakeTimer = setTimeout(() => {
      if (ocPrompting || store.status !== "running") return
      finishTurn({})
      // Prompts typed meanwhile were queued behind that turn: nothing else sends them.
      if (ocQueue.length) void promptOpencode()
    }, 6000)
    wakeTimer.unref?.()
  }
  /** Prompts typed while opencode works; sent together as the next turn, like Claude Code's queue. */
  const ocQueue                                                                                          = []
  /** session/load replays the stored conversation as updates. */
  let replaying = false

  async function startAcp(gen        , options              , harness     , model        ) {
    // A conversation of this harness (by the model it was saved with; opencode's own ids start "ses_").
    const own = (id         ) => !!id && id !== handedFrom && (harnessSession(id) === harness.id || (store.engine === harness.id && id === store.sessionID))
    const resume = [options.resume, store.sessionID].find(own)
    const previous = store.engine !== harness.id ? handOver(harness.name) : undefined
    setStore("engine", harness.id)
    const launch = harnessLaunch(harness, apiKeyFor)
    if (!launch) {
      batch(() => {
        setStore("booting", false)
        setStore("fatal", `${harness.name} is not installed. Install it with: ${harness.install}`)
      })
      return
    }
    // Harnesses that read AGENTS.md from a home folder (DeepSeek Harness) get Agent Code's instructions there: the
    // user's working profile and switches, as Claude gets them (not the parts about Claude-only tools).
    if (harness.instructions) {
      const text = behaviourPrompt([], { sessionId: resume ?? store.sessionID, session: api }, new Set(["acode-memory", "acode-memory-tools", "planning"]))
      launch.env.DSH_AGENTS_HOME = writeHarnessInstructions(harness.id, text, resume ?? store.sessionID)
    }
    const mcpServers = harness.mcp ? acpMcpServers() : []
    const client = new AcpClient(store.cwd, {
      update: (sessionId, update) => {
        // Subagent (child session) updates carry their own session id.
        if (gen !== generation || (oc?.id && sessionId !== oc.id)) return
        handleAcp(update)
        // A turn the harness starts by itself (opencode 2.3: a background subagent or shell reporting in after
        // the prompt ended): shown as running, and ended once it goes quiet.
        if (!replaying && !ocPrompting && /^(agent_message_chunk|agent_thought_chunk|tool_call|tool_call_update)$/.test(update.sessionUpdate ?? "")) wakeTurn()
      },
      request: (method, params) => acpRequest(gen, method, params),
      exit: (error) => {
        if (gen !== generation) return
        const was = oc
        oc = undefined
        log(`${harness.id} exited`, error)
        batch(() => {
          if (store.status === "running") finishTurn({ error })
          setStore("booting", false)
          setStore("ready", false)
          setStore("fatal", error)
        })
        // The kept chat (DeepSeek Harness can't reload its own) gets the turn that just ended too.
        saveAcpHistory(was)
      },
    })
    oc = { client, id: resume ?? "", harness: harness.id, caps: {} }
    const learn = (result     ) => {
      if (!result) return
      oc.caps = { models: acpModels(result) ?? oc.caps.models, effort: acpEffort(result) ?? oc.caps.effort, modes: acpModes(result) ?? oc.caps.modes }
    }
    try {
      const within = (promise, seconds, what) =>
        Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`no answer to ${what} in ${seconds} s`)), seconds * 1000).unref?.())])
      const hello = await within(client.request("initialize", { protocolVersion: 1, clientCapabilities: {} }), 45, "initialize")
      // HTTP MCP servers only where the harness says it can take them.
      if (!hello?.agentCapabilities?.mcpCapabilities?.http) for (let i = mcpServers.length - 1; i >= 0; i--) if (mcpServers[i].type === "http") mcpServers.splice(i, 1)
      // The harness's own version, for the sidebar's version line.
      const info = hello?.agentInfo ?? hello?.agent_info
      if (info?.version) setStore("engineVersion", String(info.version))
      let id = resume
      const caps = hello?.agentCapabilities ?? {}
      oc.caps.image = caps.promptCapabilities?.image !== false
      oc.caps.close = !!caps.sessionCapabilities?.close
      // DeepSeek Harness can't replay a conversation (no session/load) but can take it up again (session/resume):
      // its context comes back on its side, and the chat shown is the copy Agent Code kept.
      if (resume && !caps.loadSession && caps.sessionCapabilities?.resume) {
        try {
          learn(await within(client.request("session/resume", { sessionId: resume, cwd: store.cwd, mcpServers }), 90, "session/resume"))
          const kept = readAcpHistory(resume)
          // The kept chat, with anything typed while the harness started after it.
          if (kept && !store.messages.some((m) => m.type === "user" && !m.unsent && !m.fromChain)) setStore("messages", (list) => [...kept, ...list.filter((m) => m.unsent)])
        } catch (error) {
          log(`${harness.id} resume error`, error)
          pushNotice(`Could not reopen the ${harness.name} conversation (${errorMessage(error)}); starting a new one.`, "warning")
          id = undefined
        }
      } else if (resume) {
        replaying = true
        const shown = store.messages
        batch(() => {
          setStore("messages", [])
          setStore("children", {})
        })
        try {
          learn(await within(client.request("session/load", { sessionId: resume, cwd: store.cwd, mcpServers }), 180, "session/load"))
        } catch (error) {
          log(`${harness.id} load error`, error)
          // What the tab showed stays, as the earlier part the new conversation is given (not lost).
          setStore("messages", shown.map((m) => (m.unsent ? m : { ...m, fromChain: true })))
          pushNotice(`Could not reopen the ${harness.name} conversation (${errorMessage(error)}); starting a new one.`, "warning")
          id = undefined
        } finally {
          replaying = false
          closeReplayTurn()
          // Replayed prompts arrive in pieces: the notes Agent Code put in front of them come off once whole.
          setStore("messages", (list) => list.map((m) => (m.type === "user" && /^\[(Agent Code|Mode )/.test(m.text) ? { ...m, text: cleanUserText(m.text) } : m)))
          if (/^\[(Agent Code|Mode )/.test(store.title ?? "")) setStore("title", store.messages.find((m) => m.type === "user")?.text.split("\n")[0].slice(0, 80))
        }
      }
      if (resume && id === resume) {
        await prependChain(resume)
        restoreUnsent(resume)
        restoreDraft(resume)
      }
      if (!id) {
        const created = await within(client.request("session/new", { cwd: store.cwd, mcpServers }), 90, "session/new")
        learn(created)
        id = created.sessionId
        linkSessions(previous ?? handedFrom, id)
        handedFrom = undefined
      }
      if (gen !== generation) return
      oc.id = id
      await acpSetModel(model)
      // The variant remembered for this model (setEffort only sends changes).
      if (store.effort) await acpSetEffort(store.effort)
      if (store.mode === "plan") await acpSetMode("plan")
      if (gen !== generation) return
      batch(() => {
        setStore("sessionID", id)
        setStore("modelId", model.slice(model.lastIndexOf("/") + 1))
        setStore("ready", true)
        setStore("booting", false)
      })
      rememberSessionModel(id, store.model)
      rememberSessionEngine(id, harness.id)
      if (resume === id && harness.id === "opencode") void loadOpencodeInfo()
      if (unsent.length) setTimeout(flushUnsent, 0)
    } catch (error) {
      if (gen !== generation) return
      log(`${harness.id} start error`, error)
      // No half-alive harness is left behind: the next message starts it again.
      try {
        client.close()
      } catch {}
      if (oc?.client === client) oc = undefined
      batch(() => {
        setStore("booting", false)
        setStore("ready", false)
        setStore("fatal", `${harness.name} didn't start (${errorMessage(error)}). Send a message or /restart to try again.`)
      })
    }
  }

  /** Switch the harness's model: its `model` config option, ACP's session/set_model, or opencode's option. */
  async function acpSetModel(model        ) {
    const session = oc
    if (!session) return
    const models = session.caps.models
    try {
      if (models?.via === "set_model") await session.client.request("session/set_model", { sessionId: session.id, modelId: model })
      else await session.client.request("session/set_config_option", { sessionId: session.id, configId: models?.configId ?? "model", value: model })
    } catch (error) {
      log(`${session.harness} model error`, error)
      pushNotice(`${harnessById(session.harness)?.name ?? session.harness} did not switch to ${model}: ${errorMessage(error)}`, "warning")
    }
  }

  /** The reasoning level, where the harness has an option for it. */
  async function acpSetEffort(value                         ) {
    const session = oc
    const effort = session?.caps.effort ?? (session?.harness === "opencode" ? { configId: "effort" } : undefined)
    if (!session || !effort) return
    const pick = value ?? (effort.values?.includes("default") ? "default" : undefined)
    if (!pick || (effort.values && !effort.values.includes(pick))) return
    await session.client
      .request("session/set_config_option", { sessionId: session.id, configId: effort.configId, value: pick })
      .catch((error) => log(`${session.harness} effort error`, error))
  }

  /** Plan mode, where the harness has one (opencode's build/plan, an ACP mode called plan or read-only). */
  async function acpSetMode(mode                ) {
    const session = oc
    if (!session) return
    const modes = session.caps.modes ?? (session.harness === "opencode" ? { via: "config", configId: "mode", values: ["build", "plan"] } : undefined)
    if (!modes) return
    const plan = modes.values.find((value) => /plan|read.?only/i.test(value))
    const value = mode === "plan" ? plan : modes.values.find((item) => item !== plan)
    if (!value) return
    const request =
      modes.via === "set_mode"
        ? session.client.request("session/set_mode", { sessionId: session.id, modeId: value })
        : session.client.request("session/set_config_option", { sessionId: session.id, configId: modes.configId, value })
    await request.catch((error) => log(`${session.harness} mode error`, error))
  }

  /** Title and revert state of a reopened opencode conversation. */
  async function loadOpencodeInfo() {
    const session = oc
    if (!session) return
    try {
      const info = await opencodeApi(store.cwd, "GET", `/api/session/${session.id}`)
      if (oc !== session) return
      if (info?.title && !store.title) setStore("title", info.title)
      const point = info?.revert?.messageID
      if (point && store.messages.some((m) => m.id === point)) setStore("revert", { messageID: point, files: (info.revert.files ?? []).map(fileDiff) })
    } catch (error) {
      log("opencode info error", error)
    }
  }

  /** Replayed turns have no timing: mark the open one finished without a duration. */
  function closeReplayTurn() {
    const turn = lastTurn()
    if (!turn || turn.end !== undefined) return
    setStore(
      "messages",
      (m) => m.id === turn.id,
      produce((m     ) => {
        m.start = 0
        m.end = 0
        for (const part of m.parts) {
          if (part.type === "text") part.done = true
          if (part.type === "reasoning") {
            part.start = 0
            part.end = 0
          }
        }
      }),
    )
  }

  /** A new part starts: the reasoning or text before it is complete. */
  function settleLastPart(turn                  ) {
    const last = turn.parts.at(-1)
    if (last?.type === "reasoning" && last.end === undefined) last.end = replaying ? 0 : Date.now()
    if (last?.type === "text") last.done = true
  }

  function handleAcp(update     ) {
    switch (update.sessionUpdate) {
      case "user_message_chunk": {
        if (!replaying) return
        const text = update.content?.type === "text" ? (update.content.text ?? "") : ""
        closeReplayTurn()
        const last = store.messages.at(-1)
        if (last?.type === "user" && last.id === update.messageId) setStore("messages", store.messages.length - 1, produce((m     ) => (m.text += text)))
        else setStore("messages", (list) => [...list, { type: "user", id: update.messageId ?? randomUUID(), text, files: [] }                      ])
        if (!store.title && text.trim()) setStore("title", text.split("\n")[0].slice(0, 80))
        return
      }
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        const kind = update.sessionUpdate === "agent_message_chunk" ? "text" : "reasoning"
        const text = update.content?.type === "text" ? (update.content.text ?? "") : ""
        if (!text) return
        if (!liveBase) liveBase = store.context?.tokens ?? 0
        liveTokens(text.length)
        const source = `${update.messageId ?? ""}#`
        updateTurn((turn) => {
          turn.retry = undefined
          const last = turn.parts.at(-1)
          if (last && last.type === kind && last.id.startsWith(source)) {
            last.text += text
            return
          }
          settleLastPart(turn)
          const id = `${source}${turn.parts.length}`
          turn.parts.push(
            kind === "text"
              ? { type: "text", id, text, done: replaying }
              : { type: "reasoning", id, text, start: replaying ? 0 : Date.now(), ...(replaying ? { end: 0 } : {}) },
          )
        })
        return
      }
      case "tool_call":
      case "tool_call_update": {
        const id = update.toolCallId
        if (!id) return
        if (!findToolPart(id)) {
          const name = acpToolName(update.name ?? update.title, update.kind)
          updateTurn((turn) => {
            settleLastPart(turn)
            turn.parts.push({ type: "tool", id, name, raw: "", input: {}, status: "pending", start: replaying ? 0 : Date.now() })
          })
        }
        const status = update.status
        updateTool(id, (part) => {
          if (update.rawInput && Object.keys(update.rawInput).length) part.input = acpToolInput(part.name, update.rawInput)
          const location = update.locations?.[0]?.path
          if (location && !part.input.file_path && ["Read", "Write", "Edit", "MultiEdit"].includes(part.name)) part.input = { ...part.input, file_path: location }
          if (status === "in_progress" && part.status === "pending") part.status = "running"
          const text = acpContentText(update.content)
          if (text) part.output = text
          const diff = (update.content ?? []).find((item     ) => item?.type === "diff")
          if (diff)
            part.result = {
              ...part.result,
              type: diff.oldText == null ? "create" : "update",
              structuredPatch: structuredPatch(diff.path, diff.path, diff.oldText ?? "", diff.newText ?? "", "", "", { context: 3 }).hunks,
            }
          const meta = update.rawOutput?.metadata
          if (meta) part.result = { ...part.result, numFiles: meta.count, numMatches: meta.matches, exitCode: meta.exit }
          if (status === "completed" || status === "failed") {
            part.status = status === "completed" ? "completed" : "error"
            if (status === "failed") part.error = text || "Tool failed"
            part.end = replaying ? 0 : Date.now()
          }
        })
        const part = findToolPart(id)
        if (status === "completed" && part) trackToolSideEffects(part.name, part.input, part.result)
        return
      }
      case "plan":
        setStore(
          "todos",
          reconcile(
            (update.entries ?? []).map((entry     ) => ({
              content: String(entry.content ?? ""),
              status: entry.status === "completed" || entry.status === "in_progress" ? entry.status : "pending",
            })),
          ),
        )
        return
      case "usage_update":
        // Exact numbers from opencode: the live estimate starts again from here.
        if (typeof update.used === "number") {
          liveBase = update.used
          liveOutput = 0
        }
        batch(() => {
          if (typeof update.used === "number" && update.size)
            setStore("context", { tokens: update.used, percent: Math.round((update.used / update.size) * 100), max: update.size })
          if (typeof update.cost?.amount === "number") setStore("cost", update.cost.amount)
        })
        return
      case "available_commands_update":
        setStore(
          "commands",
          reconcile((update.availableCommands ?? []).map((command     ) => ({ name: command.name, description: command.description ?? "", argumentHint: command.input?.hint ?? "" }))),
        )
        return
      case "current_mode_update":
        setStore("mode", update.currentModeId === "plan" ? "plan" : "default")
        return
      case "config_option_update":
        if (oc && update.configOptions) {
          const result = { configOptions: update.configOptions }
          oc.caps = { ...oc.caps, models: acpModels(result) ?? oc.caps.models, effort: acpEffort(result) ?? oc.caps.effort, modes: acpModes(result) ?? oc.caps.modes }
        }
        return
      case "session_info_update":
        if (update.title) setStore("title", update.title)
        return
      default:
        return
    }
  }

  /** opencode asks before a tool runs: same prompt (and auto-allow rules) as Claude Code's. */
  async function acpRequest(gen        , method        , params     ) {
    if (method !== "session/request_permission") throw new Error(`Method not supported: ${method}`)
    const call = params?.toolCall ?? {}
    const id = String(call.toolCallId ?? randomUUID())
    const known = findToolPart(id)
    const name = known?.name ?? acpToolName(call.name ?? call.title, call.kind)
    const input = call.rawInput && Object.keys(call.rawInput).length ? acpToolInput(name, call.rawInput) : (known?.input ?? {})
    const options        = params?.options ?? []
    const pick = (...kinds          ) => kinds.map((kind) => options.find((option) => option.kind === kind)?.optionId).find(Boolean)
    const result = await requestPermission(name, input, { signal: new AbortController().signal, toolUseID: id, title: call.title }       )
    if (gen !== generation) return { outcome: { outcome: "cancelled" } }
    const choice =
      result.behavior === "allow"
        ? (result       ).updatedPermissions?.length
          ? pick("allow_always", "allow_once")
          : pick("allow_once", "allow_always")
        : (result       ).interrupt && result.message === "Interrupted by user"
          ? undefined
          : pick("reject_once", "reject_always")
    return choice ? { outcome: { outcome: "selected", optionId: choice } } : { outcome: { outcome: "cancelled" } }
  }

  function sendOpencode(text        , extra           ) {
    if (store.resumeAt !== undefined) cancelAutoResume(api)
    const id = randomUUID()
    const running = store.status === "running"
    const files = [...text.matchAll(/(?:^|\s)@([^\s]+)/g)].map((match) => match[1])
    batch(() => {
      setStore("messages", (list) => [
        ...list,
        {
          type: "user",
          id,
          text,
          files,
          queued: running,
          pastes: extra.pastes,
          time: Date.now(),
          attachments: extra.attachments?.length ? extra.attachments.map(attachmentMeta) : undefined,
        }                      ,
      ])
      setStore("status", "running")
      setStore("suggestion", undefined)
      setStore("view", "session")
      if (!store.title) setStore("title", text.split("\n")[0].slice(0, 80))
    })
    ocQueue.push({ text, images: extra.images ?? [], attachments: extra.attachments ?? [] })
    emit("sent", { id })
    emit("status", { status: "running" })
    if (!running) void promptOpencode()
  }

  /**
   * A harness that reads no instructions file (opencode — its shared background service never sees per-launch
   * settings — and Codex) gets Agent Code's instructions with the first message of a conversation, and after a
   * settings change only what changed. The chat doesn't show them (cleanUserText).
   */
  function harnessInstructions() {
    const harness = harnessById(store.engine)
    if (!harness || harness.instructions) return undefined
    const id = oc?.id ?? store.sessionID
    if (!id) return undefined
    const parts = behaviourParts([], { sessionId: id, session: api }, new Set(["acode-memory", "acode-memory-tools", "planning"]))
    if (!parts.length) return undefined
    // Counted as told only once the prompt went through (promptOpencode).
    pendingInstructions = { id, parts }
    if (!config.sessionPrompt?.[id]) return `${HARNESS_INSTRUCTIONS_START}\n\n${parts.map((part) => part.text).join("\n\n")}\n\n${HARNESS_INSTRUCTIONS_END}`
    const note = promptChange(id, parts)
    if (!note) pendingInstructions = undefined
    return note ? `${HARNESS_INSTRUCTIONS_START}\n\n${note}\n\n${HARNESS_INSTRUCTIONS_END}` : undefined
  }
  let pendingInstructions

  async function promptOpencode() {
    const session = oc
    if (!session || !ocQueue.length) return
    const items = ocQueue.splice(0)
    const prompt        = []
    for (const item of items) {
      if (oc?.caps?.image === false && item.images.length) pushNotice(`${harnessById(oc.harness)?.name ?? "This harness"} can't take images with this model: they were left out.`, "warning")
      else for (const image of item.images) prompt.push({ type: "image", mimeType: image.mime, data: image.data })
      prompt.push(...attachmentAcp(item.attachments))
    }
    const instructions = harnessInstructions()
    if (instructions) prompt.push({ type: "text", text: instructions })
    const carry = pendingCarry(items.length)
    if (carry) prompt.push({ type: "text", text: carry })
    prompt.push({ type: "text", text: [modeNote, items.map((item) => item.text).join("\n\n")].filter(Boolean).join("\n\n") })
    carryNote = undefined
    modeNote = undefined
    rememberAgentMode()
    const gen = generation
    ensureTurn()
    let result
    let error
    const told = instructions ? pendingInstructions : undefined
    pendingInstructions = undefined
    try {
      ocPrompting = true
      result = await session.client.request("session/prompt", { sessionId: session.id, prompt })
      if (told) rememberPromptParts(told.id, told.parts)
    } catch (failure) {
      error = errorMessage(failure)
    } finally {
      ocPrompting = false
    }
    if (gen !== generation) return
    if (result?.stopReason === "refusal") error = "The model refused to answer"
    if (result?.stopReason === "max_tokens") error = "Response hit the maximum output tokens"
    if (typeof result?.usage?.outputTokens === "number") {
      const turn = lastTurn()
      if (turn && !turn.end) setStore("messages", (m) => m.id === turn.id, produce((m     ) => (m.outputTokens = result.usage.outputTokens)))
    }
    const interrupted = lastTurn()?.interrupted
    finishTurn({ error: error && !interrupted ? error : undefined })
    if (isLimitError(error) && !interrupted) armAutoResume(api, limitResetTime(error))
    void syncOpencodeIds()
    if (ocQueue.length) void promptOpencode()
  }

  /** Give prompts sent from Agent Code the ids opencode stored them under (revert and fork need those). */
  async function syncOpencodeIds() {
    const session = oc
    if (!session?.id) return
    try {
      const list        = (await opencodeApi(store.cwd, "GET", `/api/session/${session.id}/message`)) ?? []
      if (oc !== session) return
      const theirs = list.filter((m) => m?.type === "user" && typeof m.id === "string").reverse()
      const textOf = (m     ) => String(m.text ?? "").trim()
      let last = -1
      for (const mine of store.messages.filter((m)                   => m.type === "user")) {
        const want = mine.text.trim()
        let k = theirs.findIndex((m, i) => i > last && (m.id === mine.id || textOf(m).includes(want)))
        // Queued prompts went out together as one opencode message.
        if (k < 0 && last >= 0 && textOf(theirs[last]).length > want.length && textOf(theirs[last]).includes(want)) k = last
        if (k < 0) continue
        last = k
        const target = theirs[k].id
        if (mine.id !== target) setStore("messages", (m) => m.type === "user" && m.id === mine.id, produce((m     ) => (m.id = target)))
      }
    } catch (error) {
      log("opencode ids error", error)
    }
  }

  async function opencodeMessageId(id        ) {
    if (id.startsWith("msg_")) return id
    const index = store.messages.findIndex((m) => m.id === id)
    await syncOpencodeIds()
    const now = store.messages[index]?.id
    return now?.startsWith("msg_") ? now : undefined
  }

  // -------------------------------------------------------------------------
  // Unsent prompts: kept while Claude Code is down or its login has to be renewed, sent once it runs again
  // -------------------------------------------------------------------------

  const unsent = []

  /** The login expired or was refused: say so once, and hold prompts until /login. */
  let loginNeededAt = 0
  function needLogin() {
    // Another provider's refused key is not Claude Code's login.
    if (store.authRequired || splitModel(store.model) || oc) return
    // One of the other Claude logins was refused (its token is wrong or expired): it is set aside for a day and the
    // work goes on with the next one; it can be replaced in /logins.
    if (store.login && store.login !== "main") {
      const broken = store.login
      blockLogin("anthropic", broken, Date.now() + 24 * 3_600_000)
      const next = chosenLogin("anthropic")
      pushNotice(`The login "${loginLabel("anthropic", broken)}" was refused (its token is wrong or expired; replace it in /logins). Going on with ${next.label}.`, "warning")
      log("login refused", store.sessionID, broken, "→", next.id)
      void restart(true).then(() => send(LOGIN_SWITCH_PROMPT))
      return
    }
    loginNeededAt = Date.now()
    setStore("authRequired", true)
    pushNotice("Claude Code's login has expired or was refused. Run /login — prompts you send meanwhile wait here and go out after you log in.", "warning")
    emit("attention", { kind: "login" })
  }

  /** Messages not sent yet are kept per session (text, pastes, attached files by path): a restart doesn't lose them. */
  function saveUnsent() {
    const id = store.sessionID
    if (!id) return
    const all = { ...(config.sessionUnsent ?? {}) }
    if (unsent.length)
      all[id] = unsent.map((item) => ({ id: item.id, text: item.text, pastes: item.extra?.pastes, attachments: (item.extra?.attachments ?? []).filter((file) => file.path).map(({ data, ...rest }) => rest) }))
    else delete all[id]
    config.sessionUnsent = all
    saveConfig()
  }
  function restoreUnsent(id) {
    const saved = config.sessionUnsent?.[id]
    if (!saved?.length || unsent.length) return
    for (const item of saved) {
      unsent.push({ id: item.id, text: item.text, extra: { pastes: item.pastes, attachments: item.attachments ?? [] } })
      setStore("messages", (list) => [...list, { type: "user", id: item.id, text: item.text, files: [], unsent: true, pastes: item.pastes, time: Date.now() }])
    }
    // Sent as soon as the engine is up.
    if (current && store.ready) setTimeout(flushUnsent, 0)
  }

  /** Bring a harness tab's process back (after it died, hung or failed to start), keeping the conversation. */
  let reviving = false
  async function reviveHarness() {
    if (reviving || disposed) return
    reviving = true
    try {
      if (oc) {
        try {
          oc.client.close()
        } catch {}
        oc = undefined
      }
      const started = store.messages.some((m) => m.type === "user" && !m.unsent && !m.fromChain)
      await start(store.sessionID && started ? { resume: store.sessionID } : {})
    } finally {
      reviving = false
    }
  }

  function holdUnsent(text, extra, harness = false) {
    const id = randomUUID()
    batch(() => {
      setStore("messages", (list) => [
        ...list,
        {
          type: "user",
          id,
          text,
          files: [...text.matchAll(/(?:^|\s)@([^\s]+)/g)].map((match) => match[1]),
          unsent: true,
          pastes: extra.pastes,
          time: Date.now(),
          attachments: extra.attachments?.length ? extra.attachments.map(attachmentMeta) : undefined,
        },
      ])
      setStore("view", "session")
      if (!store.title) setStore("title", text.split("\n")[0].slice(0, 80))
    })
    unsent.push({ id, text, extra })
    saveUnsent()
    emit("sent", { id })
    if (harness) return
    // Logged in again outside Agent Code (claude auth login in a terminal): the credentials changed, so go on.
    if (store.authRequired && credentialsChangedSince(loginNeededAt)) return void loggedIn()
    // Bring the process back (unless the login has to be renewed first).
    if (!store.authRequired && !store.booting) void revive()
  }

  /** Start Claude Code again for this tab: resume its conversation, or begin it. */
  async function revive() {
    const started = store.messages.some((m) => m.type === "user" && !m.unsent && !m.fromChain)
    if (store.sessionID && started) await start({ resume: store.sessionID })
    else await start({ sessionId: store.sessionID ?? randomUUID() })
  }

  /** Send what waited, in order, now that the process runs. */
  function flushUnsent() {
    if ((!current && !(oc && store.ready)) || store.fatal || store.authRequired || !unsent.length) return
    const items = unsent.splice(0)
    saveUnsent()
    setStore("messages", (list) => list.filter((m) => !(m.type === "user" && m.unsent)))
    for (const item of items) send(item.text, item.extra)
  }

  /** After /login: clear the hold, bring the process back and send what waited. */
  async function loggedIn() {
    if (oc) return
    setStore("authRequired", undefined)
    if (current && !store.fatal && store.status === "idle") await restart()
    else if (!current || store.fatal) await revive()
    flushUnsent()
  }

  // -------------------------------------------------------------------------
  // Pause: the work stops at its next tool call and goes on from there, so pausing and resuming send nothing
  // and cost nothing (a PreToolUse hook holds the call). Harnesses without hooks stop the turn instead and get
  // a short "continue" on resume.
  // -------------------------------------------------------------------------

  let pauseWaiters = []
  let pauseTimer
  // A limit reset was used: a pause before the limit is over.
  const onLimitReset = () =>
    (store.pause?.reason === "limit" || (store.pause?.reason === "stop" && store.pause.windows?.some((w) => w.key === "fiveHour"))) && resume(true)
  limitResetListeners.add(onLimitReset)
  allSessions.add(self)
  // A new tab starts in the default mode (Chat); a restored one takes its session's own in load().
  applyDefaultMode()

  /** Pause until `until` (ms; undefined = until resumed by hand). */
  function pause(until, reason = "user", windows, group) {
    clearTimeout(pauseTimer)
    const stopped = !!oc && store.status === "running"
    log("pause", store.sessionID, reason, until ? new Date(until).toISOString() : "until resumed")
    setStore("pause", { until, reason, windows, group, since: Date.now(), holding: false, interrupted: stopped || store.pause?.interrupted })
    if (until) pauseTimer = setTimeout(() => resume(true), Math.max(1000, until - Date.now()))
    rememberPause()
    if (stopped) void interrupt()
    emit("pause", { until, reason })
  }

  /** Let a paused turn go on (or, for a harness that was stopped, continue it with one short message). */
  /** `auto`: the pause's own end (its time, a limit's reset), not the user nor a planned resume. */
  function resume(auto = false) {
    clearTimeout(pauseTimer)
    const was = store.pause
    if (!was) return
    // An automatic end waits for a resume planned later (once): planned resumes only delay, never come earlier.
    const hold = auto && was.reason !== "break" && !was.held ? resumeHold(store.sessionID) : undefined
    if (hold && hold > Date.now() + 1000) {
      setStore("pause", { ...was, until: hold, held: true })
      rememberPause()
      pauseTimer = setTimeout(() => resume(true), Math.max(1000, hold - Date.now()))
      log("pause held by a planned resume", store.sessionID, new Date(hold).toISOString())
      return
    }
    log("resume", store.sessionID, was.reason)
    setStore("pause", undefined)
    // A break that ends (at its time or by hand): what is left of it in the schedule goes too.
    if (was.group && store.sessionID) setSchedule(store.sessionID, scheduleOf(store.sessionID).filter((entry) => entry.group !== was.group))
    rememberPause()
    // Resumed by hand before the reset: the user chose to go on up to 100 % of these windows.
    if (was.reason === "limit" && (!was.until || Date.now() < was.until - 30_000)) {
      for (const w of was.windows ?? []) waivePause(w)
      if (was.windows?.length) pushNotice("Going on up to 100% of the limit: no more pauses before this window resets.", "info")
    }
    for (const release of pauseWaiters.splice(0)) release()
    emit("pause", { resumed: true })
    if (was.interrupted && oc) send("Continue where you stopped.")
  }

  // A pause outlives Agent Code: kept per session in the config, put back when the session opens again.
  function rememberPause() {
    const id = store.sessionID
    if (!id) return
    const all = { ...(config.sessionPauses ?? {}) }
    const p = store.pause
    // Plain copies (the store's own objects are proxies).
    if (p) all[id] = { until: p.until, reason: p.reason, group: p.group, held: p.held, windows: p.windows?.map((w) => ({ key: w.key, resetsAt: w.resetsAt })), since: p.since, interrupted: !!p.interrupted }
    else delete all[id]
    config.sessionPauses = all
    saveConfig()
  }
  function restorePause() {
    const id = store.sessionID
    const saved = id ? config.sessionPauses?.[id] : undefined
    if (!saved || store.pause) return
    // Its time ran out while Agent Code was closed: the pause is over.
    if (saved.until && saved.until <= Date.now()) {
      const all = { ...(config.sessionPauses ?? {}) }
      delete all[id]
      config.sessionPauses = all
      saveConfig()
      return
    }
    setStore("pause", { ...saved, holding: false })
    if (saved.until) pauseTimer = setTimeout(() => resume(true), Math.max(1000, saved.until - Date.now()))
  }

  function waitWhilePaused(signal) {
    if (!store.pause) return Promise.resolve()
    return new Promise((resolve) => {
      pauseWaiters.push(resolve)
      signal?.addEventListener("abort", () => resolve(), { once: true })
    })
  }

  /**
   * "Pause before a limit": Anthropic refuses a request that would go past the plan limit, which costs a failed
   * request and a "continue" later. Near the limit (pauseAt %, default 95, a setting) the work pauses until the window
   * resets. Resuming by hand goes on up to 100 %: that window doesn't pause again until it resets.
   */
  function pauseNearLimit() {
    const rule = guardFor(store.sessionID)
    if (!rule.on || splitModel(store.model) || store.pause || (store.login ?? "main") !== "main") return
    const at = rule.at
    const own = (limits.scoped ?? []).filter((w) => onModel(store, w.name))
    const windows = [
      limits.fiveHour && { key: "fiveHour", ...limits.fiveHour },
      limits.week && { key: "week", ...limits.week },
      ...own.map((w) => ({ ...w, key: `scoped:${w.name}` })),
    ].filter((w) => w && w.resetsAt && w.resetsAt > Date.now() && w.utilization >= at && !waivedPause(w))
    if (!windows.length) return
    // Only the Fable window is near its end and Fable fallback is on: switch model instead of pausing.
    if (fableFallback().enabled && windows.every((w) => /^scoped:fable/i.test(w.key)) && familyOf(store) === "fable") {
      void fallBackFromFable(api)
      return
    }
    const until = Math.max(...windows.map((w) => w.resetsAt)) + 30_000
    pause(until, "limit", windows.map((w) => ({ key: w.key, resetsAt: w.resetsAt })))
    const top = windows.reduce((a, b) => (b.utilization > a.utilization ? b : a))
    const name = top.key === "fiveHour" ? "5-hour" : top.key === "week" ? "weekly" : top.key.replace(/^scoped:/, "")
    pushNotice(
      `Stopped at ${Math.round(top.utilization)}% of the ${name} limit (Stop after: any limit at ${at}%). Goes on by itself ${whenText(until)}, with nothing extra sent; resume to go on up to 100%.`,
      "info",
    )
  }

  /** The PreToolUse hook that holds a tool call while the tab is paused. */
  function pauseHook() {
    return {
      timeout: 7 * 86_400,
      hooks: [
        async (_input, _id, options) => {
          pauseNearLimit()
          if (store.pause) {
            setStore("pause", "holding", true)
            await waitWhilePaused(options?.signal)
          }
          return {}
        },
      ],
    }
  }

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  function send(text        , extra            = {}) {
    // A message from the user: orchestrator mode's per-message count starts again.
    if (text !== "Continue where you stopped." && text !== RESUME_PROMPT) agentLimits.userMessage()
    // Writing to a paused tab means: go on.
    if (store.pause && !(store.pause.interrupted && text === "Continue where you stopped.")) resume()
    // Like opencode: a new prompt deletes the reverted messages for good.
    if (store.revert) {
      void commitRevert().then(() => send(text, extra))
      return
    }
    if (oc && store.ready && !store.fatal) return sendOpencode(text, extra)
    // A harness tab that is still starting, or whose process died or never came up: hold the message, bring the
    // harness back, send when it is ready.
    if (oc || (store.engine && !current)) {
      holdUnsent(text, extra, true)
      if (store.fatal || !oc) void reviveHarness()
      return
    }
    if (!current && store.dormant && !store.authRequired) {
      void ensureStarted().then(() => send(text, extra))
      return
    }
    // The process is down (a failed login, a crash) or the login has to be renewed: the prompt stays in the chat,
    // marked unsent, and goes out once Claude Code runs again — it used to be dropped without a trace.
    if (!current || store.fatal || store.authRequired) return holdUnsent(text, extra)
    if (store.resumeAt !== undefined) cancelAutoResume(api)
    const id = randomUUID()
    const running = store.status === "running"
    const files = [...text.matchAll(/(?:^|\s)@([^\s]+)/g)].map((match) => match[1])
    batch(() => {
      setStore("messages", (list) => [
        ...list,
        {
          type: "user",
          id,
          text,
          files,
          queued: running,
          pastes: extra.pastes,
          time: Date.now(),
          attachments: extra.attachments?.length ? extra.attachments.map(attachmentMeta) : undefined,
        }                      ,
      ])
      setStore("status", "running")
      setStore("suggestion", undefined)
      setStore("view", "session")
      if (!store.title) setStore("title", text.split("\n")[0].slice(0, 80))
    })
    const content        = []
    for (const image of extra.images ?? [])
      content.push({ type: "image", source: { type: "base64", media_type: image.mime, data: image.data } })
    content.push(...attachmentBlocks(extra.attachments ?? []))
    // A mode's instruction goes to the model once, with the first prompt after switching to it.
    lastWork = Date.now()
    // The earlier conversation goes as a block of its own, before the message.
    const carry = pendingCarry(1)
    if (carry) content.push({ type: "text", text: carry })
    const forModel = [modeNote, text].filter(Boolean).join("\n\n")
    carryNote = undefined
    modeNote = undefined
    rememberAgentMode()
    content.push({ type: "text", text: forModel })
    current.input.push({
      type: "user",
      uuid: id       ,
      message: { role: "user", content: content.length === 1 ? forModel : content },
      parent_tool_use_id: null,
      inline_pastes: extra.pastes?.length ? extra.pastes : undefined,
    })
    emit("sent", { id })
    emit("status", { status: "running" })
  }

  /** Inject context without triggering a turn (used by shell mode, like Claude Code's `!` prefix). */
  function appendContext(text        ) {
    if (!current) return
    current.input.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      shouldQuery: false,
    })
  }

  async function interrupt() {
    if (!current && !oc) return
    for (const [id, resolve] of pending) resolve({ behavior: "deny", message: "Interrupted by user", interrupt: true, toolUseID: id })
    pending.clear()
    setStore("permissions", [])
    setStore("questions", [])
    try {
      if (oc) {
        oc.client.notify("session/cancel", { sessionId: oc.id })
        const session = oc
        const turnGen = generation
        const stopped = lastTurn()?.id
        setTimeout(() => {
          // Only the turn that was stopped, still open: a turn started since then is left alone.
          const open = lastTurn()
          if (oc !== session || generation !== turnGen || store.status !== "running" || open?.id !== stopped || open?.end !== undefined) return
          log(`${session.harness} didn't stop after cancel: ending the turn here`)
          generation++
          try {
            session.client.close()
          } catch {}
          oc = undefined
          // Prompts that were waiting go out once the harness runs again (shown as not sent yet).
          for (const item of ocQueue.splice(0)) unsent.push({ id: randomUUID(), text: item.text, extra: { images: item.images, attachments: item.attachments } })
          setStore("messages", (list) => list.map((m) => (m.type === "user" && m.queued ? { ...m, queued: false, unsent: true } : m)))
          saveUnsent()
          batch(() => {
            finishTurn({})
            saveAcpHistory(session)
            setStore("ready", false)
            setStore("dormant", true)
          })
          pushNotice("The harness didn't answer the stop, so its process was ended. Your next message starts it again with this conversation.", "info")
        }, 8000).unref?.()
      } else await current .q.interrupt()
    } catch (error) {
      log("interrupt error", error)
    }
    const turn = lastTurn()
    if (turn && !turn.end) {
      setStore(
        "messages",
        (m) => m.id === turn.id,
        produce((m     ) => {
          m.interrupted = true
        }),
      )
    }
  }

  async function backgroundTasks() {
    try {
      return await current?.q.backgroundTasks()
    } catch (error) {
      log("background error", error)
      return false
    }
  }

  async function stopTask(taskId        ) {
    try {
      await current?.q.stopTask(taskId)
      return true
    } catch (error) {
      log("stopTask error", error)
      return false
    }
  }

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  async function setModel(value        ) {
    // Between opencode models the running opencode session just switches.
    // Each model comes back with the reasoning level last chosen for it.
    const effort = storedEffort(value)
    const via = harnessModel(value)
    if (via && oc && oc.harness === via.harness.id) {
      setStore("model", value)
      rememberSessionModel(store.sessionID, value)
      await acpSetModel(via.model)
      setStore("modelId", via.model.slice(via.model.lastIndexOf("/") + 1))
      adoptModelLimits(value)
      if (effort !== store.effort) await setEffort(effort)
      return
    }
    const crossing = !!splitModel(value) || !!splitModel(store.model)
    const previous = store.model
    setStore("model", value)
    // The footer's limits (context window, price tier) follow the new model right away, not its first reply.
    adoptModelLimits(value)
    const effortChanged = effort !== store.effort
    // A restart below starts the new process with it; otherwise it is applied after the switch.
    setStore("effort", effort)
    // Same engine: the session's model is this one now. Another engine: that engine's own new session gets it.
    if (!!harnessModel(value) === !!harnessModel(previous) && harnessModel(value)?.harness.id === harnessModel(previous)?.harness.id) rememberSessionModel(store.sessionID, value)
    // Another provider means another endpoint: the Claude Code process has to restart.
    if (crossing && previous !== value) {
      // Mid-turn the process can't be swapped: do it as soon as the turn ends.
      if (!(await restart())) {
        restartAfterTurn = !!(current || oc)
        log("model change waits for the next start", value)
      }
      return
    }
    try {
      await current?.q.setModel(value === "default" ? undefined : value)
    } catch (error) {
      log("setModel error", error)
    }
    // Orchestrator mode and routing build their subagents from the tab's model: they are rebuilt with it.
    if (current?.shapedByModel && previous !== value && !(await restart())) restartAfterTurn = true
    if (effortChanged) await setEffort(effort)
    // Claude Code knows the new model's window: ask it for the real numbers.
    if (!splitModel(value)) void refreshContext()
  }

  /**
   * Point the session's model facts at `value`: the resolved id (until the new model's first reply carries
   * its own) and the context gauge's window, so nothing shows the previous model's limits.
   */
  function adoptModelLimits(value        ) {
    const split = splitModel(value)
    const info = store.models.find((model) => model.value === value)
    // A Claude alias without a resolved id stays unresolved: the catalogue maps the alias itself.
    const id = split ? split.model : info?.resolvedModel
    const meta = modelMeta(value, id)
    batch(() => {
      setStore("modelId", id)
      if (store.context && meta.context) {
        const tokens = store.context.tokens
        setStore("context", { tokens, max: meta.context, percent: Math.round((tokens / meta.context) * 100) })
      }
    })
  }

  async function setEffort(value                         ) {
    setStore("effort", value)
    rememberSessionEffort(store.sessionID, value)
    if (oc) return acpSetEffort(value)
    // Provider models: Agent Code's proxy reads the stored variant on every request.
    if (splitModel(store.model)) return
    try {
      await current?.q.applyFlagSettings({ effortLevel: value ?? null }       )
    } catch (error) {
      log("setEffort error", error)
    }
  }

  async function setFast(value         ) {
    setStore("fast", value)
    try {
      await current?.q.applyFlagSettings({ fastMode: value }       )
    } catch (error) {
      log("setFast error", error)
    }
  }

  async function setMode(mode                ) {
    setStore("mode", mode)
    // The tab's own mode (Chat, a custom one) holds only with its permission mode: a different one means Build or
    // Plan now, and the earlier mode's pending instruction is dropped.
    const own = store.agentMode ? agentList().find((agent) => agent.id === store.agentMode) : undefined
    if (own && own.mode !== mode) {
      setStore("agentMode", undefined)
      modeNote = instructed && !modeNote ? `[Mode "${mode === "plan" ? "Plan" : "Build"}": the earlier mode's instruction no longer applies; work normally, tools included.]` : undefined
      instructed = false
      rememberAgentMode()
    }
    if (oc) return acpSetMode(mode)
    try {
      await current?.q.setPermissionMode(mode)
    } catch (error) {
      log("setMode error", error)
    }
  }

  function cycleAgent(direction = 1) {
    const list = agentList()
    const index = agentIndex(currentAgent().id)
    // Leaving plan restores the default mode; entering plan switches Claude Code into plan mode.
    setAgent(list[(index + direction + list.length) % list.length].id)
  }

  function currentModel() {
    return store.models.find((model) => model.value === store.model)
  }

  function modelLabel(value = store.model) {
    const external = splitModel(value)
    if (external) return external.model
    const info = store.models.find((model) => model.value === value)
    if (value === store.model && store.modelId && (value === "default" || !info)) return prettyModel(store.modelId)
    if (info?.resolvedModel) return prettyModel(info.resolvedModel)
    if (info) return "Claude " + info.displayName.replace(/\s*\(.*\)$/, "")
    return prettyModel(value)
  }

  async function refreshMcp() {
    try {
      const list = await current?.q.mcpServerStatus()
      // Agent Code's own in-process server is an implementation detail, not a user MCP.
      if (list) setStore("mcp", reconcile(list.filter((server) => server.name !== ACODE_MCP)))
      // Servers connect asynchronously; keep polling while any is still pending.
      clearTimeout(mcpPoll)
      if (!disposed && list?.some((server) => server.status === "pending")) mcpPoll = setTimeout(() => void refreshMcp(), 1500)
    } catch (error) {
      log("mcp error", error)
    }
  }

  async function toggleMcp(name        , enabled         ) {
    try {
      await current?.q.toggleMcpServer(name, enabled)
    } catch (error) {
      log("toggleMcp error", error)
    }
    await refreshMcp()
  }

  async function reconnectMcp(name        ) {
    try {
      await current?.q.reconnectMcpServer(name)
    } catch (error) {
      log("reconnectMcp error", error)
    }
    await refreshMcp()
  }

  async function refreshUsage(force = false) {
    if (!current || usageInflight) return
    if (!force && Date.now() - usageLast < 30_000) return
    usageInflight = true
    usageLast = Date.now()
    try {
      if (await pollPlanUsage()) return
      const usage = await (current.q       ).usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?.({ skipBehaviors: true })
      updateLimitsFromUsage(usage)
    } catch (error) {
      log("usage error", error)
    } finally {
      usageInflight = false
    }
  }

  // -------------------------------------------------------------------------
  // Mods: Agent Code is a remote surface of the engine (as Claude Code Desktop is)
  // -------------------------------------------------------------------------

  const SURFACE = { surface: "desktop", client_id: "acode" }
  const viewport = () => ({ columns: process.stdout.columns || 100, rows: process.stdout.rows || 40, isFullscreen: true })

  async function modRequest(request                         )               {
    const live = current
    if (!live) return undefined
    try {
      return (await (live.q       ).request(request))?.response
    } catch (error) {
      log("mod request error", request.subtype, String(error).slice(0, 300))
      return undefined
    }
  }

  /** Join the engine's roster of surfaces once the mods have loaded, so their UI pushes reach Agent Code. */
  async function attachSurface(gen        ) {
    if (!modPlugins().length) return
    const attached = await modRequest({ subtype: "ui_attach", ...SURFACE, viewport: viewport() })
    if (gen !== generation || !attached) return
    setStore("mods", "attached", true)
    const roster = await modRequest({ subtype: "ui_panes", client_id: SURFACE.client_id })
    if (gen !== generation || !roster) return
    batch(() => {
      setStore("mods", "panes", reconcile(roster.panes ?? []))
      setStore("mods", "shown", roster.shown_id ?? null)
    })
  }

  /** Ask the mods to draw one site: `{ tree, hooked }`, or undefined when nothing could be asked. */
  function modRender(component                        , instanceId        , props                         ) {
    return modRequest({ subtype: "ui_render", ...SURFACE, component, instance_id: instanceId, props, viewport: viewport() })


  }

  function modPress(press          , key         , href         ) {
    return modRequest({ subtype: "ui_press", plugin: press.plugin, handle: press.handle, key, href, ...SURFACE })
  }

  function modInput(press          , kind                     , value        , at                                                         ) {
    return modRequest({ subtype: "ui_input", plugin: press.plugin, handle: press.handle, kind, value, key: at.key, component: at.component, instance_id: at.instanceId, ...SURFACE })
  }

  function modSelect(press          , value        , at                                                         ) {
    return modRequest({ subtype: "ui_select", plugin: press.plugin, handle: press.handle, value, key: at.key, component: at.component, instance_id: at.instanceId, ...SURFACE })
  }

  function modPaneShow(id        ) {
    return modRequest({ subtype: "ui_pane_show", id, ...SURFACE })
  }

  /** The person's close; a mod may keep the pane open (then the roster stays as it is). */
  function modPaneClose(id        ) {
    return modRequest({ subtype: "ui_close", id, client_id: SURFACE.client_id })
  }

  // -------------------------------------------------------------------------
  // Session navigation
  // -------------------------------------------------------------------------

  function resetTranscript() {
    streamParts.clear()
    syncedParts.clear()
    applyDefaultMode()
    batch(() => {
      setStore("messages", [])
      setStore("children", {})
      setStore("sessionID", undefined)
      setStore("title", undefined)
      setStore("cost", 0)
      setStore("lastResultCost", 0)
      resetSpend()
      setStore("context", undefined)
      setStore("todos", [])
      setStore("files", {})
      setStore("tasks", {})
      setStore("suggestion", undefined)
      setStore("status", "idle")
      setStore("child", undefined)
      setStore("goal", undefined)
      setStore("revert", undefined)
      setStore("engine", undefined)
    })
    snapshot = new Map()
  }

  /** Load a stored session's transcript; `boot` also starts its Claude Code process. */
  async function load(id        , title         , boot = true) {
    // Other harnesses' conversations replay from the harness itself, so they always boot.
    const engine = harnessSession(id)
    if (engine) {
      resetTranscript()
      const used = config.sessionModels?.[id]
      modeNote = undefined
      instructed = !!config.sessionAgentMode?.[id]
      batch(() => {
        setStore("agentMode", config.sessionAgentMode?.[id])
        setStore("sessionID", id)
        setStore("title", title)
        setStore("view", "session")
        setStore("engine", engine)
        if (used) setStore("model", used)
        // No model on record: one of this harness's own (opencode's free default for opencode).
        if (harnessModel(store.model)?.harness.id !== engine) {
          const first = harnessInfo(engine)?.models?.[0]?.id
          setStore("model", engine !== "opencode" && first ? `${engine}/${first}` : "opencode-zen/big-pickle")
        }
        setStore("effort", sessionEffort(id, store.model))
      })
      restorePause()
      // A tab restored in the background starts its harness (and replays its history) when it is opened.
      if (!boot) {
        setStore("dormant", true)
        return !disposed
      }
      await start({ resume: id })
      return !disposed && store.messages.length > 0
    }
    resetTranscript()
    batch(() => {
      setStore("sessionID", id)
      setStore("title", title)
      setStore("view", "session")
      // An existing conversation keeps its own mode (none saved: Build).
      setStore("agentMode", config.sessionAgentMode?.[id])
    })
    modeNote = undefined
    instructed = !!config.sessionAgentMode?.[id]
    restorePause()
    // What the session cost before this window opened it (its subagents too): counted from its transcripts as they
    // are now; whatever it spends from here on is counted live.
    const snapshot = spendSnapshot(store.cwd, id)
    void sessionSpend(store.cwd, id, snapshot)
      .then((spent) => {
        if (disposed || store.sessionID !== id) return
        batch(() => {
          setStore("historyCost", spent.main + spent.sub)
          setStore("historySubCost", spent.sub)
        })
      })
      .catch((error) => log("session spend", error))
    try {
      const history = await getSessionMessages(id, { dir: store.cwd })
      if (disposed) return false
      setStore("messages", convertHistory(history))
      const used = savedModel(id, history         )
      if (used) setStore("model", used)
      setStore("effort", sessionEffort(id, store.model, history))
      // The model is the session's own from now on, too (an older one only had it in its transcript).
      if (used) rememberSessionModel(id, used)
      recomputeDerived()
      loadRevert()
    } catch (error) {
      log("history error", error)
      if (!boot) return false
    }
    await prependChain(id)
    restoreUnsent(id)
    restoreDraft(id)
    if (!title && !store.title) {
      const first = store.messages.find((m)                   => m.type === "user")
      if (first) setStore("title", first.text.split("\n")[0].slice(0, 80))
    }
    if (boot) await start({ resume: id })
    else setStore("dormant", true)
    restoreAutoResume(api, id)
    return true
  }

  // -------------------------------------------------------------------------
  // Revert: opencode's way of deleting messages (/undo, /redo, message actions)
  // -------------------------------------------------------------------------

  /** Contents files had before a Claude Code revert changed them (null = didn't exist); /redo writes them back. */
  let snapshot = new Map                       ()

  function revertFile() {
    return store.sessionID ? path.join(stateDir, "reverts", `${store.sessionID}.json`) : undefined
  }

  function saveRevert() {
    const file = revertFile()
    if (!file) return
    try {
      if (!store.revert) {
        rmSync(file, { force: true })
        return
      }
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ revert: store.revert, snapshot: Object.fromEntries(snapshot) }))
    } catch (error) {
      log("revert save error", error)
    }
  }

  /** A Claude Code tab reverted before Agent Code quit comes back reverted. */
  function loadRevert() {
    const file = revertFile()
    if (!file || !existsSync(file)) return
    try {
      const saved = JSON.parse(readFileSync(file, "utf8"))
      if (!store.messages.some((m) => m.id === saved.revert?.messageID)) return
      snapshot = new Map(Object.entries(saved.snapshot ?? {}))
      setStore("revert", saved.revert)
    } catch (error) {
      log("revert load error", error)
    }
  }

  function readOrNull(file        ) {
    try {
      return existsSync(file) ? readFileSync(file, "utf8") : null
    } catch {
      return null
    }
  }

  function restoreSnapshot() {
    for (const [file, content] of snapshot) {
      try {
        if (content === null) rmSync(file, { force: true })
        else {
          mkdirSync(path.dirname(file), { recursive: true })
          writeFileSync(file, content)
        }
      } catch (error) {
        log("restore error", file, error)
      }
    }
    snapshot = new Map()
  }

  function countChanges(before        , after        ) {
    let additions = 0
    let deletions = 0
    for (const change of diffLines(before, after)) {
      if (change.added) additions += change.count ?? 0
      else if (change.removed) deletions += change.count ?? 0
    }
    return { additions, deletions }
  }

  const fileDiff = (item     )             => ({
    file: relative(String(item?.file ?? item?.path ?? "")),
    additions: Number(item?.additions ?? 0),
    deletions: Number(item?.deletions ?? 0),
  })

  /** Revert to just before the prompt `messageID`: hide it and everything after, undo their file changes. */
  async function revert(messageID        ) {
    if (!store.messages.some((m) => m.type === "user" && m.id === messageID)) return false
    if (store.status === "running") await interrupt()
    if (store.dormant) await ensureStarted()
    if (store.engine && store.engine !== "opencode") {
      emit("toast", { message: `${harnessById(store.engine)?.name ?? store.engine} can't revert messages; fork or start a new session instead.`, variant: "warning" })
      return false
    }
    if (store.engine === "opencode") {
      if (!oc) return false
      const target = await opencodeMessageId(messageID)
      if (!target) return false
      try {
        const result = await opencodeApi(store.cwd, "POST", `/api/session/${oc.id}/revert/stage`, { messageID: target })
        setStore("revert", { messageID: target, files: (result?.files ?? []).map(fileDiff) })
        return true
      } catch (error) {
        log("opencode revert error", error)
        emit("toast", { message: `Revert failed: ${errorMessage(error)}`, variant: "error" })
        return false
      }
    }
    if (!current) return false
    // Claude Code can only continue from messages after the latest compaction (older ones were summarized).
    const at = store.messages.findIndex((m) => m.type === "user" && m.id === messageID)
    if (store.messages.slice(at).some((m) => m.type === "notice" && m.variant === "compaction")) {
      emit("toast", { message: "Can't undo past a compaction: the conversation before it was summarized.", variant: "warning" })
      return false
    }
    // Moving the revert point: start again from the files as they were before any revert.
    restoreSnapshot()
    try {
      const dry = await current.q.rewindFiles(messageID, { dryRun: true })
      const files = (dry.filesChanged ?? []).map((file) => path.resolve(store.cwd, file))
      const before = new Map(files.map((file) => [file, readOrNull(file)]         ))
      if (dry.canRewind && files.length) await current.q.rewindFiles(messageID)
      snapshot = before
    } catch (error) {
      log("rewind error", error)
    }
    const files = [...snapshot].map(([file, before]) => ({ file: relative(file), ...countChanges(before ?? "", readOrNull(file) ?? "") }))
    setStore("revert", { messageID, files: files.filter((file) => file.additions || file.deletions) })
    saveRevert()
    return true
  }

  /** Bring back everything the revert hid, files included. */
  async function unrevert() {
    if (!store.revert) return
    if (store.engine === "opencode") {
      if (oc) await opencodeApi(store.cwd, "DELETE", `/api/session/${oc.id}/revert`).catch((error) => log("opencode unrevert error", error))
    } else restoreSnapshot()
    setStore("revert", undefined)
    saveRevert()
  }

  /** opencode's /redo: move the revert point to the next prompt; past the last one, undo the revert. */
  async function redo() {
    const point = store.revert?.messageID
    if (!point) return undefined
    const index = store.messages.findIndex((m) => m.id === point)
    const next = store.messages.slice(index + 1).find((m) => m.type === "user")
    if (next) await revert(next.id)
    else await unrevert()
    return { restored: !next }
  }

  /** /undo: revert the last prompt before the current revert point; returns its text for the prompt box. */
  async function undo() {
    const point = store.revert ? store.messages.findIndex((m) => m.id === store.revert .messageID) : store.messages.length
    const user = store.messages.slice(0, point < 0 ? store.messages.length : point).findLast((m)                   => m.type === "user")
    if (!user) return undefined
    if (!(await revert(user.id))) return undefined
    return { text: user.text }
  }

  /** Delete the reverted messages for good (opencode does this when the next prompt is sent). */
  async function commitRevert() {
    const point = store.revert?.messageID
    if (!point) return
    const index = store.messages.findIndex((m) => m.id === point)
    if (store.engine === "opencode" && oc)
      await opencodeApi(store.cwd, "POST", `/api/session/${oc.id}/revert/commit`).catch((error) => log("opencode commit error", error))
    const kept = index < 0 ? [...store.messages] : store.messages.slice(0, index)
    snapshot = new Map()
    batch(() => {
      setStore("revert", undefined)
      setStore("messages", kept)
    })
    saveRevert()
    recomputeDerived()
    if (store.engine === "opencode" || index < 0) return
    // Claude Code continues from the last reply before the deleted prompt (a fresh conversation if there is none).
    const before = kept.findLast((m)                        => m.type === "assistant" && !!m.sdkUuid)
    if (before && store.sessionID) await start({ resume: store.sessionID, resumeAt: before.sdkUuid })
    else {
      resetTranscript()
      await start({ sessionId: randomUUID() })
    }
  }

  function rename(title        ) {
    setStore("title", title)
  }

  // -------------------------------------------------------------------------
  // Permissions & questions
  // -------------------------------------------------------------------------

  function requestPermission(
    toolName        ,
    input                         ,
    opts                                                                                            ,
  )                            {
    const access = accessFor(store.engine)
    if (!access.web && (/^(web_?fetch|web_?search|fetch|websearch)$/i.test(String(toolName)) || /^mcp__.+__(fetch|web_?search|browse|scrape|crawl)/i.test(String(toolName)))) {
      return Promise.resolve({ behavior: "deny", message: "The user has turned web access off for this harness.", toolUseID: opts.toolUseID })
    }
    if (toolName === "AskUserQuestion" && !access.askQuestions) {
      return Promise.resolve({
        behavior: "deny",
        message: "The user has turned off clarifying questions. Make a reasonable assumption and continue.",
        toolUseID: opts.toolUseID,
      })
    }
    if (store.mode !== "plan" && [...autoAllows.values()].some((check) => check(toolName, input))) {
      return Promise.resolve({ behavior: "allow", updatedInput: input, toolUseID: opts.toolUseID })
    }
    // "Allow everything" setting: approve every tool except the ones that need the user (questions, leaving plan mode).
    if (access.autoAllow && toolName !== "AskUserQuestion" && toolName !== "ExitPlanMode" && store.mode !== "plan") {
      return Promise.resolve({ behavior: "allow", updatedInput: input, toolUseID: opts.toolUseID })
    }
    return new Promise((resolve) => {
      const id = opts.toolUseID
      pending.set(id, resolve)
      opts.signal.addEventListener("abort", () => {
        if (!pending.has(id)) return
        pending.delete(id)
        setStore("permissions", (list) => list.filter((item) => item.id !== id))
        setStore("questions", (list) => list.filter((item) => item.id !== id))
        resolve({ behavior: "deny", message: "Aborted", toolUseID: id })
      })
      if (toolName === "AskUserQuestion") {
        setStore("questions", (list) => [
          ...list,
          { id, questions: (input.questions                                ) ?? [], input: input                        },
        ])
        emit("attention", { kind: "question" })
        return
      }
      setStore("permissions", (list) => [
        ...list,
        {
          id,
          tool: toolName,
          input: input                       ,
          title: opts.title,
          displayName: opts.displayName,
          description: opts.description,
          decisionReason: opts.decisionReason,
          blockedPath: opts.blockedPath,
          suggestions: opts.suggestions,
          defaultToNo: opts.defaultToNo,
          suppressAlways: opts.suppressAlwaysAllowRule,
          agentID: opts.agentID,
        },
      ])
      emit("attention", { kind: "permission" })
    })
  }

  /** Rules to remember when the user picks "Always allow" and Claude Code didn't suggest any. */
  function alwaysRules(request                   )                     {
    if (request.suggestions?.length) return request.suggestions
    const input = request.input
    let ruleContent
    if (request.tool === "Bash" && typeof input.command === "string") {
      const words = input.command.trim().split(/\s+/)
      ruleContent = words.length > 1 ? `${words[0]} ${words[1]}:*` : `${words[0]}:*`
    } else if (request.tool === "WebFetch" && typeof input.url === "string") {
      try {
        ruleContent = `domain:${new URL(input.url).hostname}`
      } catch {}
    }
    return [
      {
        type: "addRules",
        rules: [{ toolName: request.tool, ruleContent }],
        behavior: "allow",
        destination: "session",
      },
    ]
  }

  function replyPermission(
    id        ,
    decision                              ,
    options                                              = {},
  ) {
    const request = store.permissions.find((item) => item.id === id)
    const resolve = pending.get(id)
    pending.delete(id)
    setStore("permissions", (list) => list.filter((item) => item.id !== id))
    if (!resolve || !request) return
    emit("permission.replied", { id, decision })
    if (decision === "reject") {
      resolve({
        behavior: "deny",
        message: options.message ? `The user rejected this tool use and said: ${options.message}` : REJECT_MESSAGE,
        interrupt: !options.message,
        toolUseID: id,
      })
      return
    }
    const updates                     = []
    if (decision === "always") updates.push(...alwaysRules(request))
    if (options.mode) updates.push({ type: "setMode", mode: options.mode, destination: "session" })
    resolve({
      behavior: "allow",
      updatedInput: request.input,
      updatedPermissions: updates.length ? updates : undefined,
      toolUseID: id,
    })
    if (options.mode) setStore("mode", options.mode)
  }

  // MCP elicitation (a server asks for input mid tool call): queued for ElicitationPrompt, answered there.
  const elicitPending = new Map                                             ()
  function requestElicitation(request                    , signal             )                             {
    return new Promise((resolve) => {
      const id = randomUUID()
      elicitPending.set(id, resolve)
      setStore("elicitations", (list) => [...list, { id, request }])
      emit("elicitation", { id })
      signal.addEventListener("abort", () => replyElicitation(id, { action: "cancel" }), { once: true })
    })
  }
  function replyElicitation(id        , result                   ) {
    const resolve = elicitPending.get(id)
    elicitPending.delete(id)
    setStore("elicitations", (list) => list.filter((item) => item.id !== id))
    resolve?.(result)
  }
  function cancelElicitations() {
    for (const id of [...elicitPending.keys()]) replyElicitation(id, { action: "cancel" })
  }

  function replyQuestion(id        , answers                                    ) {
    const request = store.questions.find((item) => item.id === id)
    const resolve = pending.get(id)
    pending.delete(id)
    setStore("questions", (list) => list.filter((item) => item.id !== id))
    if (!resolve || !request) return
    emit("question.replied", { id })
    if (!answers) {
      resolve({ behavior: "deny", message: "The user dismissed the questions without answering.", toolUseID: id })
      return
    }
    resolve({ behavior: "allow", updatedInput: { ...request.input, answers }, toolUseID: id })
  }

  // -------------------------------------------------------------------------
  // Message handling
  // -------------------------------------------------------------------------

  function lastTurn()                               {
    const last = store.messages.findLast((m) => m.type === "assistant" || m.type === "user")
    return last?.type === "assistant" ? last : undefined
  }

  function ensureTurn()                   {
    const existing = lastTurn()
    if (existing && !existing.end) return existing
    // The level this conversation runs on stays its own from here on.
    rememberSessionEffort(store.sessionID, store.effort)
    const last = store.messages.findLast((m) => m.type === "user" || m.type === "assistant")
    const user = last?.type === "user" ? last : undefined
    const turn                   = {
      type: "assistant",
      id: randomUUID(),
      parts: [],
      agent: currentAgent().id,
      model: store.modelId ?? store.model,
      effort: store.effort,
      // Measure from the prompt being sent (or dequeued), like opencode's turn duration.
      start: user?.time && !user.queued ? Math.min(user.time, Date.now()) : Date.now(),
    }
    batch(() => {
      // Queued prompts are delivered once a new turn starts.
      setStore("messages", (m) => m.type === "user" && !!m.queued, produce((m     ) => {
        m.queued = false
        m.time = Date.now()
      }))
      setStore("messages", (list) => [...list, turn])
    })
    return turn
  }

  function updateTurn(fn                                  ) {
    const turn = ensureTurn()
    setStore("messages", (m) => m.id === turn.id, produce(fn       ))
  }

  function findTool(id        )                                              {
    for (let i = store.messages.length - 1; i >= 0; i--) {
      const message = store.messages[i]
      if (message.type !== "assistant") continue
      const index = message.parts.findIndex((part) => part.type === "tool" && part.id === id)
      if (index >= 0) return { turn: message.id, index }
    }
    return undefined
  }

  function findToolPart(id        )                       {
    const found = findTool(id)
    if (!found) return undefined
    const turn = store.messages.find((m) => m.id === found.turn)
    return turn?.parts[found.index]
  }

  function updateTool(id        , fn                          ) {
    const found = findTool(id)
    if (!found) return false
    setStore(
      "messages",
      (m) => m.id === found.turn,
      produce((m     ) => fn(m.parts[found.index])),
    )
    return true
  }

  /** Open a subagent in this tab's subagent view; one whose conversation isn't in memory comes from its saved log. */
  function openSubagent(id) {
    if (id && !store.children[id]?.length && store.sessionID) {
      const log = subagentLogs(store.cwd, store.sessionID).find((item) => item.toolUseId === id)
      if (log) return showSubagentLog(log)
    }
    batch(() => {
      setStore("child", id)
      if (id) setStore("view", "session")
    })
  }

  /** Show a subagent's saved log in this tab's subagent view (it replaces a live view only once that has ended). */
  function showSubagentLog(log) {
    const key = log.toolUseId ?? `agent:${log.agentId}`
    const live = Object.values(store.tasks ?? {}).some((task) => task.toolUseId === key)
    if (!live || !store.children[key]?.length) {
      const entries = []
      try {
        for (const line of readFileSync(log.file, "utf8").split("\n")) {
          if (!line.trim()) continue
          try {
            const entry = JSON.parse(line)
            if (entry.type === "user" || entry.type === "assistant") entries.push(entry)
          } catch {}
        }
      } catch (error) {
        pushNotice(`Could not read the subagent log: ${errorMessage(error)}`, "warning")
        return
      }
      setStore("children", key, convertHistory(entries))
    }
    // A stand-in for the subagent's tool row when the conversation no longer has it (compacted, or older).
    if (!findToolPart(key))
      setStore("logParts", key, {
        type: "tool",
        id: key,
        name: "Agent",
        input: { description: log.description, subagent_type: log.type },
        status: log.finished ? "completed" : "running",
        children: log.tools,
        start: log.start,
        end: log.end,
      })
    batch(() => {
      setStore("child", key)
      setStore("view", "session")
    })
  }

  function finishTurn(info                     = {}) {
    if (oc) setTimeout(saveAcpHistory, 0)
    thinkingEnds()
    subThinking.clear()
    setStore("subThinkingOpen", [])
    saveThinking()
    const turn = lastTurn()
    batch(() => {
      if (turn && !turn.end) {
        setStore(
          "messages",
          (m) => m.id === turn.id,
          produce((m     ) => {
            m.end = Date.now()
            if (info.error) m.error = info.error
            m.retry = undefined
            for (const part of m.parts) {
              if (part.type === "reasoning" && !part.end) part.end = Date.now()
              if (part.type === "text") part.done = true
              if (part.type === "tool" && (part.status === "pending" || part.status === "running") && !part.background) {
                part.status = "error"
                part.error = m.interrupted ? "Interrupted" : "Tool execution was not completed"
              }
            }
          }),
        )
      } else if (info.error) {
        setStore("messages", (list) => [
          ...list,
          { type: "notice", id: randomUUID(), text: info.error , variant: "error" }                        ,
        ])
      }
      const queued = store.messages.some((m) => m.type === "user" && m.queued)
      setStore("status", queued ? "running" : "idle")
    })
    if (store.status === "idle") {
      emit("idle", { error: info.error })
      emit("status", { status: "idle" })
      if (restartAfterTurn) {
        restartAfterTurn = false
        void restart()
        return
      }
    }
    void refreshContext()
    void refreshUsage()
  }

  async function refreshContext() {
    try {
      const usage = await current?.q.getContextUsage()
      if (!usage || !usage.totalTokens) return
      setStore("context", { tokens: usage.totalTokens, percent: Math.round(usage.percentage), max: usage.maxTokens })
    } catch (error) {
      log("context error", error)
    }
    maybeCompact()
  }

  /** "Small sessions": compact before the context grows into the expensive range. */
  let compactRequested = false
  function maybeCompact() {
    if (config.smallSessions === false) return
    const limit = config.compactAt ?? COMPACT_AT
    const tokens = store.context?.tokens ?? 0
    if (tokens < limit) {
      compactRequested = false
      return
    }
    if (compactRequested || store.status !== "idle" || store.compacting || !current) return
    compactRequested = true
    pushNotice(`Context passed ${Math.round(limit / 1000)}K tokens · compacting (small sessions)`, "info")
    send("/compact")
  }

  function handle(message            ) {
    switch (message.type) {
      // Claude Code's /goal: the condition it keeps working toward (null once met or cleared).
      case "active_goal":
        setStore("goal", message.value ?? undefined)
        return
      case "system":
        return handleSystem(message       )
      case "stream_event":
        if (message.parent_tool_use_id) return childStream(message.parent_tool_use_id, message.event)
        return handleStream(message.event       )
      case "assistant":
        lastWork = Date.now()
        return handleAssistant(message)
      case "user":
        return handleUser(message       )
      case "result":
        return handleResult(message)
      case "tool_progress":
        updateTool(message.tool_use_id, (part) => {
          part.elapsed = message.elapsed_time_seconds
          if (part.status === "pending") part.status = "running"
        })
        return
      case "prompt_suggestion":
        setStore("suggestion", message.suggestion)
        return
      case "rate_limit_event"       : {
        lastWork = Date.now()
        const info = (message       ).rate_limit_info
        if (!info) return
        const resetsAt = info.resetsAt ? info.resetsAt * (info.resetsAt < 1e12 ? 1000 : 1) : undefined
        if (info.status === "rejected" && !info.isUsingOverage) {
          limitResetsAt = resetsAt
          // The Fable limit (a share of the weekly one) is its own window: the other meters are untouched.
          if (isFableLimit(info.rateLimitType)) {
            fableRefused = true
            return markFableHit(resetsAt)
          }
          return markLimitHit(info.rateLimitType, resetsAt)
        }
        const key = windowKey(info.rateLimitType)
        if (key && typeof info.utilization === "number") {
          // Claude Code's live reading (from the response headers) is newer than the last poll: never show less.
          const value = percent(info.utilization)
          const current = limits[key                       ]
          // A different reset date is a new window (after a reset): take it even though it reads lower.
          const moved = !!resetsAt && !!current?.resetsAt && Math.abs(resetsAt - current.resetsAt) > 60_000
          if (!current || current.hit || moved || value >= current.utilization || !planExact)
          {
            setLimits(key                       , keepHit(current, { utilization: value, resetsAt: resetsAt ?? current?.resetsAt }))
            shareLimits()
          }
          setLimits("available", true)
        }
        if (planExact) void pollPlanUsage()
        return
      }
      default:
        return
    }
  }

  function handleSystem(message     ) {
    if (message.session_id && message.session_id !== store.sessionID) {
      setStore("sessionID", message.session_id)
      rememberSessionModel(message.session_id, store.model)
    }
    switch (message.subtype) {
      case "init":
        batch(() => {
          setStore("modelId", message.model)
          setStore("mode", message.permissionMode)
          setStore("version", message.claude_code_version)
          if (message.output_style) setStore("outputStyle", message.output_style)
          // Provider models' variants are Agent Code's own (applied by its proxy), not Claude Code's effort.
          // A session with its own level keeps it (Claude Code would report its global setting for "default").
          const ownLevel = store.sessionID ? config.sessionEffort?.[store.sessionID] : undefined
          if (message.effort !== undefined && message.effort !== null && !splitModel(store.model) && ownLevel === undefined) setStore("effort", message.effort)
          if (message.fast_mode_state) setStore("fast", message.fast_mode_state === "on" || message.fast_mode_state === "enabled")
          setStore("skills", reconcile(message.skills ?? []))
          setStore("plugins", reconcile(message.plugins ?? []))
          // Plugins that did not load (Claude Code 2.1.323 reports them to hosts): say so once per start.
          const pluginErrors = JSON.stringify(message.plugin_errors ?? [])
          if (message.plugin_errors?.length && current && current.pluginErrors !== pluginErrors && (current.pluginErrors = pluginErrors))
            pushNotice(`Plugins that did not load: ${message.plugin_errors.map((item) => `${item.plugin} (${item.message || item.type})`).join("; ")}`, "warning")
          setStore(
            "mcp",
            reconcile(
              (message.mcp_servers ?? []).map((server     ) => ({ name: server.name, status: server.status, scope: server.source })),
            ),
          )
        })
        void refreshMcp()
        return
      case "status":
        batch(() => {
          setStore("compacting", message.status === "compacting")
          if (message.permissionMode) setStore("mode", message.permissionMode)
        })
        if (message.compact_result === "failed")
          pushNotice(`Compaction failed${message.compact_error ? `: ${message.compact_error}` : ""}`, "error")
        return
      case "session_writes_lost":
        // Claude Code could not save (the disk or its quota is full): say so, the chat on screen is all there is.
        pushNotice(
          `Claude Code could not save ${(message.lost ?? []).map((item) => (item === "transcript" ? "this conversation" : "its settings")).join(" and ") || "to disk"}: the disk ${message.error_code === "EDQUOT" ? "quota" : ""} is full. Free some space; what is on screen is not lost until you close the tab.`,
          "error",
        )
        return
      case "compact_boundary": {
        const meta = message.compact_metadata ?? {}
        pushNotice(
          `Session compacted${meta.trigger === "auto" ? " automatically" : ""} · ${Number(meta.pre_tokens ?? 0).toLocaleString()} tokens summarized`,
          "compaction",
        )
        setStore("compacting", false)
        // A compaction records the system prompt again, from this process's instructions.
        rememberPromptParts(store.sessionID, startedParts)
        emit("compacted")
        return
      }
      case "local_command_output":
        pushNotice(stripAnsi(message.content ?? ""), "command", true)
        return
      case "informational":
        pushNotice(message.content ?? "", message.level === "warning" ? "warning" : "info")
        return
      case "api_retry":
        updateTurn((turn) => {
          turn.retry = {
            attempt: message.attempt,
            max: message.max_retries,
            delay: message.retry_delay_ms,
            error: String(message.error ?? message.error_status ?? "error"),
          }
        })
        return
      case "task_started":
        setStore("tasks", message.task_id, {
          description: message.description,
          type: message.subagent_type ?? message.task_type,
          background: message.is_backgrounded,
          toolUseId: message.tool_use_id,
          start: Date.now(),
        })
        if (message.tool_use_id && message.is_backgrounded)
          updateTool(message.tool_use_id, (part) => {
            part.background = true
          })
        return
      case "task_progress":
        if (message.tool_use_id && message.summary)
          updateTool(message.tool_use_id, (part) => {
            part.childTitle = message.summary
          })
        return
      case "task_notification":
        setStore(
          "tasks",
          produce((tasks     ) => {
            delete tasks[message.task_id]
          }),
        )
        if (message.tool_use_id)
          updateTool(message.tool_use_id, (part) => {
            if (part.background) {
              part.status = message.status === "completed" ? "completed" : "error"
              part.background = false
            }
          })
        if (message.status && message.status !== "completed" && message.status !== "stopped") pushNotice(shortFailure(message.summary ?? "A background task failed"), "warning")
        return
      case "notification":
        emit("toast", { message: message.text, variant: message.priority === "high" ? "warning" : "info" })
        return
      case "permission_denied":
        updateTool(message.tool_use_id, (part) => {
          part.denied = true
        })
        return
      case "ui_toast":
        if (modsShows("toasts")) emit("toast", { message: `${message.plugin}: ${message.text}`, variant: "info", duration: message.timeout_ms })
        return
      case "ui_status":
        setStore("mods", "status", produce((status                        ) => {
          if (message.text === null || message.text === undefined || message.text === "") delete status[message.plugin]
          else status[message.plugin] = String(message.text)
        }))
        return
      case "ui_log":
        if (modsShows("logs")) pushNotice(`${message.plugin}: ${message.text}`, "info")
        return
      case "ui_panes":
        batch(() => {
          setStore("mods", "panes", reconcile(message.panes ?? []))
          setStore("mods", "shown", message.shown_id ?? null)
        })
        return
      case "ui_invalidate":
        setStore("mods", "version", (value) => value + 1)
        return
      case "commands_changed":
        current?.q
          .supportedCommands()
          .then((commands) => setStore("commands", reconcile(commands)))
          .catch(() => {})
        return
      default:
        return
    }
  }

  function pushNotice(text        , variant                          , markdown = false) {
    if (!text.trim()) return
    // A limit refusal said again (a background subagent reporting in) since the user last wrote: once is enough.
    if (isLimitError(text) && limitShownSince(store.messages)) return
    setStore("messages", (list) => [...list, { type: "notice", id: randomUUID(), text, variant, markdown }])
  }

  // Live context while a reply streams: the request's input tokens (message_start) plus an estimate of the
  // output so far (~4 characters a token). The exact numbers replace it when the step ends.
  let liveBase = 0
  let liveOutput = 0
  let liveShown = 0

  // Live spend, counted like the tokens: every API reply of this session so far (the main agent's as it streams,
  // each subagent's, background ones read from their transcripts) priced per model from the catalog. Claude Code's
  // own total (the result's total_cost_usd, subagents included) replaces the estimate at the end of every turn.
  const spend = new Map()
  const counted = new Set()
  let spendShown = 0
  let spendTimer
  function resetSpend() {
    spend.clear()
    counted.clear()
    setStore("liveCost", 0)
    setStore("livePlanCost", 0)
    setStore("liveSubCost", 0)
    setStore("subCost", 0)
    setStore("historyCost", 0)
    setStore("historySubCost", 0)
  }
  function priceOf(model, sub) {
    if (sub) {
      const value = String(model ?? "").split("#")[0]
      return modelMeta(value || store.model).price
    }
    return modelMeta(store.model, model && model !== "<synthetic>" ? model : undefined).price
  }
  function noteSpend(id, model, usage, sub = false) {
    if (!id || !usage || counted.has(id)) return
    const before = spend.get(id)
    const merged = { ...(before?.usage ?? {}) }
    for (const [key, value] of Object.entries(usage)) if (typeof value === "number") merged[key] = value
    const price = priceOf(model ?? before?.model, sub)
    const cost = price
      ? ((merged.input_tokens ?? 0) * price.input +
          (merged.output_tokens ?? 0) * price.output +
          (merged.cache_read_input_tokens ?? 0) * (price.cacheRead ?? price.input * 0.1) +
          (merged.cache_creation_input_tokens ?? 0) * (price.cacheWrite ?? price.input * 1.25)) /
        1e6
      : 0
    // Claude models count toward the plan; provider models (a provider tab, routed subagents) don't.
    const plan = !splitModel(sub ? String(model ?? before?.model ?? "").split("#")[0] : store.model)
    spend.set(id, { usage: merged, model: model ?? before?.model, cost, sub, plan })
    showSpend()
  }
  function showSpend(force = false) {
    // At most a few updates a second.
    if (!force && Date.now() - spendShown < 300) {
      clearTimeout(spendTimer)
      spendTimer = setTimeout(() => showSpend(true), 320)
      return
    }
    spendShown = Date.now()
    let all = 0
    let sub = 0
    let plan = 0
    for (const item of spend.values()) {
      all += item.cost
      if (item.sub) sub += item.cost
      if (item.plan) plan += item.cost
    }
    batch(() => {
      setStore("liveCost", all)
      setStore("liveSubCost", sub)
      setStore("livePlanCost", plan)
    })
  }
  /** A turn's result arrived: its total includes everything seen so far, so the estimates are settled. */
  function settleSpend() {
    let sub = 0
    let plan = 0
    for (const [id, item] of spend) {
      if (item.sub) sub += item.cost
      if (item.plan) plan += item.cost
      counted.add(id)
    }
    spend.clear()
    batch(() => {
      settlePlanSpend(self, plan)
      setStore("subCost", (value) => value + sub)
      setStore("liveCost", 0)
      setStore("liveSubCost", 0)
      setStore("livePlanCost", 0)
    })
  }
  // Subagents' replies as they stream (foreground ones; background ones come from their transcripts below).
  const childStreams = new Map()
  function childStream(parent, event) {
    if (event?.type === "message_start") {
      const id = event.message?.id
      if (!id) return
      childStreams.set(parent, { id, model: event.message.model, chars: 0 })
      noteSpend(id, event.message.model, event.message.usage, true)
      return
    }
    const now = childStreams.get(parent)
    if (!now) return
    if (event.type === "content_block_start" && /thinking/.test(event.content_block?.type ?? "")) {
      subThinking.set(`${parent}:${event.index}`, Date.now())
      showSubThinking()
      return
    }
    if (event.type === "content_block_stop" && subThinking.has(`${parent}:${event.index}`)) {
      const start = subThinking.get(`${parent}:${event.index}`)
      subThinking.delete(`${parent}:${event.index}`)
      setStore("subThinkingMs", (value) => value + (Date.now() - start))
      showSubThinking()
      return
    }
    if (event.type === "content_block_delta") {
      const delta = event.delta ?? {}
      now.chars += (delta.text?.length ?? 0) + (delta.thinking?.length ?? 0) + (delta.partial_json?.length ?? 0)
      noteSpend(now.id, now.model, { output_tokens: Math.round(now.chars / 4) }, true)
    } else if (event.type === "message_delta" && event.usage) noteSpend(now.id, now.model, event.usage, true)
    else if (event.type === "message_stop") {
      childStreams.delete(parent)
      // A block left open (an interrupted subagent) ends with its message.
      for (const [key, start] of subThinking)
        if (key.startsWith(`${parent}:`)) {
          subThinking.delete(key)
          setStore("subThinkingMs", (value) => value + (Date.now() - start))
        }
      showSubThinking()
    }
  }

  // Thinking time, live (sidebar → Context): the main agent's blocks and, apart, the subagents' (those that stream;
  // background subagents don't). Kept per session in the config, so it survives restarts.
  const subThinking = new Map()
  function showSubThinking() {
    setStore("subThinkingOpen", [...subThinking.values()])
  }
  function thinkingStarts() {
    if (store.thinkingSince === undefined) setStore("thinkingSince", Date.now())
  }
  function thinkingEnds() {
    const since = store.thinkingSince
    if (since === undefined) return
    batch(() => {
      setStore("thinkingMs", (value) => value + (Date.now() - since))
      setStore("thinkingSince", undefined)
    })
  }
  let thinkingSaved = ""
  function saveThinking() {
    const id = store.sessionID
    if (!id || (!store.thinkingMs && !store.subThinkingMs)) return
    const value = { main: Math.round(store.thinkingMs), sub: Math.round(store.subThinkingMs) }
    const text = JSON.stringify(value)
    if (text === thinkingSaved) return
    thinkingSaved = text
    const all = { ...(config.sessionThinking ?? {}), [id]: value }
    const keys = Object.keys(all)
    for (const old of keys.slice(0, Math.max(0, keys.length - 300))) delete all[old]
    config.sessionThinking = all
    saveConfig()
  }
  function loadThinking() {
    const saved = store.sessionID ? config.sessionThinking?.[store.sessionID] : undefined
    thinkingSaved = saved ? JSON.stringify(saved) : ""
    batch(() => {
      setStore("thinkingMs", saved?.main ?? 0)
      setStore("subThinkingMs", saved?.sub ?? 0)
      setStore("thinkingSince", undefined)
    })
  }
  // Subagents' own transcripts (<project>/<session>/subagents/*.jsonl): read as they grow, while anything runs.
  const subagentRead = new Map()
  const subagentLastAt = new Map()
  function readSubagentSpend() {
    if (!store.sessionID || splitModel(store.model)) return
    const dir = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"), "projects", store.cwd.replace(/[^a-zA-Z0-9]/g, "-"), store.sessionID, "subagents")
    let files
    try {
      files = readdirSync(dir).filter((name) => name.endsWith(".jsonl"))
    } catch {
      return
    }
    for (const name of files) {
      const file = path.join(dir, name)
      try {
        const size = statSync(file).size
        const from = subagentRead.get(file) ?? 0
        if (size <= from) continue
        const fd = openSync(file, "r")
        const buffer = Buffer.alloc(size - from)
        readSync(fd, buffer, 0, buffer.length, from)
        closeSync(fd)
        const text = buffer.toString("utf8")
        const end = text.lastIndexOf("\n") + 1
        subagentRead.set(file, from + Buffer.byteLength(text.slice(0, end)))
        for (const line of text.slice(0, end).split("\n")) {
          if (!line.trim()) continue
          try {
            const entry = JSON.parse(line)
            const message = entry.message
            if (entry.type === "assistant" && message?.id && message.usage) noteSpend(message.id, message.model, message.usage, true)
            // Subagents' thinking time: Claude Code writes each block when it is complete, so a thinking block took
            // about the time since the entry before it (the prompt or a tool result).
            const at = Date.parse(entry.timestamp ?? "")
            if (!Number.isFinite(at)) continue
            const before = subagentLastAt.get(file)
            subagentLastAt.set(file, at)
            const thought = entry.type === "assistant" && Array.isArray(message?.content) && message.content.some((block) => /thinking/.test(block?.type ?? ""))
            if (thought && before && at > before) setStore("subThinkingMs", (value) => value + Math.min(at - before, 15 * 60_000))
          } catch {}
        }
      } catch {}
    }
    saveThinking()
  }
  /** Start reading subagent transcripts from their current ends (what is there was counted before). */
  function primeSubagentRead() {
    subagentRead.clear()
    subagentLastAt.clear()
    if (!store.sessionID) return
    const dir = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"), "projects", store.cwd.replace(/[^a-zA-Z0-9]/g, "-"), store.sessionID, "subagents")
    try {
      for (const name of readdirSync(dir)) if (name.endsWith(".jsonl")) subagentRead.set(path.join(dir, name), statSync(path.join(dir, name)).size)
    } catch {}
  }
  const spendPoll = setInterval(() => {
    if (store.status === "running" || Object.keys(store.tasks).length) readSubagentSpend()
  }, 2000)
  spendPoll.unref?.()

  function liveTokens(chars        ) {
    if (!chars) return
    liveOutput += chars / 4
    if (currentStreamMessage) noteSpend(currentStreamMessage, store.modelId, { output_tokens: Math.round(liveOutput) })
    // At most a few updates a second.
    if (Date.now() - liveShown < 250 || !liveBase) return
    liveShown = Date.now()
    const tokens = Math.round(liveBase + liveOutput)
    setStore("context", (prev) => ({ tokens, percent: prev?.max ? Math.round((tokens / prev.max) * 100) : 0, max: prev?.max ?? 0 }))
  }

  let streamFirst = 0
  function handleStream(event     ) {
    switch (event.type) {
      case "message_start": {
        currentStreamMessage = event.message?.id ?? randomUUID()
        streamFirst = 0
        ensureTurn()
        const usage = event.message?.usage
        noteSpend(currentStreamMessage, event.message?.model, usage)
        const input = (usage?.input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0)
        liveOutput = 0
        if (input > 0) {
          liveBase = input
          setStore("context", (prev) => ({ tokens: input, percent: prev?.max ? Math.round((input / prev.max) * 100) : 0, max: prev?.max ?? 0 }))
        } else liveBase = store.context?.tokens ?? 0
        return
      }
      case "message_delta": {
        // Same measure as opencode's Zen gateway: output tokens / (last byte − first byte).
        const output = event.usage?.output_tokens
        if (currentStreamMessage && event.usage) noteSpend(currentStreamMessage, undefined, event.usage)
        if (typeof output !== "number" || !streamFirst) return
        const ms = Date.now() - streamFirst
        streamFirst = 0
        updateTurn((turn) => {
          turn.outputTokens = (turn.outputTokens ?? 0) + output
          turn.streamMs = (turn.streamMs ?? 0) + ms
        })
        return
      }
      case "content_block_start": {
        const block = event.content_block
        const key = `${currentStreamMessage}:${event.index}`
        if (block.type === "text") {
          const id = key
          streamParts.set(key, id)
          updateTurn((turn) => {
            turn.retry = undefined
            turn.parts.push({ type: "text", id, text: block.text ?? "", done: false })
          })
        } else if (block.type === "thinking" || block.type === "redacted_thinking") {
          const id = key
          streamParts.set(key, id)
          updateTurn((turn) => {
            turn.retry = undefined
            turn.parts.push({ type: "reasoning", id, text: block.thinking ?? "", start: Date.now() })
            thinkingStarts()
          })
        } else if (block.type === "tool_use" || block.type === "server_tool_use" || block.type === "mcp_tool_use") {
          streamParts.set(key, block.id)
          updateTurn((turn) => {
            turn.retry = undefined
            turn.parts.push({
              type: "tool",
              id: block.id,
              name: block.name,
              raw: "",
              input: {},
              status: "pending",
              start: Date.now(),
            })
          })
        }
        return
      }
      case "content_block_delta": {
        if (!streamFirst) streamFirst = Date.now()
        liveTokens((event.delta?.text ?? event.delta?.thinking ?? event.delta?.partial_json ?? "").length)
        const id = streamParts.get(`${currentStreamMessage}:${event.index}`)
        if (!id) return
        const delta = event.delta
        updateTurn((turn) => {
          const part = turn.parts.find((item) => item.id === id)
          if (!part) return
          if (delta.type === "text_delta" && part.type === "text") part.text += delta.text
          else if (delta.type === "thinking_delta" && part.type === "reasoning") part.text += delta.thinking
          else if (delta.type === "input_json_delta" && part.type === "tool") {
            part.raw += delta.partial_json
            const parsed = parseJson(part.raw)
            if (parsed) part.input = parsed
          }
        })
        return
      }
      case "content_block_stop": {
        const id = streamParts.get(`${currentStreamMessage}:${event.index}`)
        if (!id) return
        updateTurn((turn) => {
          const part = turn.parts.find((item) => item.id === id)
          if (!part) return
          if (part.type === "text") part.done = true
          if (part.type === "reasoning") {
            part.end = Date.now()
            thinkingEnds()
          }
          if (part.type === "tool") {
            const parsed = parseJson(part.raw)
            if (parsed) part.input = parsed
            if (part.status === "pending") part.status = "running"
          }
        })
        return
      }
      default:
        return
    }
  }

  // -------------------------------------------------------------------------
  // Subagent transcripts
  // -------------------------------------------------------------------------

  function childTurn(parent        , fn                                  ) {
    batch(() => {
      if (!store.children[parent]) setStore("children", parent, [])
      const list = store.children[parent]
      const last = list.at(-1)
      if (!last || last.type !== "assistant" || last.end) {
        const parentPart = findToolPart(parent)
        setStore("children", parent, (items) => [
          ...items,
          {
            type: "assistant",
            id: randomUUID(),
            parts: [],
            agent: "build",
            model: store.modelId ?? store.model,
            start: Date.now(),
            ...(parentPart?.input.subagent_type ? { agent: "build" } : {}),
          }                           ,
        ])
      }
      setStore("children", parent, store.children[parent].length - 1, produce(fn       ))
    })
  }

  function childAssistant(parent        , message     ) {
    const msg = message.message
    if (msg?.id && msg.usage && msg.model !== "<synthetic>") noteSpend(msg.id, msg.model, msg.usage, true)
    const blocks = msg?.content ?? []
    childTurn(parent, (turn) => {
      if (msg?.model && msg.model !== "<synthetic>") turn.model = msg.model
      for (const block of blocks) {
        if (block.type === "text" && block.text?.trim()) turn.parts.push({ type: "text", id: randomUUID(), text: block.text, done: true })
        else if (block.type === "thinking" && block.thinking?.trim())
          turn.parts.push({ type: "reasoning", id: randomUUID(), text: block.thinking, start: Date.now(), end: Date.now() })
        else if (block.type === "tool_use" || block.type === "server_tool_use" || block.type === "mcp_tool_use")
          turn.parts.push({ type: "tool", id: block.id, name: block.name, raw: "", input: block.input ?? {}, status: "running", start: Date.now() })
      }
    })
    // Keep the one-line summary on the parent tool row.
    for (const block of blocks) {
      if (block.type === "text" && block.text?.trim()) {
        updateTool(parent, (part) => {
          part.childLog = [...(part.childLog ?? []), { id: randomUUID(), name: "text", title: "", status: "completed", text: block.text }]
        })
      }
      if (block.type !== "tool_use") continue
      updateTool(parent, (part) => {
        part.children = (part.children ?? 0) + 1
        part.childTitle = toolTitle(block.name, block.input ?? {})
        part.childLog = [
          ...(part.childLog ?? []),
          { id: block.id, name: block.name, title: toolTitle(block.name, block.input ?? {}), status: "running" },
        ]
      })
    }
  }

  function childUser(parent        , message     ) {
    const content = message.message?.content
    if (typeof content === "string" || (Array.isArray(content) && !content.some((block     ) => block.type === "tool_result"))) {
      const text = typeof content === "string" ? content : content.filter((b     ) => b.type === "text").map((b     ) => b.text).join("\n")
      if (!text.trim()) return
      batch(() => {
        if (!store.children[parent]) setStore("children", parent, [])
        setStore("children", parent, (items) => [...items, { type: "user", id: randomUUID(), text, files: [], time: Date.now() }                      ])
      })
      return
    }
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (block.type !== "tool_result") continue
      const text = toolResultText(block.content)
      updateTool(parent, (part) => {
        const child = part.childLog?.find((entry) => entry.id === block.tool_use_id)
        if (child) child.status = block.is_error ? "error" : "completed"
      })
      const list = store.children[parent]
      if (!list) continue
      const index = list.findLastIndex((m) => m.type === "assistant" && m.parts.some((p) => p.type === "tool" && p.id === block.tool_use_id))
      if (index < 0) continue
      setStore(
        "children",
        parent,
        index,
        produce((m     ) => {
          const part = m.parts.find((p     ) => p.type === "tool" && p.id === block.tool_use_id)
          if (!part) return
          part.output = text
          part.result = message.tool_use_result
          part.end = Date.now()
          part.status = block.is_error ? "error" : "completed"
          if (block.is_error) part.error = text.replace(/^<tool_use_error>|<\/tool_use_error>$/g, "").trim()
        }),
      )
    }
  }

  function finishChild(parent        ) {
    const list = store.children[parent]
    if (!list?.length) return
    setStore(
      "children",
      parent,
      produce((items       ) => {
        for (const m of items) {
          if (m.type !== "assistant" || m.end) continue
          m.end = Date.now()
          for (const part of m.parts) {
            if (part.type === "tool" && (part.status === "running" || part.status === "pending")) part.status = "completed"
          }
        }
      }),
    )
  }

  function handleAssistant(message     ) {
    const msg = message.message
    if (message.parent_tool_use_id) {
      childAssistant(message.parent_tool_use_id, message)
      return
    }
    if (msg?.id && msg.usage && msg.model !== "<synthetic>") noteSpend(msg.id, msg.model, msg.usage)
    if (message.context_usage) {
      const usage = message.context_usage
      setStore("context", { tokens: usage.total_tokens, percent: usage.percentage, max: usage.raw_max_tokens })
    } else if (msg.usage) {
      const u = msg.usage
      const tokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0)
      if (tokens > 0) setStore("context", (prev) => ({ tokens, percent: prev?.max ? Math.round((tokens / prev.max) * 100) : 0, max: prev?.max ?? 0 }))
    }
    if (msg.model && msg.model !== "<synthetic>") setStore("modelId", msg.model)
    updateTurn((turn) => {
      turn.sdkUuid = message.uuid
      if (msg.model && msg.model !== "<synthetic>") turn.model = msg.model
      if (message.error) turn.error = assistantError(message.error, msg)
      if (message.error === "authentication_failed") needLogin()
      if (message.error === "rate_limit") limitRefusal = turn.error
      // The same refusal again for each background subagent that reports in (each report starts a turn): shown once.
      if (turn.error && isLimitError(turn.error) && !turn.repeat && refusalOnly(turn)) {
        const index = store.messages.findIndex((item) => item.id === turn.id)
        if (limitShownSince(store.messages, index)) turn.repeat = true
      }
      // Claude Code's stand-in reply when a request fails (e.g. a usage limit): show it once, as the error.
      if (msg.model === "<synthetic>") {
        const text = syntheticText(msg)
        if (text && !turn.error) turn.error = text
        if (turn.error && isLimitError(turn.error) && !turn.repeat && limitShownSince(store.messages, store.messages.findIndex((item) => item.id === turn.id))) turn.repeat = true
        return
      }
      const used = syncedParts
      for (const block of msg.content ?? []) {
        if (block.type === "tool_use" || block.type === "server_tool_use" || block.type === "mcp_tool_use") {
          let part = turn.parts.find((item) => item.type === "tool" && item.id === block.id)
          if (!part) {
            part = { type: "tool", id: block.id, name: block.name, raw: "", input: {}, status: "running", start: Date.now() }
            turn.parts.push(part)
          }
          part.input = block.input ?? part.input
          if (part.status === "pending") part.status = "running"
          continue
        }
        if (block.type === "text" || block.type === "thinking" || block.type === "redacted_thinking") {
          const kind = block.type === "text" ? "text" : "reasoning"
          const value = block.type === "text" ? block.text : (block.thinking ?? "")
          let part = turn.parts.find(
            (item) => item.type === kind && item.id.startsWith(`${msg.id}:`) && !used.has(item.id),
          )
          if (!part) {
            // Message without streaming (e.g. replayed or synthetic): create it whole.
            if (kind === "text" && (!value?.trim() || NO_REPLY.test(value))) continue
            part =
              kind === "text"
                ? { type: "text", id: `${msg.id}:${randomUUID()}`, text: value, done: true }
                : { type: "reasoning", id: `${msg.id}:${randomUUID()}`, text: value, start: Date.now(), end: Date.now() }
            turn.parts.push(part)
          } else if (value && value.length >= part.text.length) {
            part.text = value
          }
          used.add(part.id)
          if (part.type === "text") part.done = true
          if (part.type === "reasoning" && !part.end) part.end = Date.now()
        }
      }
    })
  }

  function handleUser(message     ) {
    if (message.isReplay) return
    if (message.parent_tool_use_id) {
      childUser(message.parent_tool_use_id, message)
      return
    }
    const content = message.message?.content
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (block.type !== "tool_result") continue
      const text = toolResultText(block.content)
      const result = message.tool_use_result
      let tool
      updateTool(block.tool_use_id, (part) => {
        tool = part
        part.output = text
        part.result = result
        part.end = Date.now()
        if (block.is_error) {
          part.status = "error"
          part.error = text.replace(/^<tool_use_error>|<\/tool_use_error>$/g, "").trim()
        } else {
          part.status = "completed"
        }
      })
      if (tool && isSubagentTool(tool.name) && !tool.background) finishChild(block.tool_use_id)
      if (!tool || block.is_error) continue
      trackToolSideEffects(tool.name, tool.input, result)
    }
  }

  function trackToolSideEffects(name        , input                     , result     ) {
    if (isTodoTool(name) && Array.isArray(input.todos)) setStore("todos", reconcile(input.todos))
    if ((name === "Edit" || name === "Write" || name === "MultiEdit" || name === "NotebookEdit") && input.file_path) {
      const diff = countDiff(result)
      if (name === "Write" && result?.type === "create" && !diff.additions)
        diff.additions = String(input.content ?? "").split("\n").length
      setStore(
        "files",
        produce((files     ) => {
          const key = relative(input.file_path ?? input.notebook_path)
          const prev = files[key] ?? { additions: 0, deletions: 0 }
          files[key] = { additions: prev.additions + diff.additions, deletions: prev.deletions + diff.deletions }
        }),
      )
    }
  }

  // What this turn learned about a limit refusal; the result message doesn't always carry it.
  let limitRefusal
  let limitResetsAt
  let fableRefused = false

  function handleResult(message     ) {
    agentLimits.turnEnded()
    const error =
      message.subtype !== "success"
        ? (message.errors?.join("\n") ?? message.subtype)
        : message.is_error && message.result
          ? message.result
          : undefined
    const interrupted = lastTurn()?.interrupted
    const refusal = isLimitError(error) || /fable limit/i.test(error ?? "") ? error : limitRefusal
    const resetsAt = limitResetsAt ?? limitResetTime(refusal)
    const fable = !!refusal && !splitModel(store.model) && (fableRefused || /fable limit/i.test(refusal))
    limitRefusal = limitResetsAt = undefined
    fableRefused = false
    batch(() => {
      if (typeof message.total_cost_usd === "number") {
        // total_cost_usd is cumulative for the process; carry over costs from earlier processes.
        const delta =
          message.total_cost_usd >= store.lastResultCost ? message.total_cost_usd - store.lastResultCost : message.total_cost_usd
        setStore("cost", (cost) => cost + delta)
        setStore("lastResultCost", message.total_cost_usd)
        // Read what subagents wrote last, then let Claude Code's exact total stand for all of it.
        readSubagentSpend()
        settleSpend()
        // Claude on the plan: count it toward the plan's measured worth (see planRate).
        if (catalog.plan && !splitModel(store.model)) notePlanSpend(delta)
      }
      finishTurn({ error: error && !interrupted ? error : undefined })
      setStore("compacting", false)
    })
    // The Fable limit: with Fable fallback on, the work goes on at once on the fallback model; otherwise it waits.
    if (fable) {
      markFableHit(resetsAt)
      if (interrupted) return
      void fallBackFromFable(api).then((moved) => {
        if (moved) send(FABLE_RESUME_PROMPT)
        else armAutoResume(api, resetsAt)
      })
      return
    }
    // Only Claude's own refusals count against the Claude plan (other providers answer 429 too).
    const onMain = (store.login ?? "main") === "main"
    if (refusal && !splitModel(store.model) && onMain) markLimitHit(/weekly|7.?day/i.test(refusal) ? "seven_day" : /session|5.?hour/i.test(refusal) ? "five_hour" : undefined, resetsAt)
    if (refusal && !interrupted && !splitModel(store.model) && switchLoginAfterLimit(api, resetsAt)) return
    if (refusal && !interrupted) armAutoResume(api, resetsAt)
    else {
      if (!error) resumeSucceeded(api)
      void pollPlanUsage()
    }
  }

  function recomputeDerived() {
    const files                        = {}
    let todos         = []
    for (const message of store.messages) {
      if (message.type !== "assistant") continue
      for (const part of message.parts) {
        if (part.type !== "tool" || part.status !== "completed") continue
        if (isTodoTool(part.name) && Array.isArray(part.input.todos)) todos = part.input.todos
        if ((part.name === "Edit" || part.name === "Write") && part.input.file_path) {
          const diff = countDiff(part.result)
          const key = relative(part.input.file_path)
          const prev = files[key] ?? { additions: 0, deletions: 0 }
          files[key] = { additions: prev.additions + diff.additions, deletions: prev.deletions + diff.deletions }
        }
      }
    }
    setStore("files", files)
    setStore("todos", todos)
  }

  const api = Object.assign(self, {
    notice: pushNotice,
    /** Restart once the running turn is over (a login change). */
    restartLater: () => {
      restartAfterTurn = true
    },
    start,
    stop,
    ensureStarted,
    dispose,
    restart,
    send,
    appendContext,
    interrupt,
    backgroundTasks,
    stopTask,
    setModel,
    setEffort,
    setFast,
    setMode,
    cycleAgent,
    setAgent,
    currentAgent,
    currentModel,
    modelLabel,
    refreshMcp,
    toggleMcp,
    reconnectMcp,
    refreshUsage,
    refreshContext,
    resetTranscript,
    load,
    undo,
    redo,
    revert,
    unrevert,
    rename,
    replyPermission,
    replyQuestion,
    replyElicitation,
    relative,
    findToolPart,
    showSubagentLog,
    openSubagent,
    pause,
    resume,
    loggedIn,
    modRender,
    modPress,
    modInput,
    modSelect,
    modPaneShow,
    modPaneClose,
  })
















































  return api
}

// ---------------------------------------------------------------------------
// History conversion (resume)
// ---------------------------------------------------------------------------

function userText(content     )                     {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return undefined
  if (content.some((block) => block.type === "tool_result")) return undefined
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
}

/** The text of a `<synthetic>` assistant message (Claude Code writes these for failed requests). */
function syntheticText(msg     )         {
  return (Array.isArray(msg?.content) ? msg.content : [])
    .filter((block     ) => block?.type === "text")
    .map((block     ) => String(block.text ?? ""))
    .join("\n")
    .trim()
}

/**
 * The subagent logs Claude Code keeps for a session (<project>/<session>/subagents/agent-<id>.jsonl, with a .meta.json
 * beside each): what each was asked, its type and model, when it ran, how many replies and tool calls, and roughly
 * how long it thought. Newest first.
 */
export function subagentLogs(cwd, sessionId) {
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"), "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), sessionId, "subagents")
  let names
  try {
    names = readdirSync(dir).filter((name) => /^agent-.*\.jsonl$/.test(name))
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    const file = path.join(dir, name)
    let meta = {}
    try {
      meta = JSON.parse(readFileSync(file.replace(/\.jsonl$/, ".meta.json"), "utf8"))
    } catch {}
    let start = 0
    let end = 0
    let prompt = ""
    let model = ""
    let thinkingMs = 0
    let last = 0
    const replies = new Set()
    const tools = new Set()
    try {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line.trim()) continue
        let entry
        try {
          entry = JSON.parse(line)
        } catch {
          continue
        }
        const at = Date.parse(entry.timestamp ?? "")
        if (Number.isFinite(at)) {
          if (!start) start = at
          end = at
        }
        const content = entry.message?.content
        if (entry.type === "user" && !prompt) prompt = typeof content === "string" ? content : (content?.find?.((block) => block.type === "text")?.text ?? "")
        if (entry.type === "assistant") {
          if (entry.message?.id) replies.add(entry.message.id)
          if (entry.message?.model && entry.message.model !== "<synthetic>") model = entry.message.model
          for (const block of Array.isArray(content) ? content : []) {
            if (block.type === "tool_use") tools.add(block.id)
            if (/thinking/.test(block.type ?? "") && last && at > last) thinkingMs += Math.min(at - last, 15 * 60_000)
          }
        }
        if (Number.isFinite(at)) last = at
      }
    } catch {
      continue
    }
    out.push({
      file,
      agentId: meta.agentId ?? name.replace(/^agent-|\.jsonl$/g, ""),
      toolUseId: meta.toolUseId,
      description: meta.description || prompt.replace(/\s+/g, " ").slice(0, 80) || "Subagent",
      type: meta.agentType ?? "general-purpose",
      model: meta.pickedEffortModel ?? model ?? meta.model ?? "",
      background: meta.requestShape === "background",
      finished: meta.finished !== false,
      start,
      end,
      replies: replies.size,
      tools: tools.size,
      thinkingMs,
    })
  }
  return out.sort((a, b) => b.start - a.start)
}


/** A message that is nothing but a usage-limit refusal (no reply text, no steps). */
function refusalOnly(message) {
  if (message.type === "notice") return isLimitError(message.text)
  if (message.type !== "assistant" || !message.error || !isLimitError(message.error)) return false
  return !(message.parts ?? []).some((part) => part.type === "tool" || (part.type === "text" && String(part.text ?? "").trim()))
}

/** Whether a limit refusal is already shown since the user last wrote (before `before`, an index into the list). */
function limitShownSince(list, before = list.length) {
  for (let i = (before < 0 ? list.length : before) - 1; i >= 0; i--) {
    const message = list[i]
    if (message.type === "user") return false
    if (!message.repeat && refusalOnly(message)) return true
  }
  return false
}

/**
 * When the plan limit is hit, every background subagent fails, each failure is reported to the conversation, and
 * each report starts a turn that is refused again: the same "You've hit your limit" many times. From the second
 * until the user writes again, they are marked `repeat` (not shown).
 */
function markLimitRepeats(list) {
  let shown = false
  for (const message of list) {
    if (message.type === "user") shown = false
    else if (refusalOnly(message)) {
      if (shown) message.repeat = true
      shown = true
    }
  }
  return list
}

function convertHistory(history                                                )            {
  const out            = []
  let turn
  const tools = new Map                  ()
  for (const entry of history         ) {
    if (entry.parent_tool_use_id) continue
    const msg = entry.message
    if (entry.type === "system" && entry.subtype === "compact_boundary") {
      if (turn) turn.end = turn.end ?? turn.start
      turn = undefined
      if (out.at(-1)?.type !== "notice" || (out.at(-1)                 ).variant !== "compaction")
        out.push({ type: "notice", id: entry.uuid ?? randomUUID(), text: "Session compacted", variant: "compaction" })
      continue
    }
    if (entry.type === "user") {
      const content = msg?.content
      if (Array.isArray(content) && content.some((block     ) => block.type === "tool_result")) {
        for (const block of content) {
          if (block.type !== "tool_result") continue
          const part = tools.get(block.tool_use_id)
          if (!part) continue
          const text = toolResultText(block.content)
          part.output = text
          part.status = block.is_error ? "error" : "completed"
          if (block.is_error) part.error = text
          part.result = entry.toolUseResult ?? entry.tool_use_result
        }
        continue
      }
      const attachments = Array.isArray(content) ? attachmentsFromHistory(content) : []
      const text = userText(Array.isArray(content) ? content.filter((block     ) => !(block?.type === "text" && String(block.text).startsWith("<attachment "))) : content)
      if (text === undefined || (!text.trim() && !attachments.length)) continue
      if (entry.isCompactSummary) {
        // Marks the compaction, like live sessions do (undo can't go back past it).
        if (turn) turn.end = turn.end ?? turn.start
        turn = undefined
        if (out.at(-1)?.type !== "notice" || (out.at(-1)                 ).variant !== "compaction")
          out.push({ type: "notice", id: entry.uuid ?? randomUUID(), text: "Session compacted", variant: "compaction" })
        continue
      }
      if (entry.isMeta) continue
      // Agent Code's own note about changed settings (sent into the conversation for the model): not the user's.
      if (/^\[Agent Code\] The user changed /.test(text)) continue
      // Claude Code's own notes about background tasks are not the user's messages: not shown, except a failure as
      // one short line. The reply that follows is a turn of its own.
      if (entry.origin?.kind === "task-notification" || text.startsWith("<task-notification>")) {
        if (turn) turn.end = turn.end ?? turn.start
        turn = undefined
        const failed = taskFailure(text)
        if (failed) out.push({ type: "notice", id: entry.uuid ?? randomUUID(), text: failed, variant: "warning" })
        continue
      }
      const command = text.match(/<command-name>(.*?)<\/command-name>/)
      if (command) {
        const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]
        if (turn) turn.end = turn.end ?? turn.start
        turn = undefined
        out.push({ type: "user", id: entry.uuid, text: `${command[1]}${args ? " " + args : ""}`, files: [] })
        continue
      }
      const stdout = text.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/)
      if (stdout) {
        if (stdout[1].trim()) out.push({ type: "notice", id: entry.uuid, text: stripAnsi(stdout[1]), variant: "command", markdown: true })
        continue
      }
      if (text.startsWith("<bash-input>") || text.startsWith("<bash-stdout>")) continue
      if (text.startsWith("<local-command-caveat>")) continue
      if (turn) turn.end = turn.end ?? turn.start
      turn = undefined
      out.push({ type: "user", id: entry.uuid, text: cleanUserText(text), files: [], attachments: attachments.length ? attachments : undefined, time: Date.parse(entry.timestamp ?? "") || undefined })
      continue
    }
    if (entry.type === "assistant") {
      if (!turn) {
        const at = Date.parse(entry.timestamp ?? "") || 0
        turn = { type: "assistant", id: randomUUID(), parts: [], agent: "build", model: msg?.model && msg.model !== "<synthetic>" ? msg.model : "", start: at, end: at }
        out.push(turn)
      }
      turn.sdkUuid = entry.uuid
      // The reply's last entry is when it ended.
      turn.end = Date.parse(entry.timestamp ?? "") || turn.end
      if (msg?.model === "<synthetic>") {
        // Claude Code's stand-in reply for a failed request (usage limit, API error): it is the turn's error.
        const text = syntheticText(msg)
        if (text && !turn.error) turn.error = text
        continue
      }
      if (msg?.model) turn.model = msg.model
      for (const block of msg?.content ?? []) {
        if (block.type === "text" && block.text?.trim() && !NO_REPLY.test(block.text))
          turn.parts.push({ type: "text", id: randomUUID(), text: block.text, done: true })
        else if (block.type === "thinking" && block.thinking?.trim())
          turn.parts.push({ type: "reasoning", id: randomUUID(), text: block.thinking, start: Date.parse(entry.timestamp ?? "") || 0, end: Date.parse(entry.timestamp ?? "") || 0 })
        else if (block.type === "tool_use") {
          const part           = {
            type: "tool",
            id: block.id,
            name: block.name,
            raw: "",
            input: block.input ?? {},
            status: "completed",
            start: 0,
            end: 0,
          }
          tools.set(block.id, part)
          turn.parts.push(part)
        }
      }
    }
  }
  return markLimitRepeats(out)
}
