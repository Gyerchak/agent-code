import { mkdirSync, readFileSync, watchFile, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { log } from "./log"
import { stateDir } from "./paths"

// ---------------------------------------------------------------------------
// Exact plan usage from Anthropic (the same endpoint Claude Code's /usage reads).
// Works for claude.ai subscriptions logged in through Claude Code; API-key users
// have no plan windows and get `undefined`.
// ---------------------------------------------------------------------------


/** Claude's "extra usage" (usage credits that cover you past the plan limits), in minor currency units. */

/** Every limit window Anthropic reports (session, weekly, per-model weekly, …), for auto-resume. */


/**
 * The claude.ai plan of the logged-in account, from Anthropic itself (GET /api/oauth/profile: organization type
 * and rate-limit tier), so a plan change shows at once. Claude Code's credentials file keeps the plan it saw at
 * login (it said "pro" long after an upgrade to Max) and is only the fallback. Cached 30 minutes, shared by
 * every occ window. Undefined for API-key logins.
 */
export async function planDetails() {
  const shared = readProfileCache()
  if (shared?.plan && Date.now() - shared.time < 30 * 60_000) return shared.plan
  const token = await accessToken()
  if (token) {
    try {
      const response = await fetch("https://api.anthropic.com/api/oauth/profile", {
        headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", "Content-Type": "application/json" },
        signal: AbortSignal.timeout(15_000),
      })
      if (response.ok) {
        const body = await response.json()
        const org = body?.organization ?? {}
        const type = String(org.organization_type ?? "").replace(/^claude_/, "") || (body?.account?.has_claude_max ? "max" : body?.account?.has_claude_pro ? "pro" : undefined)
        const multiple = String(org.rate_limit_tier ?? "").match(/(\d+)x$/)?.[1]
        const plan = type ? { type, label: planLabel(type, multiple), status: org.subscription_status } : undefined
        writeProfileCache(plan)
        return plan
      }
    } catch (error) {
      log("plan profile error", String(error))
    }
  }
  // Fallback: what Claude Code stored at login.
  try {
    const data = JSON.parse(await readFile(credentialsFile(), "utf8"))
    const type = data?.claudeAiOauth?.subscriptionType
    return type ? { type, label: planLabel(type) } : undefined
  } catch {
    return undefined
  }
}

/** Kept for callers that only want the plan's type ("pro", "max", "team", …). */
export async function planType() {
  return (await planDetails())?.type
}

const PLAN_NAMES = { pro: "Pro", max: "Max", team: "Team", enterprise: "Enterprise", free: "Free" }
function planLabel(type, multiple) {
  const name = PLAN_NAMES[type] ?? type.charAt(0).toUpperCase() + type.slice(1)
  return multiple && multiple !== "1" ? `${name} ${multiple}×` : name
}

function readProfileCache() {
  try {
    return JSON.parse(readFileSync(path.join(sharedDir, "plan-profile.json"), "utf8"))
  } catch {
    return undefined
  }
}
/** Forget the cached plan (after logging in or out, the account may be another one). */
export function forgetPlan() {
  writeProfileCache(undefined)
}

function writeProfileCache(plan) {
  try {
    mkdirSync(sharedDir, { recursive: true })
    writeFileSync(path.join(sharedDir, "plan-profile.json"), JSON.stringify({ time: Date.now(), plan }))
  } catch {}
}

function extra(body     )                         {
  const spend = body?.spend
  if (!spend?.used) return undefined
  const minor = (value     ) => (value && typeof value.amount_minor === "number" ? value.amount_minor : undefined)
  return {
    enabled: !!spend.enabled,
    used: minor(spend.used) ?? 0,
    limit: minor(spend.limit) ?? minor(spend.cap),
    currency: spend.used.currency ?? "USD",
    exponent: spend.used.exponent ?? 2,
    canToggle: !!spend.can_toggle,
  }
}

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage"

// The endpoint rate-limits frequent callers (HTTP 429): back off, honouring Retry-After.
let pausedUntil = 0
let backoff = 0

function credentialsFile() {
  const dir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude")
  return path.join(dir, ".credentials.json")
}

/** OAuth access token from Claude Code's credential store (Linux/Windows file; macOS keeps it in the Keychain). */
async function accessToken()                              {
  try {
    const data = JSON.parse(await readFile(credentialsFile(), "utf8"))
    const oauth = data?.claudeAiOauth
    if (!oauth?.accessToken) return undefined
    if (typeof oauth.expiresAt === "number" && oauth.expiresAt < Date.now()) return undefined
    return oauth.accessToken
  } catch {
    return undefined
  }
}

function window(raw     )                         {
  if (!raw || typeof raw.utilization !== "number") return undefined
  return { utilization: Math.round(raw.utilization * 10) / 10, resetsAt: raw.resets_at ? Date.parse(raw.resets_at) : undefined }
}

/**
 * Fetch the live 5-hour and weekly windows. Returns undefined when no OAuth token is readable
 * (macOS Keychain, API key login, expired token) so callers can fall back to the SDK.
 */
// Every occ window polls; share one result (and one backoff) through a file so they don't trip the 429 limit together.
// One file for every occ process on the machine. An occ-box has its own state folder (XDG_STATE_HOME), so it
// gets the main one from its launcher (OCC_SHARED_STATE); otherwise each box polled alone and got rate limited.
const sharedDir =
  process.env.OCC_SHARED_STATE ||
  (process.env.OCC_BOX_DIR ? path.join(process.env.OCC_MAIN_STATE || path.join(os.homedir(), ".local", "state"), "open-claude-code") : stateDir)
const sharedFile = path.join(sharedDir, "plan-usage.json")

function readShared()         {
  try {
    return JSON.parse(readFileSync(sharedFile, "utf8"))
  } catch {
    return {}
  }
}
function writeShared(shared        ) {
  try {
    mkdirSync(sharedDir, { recursive: true })
    writeFileSync(sharedFile, JSON.stringify(shared))
  } catch {}
}

/** `force`: skip the shared 100 s cache (after a limit hit the cached reading is out of date). */
/** Share numbers this window learned some other way (a live reading, a refused request) with the others. */
export function publishPlanUsage(usage           ) {
  writeShared({ ...readShared(), time: Date.now(), usage })
}

/**
 * Call `fn` whenever another occ window writes new numbers to the shared file (checked every 2 s), so every
 * window shows the same usage within seconds instead of at its own next 2-minute poll.
 */
export function onSharedPlanUsage(fn                            ) {
  let seen = readShared().time ?? 0
  watchFile(sharedFile, { interval: 2000, persistent: false }, () => {
    const shared = readShared()
    if (!shared.usage || !shared.time || shared.time === seen) return
    seen = shared.time
    fn(shared.usage)
  })
}

export async function fetchPlanUsage(force = false)                                 {
  const shared = readShared()
  const fresh = !force && shared.usage && shared.time && Date.now() - shared.time < 100_000
  if (fresh) return shared.usage
  if (Date.now() < Math.max(pausedUntil, shared.pausedUntil ?? 0)) {
    // Backing off: a result up to 15 minutes old is still better than the partial stream events.
    return shared.usage && shared.time && Date.now() - shared.time < 15 * 60_000 ? shared.usage : undefined
  }
  const token = await accessToken()
  if (!token) return undefined
  try {
    const response = await fetch(USAGE_URL, {
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15_000),
    })
    if (response.status === 429) {
      const retry = Number(response.headers.get("retry-after"))
      backoff = Math.min(15 * 60_000, backoff ? backoff * 2 : 2 * 60_000)
      pausedUntil = Date.now() + (retry > 0 ? retry * 1000 : backoff)
      log("plan usage rate limited until", new Date(pausedUntil).toISOString())
      writeShared({ ...shared, pausedUntil })
      return shared.usage && shared.time && Date.now() - shared.time < 15 * 60_000 ? shared.usage : undefined
    }
    if (!response.ok) {
      log("plan usage http", response.status)
      return undefined
    }
    backoff = 0
    const body      = await response.json()
    const all               = []
    for (const [key, raw] of Object.entries     (body ?? {})) {
      if (/^(five_hour|seven_day)/.test(key)) {
        const w = window(raw)
        if (w) all.push(w)
      }
    }
    for (const item of body?.limits ?? []) {
      if (typeof item?.percent === "number") all.push({ utilization: item.percent, resetsAt: item.resets_at ? Date.parse(item.resets_at) : undefined })
    }
    const usage = { fiveHour: window(body.five_hour), week: window(body.seven_day), extra: extra(body), all }
    writeShared({ time: Date.now(), usage })
    return usage
  } catch (error) {
    log("plan usage error", error)
    return undefined
  }
}

/**
 * True when a turn failed because a plan limit was reached. Claude Code rewords this now and then ("session limit",
 * "5-hour limit", "weekly limit", "limit"), so match the shape of the sentence, not a list of window names.
 */
export function isLimitError(text                    ) {
  return !!text && /\b(hit|reached) your\b[^.\n]{0,40}\blimit\b|usage limit reached|(?<!context |token )limit exceeded|rate.?limit|\b429\b/i.test(text)
}

/** Epoch ms of a wall-clock time in `zone` (the machine's own zone when none is named or it is unknown). */
function zonedTime(year        , month        , day        , hour        , minute        , zone         ) {
  if (zone) {
    try {
      const guess = Date.UTC(year, month, day, hour, minute)
      const parts = Object.fromEntries(
        new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" })
          .formatToParts(guess)
          .map((part) => [part.type, part.value]),
      )
      const shown = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute))
      return guess - (shown - guess)
    } catch {}
  }
  return new Date(year, month, day, hour, minute).getTime()
}

/** Today's calendar date in `zone`. */
function zonedDate(now        , zone         ) {
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(now).map((part) => [part.type, part.value]),
    )
    return { year: Number(parts.year), month: Number(parts.month) - 1, day: Number(parts.day) }
  } catch {
    const date = new Date(now)
    return { year: date.getFullYear(), month: date.getMonth(), day: date.getDate() }
  }
}

/**
 * The reset time a refusal states: "resets 12:40am (Europe/Warsaw)", "resets 6pm", "resets Nov 4, 1am (Europe/Warsaw)".
 * Undefined when there is none, or when it has only just passed (a retry refused right after the reset: reading it
 * as tomorrow would sleep a whole day, so the caller falls back to its short backoff).
 */
export function limitResetTime(text                    , now = Date.now())                     {
  const match = text?.match(/\bresets\s+(?:([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+)?(\d{1,2})(?::(\d{2}))?\s*(?:([ap])\.?m\.?)?(?:\s*\(([^)]+)\))?/i)
  if (!match) return undefined
  const [, monthName, dayText, hourText, minuteText, meridiem, zone] = match
  if (!meridiem && !minuteText) return undefined
  let hour = Number(hourText)
  if (meridiem) hour = (hour % 12) + (meridiem.toLowerCase() === "p" ? 12 : 0)
  const minute = Number(minuteText ?? 0)
  if (hour > 23 || minute > 59) return undefined
  const today = zonedDate(now, zone)
  if (monthName) {
    const month = "janfebmaraprmayjunjulaugsepoctnovdec".indexOf(monthName.slice(0, 3).toLowerCase()) / 3
    if (!Number.isInteger(month) || month < 0) return undefined
    let when = zonedTime(today.year, month, Number(dayText), hour, minute, zone)
    if (when < now - 30 * 86_400_000) when = zonedTime(today.year + 1, month, Number(dayText), hour, minute, zone)
    return when > now ? when : undefined
  }
  const when = zonedTime(today.year, today.month, today.day, hour, minute, zone)
  if (when > now) return when
  if (when > now - 15 * 60_000) return undefined
  return zonedTime(today.year, today.month, today.day + 1, hour, minute, zone)
}
