// Agent Code on a phone: shows the tabs and chats of Agent Code running on a computer, sends prompts and files, stops, pauses
// and answers permission prompts. The computer does the work; this page only talks to Agent Code's phone server.

import { openDesktop } from "./desktop.js"

const $ = (id) => document.getElementById(id)

// Phones paired before the rename kept their token under "occ.…": carry it over once, so they stay paired.
for (const key of ["token", "tab", "showFiles", "showTools"]) {
  const old = localStorage.getItem(`occ.${key}`)
  if (old !== null && localStorage.getItem(`acode.${key}`) === null) localStorage.setItem(`acode.${key}`, old)
  localStorage.removeItem(`occ.${key}`)
}
const state = { token: "", tabs: [], current: localStorage.getItem("acode.tab") ?? "", detail: undefined, files: [], serverFiles: true }
const prefs = {
  showFiles: localStorage.getItem("acode.showFiles") !== "0",
  showTools: localStorage.getItem("acode.showTools") !== "0",
}

// The pairing token comes in the link's #t=…, is kept on the phone and removed from the address bar.
const fromLink = new URLSearchParams(location.hash.slice(1)).get("t")
if (fromLink) {
  localStorage.setItem("acode.token", fromLink)
  history.replaceState(null, "", location.pathname)
}
state.token = localStorage.getItem("acode.token") ?? ""

async function api(path, body) {
  const response = await fetch(`api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${state.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`)
  return data
}

const escape = (text) => String(text ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])

/** Just enough markdown for chat replies: code blocks, inline code, bold, links. */
function markdown(text) {
  const blocks = String(text ?? "").split(/```/)
  return blocks
    .map((block, index) => {
      if (index % 2) return `<pre>${escape(block.replace(/^[\w+-]*\n/, ""))}</pre>`
      return `<div class="text">${escape(block)
        .replace(/`([^`\n]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
        .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')}</div>`
    })
    .join("")
}

const fileUrl = (path, download) => `api/file?tab=${encodeURIComponent(state.current)}&path=${encodeURIComponent(path)}&t=${encodeURIComponent(state.token)}${download ? "&download=1" : ""}`

function fileLink(path, name) {
  if (!prefs.showFiles || !state.serverFiles || !path) return ""
  const isImage = /\.(png|jpe?g|gif|webp)$/i.test(path)
  return `<a class="file" href="${fileUrl(path, !isImage)}" target="_blank" rel="noopener">⇩ ${escape(name ?? path.split("/").pop())}${isImage ? `<img loading="lazy" src="${fileUrl(path)}" alt="">` : ""}</a>`
}

function renderTabs() {
  const nav = $("tabs")
  nav.innerHTML = ""
  for (const tab of state.tabs) {
    const button = document.createElement("button")
    button.textContent = tab.title
    button.className = [tab.key === state.current && "active", tab.status === "running" && "running", tab.paused && "paused", tab.permissions && "ask"].filter(Boolean).join(" ")
    button.onclick = () => selectTab(tab.key)
    nav.append(button)
  }
}

function renderChat() {
  const chat = $("chat")
  const detail = state.detail
  if (!detail) {
    chat.innerHTML = `<div class="empty muted">${state.tabs.length ? "Pick a tab" : "No tabs open in Agent Code"}</div>`
    return
  }
  const nearBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 120
  chat.innerHTML = detail.messages
    .map((message) => {
      if (message.type === "user")
        return `<div class="msg user">${escape(message.text)}${(message.attachments ?? []).map((item) => fileLink(item.path, item.name)).join("")}</div>`
      if (message.type === "assistant") {
        const parts = message.parts
          .map((part) => {
            if (part.type === "text") return markdown(part.text)
            if (!prefs.showTools) return part.file ? fileLink(part.file) : ""
            return `<div class="tool ${part.status}">${escape(part.name)} ${escape(part.title)}${part.status === "error" && part.output ? `<br>${escape(part.output)}` : ""}</div>${part.file && /^(Write|Edit|MultiEdit|NotebookEdit)$/.test(part.name) ? fileLink(part.file) : ""}`
          })
          .join("")
        return `<div class="msg assistant">${parts}${message.error ? `<div class="notice error">${escape(message.error)}</div>` : ""}${message.done ? `<div class="meta">${escape(message.model ?? "")}</div>` : ""}</div>`
      }
      return message.text ? `<div class="msg notice ${message.variant === "error" ? "error" : ""}">${escape(message.text)}</div>` : ""
    })
    .join("")
  if (nearBottom) chat.scrollTop = chat.scrollHeight
  // Permission prompts: answered here as in Agent Code.
  const box = $("permissions")
  box.hidden = !detail.permissions?.length
  box.innerHTML = (detail.permissions ?? [])
    .map(
      (item) => `<div class="ask-card"><div class="title">Allow ${escape(item.title)}?</div><div class="detail">${escape(item.detail)}</div>
      <div class="row"><button data-id="${escape(item.id)}" data-decision="once" class="primary">Allow once</button><button data-id="${escape(item.id)}" data-decision="always">Always</button><button data-id="${escape(item.id)}" data-decision="reject">Reject</button></div></div>`,
    )
    .join("")
  for (const button of box.querySelectorAll("button"))
    button.onclick = () => api(`tabs/${state.current}/permission`, { id: button.dataset.id, decision: button.dataset.decision }).then(refreshTab).catch(showError)
  const tab = state.tabs.find((item) => item.key === state.current)
  $("status").textContent = tab ? `${tab.model} · ${tab.paused ? "paused" : tab.status}` : ""
  $("pause").textContent = tab?.paused ? "▶ Resume" : "⏸ Pause"
  $("interrupt").disabled = tab?.status !== "running"
}

async function refreshState() {
  const data = await api("state")
  state.tabs = data.tabs
  state.serverFiles = data.files
  $("host").textContent = data.host
  $("desktop-button").hidden = data.desktop?.available === false
  $("paired").textContent = data.host
  if (!state.tabs.some((tab) => tab.key === state.current)) state.current = state.tabs[0]?.key ?? ""
  renderTabs()
  if (state.current && !state.detail) await refreshTab()
  else renderChat()
}

async function refreshTab() {
  if (!state.current) {
    state.detail = undefined
    return renderChat()
  }
  state.detail = await api(`tabs/${state.current}`)
  renderChat()
}

function selectTab(key) {
  state.current = key
  localStorage.setItem("acode.tab", key)
  state.detail = undefined
  renderTabs()
  void refreshTab().catch(showError)
}

function showError(error) {
  $("status").textContent = String(error?.message ?? error)
}

// Live updates from Agent Code (server-sent events); reconnects by itself.
let events
function connect() {
  events?.close()
  events = new EventSource(`api/events?t=${encodeURIComponent(state.token)}`)
  events.onopen = () => {
    $("dot").classList.add("on")
    void refreshState().catch(showError)
  }
  events.onerror = () => $("dot").classList.remove("on")
  events.addEventListener("tabs", () => void refreshState().catch(showError))
  events.addEventListener("tab", (event) => {
    const { key, attention } = JSON.parse(event.data)
    if (key === state.current) void refreshTab().catch(showError)
    if (attention && document.hidden && "Notification" in window && Notification.permission === "granted") new Notification("Agent Code needs you", { body: "A tab is asking for permission" })
  })
}

// Files picked on the phone go along with the next prompt.
$("files").onchange = async (event) => {
  for (const file of event.target.files) {
    const data = await new Promise((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "")
      reader.readAsDataURL(file)
    })
    state.files.push({ name: file.name, data })
  }
  event.target.value = ""
  $("attached").innerHTML = state.files.map((file) => `<span>📎 ${escape(file.name)}</span>`).join("")
}

async function send() {
  const text = $("prompt").value.trim()
  if (!text && !state.files.length) return
  $("send").disabled = true
  try {
    if (!state.current) {
      const created = await api("new", { text, attachments: state.files })
      state.current = created.key
    } else await api(`tabs/${state.current}/send`, { text, attachments: state.files })
    $("prompt").value = ""
    state.files = []
    $("attached").innerHTML = ""
    await refreshTab()
  } catch (error) {
    showError(error)
  } finally {
    $("send").disabled = false
  }
}

$("send").onclick = send
$("prompt").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !matchMedia("(pointer: coarse)").matches) {
    event.preventDefault()
    void send()
  }
})
$("prompt").addEventListener("input", (event) => {
  event.target.style.height = "auto"
  event.target.style.height = `${event.target.scrollHeight}px`
})
$("interrupt").onclick = () => api(`tabs/${state.current}/interrupt`, {}).catch(showError)
$("pause").onclick = () => {
  const tab = state.tabs.find((item) => item.key === state.current)
  if (tab?.paused) return void api(`tabs/${state.current}/resume`, {}).catch(showError)
  $("pause-dialog").showModal()
}
for (const button of $("pause-dialog").querySelectorAll("button")) {
  button.onclick = () => {
    $("pause-dialog").close()
    if (button.hasAttribute("data-close")) return
    void api(`tabs/${state.current}/pause`, { minutes: button.dataset.minutes ? Number(button.dataset.minutes) : undefined }).catch(showError)
  }
}
$("new").onclick = () => {
  state.current = ""
  state.detail = undefined
  renderTabs()
  $("chat").innerHTML = `<div class="empty muted">New tab: write the first prompt</div>`
  $("prompt").focus()
}
$("settings-button").onclick = () => {
  $("show-files").checked = prefs.showFiles
  $("show-tools").checked = prefs.showTools
  $("settings").showModal()
  if ("Notification" in window && Notification.permission === "default") void Notification.requestPermission()
}
$("show-files").onchange = (event) => {
  prefs.showFiles = event.target.checked
  localStorage.setItem("acode.showFiles", prefs.showFiles ? "1" : "0")
  renderChat()
}
$("show-tools").onchange = (event) => {
  prefs.showTools = event.target.checked
  localStorage.setItem("acode.showTools", prefs.showTools ? "1" : "0")
  renderChat()
}
$("close-settings").onclick = () => $("settings").close()
$("desktop-button").onclick = () => (state.token ? openDesktop(state.token) : showError("Pair this phone first"))
$("unpair").onclick = () => {
  localStorage.removeItem("acode.token")
  location.reload()
}

if (!state.token) {
  $("chat").innerHTML = `<div class="empty muted">Not paired. In Agent Code on your computer run <b>/phone</b> and scan the QR code (or open its link here).</div>`
} else connect()

if ("serviceWorker" in navigator && window.isSecureContext) void navigator.serviceWorker.register("sw.js").catch(() => {})
