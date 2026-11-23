// Several logins per provider (Settings → Logins…, /logins). The main one is what Agent Code used before: Claude
// Code's own login for Claude, the saved key for a provider. More can be added: for Claude a token from
// `claude setup-token` (signed in with the other account; Claude Code takes it as CLAUDE_CODE_OAUTH_TOKEN, so the
// conversations stay where they are), for a provider another API key.
//
// Which one is used: a project (folder) can be tied to one login — it then always uses that one, and a login tied to
// projects is kept for them. Elsewhere the preferred login (main unless picked). For Claude there is no switching at
// a limit: Anthropic's Usage Policy forbids using several accounts to get around its limits (see CLAUDE_TERMS); for
// a provider's keys "next key at a limit" can be switched on (each provider's terms apply). Secrets stay in Agent
// Code's auth.json only.

/** What Anthropic's terms say about several accounts and plan limits (shown in the Logins dialog, with links). */
export const CLAUDE_TERMS = [
  { text: "Don't create or use several accounts to avoid detection or get around product guardrails (Usage Policy)", url: "https://www.anthropic.com/legal/aup" },
  { text: "Plan limits assume ordinary, individual use of Claude Code and the Agent SDK", url: "https://code.claude.com/docs/en/legal-and-compliance" },
  { text: "Each person signs in with their own plan; credentials aren't shared or used on others' behalf", url: "https://code.claude.com/docs/en/legal-and-compliance" },
  { text: "To go on past a limit, the allowed way is usage credits (extra usage)", url: "https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans" },
]
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

// Claude never switches logins at a limit (Anthropic's terms); providers' keys may.
const rules = (provider) => ({ prefer: "main", rotate: false, ...(config.logins?.[provider] ?? {}), ...(provider === "anthropic" ? { rotate: false } : {}) })

/** The folder a project is tied to a login under, for a working folder (the closest tied folder above it). */
export function projectTie(provider, cwd) {
  const ties = config.projectLogins?.[provider] ?? {}
  let best
  for (const folder of Object.keys(ties)) if (cwd && (cwd === folder || cwd.startsWith(folder.endsWith("/") ? folder : `${folder}/`)) && (!best || folder.length > best.length)) best = folder
  return best ? { folder: best, id: ties[best] } : undefined
}

/** Tie a project folder to a login (no id: untie it). */
export function setProjectTie(provider, folder, id) {
  const ties = { ...(config.projectLogins?.[provider] ?? {}) }
  if (id) ties[folder] = id
  else delete ties[folder]
  config.projectLogins = { ...(config.projectLogins ?? {}), [provider]: ties }
  saveConfig()
}

/** Every tied project: [{ folder, id }]. */
export const projectTies = (provider) => Object.entries(config.projectLogins?.[provider] ?? {}).map(([folder, id]) => ({ folder, id }))

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
 * The login to use now in a working folder: the project's own when it is tied to one; else the preferred one (a
 * login tied to other projects is kept for them: then main); with rotation on (providers' keys only), the first that
 * isn't blocked, starting from the preferred one. All blocked: the one free soonest.
 */
export function chosenLogin(provider, cwd) {
  const list = loginsOf(provider)
  const tie = projectTie(provider, cwd)
  const tied = tie && list.find((item) => item.id === tie.id)
  if (tied) return { ...tied, tied: tie.folder }
  const reserved = new Set(projectTies(provider).map((item) => item.id).filter((id) => id !== "main"))
  const rule = rules(provider)
  const free = list.filter((item) => !reserved.has(item.id))
  const preferred = free.find((item) => item.id === rule.prefer) ?? free[0] ?? list[0]
  if (!rule.rotate || free.length < 2) return preferred
  const order = [preferred, ...free.filter((item) => item !== preferred)]
  const open = order.find((item) => !blockedUntil(provider, item.id))
  if (open) return open
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
