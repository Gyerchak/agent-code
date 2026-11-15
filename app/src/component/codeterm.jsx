// Code Mode in a tab: the real, interactive Claude Code (`claude`) running in a terminal inside Agent Code.
// Claude Code allows Code Mode (Claude writes JavaScript that calls its tools) only in its own interactive terminal,
// never under the Agent SDK that Agent Code's chat tabs use — so a Code Mode tab hosts that terminal itself, through
// OpenTUI's embedded terminal and a small pseudo-terminal helper (src/terminal/pty.py).
import { EmbeddedTerminalRenderable, RGBA } from "@opentui/core"
import { extend } from "@opentui/solid"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { config, saveConfig } from "../context/config"
import { setKeyCapture } from "../context/keymap"
import { log } from "../context/log"
import { findBinary } from "../context/platform"
import { theme } from "../context/theme"

extend({ codeterm: EmbeddedTerminalRenderable })

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const PTY = path.join(ROOT, "src", "terminal", "ptybridge.py")
// Output kept to draw the screen again when the tab is shown again (from the last full clear on).
const KEEP = 2 * 1024 * 1024

/** Conversations that have run in Code Mode: Claude Code continues them only with Code Mode on. */
export const codeModeSession = (id) => !!id && !!config.codeModeSessions?.[id]
function markCodeMode(id) {
  if (!id || config.codeModeSessions?.[id]) return
  config.codeModeSessions = { ...(config.codeModeSessions ?? {}), [id]: Date.now() }
  saveConfig()
}

// One running Claude Code per tab, alive while the tab is open (switching tabs only hides it).
const running = new Map()

/** Claude Code's environment without the marks of an Agent SDK child (it would refuse Code Mode). */
function cleanEnv() {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_AGENT_SDK_|CLAUDE_PID$|CLAUDE_EFFORT$|ACODE_|OTEL_)/.test(key)) continue
    env[key] = value
  }
  return { ...env, TERM: "xterm-256color", COLORTERM: "truecolor", CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: "1" }
}

/**
 * Start (or find) the Code Mode terminal of a tab: `claude --resume <its session>` (or a new session with its id),
 * on its model when that is Opus or Fable (Code Mode needs Opus 5.5+ or Fable 5.2+), else on Opus.
 */
export function startCodeMode(session, { cols = 100, rows = 30 } = {}) {
  const existing = running.get(session.key)
  if (existing && !existing.exited) return existing
  const claude = findBinary("claude")
  const python = findBinary("python3") ?? findBinary("python")
  if (!claude || !python) throw new Error(!claude ? "Claude Code (claude) isn't installed on this PATH" : "Python 3 is needed for the built-in terminal")
  const store = session.store
  const known = store.sessionID && store.messages.some((m) => m.type === "user")
  const id = known ? store.sessionID : randomUUID()
  const strong = /opus|fable/i.test(`${store.modelId ?? ""} ${store.model ?? ""}`) && !/\//.test(store.model ?? "")
  const args = [...(known ? ["--resume", id] : ["--session-id", id]), "--model", strong ? store.model : "opus"]
  markCodeMode(id)
  // A new conversation is the tab's from now on.
  if (!known) session.setStore("sessionID", id)
  // -I: the helper's folder isn't searched for modules (nothing there may stand in for the standard ones).
  const proc = spawn(python, ["-I", PTY, String(cols), String(rows), "--", claude, ...args], {
    cwd: store.cwd,
    env: cleanEnv(),
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  })
  const state = { proc, id, output: [], size: 0, exited: false, listeners: new Set(), onExit: new Set(), cols, rows }
  proc.stdout.on("data", (chunk) => {
    // From a full clear of the screen on, that is enough to draw it again.
    const text = chunk.toString("latin1")
    const clear = Math.max(text.lastIndexOf("\x1b[2J"), text.lastIndexOf("\x1b[3J"), text.lastIndexOf("\x1bc"))
    if (clear >= 0) {
      state.output = [chunk.subarray(clear)]
      state.size = chunk.length - clear
    } else {
      state.output.push(chunk)
      state.size += chunk.length
      while (state.size > KEEP && state.output.length > 1) state.size -= state.output.shift().length
    }
    for (const listener of state.listeners) listener(chunk)
  })
  proc.stderr.on("data", (chunk) => log("code mode", chunk.toString().trim().slice(0, 300)))
  proc.on("exit", (code) => {
    state.exited = true
    running.delete(session.key)
    log("code mode ended", code)
    for (const done of state.onExit) done(code)
  })
  proc.on("error", (error) => log("code mode", error))
  // A helper that ends closes its pipes under us: nothing to do but note it.
  for (const pipe of [proc.stdin, proc.stdout, proc.stderr, proc.stdio[3]]) pipe?.on?.("error", (error) => log("code mode pipe", error.code ?? error))
  running.set(session.key, state)
  log("code mode", "claude", args.join(" "))
  return state
}

export const codeModeRunning = (session) => {
  const state = running.get(session.key)
  return !!state && !state.exited
}

/** End a tab's Code Mode terminal (the tab closes, or the user leaves Code Mode). */
export function stopCodeMode(session) {
  const state = running.get(session.key)
  if (!state || state.exited) return
  try {
    state.proc.stdin.end()
  } catch {}
  setTimeout(() => !state.exited && state.proc.kill("SIGTERM"), 1500)
}

/**
 * The terminal of a Code Mode tab. All keys go to Claude Code while it has the focus (Ctrl+O shows the code it
 * runs); Ctrl+] gives the keys back to Agent Code (a click on the terminal takes them again); Ctrl+Tab still
 * switches tabs.
 */
export function CodeModeView(props) {
  const [focused, setFocused] = createSignal(true)
  const [error, setError] = createSignal()
  let term
  let state
  let control
  const onChunk = (chunk) => term && !term.isDestroyed && term.write(chunk)
  const done = () => props.onExit?.(state?.id)
  onMount(() => {
    try {
      state = startCodeMode(props.session, { cols: Math.max(20, term?.width ?? 100), rows: Math.max(5, term?.height ?? 30) })
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
      return
    }
    control = state.proc.stdio[3]
    // Draw what is on Claude Code's screen already (the tab was shown before), then follow it.
    for (const chunk of state.output) term.write(chunk)
    state.listeners.add(onChunk)
    state.onExit.add(done)
    term.onData = (data) => {
      if (state.exited) return
      try {
        state.proc.stdin.write(data)
      } catch {}
    }
    term.onTerminalResize = (cols, rows) => {
      state.cols = cols
      state.rows = rows
      try {
        control?.write(`resize ${cols} ${rows}\n`)
      } catch {}
    }
    try {
      control?.write(`resize ${term.width} ${term.height}\n`)
    } catch {}
    term.focus()
  })
  onCleanup(() => {
    state?.listeners.delete(onChunk)
    state?.onExit.delete(done)
    setKeyCapture(undefined)
  })
  // While the terminal has the focus, Agent Code's own keys stand aside (except the way out and tab switching).
  setKeyCapture((event) => {
    if (!focused()) return false
    if (event.ctrl && (event.name === "]" || event.sequence === "\x1d")) {
      setFocused(false)
      term?.blur()
      return true
    }
    if (event.ctrl && event.name === "tab") return false
    return "terminal"
  })
  return (
    <box flexGrow={1} minHeight={0} flexDirection="column">
      <box flexShrink={0} flexDirection="row" gap={2} paddingLeft={1} backgroundColor={theme.backgroundPanel}>
        <text fg={theme.primary} flexShrink={0}>
          Code Mode
        </text>
        <text fg={theme.textMuted} wrapMode="none" truncate flexShrink={1}>
          {focused() ? "ctrl+o shows the code · ctrl+] gives keys back to Agent Code · /exit leaves Code Mode" : "click the terminal to type in it"}
        </text>
      </box>
      <Show when={!error()} fallback={<text fg={theme.error}>{error()}</text>}>
        <codeterm
          ref={(r) => (term = r)}
          flexGrow={1}
          minHeight={0}
          onMouseDown={() => {
            if (!focused()) {
              setFocused(true)
              term?.focus()
            }
          }}
        />
      </Show>
    </box>
  )
}
