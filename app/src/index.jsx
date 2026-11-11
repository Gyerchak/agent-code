import * as opentuiCore from "@opentui/core"
import { createCliRenderer } from "@opentui/core"
import * as opentuiSolid from "@opentui/solid"
import { render } from "@opentui/solid"
import * as solid from "solid-js"
import * as solidStore from "solid-js/store"
import { createRoot } from "solid-js"
import { statSync } from "node:fs"
import { App } from "./app"
import { refreshCatalog } from "./context/catalog"
import { refreshProviders } from "./context/providers"
import { setExitHandler } from "./context/app"
import { log } from "./context/log"
import { flushConfig } from "./context/config"
import { active, app, continueLast, flushTabs, initTabs, disposeAll, openSession, refreshSessions, restoreTabs, setApp, startFresh } from "./context/tabs"
import { setSyntaxOwner, theme } from "./context/theme"
import { builtins } from "./feature-plugins/builtins"
import { provideHostModules } from "./plugin/loader"
import { registerBuiltin, reportSlotError, startPlugins, stopPlugins } from "./plugin/runtime"
import { setupSlots } from "./plugin/slots"
import { autostartPhoneServer, stopPhoneServer } from "./context/remote"

function parseArgs(argv          ) {
  const args                                                                                                                     = {}
  const rest           = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "-c" || arg === "--continue") args.continue = true
    else if (arg === "-r" || arg === "--resume" || arg === "-s" || arg === "--session") {
      const next = argv[i + 1]
      if (next && !next.startsWith("-")) {
        args.resume = next
        i++
      } else args.resume = true
    } else if (arg === "-m" || arg === "--model") args.model = argv[++i]
    else if (arg === "-p" || arg === "--prompt") args.prompt = argv[++i]
    else if (arg === "-h" || arg === "--help") args.help = true
    else if (arg === "-v" || arg === "--version") args.version = true
    else if (arg === "--cwd" || arg === "--dir") process.chdir(argv[++i])
    else rest.push(arg)
  }
  if (rest.length) {
    const first = rest[0]
    try {
      // `agentcode <dir>` opens a project directory, like `opencode <dir>`.
      const stat = statSync(first)
      if (stat.isDirectory()) {
        process.chdir(first)
        rest.shift()
      }
    } catch {}
  }
  if (rest.length && !args.prompt) args.prompt = rest.join(" ")
  return args
}

const args = parseArgs(process.argv.slice(2))

if (args.help) {
  console.log(`Agent Code — one terminal for every coding agent (Claude Code, opencode, DeepSeek Harness, Codex)

Usage: agentcode [dir] [prompt] [options]

Options:
  -c, --continue        Continue the most recent session in this directory
  -r, --resume [id]     Resume a session (opens the session list without an id)
  -m, --model <model>   Model alias or id (opus, sonnet, haiku, claude-opus-5-5, …)
  -p, --prompt <text>   Send a prompt on start
  -h, --help            Show this help`)
  process.exit(0)
}

setApp("cwd", process.cwd())
if (args.model) setApp("defaultModel", args.model)
initTabs()
// Plugins import these and must get Agent Code's instances (one Solid runtime, one renderer).
provideHostModules({ "solid-js": solid, "solid-js/store": solidStore, "@opentui/solid": opentuiSolid, "@opentui/core": opentuiCore })

const renderer = await createCliRenderer({
  externalOutputMode: "passthrough",
  targetFps: 60,
  gatherStats: false,
  exitOnCtrlC: false,
  useKittyKeyboard: {},
  autoFocus: false,
  openConsoleOnError: false,
  useMouse: true,
  backgroundColor: theme.background,
})

setSyntaxOwner((renderer       ).nativeScene)
setupSlots(renderer, { theme }, reportSlotError)
for (const plugin of builtins) registerBuiltin(plugin)

let exiting = false
async function shutdown(code = 0) {
  if (exiting) return
  exiting = true
  const sessionID = active().store.sessionID
  const hasMessages = active().store.messages.length > 0
  flushTabs()
  flushConfig()
  stopPhoneServer()
  void stopPlugins().catch(() => {})
  disposeAll()
  setTimeout(() => process.exit(code), 50)
  // The terminal may already be gone (window closed): nothing left to restore or print to.
  try {
    renderer.destroy()
    if (sessionID && hasMessages) process.stdout.write(`\n  \x1b[2mContinue\x1b[0m  agentcode -r ${sessionID}\n\n`)
  } catch {}
}
setExitHandler((code) => void shutdown(code ?? 0))
process.on("SIGTERM", () => void shutdown(0))
process.on("SIGHUP", () => void shutdown(0))
process.on("uncaughtException", (error                       ) => {
  log("uncaught", error)
  // A dead terminal: every further write fails the same way, so save the tabs and leave.
  if (error?.code === "EIO" || error?.code === "EPIPE") void shutdown(0)
})
process.on("unhandledRejection", (error) => log("unhandled", error))

// The terminal's own background takes the theme's colour (OSC 11), so the strip a terminal leaves around the cell
// grid (window size not a multiple of the cell size, padding) looks filled instead of showing another colour.
const paintTerminal = () => {
  try {
    const [r, g, b] = theme.background.toInts()
    process.stdout.write(`\x1b]11;#${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}\x07`)
  } catch {}
}
createRoot(() => solid.createEffect(paintTerminal))
process.on("exit", () => {
  try {
    process.stdout.write("\x1b]111\x07")
  } catch {}
})

void render(() => <App />, renderer)

void startPlugins(renderer).catch((error) => log("plugins error", error))

// The phone server (/phone), when it is switched on.
autostartPhoneServer()

// Prices, plan type and OpenCode Go meters (prices daily, Go meters every 5 minutes).
void refreshCatalog()
setInterval(() => void refreshCatalog(), 5 * 60_000).unref()
// Provider list: model variants, local-model status and billing labels read it before any picker opens.
void refreshProviders().catch((error) => log("providers error", error))

createRoot(async () => {
  if (args.continue) {
    await continueLast()
    await restoreTabs({ focus: active().store.sessionID, keepActive: true })
  } else if (typeof args.resume === "string") {
    await openSession(args.resume)
    await restoreTabs({ focus: args.resume, keepActive: true })
  } else if (args.prompt) {
    // A prompt on the command line gets a fresh tab; saved tabs come back behind it.
    await startFresh()
    await restoreTabs({ keepActive: true })
  } else {
    // Plain `agentcode` reopens the tabs left open last time, or else the most recent session.
    const restored = await restoreTabs()
    if (!restored && args.resume !== true) await continueLast()
    else if (!restored) await startFresh()
    if (args.resume === true) {
      await refreshSessions()
      const { runCommand } = await import("./context/keymap")
      runCommand("session.list")
    }
  }
  if (args.prompt) active().send(args.prompt)
  void app
})
