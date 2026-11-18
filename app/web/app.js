// Agent Code web app: the browser side. It talks to the Agent Code running on this computer (its web server on
// 127.0.0.1, started by acode-web) with the token in the address (#t=…). Chats live in Agent Code; this page shows
// them and sends what you type. The "terminal view" shows Agent Code's own screen for everything else.
const $ = (id) => document.getElementById(id)
const token = (() => {
  const fromHash = new URLSearchParams(location.hash.slice(1)).get("t")
  if (fromHash) {
    sessionStorage.setItem("acode.web.t", fromHash)
    history.replaceState(null, "", location.pathname)
  }
  return fromHash || sessionStorage.getItem("acode.web.t") || ""
})()

const state = { boot: undefined, active: undefined, tab: undefined, sessions: [], files: [], openSteps: new Set(), sending: false }

// ---------------------------------------------------------------------------------------------------- the server
async function api(method, url, body) {
  const response = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (response.status === 401) throw new Error("This page's key is old: open Agent Code again from acode-web.")
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
  return data
}
const get = (path) => api("GET", `api/${path}`)
const post = (path, body = {}) => api("POST", `api/${path}`, body)

function toast(text, ms = 3200) {
  const box = $("toast")
  box.textContent = text
  box.classList.remove("hidden")
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => box.classList.add("hidden"), ms)
}

// ---------------------------------------------------------------------------------------------------- markdown
const escape = (text) => String(text ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])
function inline(text) {
  return escape(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
}
function markdown(source) {
  const out = []
  const lines = String(source ?? "").replace(/\r/g, "").split("\n")
  let i = 0
  let list
  const closeList = () => {
    if (list) out.push(`</${list}>`)
    list = undefined
  }
  while (i < lines.length) {
    const line = lines[i]
    const fence = line.match(/^```(\w*)/)
    if (fence) {
      closeList()
      const code = []
      i++
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++])
      i++
      out.push(`<pre><button class="copy">copy</button><code data-lang="${escape(fence[1])}">${escape(code.join("\n"))}</code></pre>`)
      continue
    }
    const heading = line.match(/^(#{1,4})\s+(.*)/)
    if (heading) {
      closeList()
      out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`)
    } else if (/^\s*[-*]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      const kind = /^\s*\d/.test(line) ? "ol" : "ul"
      if (list !== kind) {
        closeList()
        out.push(`<${kind}>`)
        list = kind
      }
      out.push(`<li>${inline(line.replace(/^\s*([-*]|\d+[.)])\s+/, ""))}</li>`)
    } else if (/^>\s?/.test(line)) {
      closeList()
      out.push(`<blockquote>${inline(line.replace(/^>\s?/, ""))}</blockquote>`)
    } else if (/^\|.*\|\s*$/.test(line)) {
      closeList()
      const rows = []
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++])
      const cells = (row) => row.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim())
      const body = rows.filter((row) => !/^\|[\s:|-]+\|$/.test(row.trim()))
      out.push(`<table>${body.map((row, index) => `<tr>${cells(row).map((cell) => (index ? `<td>${inline(cell)}</td>` : `<th>${inline(cell)}</th>`)).join("")}</tr>`).join("")}</table>`)
      continue
    } else if (!line.trim()) closeList()
    else {
      closeList()
      const para = [line]
      while (i + 1 < lines.length && lines[i + 1].trim() && !/^(```|#{1,4}\s|\s*[-*]\s|\s*\d+[.)]\s|>|\|)/.test(lines[i + 1])) para.push(lines[++i])
      out.push(`<p>${inline(para.join("\n")).replace(/\n/g, "<br>")}</p>`)
    }
    i++
  }
  closeList()
  return out.join("")
}

// ---------------------------------------------------------------------------------------------------- sidebar
const ago = (ms) => {
  const minutes = Math.round((Date.now() - ms) / 60000)
  if (minutes < 60) return `${Math.max(1, minutes)}m`
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`
  return `${Math.round(minutes / 1440)}d`
}
const dayOf = (ms) => {
  const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(ms).setHours(0, 0, 0, 0)) / 86400000)
  return days <= 0 ? "Today" : days === 1 ? "Yesterday" : days < 7 ? "Previous 7 days" : days < 30 ? "Previous 30 days" : "Older"
}

function renderTabs() {
  const box = $("tabs")
  box.innerHTML = ""
  for (const tab of state.boot?.tabs ?? []) {
    const item = document.createElement("div")
    item.className = `item${tab.key === state.active ? " active" : ""}`
    const status = tab.permissions ? "attention" : tab.status === "running" ? "running" : ""
    item.innerHTML = `<span class="dot ${status}"></span><span class="label">${escape(tab.title)}</span><span class="meta">${escape(tab.agent ?? "")}</span><button class="x" title="Close tab">✕</button>`
    item.onclick = (event) => {
      if (event.target.classList.contains("x")) return void closeTab(tab.key)
      void selectTab(tab.key)
    }
    box.append(item)
  }
}

function renderSessions() {
  const box = $("sessions")
  const filter = $("search").value.trim().toLowerCase()
  box.innerHTML = ""
  let day
  for (const item of state.sessions) {
    if (filter && !item.title.toLowerCase().includes(filter)) continue
    const label = dayOf(item.time)
    if (label !== day) {
      day = label
      const title = document.createElement("div")
      title.className = "day"
      title.textContent = label
      box.append(title)
    }
    const row = document.createElement("div")
    row.className = `item${item.open && item.open === state.active ? " active" : ""}`
    row.innerHTML = `<span class="label">${escape(item.title)}</span><span class="meta">${item.cost ? `$${item.cost.toFixed(2)} · ` : ""}${ago(item.time)}</span>`
    row.title = item.title
    row.onclick = async () => {
      if (item.open) return void selectTab(item.open)
      const opened = await post("web/open", { id: item.id })
      await refreshBoot()
      if (opened.key) await selectTab(opened.key)
    }
    box.append(row)
  }
}

// ---------------------------------------------------------------------------------------------------- the chat
function stepLine(parts) {
  const counts = {}
  for (const part of parts) if (part.type === "tool") counts[part.name] = (counts[part.name] ?? 0) + 1
  return Object.entries(counts)
    .map(([name, count]) => (count > 1 ? `${name} ×${count}` : name))
    .join(" · ")
}

function renderPart(part) {
  if (part.type === "text") {
    const div = document.createElement("div")
    div.className = "md"
    div.innerHTML = markdown(part.text)
    return div
  }
  if (part.type === "reasoning") {
    const box = document.createElement("details")
    box.className = "thought"
    box.innerHTML = `<summary>${part.done ? `Thought${part.ms ? ` for ${Math.max(1, Math.round(part.ms / 1000))}s` : ""}` : "Thinking…"}</summary><pre>${escape(part.text)}</pre>`
    return box
  }
  const box = document.createElement("details")
  box.className = `tool${part.status === "error" ? " error" : ""}`
  const state = part.status === "running" || part.status === "pending" ? "…" : part.status === "error" ? "✗" : "✓"
  box.innerHTML = `<summary><span class="name">${escape(part.name.replace(/^mcp__(.+?)__/, "$1."))}</span><span class="what">${escape(part.title)}</span><span class="state">${state}</span></summary><pre>${escape(part.output || part.input)}</pre>`
  return box
}

function renderMessages() {
  const tab = state.tab
  const box = $("messages")
  const chat = $("chat")
  const atBottom = chat.scrollTop + chat.clientHeight >= chat.scrollHeight - 40
  box.innerHTML = ""
  const messages = tab?.messages ?? []
  document.querySelector(".app").classList.toggle("fresh", !messages.some((m) => m.type === "user"))
  $("empty").classList.toggle("hidden", messages.some((m) => m.type === "user"))
  for (const message of messages) {
    if (message.type === "user") {
      const div = document.createElement("div")
      div.className = `msg-user${message.unsent ? " unsent" : ""}`
      div.textContent = message.text
      if (message.unsent || message.queued) {
        const tag = document.createElement("span")
        tag.className = "tag"
        tag.textContent = message.unsent ? "not sent yet · goes out when the engine is up" : "queued"
        div.append(tag)
      }
      box.append(div)
    } else if (message.type === "assistant") {
      const div = document.createElement("div")
      div.className = "msg-assistant"
      const steps = message.parts.filter((part) => part.type === "tool")
      const open = state.openSteps.has(message.id)
      // Like the terminal's "low" detail: a run of tool calls folds into one line until clicked.
      let folded = false
      for (const part of message.parts) {
        if (part.type === "tool" && steps.length > 2 && !open) {
          if (!folded) {
            folded = true
            const line = document.createElement("div")
            line.className = "steps"
            line.textContent = `▸ ${steps.length} steps · ${stepLine(message.parts)}`
            line.onclick = () => {
              state.openSteps.add(message.id)
              renderMessages()
            }
            div.append(line)
          }
          continue
        }
        if (part.type === "text" && !part.text.trim()) continue
        div.append(renderPart(part))
      }
      if (message.error) {
        const error = document.createElement("div")
        error.className = "error-line"
        error.textContent = `Error: ${message.error}`
        div.append(error)
      }
      if (message.done) {
        const foot = document.createElement("div")
        foot.className = "foot"
        foot.innerHTML = `<b>${escape(agentName(message.agent))}</b> · ${escape(prettyModel(message.model))}${message.ms ? ` · ${(message.ms / 1000).toFixed(1)}s` : ""}`
        div.append(foot)
      } else if (!message.parts.length) {
        const wait = document.createElement("div")
        wait.className = "foot"
        wait.textContent = "…"
        div.append(wait)
      }
      if (div.childNodes.length) box.append(div)
    } else if (message.text?.trim()) {
      const div = document.createElement("div")
      div.className = `msg-notice ${message.variant ?? ""}`
      div.textContent = message.text
      box.append(div)
    }
  }
  for (const button of box.querySelectorAll(".copy"))
    button.onclick = () => {
      void navigator.clipboard.writeText(button.nextElementSibling.textContent)
      toast("Copied")
    }
  if (atBottom) chat.scrollTop = chat.scrollHeight
}

function renderPermissions() {
  const box = $("permissions")
  box.innerHTML = ""
  for (const request of state.tab?.permissions ?? []) {
    const card = document.createElement("div")
    card.className = "perm"
    card.innerHTML = `<div><b>${escape(request.title)}</b> wants to run</div><div class="what">${escape(request.detail)}</div><div class="row-buttons"><button data-d="once">Allow once</button><button data-d="always">Always allow</button><button data-d="reject" class="danger">Reject</button></div>`
    for (const button of card.querySelectorAll("button"))
      button.onclick = () => void post(`tabs/${state.active}/permission`, { id: request.id, decision: button.dataset.d }).then(refreshTab)
    box.append(card)
  }
}

/** "claude-haiku-5-5" → "Haiku 5.5"; a provider model by its label in the model list. */
function prettyModel(id) {
  if (!id) return ""
  const listed = state.boot?.models.find((item) => item.value === id || item.value.endsWith(`/${id}`))
  if (listed) return listed.label
  const claude = String(id).match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?/)
  if (claude) return `${claude[1][0].toUpperCase()}${claude[1].slice(1)} ${claude[2]}${claude[3] ? `.${claude[3]}` : ""}`
  return String(id).split("/").pop()
}
const agentName = (id) => state.boot?.agents.find((agent) => agent.id === id)?.name ?? (id ? id[0].toUpperCase() + id.slice(1) : "Build")
const span = (ms) => {
  const s = Math.floor(ms / 1000)
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s` : `${Math.floor(s / 3600)}h ${String(Math.floor(s / 60) % 60).padStart(2, "0")}m`
}
const money = (value) => (value < 0.01 ? "<$0.01" : `$${value.toFixed(2)}`)

function renderPanels() {
  const tab = state.tab
  const context = []
  if (tab?.context?.tokens) context.push(`${tab.context.tokens.toLocaleString()} tokens`, `${tab.context.percent ?? 0}% used`)
  if (tab?.cost) context.push(`${money(tab.cost)} spent${tab.subCost ? ` · subagents ${money(tab.subCost)}` : ""}`)
  if (tab?.thinkingMs >= 1000) context.push(`${span(tab.thinkingMs)} thinking`)
  if (tab?.subThinkingMs >= 1000) context.push(`${span(tab.subThinkingMs)} subagents thinking`)
  $("context").innerHTML = context.map((line) => `<div>${escape(line)}</div>`).join("") || "<div>—</div>"
  const limits = state.boot?.limits ?? {}
  const bar = (label, window) => {
    if (!window) return ""
    const used = Math.round(window.utilization ?? 0)
    const reset = window.resetsAt ? new Date(window.resetsAt).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" }) : ""
    return `<div>${escape(label)} ${used}%</div><div class="bar"><i class="${used >= 90 ? "bad" : used >= 75 ? "warn" : ""}" style="width:${Math.min(100, used)}%"></i></div><div class="small">${reset ? `resets ${escape(reset)}` : ""}</div>`
  }
  $("usage").innerHTML = bar("5-hour", limits.fiveHour) + bar("Weekly", limits.week) + (limits.scoped ?? []).map((window) => bar(window.name, window)).join("") || "<div>—</div>"
  $("tasks").innerHTML = (tab?.tasks ?? []).map((task) => `<div>● ${escape(task.description ?? task.type ?? "task")}</div>`).join("") || "<div>none running</div>"
}

function renderComposer() {
  const tab = state.tab
  const running = tab?.status === "running"
  const send = $("send")
  send.textContent = running ? "■" : "↑"
  send.classList.toggle("stop", running)
  send.title = running ? "Stop" : "Send (Enter; Shift+Enter: new line)"
  const mode = $("mode")
  mode.innerHTML = (state.boot?.agents ?? []).map((agent) => `<option value="${escape(agent.id)}">${escape(agent.name)}</option>`).join("")
  mode.value = tab?.agent ?? "chat"
  mode.classList.toggle("mode-chat", mode.value === "chat")
  const model = $("model")
  if (!model.dataset.filled) {
    const groups = {}
    for (const item of state.boot?.models ?? []) (groups[item.group] ??= []).push(item)
    model.innerHTML = Object.entries(groups)
      .map(([group, items]) => `<optgroup label="${escape(group)}">${items.map((item) => `<option value="${escape(item.value)}">${escape(item.label)}</option>`).join("")}</optgroup>`)
      .join("")
    model.dataset.filled = "1"
  }
  if (tab?.modelValue && ![...model.options].some((option) => option.value === tab.modelValue)) model.add(new Option(tab.model ?? tab.modelValue, tab.modelValue))
  // A new chat (no tab yet) opens on the default model.
  model.value = tab?.modelValue ?? state.newModel ?? state.boot?.defaultModel ?? model.options[0]?.value ?? ""
  const effort = $("effort")
  const levels = tab?.efforts ?? []
  effort.innerHTML = `<option value="">default</option>${levels.map((level) => `<option>${escape(level)}</option>`).join("")}`
  effort.value = tab?.effort ?? ""
  effort.classList.toggle("hidden", !levels.length)
  $("title").textContent = tab?.title ?? "New chat"
  $("engine").textContent = tab ? `${tab.engine === "claude" ? "Claude Code" : tab.engine} · ${tab.model}${tab.fatal ? " · stopped" : tab.ready ? "" : " · starting"}` : ""
}

function render() {
  renderTabs()
  renderSessions()
  renderMessages()
  renderPermissions()
  renderPanels()
  renderComposer()
}

// ---------------------------------------------------------------------------------------------------- actions
async function refreshBoot() {
  state.boot = await get("web/boot")
  if (!state.active || !state.boot.tabs.some((tab) => tab.key === state.active)) state.active = state.boot.active ?? state.boot.tabs[0]?.key
  $("user-name").textContent = state.boot.users.current
  $("avatar").textContent = state.boot.users.current.slice(0, 1).toUpperCase()
  document.title = `Agent Code${state.boot.box ? " · box" : ""}`
}
async function refreshTab() {
  if (!state.active) return
  try {
    state.tab = await get(`web/tab/${state.active}`)
  } catch {
    state.tab = undefined
  }
  render()
}
async function refreshSessions() {
  try {
    state.sessions = await get("web/sessions")
  } catch {}
  renderSessions()
}
async function selectTab(key) {
  state.active = key
  await post("web/focus", { key })
  await refreshTab()
  $("input").focus()
}
async function closeTab(key) {
  await post("web/close", { key })
  await refreshBoot()
  await refreshTab()
  await refreshSessions()
}

async function sendMessage() {
  const input = $("input")
  const text = input.value.trim()
  if (state.tab?.status === "running" && !text) return void post(`tabs/${state.active}/interrupt`)
  if (!text && !state.files.length) return
  const attachments = state.files.map((file) => ({ name: file.name, data: file.data }))
  input.value = ""
  state.files = []
  renderFiles()
  autosize()
  try {
    if (!state.active) {
      // A new chat: its tab first (with the model and mode picked here), then the message.
      const made = await post("web/new", { model: state.newModel, agent: state.newAgent })
      state.newModel = state.newAgent = undefined
      await refreshBoot()
      state.active = made.key
      await post(`tabs/${state.active}/send`, { text, attachments })
    } else await post(`tabs/${state.active}/send`, { text, attachments })
  } catch (error) {
    toast(error.message)
    input.value = text
  }
  await refreshTab()
  setTimeout(refreshSessions, 1500)
}

function renderFiles() {
  const box = $("files")
  box.innerHTML = ""
  state.files.forEach((file, index) => {
    const chip = document.createElement("span")
    chip.className = "file"
    chip.innerHTML = `${escape(file.name)} <button title="Remove">✕</button>`
    chip.querySelector("button").onclick = () => {
      state.files.splice(index, 1)
      renderFiles()
    }
    box.append(chip)
  })
}
async function addFiles(list) {
  for (const file of list) {
    const buffer = new Uint8Array(await file.arrayBuffer())
    let binary = ""
    for (let i = 0; i < buffer.length; i += 0x8000) binary += String.fromCharCode(...buffer.subarray(i, i + 0x8000))
    state.files.push({ name: file.name, data: btoa(binary) })
  }
  renderFiles()
}

function autosize() {
  const input = $("input")
  input.style.height = "auto"
  input.style.height = `${Math.min(input.scrollHeight, window.innerHeight * 0.4)}px`
}

// ---------------------------------------------------------------------------------------------------- terminal view
const term = { open: false, timer: undefined, frame: 0, cols: 0, rows: 0, escapes: 0 }
function cellSize() {
  const probe = document.createElement("span")
  probe.textContent = "M".repeat(10)
  probe.style.visibility = "hidden"
  $("screen").append(probe)
  const box = probe.getBoundingClientRect()
  probe.remove()
  return { w: box.width / 10, h: box.height }
}
async function openTerminal() {
  term.open = true
  $("terminal").classList.remove("hidden")
  const screen = $("screen")
  screen.focus()
  const cell = cellSize()
  const cols = Math.max(80, Math.floor((screen.clientWidth - 12) / cell.w))
  const rows = Math.max(24, Math.floor((screen.clientHeight - 12) / cell.h))
  term.cell = cell
  if (cols !== term.cols || rows !== term.rows) {
    term.cols = cols
    term.rows = rows
    await post("web/resize", { cols, rows }).catch(() => {})
  }
  term.frame = 0
  pollScreen()
}
function closeTerminal() {
  term.open = false
  clearTimeout(term.timer)
  $("terminal").classList.add("hidden")
  void refreshBoot().then(refreshTab)
}
async function pollScreen() {
  if (!term.open) return
  try {
    const frame = await get(`web/screen?have=${term.frame}`)
    if (!frame.same) {
      term.frame = frame.id
      const html = frame.lines
        .map((line, y) => {
          let x = 0
          const spans = line
            .map(([text, fg, bg, attrs]) => {
              let style = ""
              if (fg) style += `color:#${fg};`
              if (bg) style += `background:#${bg};`
              if (attrs & 1) style += "font-weight:700;"
              if (attrs & 4) style += "text-decoration:underline;"
              const cursor = frame.cursor && frame.cursor[1] === y && frame.cursor[0] >= x && frame.cursor[0] < x + text.length
              x += text.length
              return `<span style="${style}"${cursor ? ' class="cur"' : ""}>${escape(text)}</span>`
            })
            .join("")
          return `<div class="line">${spans || " "}</div>`
        })
        .join("")
      $("screen").innerHTML = html
    }
  } catch {}
  term.timer = setTimeout(pollScreen, 90)
}
const KEYS = { Enter: "RETURN", Backspace: "BACKSPACE", Tab: "TAB", Escape: "ESCAPE", ArrowUp: "ARROW_UP", ArrowDown: "ARROW_DOWN", ArrowLeft: "ARROW_LEFT", ArrowRight: "ARROW_RIGHT", Delete: "DELETE", Home: "HOME", End: "END", PageUp: "\u001b[5~", PageDown: "\u001b[6~", F1: "F1", F2: "F2", F3: "F3", F4: "F4", F5: "F5", F6: "F6", F7: "F7", F8: "F8", F9: "F9", F10: "F10", F11: "F11", F12: "F12" }
function screenKey(event) {
  if (!term.open) return
  // Esc twice quickly leaves the terminal view.
  if (event.key === "Escape") {
    if (Date.now() - term.escapes < 450) return closeTerminal()
    term.escapes = Date.now()
  }
  const named = KEYS[event.key]
  let body
  if (named) body = { key: named, ctrl: event.ctrlKey, shift: event.shiftKey, alt: event.altKey }
  else if (event.key.length === 1 && (event.ctrlKey || event.altKey)) body = { key: event.key.toLowerCase(), ctrl: event.ctrlKey, shift: event.shiftKey, alt: event.altKey }
  else if (event.key.length === 1) body = { text: event.key }
  if (!body) return
  event.preventDefault()
  void post("web/key", body)
}
function screenMouse(type, event) {
  if (!term.cell) return
  const box = $("screen").getBoundingClientRect()
  const x = Math.floor((event.clientX - box.left - 6) / term.cell.w)
  const y = Math.floor((event.clientY - box.top - 6) / term.cell.h)
  if (type === "scroll") return void post("web/mouse", { type, x, y, direction: event.deltaY < 0 ? "up" : "down" })
  void post("web/mouse", { type, x, y, button: event.button === 2 ? 2 : event.button === 1 ? 1 : 0 })
}

// ---------------------------------------------------------------------------------------------------- settings
function renderSettings() {
  const list = $("settings-list")
  list.innerHTML = ""
  const light = document.documentElement.classList.contains("light")
  const theme = document.createElement("div")
  theme.className = "setting"
  theme.innerHTML = `<span>Light theme (this window)</span><button class="switch${light ? " on" : ""}" aria-label="Light theme"></button>`
  theme.querySelector("button").onclick = () => {
    document.documentElement.classList.toggle("light")
    localStorage.setItem("acode.web.theme", document.documentElement.classList.contains("light") ? "light" : "dark")
    renderSettings()
  }
  list.append(theme)
  for (const item of state.boot?.settings ?? []) {
    const row = document.createElement("div")
    row.className = "setting"
    row.innerHTML = `<span>${escape(item.title)}</span><button class="switch${item.value ? " on" : ""}" aria-label="${escape(item.title)}"></button>`
    row.querySelector("button").onclick = async () => {
      await post("web/setting", { name: item.key, value: !item.value })
      await refreshBoot()
      renderSettings()
    }
    list.append(row)
  }
  const users = $("users")
  users.innerHTML = ""
  for (const name of state.boot?.users.list ?? []) {
    const button = document.createElement("button")
    button.textContent = name
    button.className = name === state.boot.users.current ? "on" : ""
    button.onclick = () => name !== state.boot.users.current && switchUser(name)
    users.append(button)
  }
}
async function switchUser(name, create = false) {
  toast(`Switching to ${name}…`, 6000)
  await post("web/user", { name, action: create ? "new" : "switch" }).catch((error) => toast(error.message))
  setTimeout(waitForRestart, 1200)
}
async function waitForRestart() {
  for (let i = 0; i < 60; i++) {
    try {
      await refreshBoot()
      state.active = undefined
      await refreshBoot()
      await refreshTab()
      await refreshSessions()
      $("settings").classList.add("hidden")
      return toast(`User: ${state.boot.users.current}`)
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 700))
    }
  }
}

// ---------------------------------------------------------------------------------------------------- wiring
function layout(part, hidden) {
  const app = document.querySelector(".app")
  app.classList.toggle(`${part}-hidden`, hidden)
  localStorage.setItem(`acode.web.${part}`, hidden ? "hidden" : "shown")
}

function wire() {
  if (localStorage.getItem("acode.web.theme") === "light") document.documentElement.classList.add("light")
  for (const part of ["left", "right"]) if (localStorage.getItem(`acode.web.${part}`) === "hidden") document.querySelector(".app").classList.add(`${part}-hidden`)
  $("collapse-left").onclick = () => layout("left", true)
  $("expand-left").onclick = () => layout("left", false)
  $("toggle-right").onclick = () => layout("right", !document.querySelector(".app").classList.contains("right-hidden"))
  $("expand-right").onclick = () => layout("right", false)
  $("new-chat").onclick = async () => {
    state.active = undefined
    state.tab = undefined
    render()
    $("input").focus()
  }
  $("search").oninput = renderSessions
  $("send").onclick = () => void sendMessage()
  const input = $("input")
  input.oninput = autosize
  input.onkeydown = (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      void sendMessage()
    }
  }
  input.onpaste = (event) => {
    const files = [...(event.clipboardData?.files ?? [])]
    if (files.length) {
      event.preventDefault()
      void addFiles(files)
    }
  }
  document.ondragover = (event) => event.preventDefault()
  document.ondrop = (event) => {
    event.preventDefault()
    if (event.dataTransfer?.files?.length) void addFiles([...event.dataTransfer.files])
  }
  $("attach").onchange = (event) => void addFiles([...event.target.files]).then(() => (event.target.value = ""))
  $("mode").onchange = (event) => (state.active ? void post("web/agent", { key: state.active, agent: event.target.value }).then(refreshTab) : (state.newAgent = event.target.value))
  $("model").onchange = (event) => (state.active ? void post("web/model", { key: state.active, model: event.target.value }).then(refreshTab) : (state.newModel = event.target.value))
  $("effort").onchange = (event) => state.active && void post("web/effort", { key: state.active, effort: event.target.value }).then(refreshTab)
  $("stop").onclick = () => state.active && void post(`tabs/${state.active}/interrupt`)
  $("restart").onclick = () => state.active && void post("web/restart", { key: state.active }).then(() => toast("Engine restarting…"))
  $("close-tab").onclick = () => state.active && void closeTab(state.active)
  $("open-terminal").onclick = () => void openTerminal()
  $("close-terminal").onclick = closeTerminal
  const screen = $("screen")
  screen.onkeydown = screenKey
  screen.onmousedown = (event) => screenMouse("down", event)
  screen.onmouseup = (event) => screenMouse("up", event)
  screen.oncontextmenu = (event) => event.preventDefault()
  screen.onwheel = (event) => {
    event.preventDefault()
    screenMouse("scroll", event)
  }
  screen.onpaste = (event) => {
    event.preventDefault()
    void post("web/key", { text: event.clipboardData.getData("text") })
  }
  $("open-settings").onclick = $("user-button").onclick = () => {
    renderSettings()
    $("settings").classList.remove("hidden")
  }
  $("close-settings").onclick = () => $("settings").classList.add("hidden")
  $("add-user").onclick = () => {
    const name = $("new-user").value.trim()
    if (name) void switchUser(name, true)
  }
  $("reset-user").onclick = () => {
    if (confirm("Put every setting of this user back to its default? (Saved first; chats, tabs and keys stay.)")) {
      void post("web/user", { action: "reset", name: state.boot.users.current }).then(() => setTimeout(waitForRestart, 1200))
    }
  }
  $("make-box").onclick = async () => {
    $("box-out").textContent = "Making the box…"
    try {
      const result = await post("web/box", { dir: $("box-dir").value.trim() })
      $("box-out").textContent = `${result.output}\n\nOpen it with: acode-web "${result.dir}"`
    } catch (error) {
      $("box-out").textContent = error.message
    }
  }
  $("quit").onclick = () => confirm("Quit Agent Code?") && void post("web/quit").then(() => window.close())
  document.addEventListener("keydown", (event) => {
    if (term.open) return
    if (event.ctrlKey && event.key === "b") {
      event.preventDefault()
      layout("left", !document.querySelector(".app").classList.contains("left-hidden"))
    } else if (event.ctrlKey && event.key === ".") {
      event.preventDefault()
      layout("right", !document.querySelector(".app").classList.contains("right-hidden"))
    } else if (event.ctrlKey && event.key === "`") {
      event.preventDefault()
      void openTerminal()
    } else if (event.key === "Escape" && state.tab?.status === "running") void post(`tabs/${state.active}/interrupt`)
  })
}

function listen() {
  const source = new EventSource(`api/events?t=${encodeURIComponent(token)}`)
  let pending
  const later = (fn) => {
    clearTimeout(pending)
    pending = setTimeout(fn, 120)
  }
  source.addEventListener("tab", (event) => {
    const data = JSON.parse(event.data)
    if (data.key === state.active) later(refreshTab)
  })
  source.addEventListener("tabs", () => later(() => refreshBoot().then(render)))
  source.onerror = () => {
    // Agent Code restarting (another user, a reset): reconnects by itself.
  }
  // Limits and costs change without chat events too.
  setInterval(() => refreshBoot().then(() => (renderPanels(), renderTabs())).catch(() => {}), 15000)
}

async function main() {
  wire()
  try {
    await refreshBoot()
    await refreshTab()
    await refreshSessions()
    listen()
  } catch (error) {
    $("messages").innerHTML = `<div class="msg-notice error">${escape(error.message)}</div>`
  }
  $("input").focus()
}
void main()
