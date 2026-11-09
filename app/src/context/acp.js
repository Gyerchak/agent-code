import { execFile, spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { log } from "./log"
import { findBinary, spawnOptions } from "./platform"

// ---------------------------------------------------------------------------
// opencode as an engine. OpenCode Zen serves its free models only to opencode itself, so occ runs
// those tabs through the real opencode: `opencode acp` (Agent Client Protocol, JSON-RPC over stdio)
// for the conversation, `opencode api` (its local server's HTTP API) for revert/fork.
// ---------------------------------------------------------------------------

/** Path of the opencode CLI, or undefined when it isn't installed. */
export function opencodeBinary() {
  return findBinary("opencode")
}










export class AcpClient {
          proc
          next = 0
          waiting = new Map                                                                           ()
          closing = false
          stderr = ""
          handlers

  /**
   * `launch`: the agent's command line and extra environment (default `opencode acp`); `label` names it in
   * errors. Any Agent Client Protocol agent works: opencode, DeepSeek Harness, Codex through codex-acp, …
   */
  constructor(cwd        , handlers          , launch = undefined, label = "opencode") {
    this.handlers = handlers
    this.label = label
    const file = launch?.command ?? opencodeBinary() ?? "opencode"
    const args = launch?.args ?? ["acp"]
    this.proc = spawn(file, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...(launch?.env ?? {}) }, ...spawnOptions(file) })
    createInterface({ input: this.proc.stdout  }).on("line", (line) => this.receive(line))
    this.proc.stderr .on("data", (data) => {
      this.stderr = (this.stderr + data).slice(-4000)
    })
    this.proc.on("error", (error) => this.ended(error.message))
    this.proc.on("exit", (code) => this.ended(`${this.label} exited (${code ?? "signal"})${this.lastError()}`))
  }

          lastError() {
    const line = this.stderr.trim().split("\n").at(-1)
    return line ? `: ${line}` : ""
  }

          ended(reason        ) {
    for (const waiter of this.waiting.values()) waiter.reject(new Error(reason))
    this.waiting.clear()
    if (this.closing) return
    this.closing = true
    this.handlers.exit(reason)
  }

          write(message                         ) {
    if (this.closing || !this.proc.stdin?.writable) return
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n")
  }

  request(method        , params         )               {
    if (this.closing) return Promise.reject(new Error(`${this.label} is not running`))
    const id = ++this.next
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject })
      this.write({ id, method, params })
    })
  }

  notify(method        , params         ) {
    this.write({ method, params })
  }

          receive(line        ) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (message.method && message.id !== undefined) {
      this.handlers
        .request(message.method, message.params)
        .then((result) => this.write({ id: message.id, result }))
        .catch((error) => this.write({ id: message.id, error: { code: -32603, message: String(error?.message ?? error) } }))
      return
    }
    if (message.method) {
      if (message.method === "session/update") {
        try {
          this.handlers.update(message.params?.sessionId, message.params?.update ?? {})
        } catch (error) {
          log("acp update error", error, line.slice(0, 1000))
        }
      }
      return
    }
    const waiter = this.waiting.get(message.id)
    if (!waiter) return
    this.waiting.delete(message.id)
    if (message.error) waiter.reject(new Error(message.error.message ?? `${this.label} error`))
    else waiter.resolve(message.result)
  }

  close() {
    this.closing = true
    for (const waiter of this.waiting.values()) waiter.reject(new Error("closed"))
    this.waiting.clear()
    try {
      this.proc.stdin?.end()
      this.proc.kill()
    } catch {}
  }
}

/** Call opencode's local server (`opencode api METHOD PATH`), returning the parsed JSON body. */
export function opencodeApi(cwd        , method        , route        , body          )               {
  const args = ["api", method, route, ...(body === undefined ? [] : ["-d", JSON.stringify(body)])]
  return new Promise((resolve, reject) => {
    execFile(opencodeBinary() ?? "opencode", args, { cwd, timeout: 60_000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || stdout || error.message).trim().split("\n").slice(-1)[0]))
        return
      }
      const text = stdout.trim()
      if (!text) return resolve(undefined)
      try {
        const parsed = JSON.parse(text)
        resolve(parsed && typeof parsed === "object" && "data" in parsed ? parsed.data : parsed)
      } catch {
        reject(new Error(text.slice(0, 300)))
      }
    })
  })
}

// ---------------------------------------------------------------------------
// opencode tools → the Claude Code tool shapes occ's tool views render
// ---------------------------------------------------------------------------

const TOOL_NAMES                         = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  multiedit: "MultiEdit",
  patch: "Edit",
  apply_patch: "Edit",
  bash: "Bash",
  shell: "Bash",
  glob: "Glob",
  grep: "Grep",
  list: "LS",
  webfetch: "WebFetch",
  websearch: "WebSearch",
  todowrite: "TodoWrite",
  todoread: "TodoRead",
  task: "Agent",
  question: "AskUserQuestion",
  skill: "Skill",
}

export function acpToolName(name                    , kind         ) {
  const key = (name ?? "").toLowerCase()
  if (TOOL_NAMES[key]) return TOOL_NAMES[key]
  if (kind === "execute") return "Bash"
  return name || kind || "tool"
}

/** Translate opencode's tool input (camelCase, `path`) to Claude Code's (`file_path`, snake_case). */
export function acpToolInput(name        , raw                                 )                      {
  const input                      = { ...(raw ?? {}) }
  const file = input.filePath ?? input.file_path ?? input.path
  if (["Read", "Write", "Edit", "MultiEdit"].includes(name) && file) input.file_path = file
  if (input.oldString !== undefined) input.old_string = input.oldString
  if (input.newString !== undefined) input.new_string = input.newString
  if (input.replaceAll !== undefined) input.replace_all = input.replaceAll
  if (Array.isArray(input.edits))
    input.edits = input.edits.map((edit     ) => ({ old_string: edit.oldString ?? edit.old_string, new_string: edit.newString ?? edit.new_string }))
  if (name === "Agent") {
    input.subagent_type = input.subagent_type ?? input.subagentType ?? input.agent
  }
  return input
}

/** Plain text of an ACP tool_call content list. */
export function acpContentText(content                   ) {
  return (content ?? [])
    .map((item) => (item?.type === "content" && item.content?.type === "text" ? item.content.text : ""))
    .filter(Boolean)
    .join("\n")
}
