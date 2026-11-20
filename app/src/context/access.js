// Access settings, per harness (sidebar, above the harness line; Settings → Access…): what the agent may do —
// permission prompts, installing software, downloading files, the web, tests, questions. Claude Code, opencode,
// DeepSeek Harness and Codex each keep their own; one click copies one harness's settings to the others.
// A harness that has no value of its own yet takes the earlier global setting (config[key]), then the default, so
// nothing changes for anyone until a setting is changed here.
import { config, saveConfig } from "./config"
import { HARNESSES } from "./harnesses"

export const ACCESS = [
  { key: "autoAllow", title: "Allow everything", description: "no permission prompts (questions and leaving plan mode still ask)", fallback: false },
  { key: "installTools", title: "Install software", description: "programs, packages and libraries, when it clearly pays off", fallback: false },
  // Before this switch, "install off" also meant "no downloads": it follows Install software until set.
  { key: "downloads", title: "Download files", description: "model weights, datasets, archives, documents (official sources)", fallback: undefined },
  { key: "web", title: "Web access", description: "search the web and read pages", fallback: true },
  { key: "runTests", title: "Run tests", description: "test suites and type/lint checks", fallback: true },
  { key: "askQuestions", title: "Clarifying questions", description: "may stop to ask you", fallback: true },
  { key: "preferTools", title: "Prefer installed tools", description: "use the machine's tools instead of generating the same work", fallback: true },
]

/** Claude Code ("claude"), then each harness by its engine id. */
export const ACCESS_ENGINES = [{ id: "claude", name: "Claude Code" }, ...HARNESSES.map((harness) => ({ id: harness.id, name: harness.name }))]

/** A tab's engine (undefined: Claude Code) as an access id. */
export const accessEngine = (engine) => engine || "claude"
export const accessEngineName = (engine) => ACCESS_ENGINES.find((item) => item.id === accessEngine(engine))?.name ?? engine

/** The access settings a harness works with. */
export function accessFor(engine) {
  const own = config.harnessAccess?.[accessEngine(engine)] ?? {}
  const out = {}
  for (const item of ACCESS) {
    const fallback = item.key === "downloads" ? out.installTools : item.fallback
    out[item.key] = own[item.key] ?? config[item.key] ?? fallback
  }
  return out
}

/** Change one setting of one harness (it then keeps all of them as its own). */
export function setAccess(engine, key, value) {
  const id = accessEngine(engine)
  config.harnessAccess = { ...(config.harnessAccess ?? {}), [id]: { ...accessFor(id), [key]: value } }
  saveConfig()
}

/** Copy one harness's access settings to the others given (ids). */
export function syncAccess(from, targets) {
  const source = accessFor(from)
  const all = { ...(config.harnessAccess ?? {}) }
  for (const id of targets) if (id !== accessEngine(from)) all[id] = { ...source }
  config.harnessAccess = all
  saveConfig()
}

/** A few words for the sidebar: what is off (or on, for "Allow everything"). */
export function accessSummary(engine) {
  const access = accessFor(engine)
  const off = [
    !access.installTools && "no installs",
    !access.downloads && "no downloads",
    !access.web && "no web",
    !access.runTests && "no tests",
    !access.askQuestions && "no questions",
  ].filter(Boolean)
  const parts = [access.autoAllow && "allow all", ...off].filter(Boolean)
  return parts.length ? parts.join(" · ") : "everything allowed"
}
