// Several logins per provider (Settings → Logins…, /logins). The main one is what Agent Code used before: Claude
// Code's own login for Claude, the saved key for a provider. More can be added: for Claude a token from
// `claude setup-token` (signed in with the other account; Claude Code takes it as CLAUDE_CODE_OAUTH_TOKEN, so the
// conversations stay where they are), for a provider another API key.
//
// Which one is used: the preferred one (main unless picked), and with "next login at a limit" on, a login that hit
// a limit is passed over until that limit resets — then the work comes back to the preferred one by itself. Blocks
// are kept in the config (they outlive a restart). Secrets stay in Agent Code's auth.json only.
import { readAuthFile, writeAuthEntries } from "./auth"
import { config, saveConfig } from "./config"

const PREFIX = "login:"
const ownKey = (provider, id) => `${PREFIX}${provider}:${id}`

/** A provider's logins, main first: [{ id, label, main, secret }] (the main one's secret is not here). */
export function loginsOf(provider) {
  const extra = Object.entries(readAuthFile())
    .filter(([key, value]) => key.startsWith(`${PREFIX}${provider}:`) && value?.type === "login" && value.secret)
    .map(([key, value]) => ({ id: key.slice(`${PREFIX}${provider}:`.length), label: value.label || "Another login", secret: value.secret, added: value.added }))
    .sort((a, b) => (a.added ?? 0) - (b.added ?? 0))
  return [{ id: "main", label: provider === "anthropic" ? "Main login (Claude Code's)" : "Main key", main: true }, ...extra]
}

export function addLogin(provider, label, secret) {
  const id = `l${Date.now().toString(36)}`
  writeAuthEntries(() => false, { [ownKey(provider, id)]: { type: "login", provider, label: String(label || "Another login").slice(0, 60), secret: String(secret).trim(), added: Date.now() } })
  return id
}

export function removeLogin(provider, id) {
  if (id === "main") return
  writeAuthEntries((key) => key === ownKey(provider, id), {})
  const rule = rules(provider)
  if (rule.prefer === id) setRule(provider, { prefer: "main" })
}

const rules = (provider) => ({ prefer: "main", rotate: false, ...(config.logins?.[provider] ?? {}) })

/** { prefer: login id, rotate: go on with the next login when one hits a limit }. */
export const loginRule = rules

export function setRule(provider, change) {
  config.logins = { ...(config.logins ?? {}), [provider]: { ...rules(provider), ...change } }
  saveConfig()
}

/** Until when a login is passed over (it hit a limit), or undefined. */
export function blockedUntil(provider, id) {
  const until = config.loginBlocks?.[`${provider}:${id}`]
  return until && until > Date.now() ? until : undefined
}

export function blockLogin(provider, id, until) {
  const all = { ...(config.loginBlocks ?? {}) }
  for (const [key, value] of Object.entries(all)) if (!(value > Date.now())) delete all[key]
  all[`${provider}:${id}`] = until
  config.loginBlocks = all
  saveConfig()
}

/**
 * The login to use now: the preferred one; with rotation on, the first that isn't blocked, starting from the
 * preferred one (then main, then the others in the order they were added). All blocked: the one free soonest.
 */
export function chosenLogin(provider) {
  const list = loginsOf(provider)
  const rule = rules(provider)
  const preferred = list.find((item) => item.id === rule.prefer) ?? list[0]
  if (!rule.rotate || list.length < 2) return preferred
  const order = [preferred, ...list.filter((item) => item !== preferred)]
  const free = order.find((item) => !blockedUntil(provider, item.id))
  if (free) return free
  return order.reduce((a, b) => ((blockedUntil(provider, b.id) ?? 0) < (blockedUntil(provider, a.id) ?? 0) ? b : a))
}

export const loginLabel = (provider, id) => loginsOf(provider).find((item) => item.id === id)?.label ?? id

// ---------------------------------------------------------------------------------------------------------------
// API keys for the proxy: the provider's keys in order (main first), those blocked by a rate or credit limit last.
// ---------------------------------------------------------------------------------------------------------------

const keyBlocks = new Map()

/** The keys to try for a provider: its preferred / unblocked ones first. */
export function keysFor(provider, mainKey) {
  const list = loginsOf(provider).map((item) => ({ id: item.id, key: item.main ? mainKey : item.secret })).filter((item) => item.key)
  if (list.length < 2) return list.map((item) => item.key)
  const rule = rules(provider)
  const preferred = list.find((item) => item.id === rule.prefer) ?? list[0]
  // Without "next login at a limit": only the preferred key.
  if (!rule.rotate) return [preferred.key]
  const order = [preferred, ...list.filter((item) => item !== preferred)]
  const now = Date.now()
  const open = order.filter((item) => !((keyBlocks.get(item.key) ?? 0) > now))
  return [...open, ...order.filter((item) => !open.includes(item))].map((item) => item.key)
}

/** A key answered "too many requests" / "out of credit": try the others first for a while. */
export function blockKey(key, ms) {
  keyBlocks.set(key, Date.now() + Math.max(30_000, ms ?? 15 * 60_000))
}
