import os from "node:os"
import { findBinary } from "./platform"
import {
  createSdkMcpServer,
  getSessionMessages,
  query,
  tool,
} from "@anthropic-ai/claude-agent-sdk"
import { batch } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import { execFile, execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs"
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
import { acpEffort, acpModels, acpModes, harnessById, harnessLaunch } from "./harnesses"
import { claimResetOffer, fetchPlanUsage, fetchResetOffer, isLimitError, limitResetTime, notePlanSpend, onSharedPlanUsage, planDetails, publishPlanUsage, samplePlanRate } from "./usage"

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
  return [...AGENTS, ...(config.agentModes ?? []).filter((mode) => mode?.id && mode.name && !AGENTS.some((agent) => agent.id === mode.id))]
}

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
  if (planInflight || (!force && Date.now() - planLast < (working() ? 18_000 : 30_000))) {
    checkAutoResume()
    return planExact
  }
  planInflight = true
  planLast = Date.now()
  try {
    const usage = await fetchPlanUsage(force, working() ? 18_000 : 100_000)
    planExact = !!usage
    // Claude Code rewrites the plan into its credentials when the login refreshes (e.g. after a plan change).
    void planDetails().then((plan) => {
      if (plan && plan.type !== catalog.plan) setCatalog("plan", plan.type)
      if (plan && plan.label !== catalog.planLabel) setCatalog("planLabel", plan.label)
    })
    if (usage) {
      applyUsage(usage)
      checkFableReturn()
      if (catalog.plan && !usage.week?.hit) samplePlanRate(usage.week?.utilization, catalog.planLabel ?? catalog.plan)
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
  if (offer && blocked && config.autoResume === true && config.autoLimitReset !== false) await useLimitReset(true)
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
function applyUsage(usage) {
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
// Fable fallback and return (sidebar, under auto-pause; Settings → Fable fallback… / Back to Fable…)
//  - fallback: a Fable tab that hits the Fable limit (or would pause before it) goes on at once on another model
//    (Opus by default) with its reasoning level raised (+1 by default). Off by default.
//  - return: once a Fable limit that was used up resets, tabs on Opus, Sonnet or Haiku go back to Fable with their
//    level lowered (Opus 1, Sonnet 2, Haiku 3 levels by default; each model can be left out). On by default.
// ---------------------------------------------------------------------------

const LEVELS = ["low", "medium", "high", "xhigh", "max"]
const FABLE_RESUME_PROMPT = "The Fable limit was reached, so this session moved to another model. Continue the work from where it stopped."
const allSessions = new Set()

export const FABLE_FAMILIES = ["opus", "sonnet", "haiku"]
const UPGRADE_DEFAULTS = { opus: { on: true, step: 1 }, sonnet: { on: true, step: 2 }, haiku: { on: true, step: 3 } }

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
  planPoll = setInterval(() => (working() || ++ticks % 6 === 0) && void pollPlanUsage(), 20_000)
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
  if (config.autoResume !== true) return
  if (resetsAt) refusedUntil.set(session, resetsAt)
  else refusedUntil.delete(session)
  session.setStore("resumeAt", 0)
  waitingResume.add(session)
  startResumeClock()
  void pollPlanUsage(true)
    .catch((error) => log("auto-resume usage poll failed", error))
    .then(() => checkAutoResume())
}

/** Continue a tab whose wait is over, booting or reviving its process first (a bare send would be dropped). */
async function fireAutoResume(session         ) {
  try {
    if (session.store.fatal && session.store.sessionID) await session.start({ resume: session.store.sessionID })
    else await session.ensureStarted()
    session.send(RESUME_PROMPT)
  } catch (error) {
    log("auto-resume failed, trying again in 5 minutes", error)
    if (session.disposed) return
    setResumeAt(session, Date.now() + 5 * 60_000)
    waitingResume.add(session)
  }
}

function checkAutoResume() {
  for (const session of waitingResume) {
    try {
      if (session.disposed || config.autoResume !== true || session.store.resumeAt === undefined) {
        waitingResume.delete(session)
        if (!session.disposed && session.store.resumeAt !== undefined) setResumeAt(session, undefined)
        continue
      }
      // First check after the error: fix the time from the refusal or the limit data, or back off 5 → 10 → 20 → 40 min without data.
      if (!session.store.resumeAt) {
        const tries = resumeTries.get(session) ?? 0
        const stated = refusedUntil.get(session)
        const when = (stated && stated > Date.now() ? stated : resumeTime(session)) ?? Date.now() + Math.min(40, 5 * 2 ** tries) * 60_000
        setResumeAt(session, when + 20_000)
        continue
      }
      if (Date.now() < session.store.resumeAt) continue
      // A turn is going (e.g. a background task reported in) or the process is booting: continue once it is free.
      if (session.store.status === "running" || session.store.booting) continue
      waitingResume.delete(session)
      resumeTries.set(session, (resumeTries.get(session) ?? 0) + 1)
      setResumeAt(session, undefined)
      void fireAutoResume(session)
    } catch (error) {
      log("auto-resume check failed", error)
    }
  }
}

/** A turn finished without a limit error: the next limit starts the backoff afresh. */
export function resumeSucceeded(session         ) {
  resumeTries.delete(session)
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
  if (config.autoResume !== true || at < Date.now() - RESUME_KEEP) {
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

function planningServer() {
  return createSdkMcpServer({
    name: ACODE_MCP,
    tools: [
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
    ],
  })
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

/** `context`: the session the prompt is for ({ sessionId, session }), so a part can differ per session. */
export function behaviourPrompt(extra           = [], context = {}) {
  const parts           = []
  for (const part of promptParts.values()) {
    try {
      const text = part(context)?.trim()
      if (text) parts.push(text)
    } catch (error) {
      log("prompt part failed", error)
    }
  }
  if (config.planning) parts.push(PLANNING_PROMPT)
  if (config.runTests === false) parts.push(NO_TESTS_PROMPT)
  if (config.askQuestions === false) parts.push(NO_QUESTIONS_PROMPT)
  parts.push(...extra)
  return parts.length ? parts.join("\n\n") : undefined
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

const PICK_PROMPT =
  "When delegating to subagents (the Agent tool), choose each subagent's model and effort to fit the task: haiku with low effort for searches, file reading and mechanical edits; sonnet for ordinary implementation; opus with higher effort only for hard reasoning. You may set the Agent tool's model and effort parameters for this without being asked."
const providerPrompt = (lines          ) =>
  `Subagents on other models are available as subagent_type values, by kind:\n${lines.join("\n")}\nUse them for routine delegated work (searches, reading, summaries, mechanical edits), the ones marked preferred first; keep Claude models for anything that needs careful judgment. They don't count against the user's Claude limits.`

function subagentHooks(main              , effort                               )                        {
  return [
    {
      matcher: "Agent|Task",
      hooks: [
        async (input     ) => {
          const policy = subagentPolicy()
          const next = { ...(input.tool_input ?? {}) }
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
  if (id.startsWith("ses_")) return "opencode"
  return harnessModel(config.sessionModels?.[id])?.harness.id
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
  function currentAgent()        {
    const id = store.agentMode ?? (store.sessionID ? config.sessionAgentMode?.[store.sessionID] : undefined)
    const own = id ? agentList().find((agent) => agent.id === id) : undefined
    if (own && own.mode === store.mode) return own
    return store.mode === "plan" ? AGENTS[1] : AGENTS[0]
  }

  /** Switch to a mode: its permission mode now, its instruction with the next prompt. */
  function setAgent(id) {
    const agent = agentList().find((item) => item.id === id)
    if (!agent) return
    const custom = !AGENTS.includes(agent)
    setStore("agentMode", custom ? agent.id : undefined)
    if (store.sessionID) {
      const all = { ...(config.sessionAgentMode ?? {}) }
      if (custom) all[store.sessionID] = agent.id
      else delete all[store.sessionID]
      config.sessionAgentMode = all
      saveConfig()
    }
    modeNote = custom && agent.prompt?.trim() ? `[Mode "${agent.name}": ${agent.prompt.trim()}]` : custom ? undefined : modeNote && `[Mode "${agent.name}": the earlier mode's instruction no longer applies.]`
    void setMode(agent.mode)
  }

  // -------------------------------------------------------------------------
  // Process lifecycle
  // -------------------------------------------------------------------------

  async function start(options               = {}) {
    stop()
    if (disposed) return
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
      if (store.messages.some((m) => m.type === "user")) pushNotice("Continuing in Claude Code: earlier messages are not in this model's context.", "info")
      batch(() => {
        setStore("engine", undefined)
        setStore("sessionID", undefined)
        setStore("revert", undefined)
      })
      options = { sessionId: randomUUID() }
    }
    const policy = subagentPolicy()
    const external = splitModel(store.model)
    const sessionKey = options.sessionId ?? options.resume ?? store.sessionID
    // Mixing providers: Claude Code keeps its Claude login and every request goes through Agent Code's router.
    const routed = policy.providers
    const providerVars = routed ? await routerEnv(sessionKey, store.model) : external ? await providerEnv(store.model, sessionKey) : undefined
    if (gen !== generation) return
    if (routed && !providers.list.length) await refreshProviders()
    if (gen !== generation) return
    const { agents, lines } = routed && policy.pick ? providerAgents(store.model) : { agents: {}, lines: []             }
    const extra           = []
    if (policy.enabled && policy.pick && (policy.models || policy.effort)) extra.push(PICK_PROMPT)
    if (lines.length) extra.push(providerPrompt(lines))
    const append = behaviourPrompt(extra, { sessionId: options.sessionId ?? options.resume ?? store.sessionID, session: api })
    const disallowed = [
      ...(config.askQuestions === false ? ["AskUserQuestion"] : []),
      ...(policy.enabled ? [] : ["Agent", "Task"]),
    ]
    ensureBoxTrusted(store.cwd)
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
        hooks: { PreToolUse: [...(policy.enabled ? subagentHooks(() => store.model, () => (splitModel(store.model) ? undefined : store.effort)) : []), pauseHook()] },
        // Agent Code's own MCP servers (mcp.ts) win over same-named ones in ~/.claude.json.
        mcpServers: { ...acodeMcpServers(), ...(config.planning ? { [ACODE_MCP]: planningServer() } : {}) },
        plugins: modPlugins(),
        allowedTools: config.planning ? [TODO_TOOL] : undefined,
        resume: options.resume,
        resumeSessionAt: options.resumeAt,
        continue: options.continue,
        forkSession: options.fork,
        sessionId: options.sessionId,
        pathToClaudeCodeExecutable: executable,
        canUseTool: (toolName, toolInput, opts) => requestPermission(toolName, toolInput, opts),
        onElicitation: (request, { signal }) => requestElicitation(request, signal),
        stderr: (data) => log("stderr", data),
        env: {
          // Agent Code passes CLAUDE_CODE_PLUGIN_DIRS mods itself (as `plugins`), so each can be switched off.
          ...withoutKey(process.env, "CLAUDE_CODE_PLUGIN_DIRS"),
          CLAUDE_AGENT_SDK_CLIENT_APP: "agent-code",
          ...providerVars,
          // Claude Code assumes 200K for models it doesn't know: give it the real window so it compacts in time.
          ...(external && !routed ? contextEnv(store.model, providerVars?.ANTHROPIC_MODEL) : {}),
        },
      },
    })
    current = { q, input, generation: gen }
    if (options.sessionId && !store.sessionID) setStore("sessionID", options.sessionId)
    void pump(q, gen)
    try {
      const init = await q.initializationResult()
      if (gen !== generation) return
      batch(() => {
        setStore("commands", reconcile(init.commands ?? []))
        if (!external) rememberClaudeModels(init.models ?? [])
        rememberSessionModel(store.sessionID, store.model)
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

  function stop() {
    if (oc) {
      generation++
      for (const [id, resolve] of pending) resolve({ behavior: "deny", message: "Session closed", toolUseID: id })
      pending.clear()
      cancelElicitations()
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
    if (store.sessionID && store.messages.length) await start({ resume: store.sessionID })
    else await start({ sessionId: store.sessionID ?? randomUUID() })
  }

  function dispose() {
    stop()
    disposed = true
    limitResetListeners.delete(onLimitReset)
    allSessions.delete(self)
    clearTimeout(mcpPoll)
    emit("closed")
  }

  /** Restart the Claude Code process keeping the conversation (used when behaviour settings change). */
  let restartAfterTurn = false
  async function restart() {
    if (!(current || oc) || store.status === "running") return false
    restartAfterTurn = false
    if (store.sessionID && store.messages.some((m) => m.type === "user")) await start({ resume: store.sessionID })
    // A session with no prompt yet keeps its id (and so its per-session settings, like the agent mix).
    else await start({ sessionId: store.sessionID && !store.engine ? store.sessionID : randomUUID() })
    return true
  }

  // -------------------------------------------------------------------------
  // opencode engine: OpenCode Zen's free models run inside opencode itself (`opencode acp`)
  // -------------------------------------------------------------------------

  let oc
  /** Prompts typed while opencode works; sent together as the next turn, like Claude Code's queue. */
  const ocQueue                                                                                          = []
  /** session/load replays the stored conversation as updates. */
  let replaying = false

  async function startAcp(gen        , options              , harness     , model        ) {
    // A conversation of this harness (by the model it was saved with; opencode's own ids start "ses_").
    const own = (id         ) => !!id && (harnessSession(id) === harness.id || (store.engine === harness.id && id === store.sessionID))
    const resume = [options.resume, store.sessionID].find(own)
    if (store.engine !== harness.id && store.messages.some((m) => m.type === "user"))
      pushNotice(`Continuing in ${harness.name}: earlier messages are not in this model's context.`, "info")
    setStore("engine", harness.id)
    const launch = harnessLaunch(harness, apiKeyFor)
    if (!launch) {
      batch(() => {
        setStore("booting", false)
        setStore("fatal", `${harness.name} is not installed. Install it with: ${harness.install}`)
      })
      return
    }
    const client = new AcpClient(store.cwd, {
      update: (sessionId, update) => {
        // Subagent (child session) updates carry their own session id.
        if (gen !== generation || (oc?.id && sessionId !== oc.id)) return
        handleAcp(update)
      },
      request: (method, params) => acpRequest(gen, method, params),
      exit: (error) => {
        if (gen !== generation) return
        oc = undefined
        log(`${harness.id} exited`, error)
        batch(() => {
          if (store.status === "running") finishTurn({ error })
          setStore("booting", false)
          setStore("ready", false)
          setStore("fatal", error)
        })
      },
    })
    oc = { client, id: resume ?? "", harness: harness.id, caps: {} }
    const learn = (result     ) => {
      if (!result) return
      oc.caps = { models: acpModels(result) ?? oc.caps.models, effort: acpEffort(result) ?? oc.caps.effort, modes: acpModes(result) ?? oc.caps.modes }
    }
    try {
      const hello = await client.request("initialize", { protocolVersion: 1, clientCapabilities: {} })
      // The harness's own version, for the sidebar's version line.
      const info = hello?.agentInfo ?? hello?.agent_info
      if (info?.version) setStore("engineVersion", String(info.version))
      let id = resume
      if (resume) {
        replaying = true
        batch(() => {
          setStore("messages", [])
          setStore("children", {})
        })
        try {
          learn(await client.request("session/load", { sessionId: resume, cwd: store.cwd, mcpServers: [] }))
        } catch (error) {
          log(`${harness.id} load error`, error)
          pushNotice(`Could not reopen the ${harness.name} conversation (${errorMessage(error)}); starting a new one.`, "warning")
          id = undefined
        } finally {
          replaying = false
          closeReplayTurn()
        }
      }
      if (!id) {
        const created = await client.request("session/new", { cwd: store.cwd, mcpServers: [] })
        learn(created)
        id = created.sessionId
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
      if (resume === id && harness.id === "opencode") void loadOpencodeInfo()
    } catch (error) {
      if (gen !== generation) return
      log(`${harness.id} start error`, error)
      batch(() => {
        setStore("booting", false)
        setStore("fatal", errorMessage(error))
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

  async function promptOpencode() {
    const session = oc
    if (!session || !ocQueue.length) return
    const items = ocQueue.splice(0)
    const prompt        = []
    for (const item of items) {
      for (const image of item.images) prompt.push({ type: "image", mimeType: image.mime, data: image.data })
      prompt.push(...attachmentAcp(item.attachments))
    }
    prompt.push({ type: "text", text: items.map((item) => item.text).join("\n\n") })
    const gen = generation
    ensureTurn()
    let result
    let error
    try {
      result = await session.client.request("session/prompt", { sessionId: session.id, prompt })
    } catch (failure) {
      error = errorMessage(failure)
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
    loginNeededAt = Date.now()
    setStore("authRequired", true)
    pushNotice("Claude Code's login has expired or was refused. Run /login — prompts you send meanwhile wait here and go out after you log in.", "warning")
    emit("attention", { kind: "login" })
  }

  function holdUnsent(text, extra) {
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
    emit("sent", { id })
    // Logged in again outside Agent Code (claude auth login in a terminal): the credentials changed, so go on.
    if (store.authRequired && credentialsChangedSince(loginNeededAt)) return void loggedIn()
    // Bring the process back (unless the login has to be renewed first).
    if (!store.authRequired && !store.booting) void revive()
  }

  /** Start Claude Code again for this tab: resume its conversation, or begin it. */
  async function revive() {
    const started = store.messages.some((m) => m.type === "user" && !m.unsent)
    if (store.sessionID && started) await start({ resume: store.sessionID })
    else await start({ sessionId: store.sessionID ?? randomUUID() })
  }

  /** Send what waited, in order, now that the process runs. */
  function flushUnsent() {
    if (!current || store.fatal || store.authRequired || !unsent.length) return
    const items = unsent.splice(0)
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
  const onLimitReset = () => store.pause?.reason === "limit" && resume()
  limitResetListeners.add(onLimitReset)
  allSessions.add(self)

  /** Pause until `until` (ms; undefined = until resumed by hand). */
  function pause(until, reason = "user", windows) {
    clearTimeout(pauseTimer)
    const stopped = !!oc && store.status === "running"
    setStore("pause", { until, reason, windows, since: Date.now(), holding: false, interrupted: stopped || store.pause?.interrupted })
    if (until) pauseTimer = setTimeout(() => resume(), Math.max(1000, until - Date.now()))
    if (stopped) void interrupt()
    emit("pause", { until, reason })
  }

  /** Let a paused turn go on (or, for a harness that was stopped, continue it with one short message). */
  function resume() {
    clearTimeout(pauseTimer)
    const was = store.pause
    if (!was) return
    setStore("pause", undefined)
    // Resumed by hand before the reset: the user chose to go on up to 100 % of these windows.
    if (was.reason === "limit" && (!was.until || Date.now() < was.until - 30_000)) {
      for (const w of was.windows ?? []) waivePause(w)
      if (was.windows?.length) pushNotice("Going on up to 100% of the limit: no more pauses before this window resets.", "info")
    }
    for (const release of pauseWaiters.splice(0)) release()
    emit("pause", { resumed: true })
    if (was.interrupted && oc) send("Continue where you stopped.")
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
    if (config.pauseNearLimit === false || splitModel(store.model) || store.pause) return
    const at = config.pauseAt ?? 95
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
    pushNotice(
      `Paused before the plan limit (${Math.round(Math.max(...windows.map((w) => w.utilization)))}% used, pausing at ${at}%); resumes at ${new Date(until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} with nothing extra sent. Resume to go on up to 100%.`,
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
    // Writing to a paused tab means: go on.
    if (store.pause && !(store.pause.interrupted && text === "Continue where you stopped.")) resume()
    // Like opencode: a new prompt deletes the reverted messages for good.
    if (store.revert) {
      void commitRevert().then(() => send(text, extra))
      return
    }
    if (oc) return sendOpencode(text, extra)
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
    const forModel = modeNote ? `${modeNote}\n\n${text}` : text
    modeNote = undefined
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
      if (oc) oc.client.notify("session/cancel", { sessionId: oc.id })
      else await current .q.interrupt()
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
    rememberSessionModel(store.sessionID, value)
    // Another provider means another endpoint: the Claude Code process has to restart.
    if (crossing && previous !== value) {
      // Mid-turn the process can't be swapped: do it as soon as the turn ends.
      if (!(await restart())) {
        restartAfterTurn = !!current
        log("model change waits for the next start", value)
      }
      return
    }
    try {
      await current?.q.setModel(value === "default" ? undefined : value)
    } catch (error) {
      log("setModel error", error)
    }
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
    batch(() => {
      setStore("messages", [])
      setStore("children", {})
      setStore("sessionID", undefined)
      setStore("title", undefined)
      setStore("cost", 0)
      setStore("lastResultCost", 0)
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
      batch(() => {
        setStore("sessionID", id)
        setStore("title", title)
        setStore("view", "session")
        setStore("engine", engine)
        if (used) setStore("model", used)
        if (harnessModel(store.model)?.harness.id !== engine) setStore("model", "opencode-zen/big-pickle")
        setStore("effort", sessionEffort(id, store.model))
      })
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
    })
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
    if (toolName === "AskUserQuestion" && config.askQuestions === false) {
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
    if (config.autoAllow && toolName !== "AskUserQuestion" && toolName !== "ExitPlanMode" && store.mode !== "plan") {
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

  function finishTurn(info                     = {}) {
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
        if (message.parent_tool_use_id) return
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
    setStore("messages", (list) => [...list, { type: "notice", id: randomUUID(), text, variant, markdown }])
  }

  // Live context while a reply streams: the request's input tokens (message_start) plus an estimate of the
  // output so far (~4 characters a token). The exact numbers replace it when the step ends.
  let liveBase = 0
  let liveOutput = 0
  let liveShown = 0
  function liveTokens(chars        ) {
    if (!chars) return
    liveOutput += chars / 4
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
          if (part.type === "reasoning") part.end = Date.now()
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
      // Claude Code's stand-in reply when a request fails (e.g. a usage limit): show it once, as the error.
      if (msg.model === "<synthetic>") {
        const text = syntheticText(msg)
        if (text && !turn.error) turn.error = text
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
            if (kind === "text" && !value?.trim()) continue
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
    if (refusal && !splitModel(store.model)) markLimitHit(/weekly|7.?day/i.test(refusal) ? "seven_day" : /session|5.?hour/i.test(refusal) ? "five_hour" : undefined, resetsAt)
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
      out.push({ type: "user", id: entry.uuid, text, files: [], attachments: attachments.length ? attachments : undefined })
      continue
    }
    if (entry.type === "assistant") {
      if (!turn) {
        turn = { type: "assistant", id: randomUUID(), parts: [], agent: "build", model: msg?.model && msg.model !== "<synthetic>" ? msg.model : "", start: 0, end: 0 }
        out.push(turn)
      }
      turn.sdkUuid = entry.uuid
      if (msg?.model === "<synthetic>") {
        // Claude Code's stand-in reply for a failed request (usage limit, API error): it is the turn's error.
        const text = syntheticText(msg)
        if (text && !turn.error) turn.error = text
        continue
      }
      if (msg?.model) turn.model = msg.model
      for (const block of msg?.content ?? []) {
        if (block.type === "text" && block.text?.trim())
          turn.parts.push({ type: "text", id: randomUUID(), text: block.text, done: true })
        else if (block.type === "thinking" && block.thinking?.trim())
          turn.parts.push({ type: "reasoning", id: randomUUID(), text: block.thinking, start: 0, end: 0 })
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
  return out
}
