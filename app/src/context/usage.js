import { mkdirSync, readFileSync, watchFile, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
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
        const plan = type ? { type, label: planLabel(type, multiple), status: org.subscription_status, org: org.uuid } : undefined
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

const PLAN_NAMES = { pro: "Pro", max: "Max", ultra: "Ultra", team: "Team", enterprise: "Enterprise", free: "Free" }
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
// `time` is when the shared numbers last changed (other windows pick them up); `fetched` is when they last came from
// Anthropic. Only `fetched` makes a reading fresh: windows republishing their own live numbers used to keep the
// cache "fresh" for good, so after a reset (a new weekly date) nobody asked Anthropic again.
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

/** A window in the shared reading has reset since Anthropic was last asked: its numbers and next date are new. */
function passedReset(shared) {
  const windows = [shared.usage?.fiveHour, shared.usage?.week, ...(shared.usage?.all ?? [])]
  return windows.some((w) => w?.resetsAt && w.resetsAt <= Date.now() && w.resetsAt > (shared.fetched ?? 0))
}

export async function fetchPlanUsage(force = false)                                 {
  const shared = readShared()
  const fresh = !force && shared.usage && shared.fetched && Date.now() - shared.fetched < 100_000 && !passedReset(shared)
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
    // Per-model weekly limits (Fable on Max and up: at most a share of the weekly limit). Tagged with the model so
    // a tab on another model doesn't wait for (or pause before) a limit that isn't its own.
    const scoped = []
    const shares = body?.weekly_scoped_shares ?? []
    ;(body?.limits ?? []).forEach((item, index) => {
      if (typeof item?.percent !== "number") return
      const model = item.kind === "weekly_scoped" ? item.scope?.model?.display_name || undefined : undefined
      const entry = { utilization: item.percent, resetsAt: item.resets_at ? Date.parse(item.resets_at) : undefined, ...(model ? { model } : {}) }
      all.push(entry)
      if (model) {
        const share = shares.find((s) => s?.limit_index === index)
        scoped.push({ ...entry, name: model, allowance: share?.allowance_percent_of_weekly, ofWeekly: share?.used_percent_of_weekly })
      }
    })
    // No five_hour window (and no "session" limit) means the plan has no rolling limit (Ultra).
    const rolling = !!body.five_hour || (body?.limits ?? []).some((item) => item?.kind === "session")
    const usage = { fiveHour: window(body.five_hour), week: window(body.seven_day), extra: extra(body), all, scoped, rolling }
    writeShared({ time: Date.now(), fetched: Date.now(), usage })
    return usage
  } catch (error) {
    log("plan usage error", error)
    return undefined
  }
}

// ---------------------------------------------------------------------------
// What the plan is worth. Claude Code prices every turn at API rates (total_cost_usd); set against how far the
// weekly meter moved meanwhile, that gives "API dollars per 1 % of the weekly limit" for this account, and from
// the plan's price the share of the API price a plan token really costs. Shared by every occ window; work done
// outside occ (claude.ai, another Claude Code) also moves the meter, so the estimate errs on the expensive side.
// ---------------------------------------------------------------------------

const rateFile = () => path.join(sharedDir, "plan-rate.json")
function readRate() {
  try {
    return JSON.parse(readFileSync(rateFile(), "utf8")) ?? {}
  } catch {
    return {}
  }
}
function writeRate(rate) {
  try {
    mkdirSync(sharedDir, { recursive: true })
    writeFileSync(rateFile(), JSON.stringify(rate))
  } catch {}
}

/** A plan-billed Claude turn cost `dollars` at API prices. */
export function notePlanSpend(dollars) {
  if (!(dollars > 0)) return
  const rate = readRate()
  writeRate({ ...rate, spent: (rate.spent ?? 0) + dollars })
}

/** A fresh weekly reading (percent): once it moved 2 points, fold the dollars spent meanwhile into the estimate. */
export function samplePlanRate(week, plan) {
  if (typeof week !== "number") return
  const rate = readRate()
  // A new plan or a weekly reset starts over from here.
  if (rate.base === undefined || week < rate.base || rate.plan !== plan) return writeRate({ ...rate, base: week, spent: 0, plan, ...(rate.plan !== plan ? { perPercent: undefined, samples: 0 } : {}) })
  const grew = week - rate.base
  if (grew < 2) return
  if (!(rate.spent > 0)) return writeRate({ ...rate, base: week, spent: 0 })
  const sample = rate.spent / grew
  const perPercent = rate.perPercent ? rate.perPercent * 0.7 + sample * 0.3 : sample
  writeRate({ ...rate, base: week, spent: 0, perPercent, samples: (rate.samples ?? 0) + 1, time: Date.now() })
}

// Monthly list prices of the claude.ai plans (USD); `planPrice` in the config overrides them.
const PLAN_PRICES = { pro: 20, "max 5×": 100, "max 20×": 200, max: 100 }

/**
 * The measured worth of the plan: `perPercent` (API $ per 1 % of the weekly limit), `monthly` (API $ the plan
 * covers in a month at full use) and `factor` (what a plan token costs as a share of its API price), or
 * undefined until there is a measurement.
 */
export function planRate(label, price) {
  const rate = readRate()
  if (!rate.perPercent || (label && rate.plan && rate.plan !== label)) return undefined
  const monthly = rate.perPercent * 100 * (30.44 / 7)
  const cost = price ?? PLAN_PRICES[String(label ?? "").toLowerCase()]
  return { perPercent: rate.perPercent, monthly, factor: cost ? cost / monthly : undefined, samples: rate.samples ?? 1 }
}

// ---------------------------------------------------------------------------
// Limit resets Anthropic sometimes offers at the 5-hour wall ("Reset your 5-hour limit now · uses weekly limit ·
// 1/week", or reset grants from an event). Read from the usage endpoint's at-the-wall view, claimed with the same
// request Claude Code's /limit-reset makes. occ only shows what Anthropic says is available to it.
// ---------------------------------------------------------------------------

let offerLast = 0
let offerCached

/** The reset offer available right now, or undefined. Throttled to one read a minute unless forced. */
export async function fetchResetOffer(force = false) {
  if (!force && Date.now() - offerLast < 60_000) return offerCached
  offerLast = Date.now()
  const token = await accessToken()
  if (!token) return (offerCached = undefined)
  try {
    const response = await fetch(`${USAGE_URL}?at_wall=1&skip_spend=1`, {
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) return offerCached
    return (offerCached = readOffer(await response.json()))
  } catch (error) {
    log("reset offer error", String(error))
    return offerCached
  }
}

function readOffer(body) {
  const grants = body?.cedar_ember
  if (grants?.eligible) {
    const grant = (grants.grants ?? []).find((g) => g?.id === grants.next_grant_id) ?? (grants.grants ?? []).find((g) => g?.usable_now && g?.resets_left > 0 && !g?.paused)
    if (grant?.usable_now && grant.resets_left > 0 && !grant.paused)
      return { program: "cedar_ember", grant: grant.id, label: grant.label || "limit reset", left: grant.resets_left, weekly: !grant.gives_back_weekly }
  }
  const tide = body?.juniper_tide
  if (tide?.eligible && tide.available) return { program: "juniper_tide", label: "5-hour limit reset", left: tide.resets_per_week ?? 1, weekly: true }
  return undefined
}

/** Claim an offer. Resolves to "reset" when the limit was reset, otherwise the reason it wasn't. */
export async function claimResetOffer(offer) {
  const token = await accessToken()
  let org = (await planDetails())?.org
  if (!org) {
    forgetPlan() // a cached plan from before occ kept the organization
    org = (await planDetails())?.org
  }
  if (!token || !org) return "auth_error"
  const body = offer.program === "cedar_ember" ? { program: offer.program, grant_id: offer.grant, request_id: crypto.randomUUID().replace(/-/g, "") } : { program: offer.program }
  try {
    const response = await fetch(`https://api.anthropic.com/api/organizations/${encodeURIComponent(org)}/reset_rate_limits`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25_000),
    })
    offerCached = undefined
    offerLast = 0
    if (response.status === 401 || response.status === 403) return "auth_error"
    if (response.status === 429) return "rate_limited"
    const data = await response.json().catch(() => ({}))
    if (!response.ok) return "error"
    log("limit reset claim", data?.result)
    return data?.result ?? "error"
  } catch (error) {
    log("limit reset claim error", String(error))
    return "error"
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
