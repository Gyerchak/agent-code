// Agent Code web app: the browser side. It talks to the Agent Code running on this computer (its web server on
// 127.0.0.1, started by acode-web) with the token in the address (#t=…). Chats live in Agent Code; this page shows
// them and sends what you type. The "terminal view" shows Agent Code's own screen for everything else.
const $ = (id) => document.getElementById(id)
// The address carries a one-time code (other users can see a browser's command line); the page swaps it for the
// key once and keeps the key for this window only.
let token = sessionStorage.getItem("acode.web.t") || ""
async function claimKey() {
  const hash = new URLSearchParams(location.hash.slice(1))
  history.replaceState(null, "", location.pathname)
  if (hash.get("t")) token = hash.get("t")
  else if (hash.get("c")) {
    const answer = await fetch("api/web/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: hash.get("c") }) })
    const data = await answer.json().catch(() => ({}))
    if (data.token) token = data.token
    else if (!token) throw new Error(data.error || "This link was used already: start acode-web again.")
  }
  sessionStorage.setItem("acode.web.t", token)
}

// composingNew: "New chat" was clicked; the next message makes a new tab (nothing may switch the page back meanwhile).
const state = { boot: undefined, active: undefined, tab: undefined, sessions: [], files: [], openSteps: new Set(), openParts: new Set(), sending: false, composingNew: false }

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
  // Code spans first, kept aside: emphasis and links apply only outside them (`*args, **kwargs` stays as typed).
  const spans = []
  const marked = escape(text).replace(/`([^`]+)`/g, (_, code) => `\u0000${spans.push(code) - 1}\u0000`)
  return marked
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(/\u0000(\d+)\u0000/g, (_, index) => `<code>${spans[Number(index)]}</code>`)
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

/** A <details> that stays open across re-renders (keyed by message and part). */
function keepOpen(box, key) {
  if (state.openParts.has(key)) box.open = true
  box.addEventListener("toggle", () => (box.open ? state.openParts.add(key) : state.openParts.delete(key)))
  return box
}

function renderPart(part, key) {
  if (part.type === "text") {
    const div = document.createElement("div")
    div.className = "md"
    div.innerHTML = markdown(part.text)
    return div
  }
  if (part.type === "reasoning") {
    const box = document.createElement("details")
    box.className = "thought"
    box.innerHTML = `<summary>${part.done ? `Thought${part.at ? ` ${messageTime(part.at)}` : ""}${part.ms ? ` · ${Math.max(1, Math.round(part.ms / 1000))}s` : ""}` : "Thinking…"}</summary><pre>${escape(part.text)}</pre>`
    return keepOpen(box, key)
  }
  const box = document.createElement("details")
  box.className = `tool${part.status === "error" ? " error" : ""}`
  const state = part.status === "running" || part.status === "pending" ? "…" : part.status === "error" ? "✗" : "✓"
  box.innerHTML = `<summary><span class="name">${escape(part.name.replace(/^mcp__(.+?)__/, "$1."))}</span><span class="what">${escape(part.title)}</span><span class="state">${state}</span></summary><pre>${escape(part.output || part.input)}</pre>`
  return keepOpen(box, key)
}

/** When a message was sent: "14:32" today, "Wed 14:32" this week, "19 Nov 14:32" before. */
function messageTime(ms) {
  const date = new Date(ms)
  const now = new Date()
  const clock = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  if (date.toDateString() === now.toDateString()) return clock
  if (now - date < 6 * 86_400_000) return `${date.toLocaleDateString([], { weekday: "short" })} ${clock}`
  return `${date.toLocaleDateString([], { day: "numeric", month: "short" })} ${clock}`
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
      if (message.time) {
        const when = document.createElement("span")
        when.className = "time"
        when.textContent = messageTime(message.time)
        div.append(when)
      }
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
        div.append(renderPart(part, `${message.id}:${message.parts.indexOf(part)}`))
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
        foot.innerHTML = `<b>${escape(agentName(message.agent))}</b> · ${escape(prettyModel(message.model))}${message.ms ? ` · ${(message.ms / 1000).toFixed(1)}s` : ""}${message.time ? ` · ${messageTime(message.time)}` : ""}`
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
  for (const link of box.querySelectorAll("a[href^='http']"))
    link.onclick = (event) => {
      event.preventDefault()
      void post("web/openurl", { url: link.href }).catch((error) => toast(error.message))
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
  // Thinking, all agents together (two subagents thinking a minute each are two minutes).
  const thought = (tab?.thinkingMs ?? 0) + (tab?.subThinkingMs ?? 0)
  if (thought >= 1000) context.push(`${span(thought)} thinking${tab?.subThinkingMs >= 1000 ? ` · ${span(tab.subThinkingMs)} of it subagents` : ""}`)
  renderControls()
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

/** The terminal sidebar's control rows: a click, a right click and ctrl+click run the same commands as there. */
function renderControls() {
  const box = $("controls")
  if (!box) return
  box.innerHTML = ""
  for (const row of state.tab?.controls ?? []) {
    const div = document.createElement("div")
    div.className = `ctl${row.on ? "" : " off"}${row.highlight ? " lit" : ""}`
    div.title = row.hint ? `${row.label} (${row.hint})` : row.label
    div.innerHTML = `<span class="icon">${escape(row.icon ?? "")}</span><span>${escape(row.label)}<span class="extra">${escape(row.extra ?? "")}</span></span>`
    div.onclick = (event) => void runCommandId(event.ctrlKey && row.ctrl ? row.ctrl : row.click)
    div.oncontextmenu = (event) => {
      event.preventDefault()
      void runCommandId(row.right ?? row.click)
    }
    box.append(div)
  }
}

async function runCommandId(id) {
  if (!id) return
  try {
    // The page's tab: the server focuses it first, so the command acts on the chat shown here.
    await post("web/command", { id, key: state.active })
  } catch (error) {
    toast(error.message)
  }
  // A command may open a dialog (the page draws it) or change the tab.
  await Promise.all([refreshDialog(), refreshTab()])
}

// --- The terminal's dialog, drawn here ----------------------------------------------------------------------------
// A filter typed here goes out after a short pause; it is kept so Enter can send it first.
let filterTimer
async function refreshDialog() {
  const before = state.dialog?.seq
  try {
    const { open, dialog } = await get("web/dialog")
    state.dialog = open ? (dialog ?? { kind: "other" }) : undefined
  } catch {
    state.dialog = undefined
  }
  // Another dialog now: a filter typed for the old one must not go to it.
  if (state.dialog?.seq !== before) {
    clearTimeout(filterTimer)
    filterTimer = undefined
  }
  renderDialog()
}
// Each op names the dialog it was meant for (seq): the server refuses it when another one is open by now.
const dialogAct = (op, args = {}) => post("web/dialog", { op, seq: state.dialog?.seq, ...args }).catch((error) => toast(error.message)).then(() => refreshDialog())

function renderDialog() {
  const box = $("dlg")
  const d = state.dialog
  // In the terminal view the same dialog is on its screen already.
  box.classList.toggle("hidden", !d || !$("terminal").classList.contains("hidden"))
  if (!d) return
  $("dlg-title").textContent = d.title || (d.kind === "other" ? "A dialog is open" : "")
  const list = $("dlg-list")
  const filter = $("dlg-filter")
  const tabsRow = $("dlg-tabs")
  list.innerHTML = ""
  tabsRow.innerHTML = ""
  filter.classList.toggle("hidden", d.kind !== "select")
  $("dlg-foot").textContent = d.footer ?? ""
  if (d.kind === "other") {
    list.innerHTML = `<div class="dlg-prompt">This dialog is only in the terminal view. <button id="dlg-term">Open the terminal view</button></div>`
    $("dlg-term").onclick = () => openTerminal?.()
    return
  }
  if (d.kind === "prompt" || d.kind === "confirm") {
    const row = document.createElement("div")
    row.className = "dlg-prompt"
    if (d.kind === "prompt") {
      row.innerHTML = `<input id="dlg-input" class="search" placeholder="${escape(d.placeholder ?? "")}" value="${escape(d.value ?? "")}" /><button id="dlg-ok">OK</button>`
      list.append(row)
      const input = $("dlg-input")
      const ok = () => void dialogAct("confirm", { text: input.value })
      $("dlg-ok").onclick = ok
      input.onkeydown = (event) => event.key === "Enter" && ok()
      setTimeout(() => input.focus(), 0)
    } else {
      row.innerHTML = `<span style="flex:1">${escape(d.message ?? "")}</span><button id="dlg-yes">Yes</button><button id="dlg-no">No</button>`
      list.append(row)
      $("dlg-yes").onclick = () => void dialogAct("confirm")
      $("dlg-no").onclick = () => void dialogAct("close")
    }
    return
  }
  for (const tab of d.tabs ?? []) {
    const button = document.createElement("button")
    button.textContent = tab.title
    button.className = tab.key === d.tab ? "on" : ""
    button.onclick = () => void dialogAct("tab", { key: tab.key })
    tabsRow.append(button)
  }
  if (document.activeElement !== filter) filter.value = d.filter ?? ""
  let category
  for (const option of d.options ?? []) {
    if (option.category !== category) {
      category = option.category
      if (category) {
        const head = document.createElement("div")
        head.className = "dlg-cat"
        head.textContent = category
        list.append(head)
      }
    }
    const row = document.createElement("div")
    row.className = `dlg-row${option.value === d.selected ? " sel" : ""}`
    row.innerHTML = `<span class="mark">${escape(option.mark ?? "")}</span><span>${escape(option.title)}</span><span class="desc">${escape(option.description ?? "")}</span><span class="chips"></span><span class="foot">${escape(option.footer ?? "")}</span>`
    const chips = row.querySelector(".chips")
    const chip = (label, run) => {
      const button = document.createElement("button")
      button.textContent = label
      button.onclick = (event) => {
        event.stopPropagation()
        run()
      }
      chips.append(button)
    }
    if (option.side) chip(option.side, () => void dialogAct("side", { value: option.value }))
    for (const action of d.actions ?? []) chip(action.label, () => void dialogAct("action", { value: option.value, keybind: action.keybind }))
    row.onclick = () => void dialogAct("select", { value: option.value })
    row.oncontextmenu = (event) => {
      event.preventDefault()
      if (d.rightClick) void dialogAct("right", { value: option.value })
    }
    list.append(row)
  }
}

// --- The command list (ctrl+p in the terminal) ----------------------------------------------------------------------
async function openCommands() {
  $("cmds").classList.remove("hidden")
  try {
    state.commands = (await get("web/commands")).commands
  } catch (error) {
    toast(error.message)
  }
  $("cmds-filter").value = ""
  renderCommands()
  setTimeout(() => $("cmds-filter").focus(), 0)
}
function renderCommands() {
  const needle = $("cmds-filter").value.trim().toLowerCase()
  const list = $("cmds-list")
  list.innerHTML = ""
  let category
  const shown = (state.commands ?? []).filter((item) => !needle || `${item.title} ${item.category} /${item.slash ?? ""}`.toLowerCase().includes(needle))
  for (const item of shown.sort((a, b) => a.category.localeCompare(b.category))) {
    if (item.category !== category) {
      category = item.category
      const head = document.createElement("div")
      head.className = "dlg-cat"
      head.textContent = category || "Other"
      list.append(head)
    }
    const row = document.createElement("div")
    row.className = "dlg-row"
    row.innerHTML = `<span>${escape(item.title)}</span><span class="desc"></span><span class="foot">${item.slash ? `/${escape(item.slash)}` : ""}</span>`
    row.onclick = () => {
      $("cmds").classList.add("hidden")
      void runCommandId(item.id)
    }
    list.append(row)
  }
}

function renderComposer() {
  const tab = state.tab
  const running = tab?.status === "running"
  const send = $("send")
  send.textContent = running ? "■" : "↑"
  send.classList.toggle("stop", running)
  send.title = running ? "Stop" : "Send (Enter; Shift+Enter: new line)"
  const mode = $("mode")
  // Lists are rebuilt only when they change (a rebuild closes a list that is open, while a reply streams).
  const modes = (state.boot?.agents ?? []).map((agent) => `<option value="${escape(agent.id)}">${escape(agent.name)}</option>`).join("")
  if (mode.dataset.list !== modes) {
    mode.innerHTML = modes
    mode.dataset.list = modes
  }
  if (document.activeElement !== mode) mode.value = tab?.agent ?? state.newAgent ?? state.boot?.defaultAgent ?? "chat"
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
  const efforts = `<option value="">default</option>${levels.map((level) => `<option>${escape(level)}</option>`).join("")}`
  if (effort.dataset.list !== efforts) {
    effort.innerHTML = efforts
    effort.dataset.list = efforts
  }
  if (document.activeElement !== effort) effort.value = tab?.effort ?? ""
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
  // The access settings in it are for this page's tab.
  state.boot = await get(`web/boot${state.active ? `?tab=${encodeURIComponent(state.active)}` : ""}`)
  if (state.composingNew) return finishBoot()
  if (!state.active || !state.boot.tabs.some((tab) => tab.key === state.active)) state.active = state.boot.active ?? state.boot.tabs[0]?.key
  finishBoot()
}
function finishBoot() {
  $("user-name").textContent = state.boot.users.current
  $("avatar").textContent = state.boot.users.current.slice(0, 1).toUpperCase()
  document.title = `Agent Code${state.boot.box ? " · box" : ""}`
}
async function refreshTab() {
  const key = state.active
  if (!key) return
  try {
    const tab = await get(`web/tab/${key}`)
    // Another tab was picked while this one loaded: its answer is stale.
    if (state.active !== key) return
    state.tab = tab
  } catch {
    // A failed load keeps what is shown (a reconnect brings it up to date).
    if (state.active !== key) return
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
  state.composingNew = false
  state.active = key
  await post("web/focus", { key })
  // Access settings are the focused tab's harness's: the settings come again with the tab.
  await Promise.all([refreshTab(), refreshBoot().catch(() => {})])
  renderPanels?.()
  $("input").focus()
}
async function closeTab(key) {
  await post("web/close", { key })
  await refreshBoot()
  await refreshTab()
  await refreshSessions()
}

/** The id of the terminal command a typed "/name" stands for (its name, then an alias), if it is one. */
async function slashCommandId(text) {
  const match = text.match(/^\/([^\s]+)$/)
  if (!match) return undefined
  const name = match[1].toLowerCase()
  if (!state.commands) state.commands = (await get("web/commands").catch(() => ({ commands: [] }))).commands
  const found = state.commands.find((item) => item.slash?.toLowerCase() === name) ?? state.commands.find((item) => item.aliases?.some((alias) => alias.toLowerCase() === name))
  return found?.id
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
    const slash = !state.active && !attachments.length ? await slashCommandId(text) : undefined
    if (slash) {
      // A terminal command typed in a new chat runs without making an empty tab first.
      await runCommandId(slash)
    } else if (!state.active) {
      // A new chat: its tab first (with the model and mode picked here), then the message.
      const made = await post("web/new", { model: state.newModel, agent: state.newAgent })
      state.newModel = state.newAgent = undefined
      state.composingNew = false
      await refreshBoot()
      state.active = made.key
      await post(`tabs/${state.active}/send`, { text, attachments })
    } else await post(`tabs/${state.active}/send`, { text, attachments })
  } catch (error) {
    toast(error.message)
    input.value = text
  }
  await refreshTab()
  // A slash command may have opened one of the terminal's dialogs: it is drawn here.
  if (text.startsWith("/")) void refreshDialog()
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
  // A row as the screen draws it (its height is the line spacing, not the font's box).
  const line = document.createElement("div")
  line.className = "line"
  line.style.visibility = "hidden"
  line.textContent = "M".repeat(10)
  $("screen").append(line)
  const range = document.createRange()
  range.selectNodeContents(line)
  const width = range.getBoundingClientRect().width
  const height = line.getBoundingClientRect().height
  line.remove()
  return { w: width / 10, h: height }
}
async function fitTerminal() {
  const screen = $("screen")
  const cell = cellSize()
  term.cell = cell
  const cols = Math.max(80, Math.floor((screen.clientWidth - 12) / cell.w))
  const rows = Math.max(24, Math.floor((screen.clientHeight - 12) / cell.h))
  if (cols !== term.cols || rows !== term.rows) {
    term.cols = cols
    term.rows = rows
    await post("web/resize", { cols, rows }).catch(() => {})
  }
}
window.addEventListener("resize", () => term.open && void fitTerminal())
async function openTerminal() {
  term.open = true
  $("terminal").classList.remove("hidden")
  // The terminal view shows the dialog itself: hide ours.
  renderDialog()
  $("screen").focus()
  // After a restart (another user) Agent Code is back at its own size: always send it.
  term.cols = term.rows = 0
  await fitTerminal()
  term.frame = 0
  pollScreen()
}
function closeTerminal() {
  term.open = false
  clearTimeout(term.timer)
  $("terminal").classList.add("hidden")
  // The dialog hidden while the terminal view was open is drawn again.
  renderDialog()
  // Tabs may have been switched in the terminal view: the page follows the app's tab.
  void refreshBoot()
    .then(() => {
      if (state.composingNew || !state.boot.active || state.boot.active === state.active) return
      state.active = state.boot.active
      return refreshBoot()
    })
    .then(refreshTab)
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
              const at = frame.cursor && frame.cursor[1] === y && frame.cursor[0] >= x && frame.cursor[0] < x + text.length ? frame.cursor[0] - x : -1
              x += text.length
              // The cursor marks one cell, not the whole run of text it sits in.
              if (at < 0) return `<span style="${style}">${escape(text)}</span>`
              return `<span style="${style}">${escape(text.slice(0, at))}<span class="cur">${escape(text[at])}</span>${escape(text.slice(at + 1))}</span>`
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
      await post("web/setting", { name: item.key, value: !item.value, key: state.active })
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
  $("open-commands").onclick = () => void openCommands()
  $("cmds-close").onclick = () => $("cmds").classList.add("hidden")
  $("cmds-filter").oninput = renderCommands
  $("cmds-filter").onkeydown = (event) => {
    if (event.key === "Enter") $("cmds-list").querySelector(".dlg-row")?.click()
    if (event.key === "Escape") {
      // Handled here: it must not also close the dialog under the palette, or stop a running chat.
      event.preventDefault()
      $("cmds").classList.add("hidden")
    }
  }
  $("dlg-close").onclick = () => void dialogAct("close")
  $("dlg-filter").oninput = () => {
    clearTimeout(filterTimer)
    filterTimer = setTimeout(() => {
      filterTimer = undefined
      void dialogAct("filter", { text: $("dlg-filter").value })
    }, 150)
  }
  $("dlg-filter").onkeydown = async (event) => {
    if (event.key !== "Enter") return
    // A filter still waiting is sent now, and the choice is made on what it left.
    const pending = filterTimer !== undefined
    if (pending) {
      clearTimeout(filterTimer)
      filterTimer = undefined
      await dialogAct("filter", { text: $("dlg-filter").value })
    }
    const options = state.dialog?.options
    if (options?.length) void dialogAct("select", { value: pending ? options[0].value : (state.dialog.selected ?? options[0].value) })
  }
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault()
      void openCommands()
    }
    // Esc closes the palette, else the dialog drawn here (in the terminal view the keys go to the program itself). What
    // it closes it marks as handled: only an Esc that closed nothing interrupts the chat.
    if (event.key === "Escape" && !event.defaultPrevented) {
      if (!$("cmds").classList.contains("hidden")) {
        event.preventDefault()
        $("cmds").classList.add("hidden")
      } else if (state.dialog && $("terminal").classList.contains("hidden")) {
        event.preventDefault()
        void dialogAct("close")
      }
    }
  })
  if (localStorage.getItem("acode.web.theme") === "light") document.documentElement.classList.add("light")
  for (const part of ["left", "right"]) if (localStorage.getItem(`acode.web.${part}`) === "hidden") document.querySelector(".app").classList.add(`${part}-hidden`)
  $("collapse-left").onclick = () => layout("left", true)
  $("expand-left").onclick = () => layout("left", false)
  $("toggle-right").onclick = () => layout("right", !document.querySelector(".app").classList.contains("right-hidden"))
  $("expand-right").onclick = () => layout("right", false)
  $("new-chat").onclick = async () => {
    state.composingNew = true
    state.active = undefined
    state.tab = undefined
    render()
    $("input").focus()
  }
  $("search").oninput = renderSessions
  $("send").onclick = () => void sendMessage()
  const input = $("input")
  // "/" at the start: the terminal's slash commands, as suggestions (a click, or Tab, puts one in).
  const slashBox = document.createElement("div")
  slashBox.className = "slash-box hidden"
  $("composer-wrap").prepend(slashBox)
  const showSlash = async () => {
    const text = input.value
    if (!/^\/[^\s]*$/.test(text)) return slashBox.classList.add("hidden")
    if (!state.commands) state.commands = (await get("web/commands").catch(() => ({ commands: [] }))).commands
    const query = text.slice(1).toLowerCase()
    const hits = state.commands.filter((item) => item.slash && item.slash.toLowerCase().includes(query)).sort((a, b) => (b.slash.toLowerCase().startsWith(query) ? 1 : 0) - (a.slash.toLowerCase().startsWith(query) ? 1 : 0)).slice(0, 8)
    slashBox.innerHTML = hits.map((item) => `<div class="dlg-row" data-slash="${escape(item.slash)}"><b>/${escape(item.slash)}</b><span class="desc">${escape(item.title)}</span></div>`).join("")
    slashBox.classList.toggle("hidden", !hits.length)
    for (const row of slashBox.querySelectorAll(".dlg-row"))
      row.onclick = () => {
        input.value = `/${row.dataset.slash}`
        slashBox.classList.add("hidden")
        void sendMessage()
      }
  }
  input.oninput = () => {
    autosize()
    void showSlash()
  }
  input.onkeydown = (event) => {
    if (event.key === "Tab" && !slashBox.classList.contains("hidden")) {
      event.preventDefault()
      const first = slashBox.querySelector(".dlg-row")
      if (first) input.value = `/${first.dataset.slash}`
      return
    }
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) slashBox.classList.add("hidden")
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
  let lastMove = 0
  screen.onmousemove = (event) => {
    if (Date.now() - lastMove < 40) return
    lastMove = Date.now()
    screenMouse(event.buttons ? "drag" : "move", event)
  }
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
      $("box-out").textContent = `${result.output}\n\nOpen it in this app with: ${result.open}\n(or in a terminal: acode-box in ${result.dir})`
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
    } else if (event.key === "Escape" && !event.defaultPrevented && state.tab?.status === "running") void post(`tabs/${state.active}/interrupt`)
  })
}

function listen() {
  const source = new EventSource(`api/events?t=${encodeURIComponent(token)}`)
  const timers = {}
  const later = (name, fn) => {
    clearTimeout(timers[name])
    timers[name] = setTimeout(fn, 120)
  }
  source.addEventListener("tab", (event) => {
    const data = JSON.parse(event.data)
    if (data.key === state.active) later("tab", refreshTab)
  })
  source.addEventListener("tabs", () => later("tabs", () => refreshBoot().then(render)))
  source.addEventListener("dialog", () => later("dialog", refreshDialog))
  source.onerror = () => {
    // Agent Code restarting (another user, a reset), sleep, a network blip: the browser reconnects by itself.
  }
  // Each (re)connection: whatever changed meanwhile is fetched (nothing is sent again for an idle chat).
  let connected = false
  source.onopen = () => {
    if (!connected) return void (connected = true)
    void refreshBoot()
      .then(() => refreshTab())
      .then(render)
      .then(() => refreshDialog())
      .catch(() => {})
  }
  // Limits and costs change without chat events too.
  // (the open chat too: its control rows have times in them.)
  setInterval(() => refreshBoot().then(() => refreshTab()).catch(() => {}), 15000)
}

async function main() {
  wire()
  try {
    await claimKey()
    await refreshBoot()
    await refreshTab()
    await refreshSessions()
    await refreshDialog()
    listen()
  } catch (error) {
    $("messages").innerHTML = `<div class="msg-notice error">${escape(error.message)}</div>`
  }
  $("input").focus()
}
void main()
