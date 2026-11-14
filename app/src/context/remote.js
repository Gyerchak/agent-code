import { execFileSync, spawn, spawnSync } from "node:child_process"
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import http from "node:http"
import https from "node:https"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { readAttachment } from "./attachments"
import { config, saveConfig } from "./config"
import { log } from "./log"
import { stateDir } from "./paths"
import { findBinary } from "./platform"
// tabs before session: tabs.js has to load first (it imports session.js, which reaches back to it).
import { newSession, tabs } from "./tabs"
import { onSessionEvent } from "./session"
import { machine, vc, whisperPython } from "./voice"

// ---------------------------------------------------------------------------
// Agent Code on a phone. Agent Code runs a small web server (on this machine, the local network or a public address, as set
// in /phone): it serves the phone app (phone/, a web app you add to the home screen on Android and iOS) and an
// API to it. The work stays on this computer; the phone shows the tabs and the chat live, sends prompts and files,
// interrupts, pauses and answers permission prompts, and downloads the files a chat made (when allowed).
// Every API call carries the pairing token from the link (or QR code) Agent Code shows; a new token unpairs every phone.
// ---------------------------------------------------------------------------

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "phone")
const uploadDir = path.join(stateDir, "phone-uploads")
const DEFAULT_PORT = 7787
let version
const acodeVersion = () => (version ??= (() => {
  try {
    return JSON.parse(readFileSync(path.join(appDir, "..", "package.json"), "utf8")).version
  } catch {
    return undefined
  }
})())

export function phoneSettings() {
  const own = config.phone ?? {}
  return {
    enabled: !!own.enabled,
    host: own.host ?? "lan",
    port: Number(own.port) || DEFAULT_PORT,
    address: own.address,
    tls: own.tls ?? "off",
    files: own.files !== false,
    // Remote desktop (screen, sound, mouse, keys): on unless switched off; KDE still asks once at the PC.
    desktop: own.desktop !== false,
    token: own.token,
  }
}

export function setPhoneSetting(key, value) {
  config.phone = { ...(config.phone ?? {}), [key]: value }
  saveConfig()
}

/** The pairing token (made on first use); `renew` makes a new one, which unpairs every phone. */
export function phoneToken(renew = false) {
  if (renew || !config.phone?.token) setPhoneSetting("token", randomBytes(18).toString("base64url"))
  return config.phone.token
}

/** This machine's first non-internal IPv4 address (what phones on the same network reach). */
export function lanAddress() {
  for (const list of Object.values(os.networkInterfaces()))
    for (const item of list ?? []) if (item.family === "IPv4" && !item.internal) return item.address
  return "127.0.0.1"
}

function bindHost(host) {
  if (host === "lan") return lanAddress()
  if (host === "all") return "0.0.0.0"
  if (host === "localhost") return "127.0.0.1"
  return host
}

/** The link a phone opens: the address the phone can reach, the port and the token (after #, never sent to servers). */
export function phoneLink() {
  const s = phoneSettings()
  const host = s.address || (s.host === "all" || s.host === "lan" ? lanAddress() : bindHost(s.host))
  return `${s.tls === "off" ? "http" : "https"}://${host}:${s.port}/#t=${phoneToken()}`
}

/** The link as a QR code in text (qrencode's half blocks), when qrencode is installed. */
export function phoneQr() {
  const qrencode = findBinary("qrencode")
  if (!qrencode) return undefined
  try {
    return execFileSync(qrencode, ["-t", "UTF8", "-m", "1", phoneLink()], { encoding: "utf8" })
  } catch {
    return undefined
  }
}

/** A self-signed certificate for https (made once with openssl). */
function selfSigned() {
  const cert = path.join(stateDir, "phone-cert.pem")
  const key = path.join(stateDir, "phone-key.pem")
  if (!existsSync(cert) || !existsSync(key)) {
    const openssl = findBinary("openssl")
    if (!openssl) throw new Error("openssl is needed for a self-signed certificate")
    mkdirSync(stateDir, { recursive: true })
    const host = phoneSettings().address || lanAddress()
    execFileSync(openssl, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "3650", "-subj", "/CN=Agent Code", "-addext", `subjectAltName=IP:${/^[\d.]+$/.test(host) ? host : "127.0.0.1"}`, "-keyout", key, "-out", cert], { stdio: "ignore" })
  }
  return { cert: readFileSync(cert), key: readFileSync(key) }
}

// ---------------------------------------------------------------------------
// What the phone sees: tabs and a plain copy of their chats
// ---------------------------------------------------------------------------

function tabSummary(session) {
  const s = session.store
  return {
    key: session.key,
    title: s.title ?? "New session",
    model: session.modelLabel?.() ?? s.model,
    engine: s.engine ?? "claude",
    status: s.status,
    paused: s.pause ? { until: s.pause.until, reason: s.pause.reason } : undefined,
    permissions: s.permissions.length,
    unseen: s.unseen,
  }
}

const toolTitle = (part) => {
  const input = part.input ?? {}
  return String(input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.description ?? input.query ?? "").split("\n")[0].slice(0, 160)
}

function plainMessages(session) {
  return session.store.messages.slice(-200).map((message) => {
    if (message.type === "user")
      return {
        type: "user",
        id: message.id,
        text: message.text,
        attachments: (message.attachments ?? []).map((item) => ({ name: item.name, kind: item.kind, path: item.path, size: item.size })),
      }
    if (message.type === "assistant")
      return {
        type: "assistant",
        id: message.id,
        model: message.model,
        done: message.end !== undefined,
        error: message.error,
        parts: message.parts
          .filter((part) => part.type === "text" || part.type === "tool")
          .map((part) =>
            part.type === "text"
              ? { type: "text", text: part.text }
              : { type: "tool", name: part.name, title: toolTitle(part), status: part.status, file: part.input?.file_path, output: (part.error ?? part.output ?? "").slice(0, 600) },
          ),
      }
    if (message.type === "notice") return { type: "notice", id: message.id, text: message.text, variant: message.variant }
    if (message.type === "shell") return { type: "notice", id: message.id, text: `$ ${message.command}\n${(message.output ?? "").slice(-600)}`, variant: "info" }
    return { type: "notice", id: message.id, text: "" }
  })
}

function tabDetail(session) {
  return {
    ...tabSummary(session),
    messages: plainMessages(session),
    permissions: session.store.permissions.map((item) => ({ id: item.id, tool: item.tool, title: item.title ?? item.displayName ?? item.tool, detail: toolTitle({ input: item.input }) })),
  }
}

/** Files a phone may download from a tab: its attachments and the files its tools wrote, edited or read. */
function allowedFiles(session) {
  const files = new Set()
  for (const message of session.store.messages) {
    if (message.type === "user") for (const item of message.attachments ?? []) if (item.path) files.add(item.path)
    if (message.type === "assistant")
      for (const part of message.parts) if (part.type === "tool" && part.input?.file_path) files.add(path.resolve(session.store.cwd, part.input.file_path))
  }
  return files
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

let server
let clients = new Set()
let signatureTimer
const signatures = new Map()
const failures = new Map()

export function phoneServerState() {
  return { running: !!server, clients: clients.size }
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json", ".png": "image/png", ".json": "application/json" }
const FILE_MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf", ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8", ".json": "application/json" }

function authorized(request, url) {
  const token = phoneToken()
  const given = (request.headers.authorization ?? "").replace(/^Bearer\s+/i, "") || url.searchParams.get("t") || ""
  const a = Buffer.from(given)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" })
  response.end(JSON.stringify(body))
}

function readBody(request, limit = 60 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    request.on("data", (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error("too large"))
        request.destroy()
      } else chunks.push(chunk)
    })
    request.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {})
      } catch (error) {
        reject(error)
      }
    })
    request.on("error", reject)
  })
}

const findSession = (key) => tabs().find((session) => session.key === key)

async function saveUploads(list) {
  const out = []
  mkdirSync(uploadDir, { recursive: true })
  for (const item of list ?? []) {
    const name = String(item.name ?? "file").replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "file"
    const file = path.join(uploadDir, `${Date.now()}-${name}`)
    writeFileSync(file, Buffer.from(String(item.data ?? ""), "base64"))
    out.push(await readAttachment(file))
  }
  return out
}

async function handleApi(request, response, url) {
  const parts = url.pathname.split("/").filter(Boolean) // api, …
  if (request.method === "GET" && parts[1] === "state")
    return json(response, 200, {
      host: os.hostname(),
      version: acodeVersion(),
      files: phoneSettings().files,
      tabs: tabs().map(tabSummary),
      desktop: { available: !!DESKTOP_HELPER && phoneSettings().desktop, secure: phoneSettings().tls !== "off" },
    })
  if (parts[1] === "desktop") {
    if (!phoneSettings().desktop) return json(response, 403, { error: "Remote desktop is switched off on the PC (/phone)" })
    return desktopApi(request, response, url, parts)
  }
  if (request.method === "GET" && parts[1] === "events") return events(request, response)
  if (parts[1] === "tabs" && parts[2]) {
    const session = findSession(parts[2])
    if (!session) return json(response, 404, { error: "no such tab" })
    if (request.method === "GET" && !parts[3]) return json(response, 200, tabDetail(session))
    if (request.method !== "POST") return json(response, 405, { error: "method" })
    const body = await readBody(request)
    switch (parts[3]) {
      case "send": {
        const attachments = await saveUploads(body.attachments)
        const text = String(body.text ?? "").trim() || (attachments.length ? "See the attached files." : "")
        if (!text) return json(response, 400, { error: "empty" })
        session.send(text, { attachments })
        return json(response, 200, { ok: true })
      }
      case "interrupt":
        await session.interrupt()
        return json(response, 200, { ok: true })
      case "pause":
        session.pause(body.minutes ? Date.now() + Number(body.minutes) * 60_000 : undefined)
        return json(response, 200, { ok: true })
      case "resume":
        session.resume()
        return json(response, 200, { ok: true })
      case "permission":
        session.replyPermission(String(body.id), body.decision === "always" ? "always" : body.decision === "reject" ? "reject" : "once")
        return json(response, 200, { ok: true })
    }
    return json(response, 404, { error: "unknown action" })
  }
  if (request.method === "POST" && parts[1] === "new") {
    const body = await readBody(request)
    const session = await newSession()
    const attachments = await saveUploads(body.attachments)
    if (String(body.text ?? "").trim()) session.send(String(body.text), { attachments })
    return json(response, 200, { key: session.key })
  }
  if (request.method === "GET" && parts[1] === "file") {
    if (!phoneSettings().files) return json(response, 403, { error: "file downloads are off in Agent Code (/phone)" })
    const session = findSession(url.searchParams.get("tab") ?? "")
    const file = path.resolve(url.searchParams.get("path") ?? "")
    if (!session || !allowedFiles(session).has(file) || !existsSync(file) || !statSync(file).isFile()) return json(response, 404, { error: "not a file of this chat" })
    response.writeHead(200, {
      "content-type": FILE_MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
      "content-length": statSync(file).size,
      "content-disposition": `${url.searchParams.get("download") ? "attachment" : "inline"}; filename="${path.basename(file).replace(/"/g, "")}"`,
    })
    return createReadStream(file).pipe(response)
  }
  return json(response, 404, { error: "unknown" })
}

/** Server-sent events: "tabs" when the tab list changes, "tab" with a key when that chat changed. */
function events(request, response) {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" })
  response.write("retry: 3000\n\n")
  const client = { response }
  clients.add(client)
  request.on("close", () => {
    clients.delete(client)
    if (!clients.size) {
      clearInterval(signatureTimer)
      signatureTimer = undefined
    }
  })
  // Cheap change detection: a signature per tab, compared a few times a second while a phone listens.
  if (!signatureTimer) signatureTimer = setInterval(checkChanges, 600)
  return undefined
}

function broadcast(event, data) {
  const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const client of clients) client.response.write(line)
}

function checkChanges() {
  const list = tabs()
  const listSig = list.map((session) => `${session.key}:${session.store.title}:${session.store.status}:${!!session.store.pause}:${session.store.permissions.length}`).join("|")
  if (signatures.get("tabs") !== listSig) {
    signatures.set("tabs", listSig)
    broadcast("tabs", {})
  }
  for (const session of list) {
    const messages = session.store.messages
    const last = messages.at(-1)
    const lastPart = last?.type === "assistant" ? last.parts.at(-1) : undefined
    const sig = `${messages.length}:${last?.type === "assistant" ? last.parts.length : 0}:${lastPart?.type === "text" ? lastPart.text.length : (lastPart?.status ?? "")}:${session.store.status}:${session.store.permissions.length}:${!!session.store.pause}`
    if (signatures.get(session.key) !== sig) {
      signatures.set(session.key, sig)
      broadcast("tab", { key: session.key })
    }
  }
}

async function handle(request, response) {
  const url = new URL(request.url ?? "/", "http://acode")
  try {
    if (url.pathname.startsWith("/api/")) {
      const ip = request.socket.remoteAddress ?? ""
      if ((failures.get(ip) ?? 0) > 20) return json(response, 429, { error: "too many wrong tokens" })
      if (!authorized(request, url)) {
        failures.set(ip, (failures.get(ip) ?? 0) + 1)
        return json(response, 401, { error: "pair this phone again (the token is wrong or was renewed)" })
      }
      return await handleApi(request, response, url)
    }
    // The phone app itself: static files, no secrets in them.
    const name = url.pathname === "/" ? "index.html" : path.normalize(url.pathname).replace(/^[/\\]+/, "")
    const file = path.join(appDir, name)
    if (!file.startsWith(appDir) || !existsSync(file) || !statSync(file).isFile()) {
      response.writeHead(404)
      return response.end()
    }
    response.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" })
    createReadStream(file).pipe(response)
  } catch (error) {
    log("phone server error", error)
    if (!response.headersSent) json(response, 500, { error: String(error?.message ?? error) })
  }
}

/** Start (or restart) the server with the current settings; resolves to its link, or rejects. */
export function startPhoneServer() {
  stopPhoneServer()
  listenToSessions()
  const s = phoneSettings()
  phoneToken()
  const tls = s.tls === "self-signed" ? selfSigned() : typeof s.tls === "object" && s.tls.cert ? { cert: readFileSync(s.tls.cert), key: readFileSync(s.tls.key) } : undefined
  server = tls ? https.createServer(tls, handle) : http.createServer(handle)
  server.on("upgrade", upgrade)
  return new Promise((resolve, reject) => {
    server.once("error", (error) => {
      log("phone server failed", error)
      server = undefined
      reject(error)
    })
    server.listen(s.port, bindHost(s.host), () => {
      log("phone server", phoneLink().replace(/#t=.*/, ""))
      resolve(phoneLink())
    })
  })
}

export function stopPhoneServer() {
  stopDesktop(true)
  for (const client of clients) client.response.end()
  clients = new Set()
  clearInterval(signatureTimer)
  signatureTimer = undefined
  server?.close()
  server = undefined
}

/** On Agent Code's start: run the server when it is switched on. */
export function autostartPhoneServer() {
  if (!phoneSettings().enabled) return
  startPhoneServer().catch((error) => log("phone server not started", String(error?.message ?? error)))
}

// A tab asking for permission or finishing is worth a quick push to the phone (hooked when a server starts, so
// importing this module never touches the session registry while the modules are still loading).
let listening = false
function listenToSessions() {
  if (listening) return
  listening = true
  onSessionEvent((event) => {
    if (clients.size && (event.type === "attention" || event.type === "idle")) broadcast("tab", { key: event.session.key, attention: event.type === "attention" })
  })
}

// ---------------------------------------------------------------------------
// Remote desktop: the PC's screen and sound on the phone; the phone's touches, keys, microphone and voice typing on
// the PC. On demand: the helper (src/remote-desktop/desktop.py: portal session + GStreamer) starts when a phone
// opens the Desktop view and stops DESKTOP_IDLE_STOP after the last one leaves. Video and sound go to the phone over
// a WebSocket (/api/desktop/ws, same token as the rest of the API):
//   server → phone  binary [1][flags][pts u64][H.264 Annex B] video · [2][pts u64][Opus] sound · text: JSON events
//   phone → server  text: JSON commands ({cmd, id?}) · binary [1 Opus | 2 PCM s16 48 kHz mono][data]: microphone
// ---------------------------------------------------------------------------

const DESKTOP_HELPER = [path.join(appDir, "..", "src", "remote-desktop", "desktop.py")].find(existsSync)
const VOICE_SCRIPT = [path.join(appDir, "..", "voice", "acode_voice.py")].find(existsSync)
const ONE_SCREEN_MARK = path.join(stateDir, "desktop-one-screen.json")
const DESKTOP_IDLE_STOP = 15_000
const TEST_DESKTOP = process.env.ACODE_DESKTOP_TEST === "1"
const COMMANDS = new Set(["move", "rel", "button", "click", "scroll", "key", "combo", "text", "view", "quality", "keyframe", "audio", "mic", "desktops", "desktop", "windows", "activate", "apps", "launch", "files", "open", "oneScreen"])
const desktop = { proc: undefined, viewers: new Set(), stopTimer: undefined, buffer: Buffer.alloc(0), cache: {}, pending: new Map(), nextId: 1, icons: new Set(), quality: "", keyAsked: 0, whisper: undefined }

export function desktopState() {
  return { available: !!DESKTOP_HELPER, running: !!desktop.proc, viewers: desktop.viewers.size }
}

/** Start the helper with no phone yet, so screen sharing can be approved at the PC once (it stops a minute later). */
export function setupDesktop() {
  startDesktop()
  scheduleDesktopStop(60_000)
}

function helperSend(message) {
  try {
    desktop.proc?.stdin.write(`${JSON.stringify(message)}\n`)
  } catch (error) {
    log("desktop helper write", error)
  }
}

function startDesktop() {
  clearTimeout(desktop.stopTimer)
  desktop.stopTimer = undefined
  if (desktop.proc) return
  if (!DESKTOP_HELPER) throw new Error("src/remote-desktop/desktop.py is missing from this install")
  const proc = spawn(findBinary("python3") ?? "python3", [DESKTOP_HELPER, "--state", stateDir], { stdio: ["pipe", "pipe", "pipe"] })
  desktop.proc = proc
  desktop.buffer = Buffer.alloc(0)
  desktop.cache = {}
  desktop.quality = ""
  proc.stdout.on("data", onHelperData)
  proc.stderr.on("data", (chunk) => {
    // Input lines are noise in normal use; in test mode they are what shows the phone's touches arrived.
    for (const line of chunk.toString().split("\n")) if (line.trim() && (TEST_DESKTOP || !line.startsWith("[desktop] input"))) log("desktop", line.trim().slice(0, 400))
  })
  proc.stdin.on("error", () => {})
  proc.on("error", (error) => log("desktop helper", error))
  proc.on("exit", (code, sig) => {
    log("desktop helper ended", code, sig)
    if (desktop.proc !== proc) return
    desktop.proc = undefined
    stopWhisper()
    // A helper that was killed can't put the screens back itself.
    if (existsSync(ONE_SCREEN_MARK)) spawnSync(findBinary("python3") ?? "python3", [DESKTOP_HELPER, "--restore", "--state", stateDir], { stdio: "ignore", timeout: 20_000 })
    for (const viewer of desktop.viewers) viewer.send(JSON.stringify({ type: "status", state: "stopped", text: "Screen sharing stopped on the PC" }))
  })
}

function scheduleDesktopStop(delay = DESKTOP_IDLE_STOP) {
  clearTimeout(desktop.stopTimer)
  desktop.stopTimer = setTimeout(() => {
    if (desktop.viewers.size) return
    stopDesktop()
  }, delay)
}

export function stopDesktop(now = false) {
  clearTimeout(desktop.stopTimer)
  desktop.stopTimer = undefined
  for (const viewer of desktop.viewers) if (now) viewer.close(1001)
  const proc = desktop.proc
  if (!proc) return
  helperSend({ cmd: "stop" })
  setTimeout(() => proc.exitCode === null && proc.kill("SIGTERM"), now ? 1500 : 4000)
}

process.on("exit", () => desktop.proc?.kill("SIGTERM"))

function onHelperData(chunk) {
  let buffer = desktop.buffer.length ? Buffer.concat([desktop.buffer, chunk]) : chunk
  let at = 0
  while (buffer.length - at >= 5) {
    const length = buffer.readUInt32BE(at + 1)
    if (buffer.length - at - 5 < length) break
    onHelperFrame(buffer[at], buffer.subarray(at + 5, at + 5 + length))
    at += 5 + length
  }
  desktop.buffer = at >= buffer.length ? Buffer.alloc(0) : at ? Buffer.from(buffer.subarray(at)) : buffer
}

const TYPE_VIDEO = Buffer.from([1])
const TYPE_AUDIO = Buffer.from([2])

function askKeyframe() {
  if (Date.now() - desktop.keyAsked < 500) return
  desktop.keyAsked = Date.now()
  helperSend({ cmd: "keyframe" })
}

function onHelperFrame(type, payload) {
  if (type === 1) {
    const key = (payload[0] & 1) === 1
    for (const viewer of desktop.viewers) {
      // A phone that can't keep up skips to the next keyframe instead of falling behind.
      if (viewer.socket.writableLength > 1_500_000) {
        viewer.needKey = true
        continue
      }
      if (viewer.needKey && !key) {
        askKeyframe()
        continue
      }
      viewer.needKey = false
      viewer.sendParts(2, TYPE_VIDEO, payload)
    }
    return
  }
  if (type === 2) {
    for (const viewer of desktop.viewers) if (viewer.socket.writableLength < 400_000) viewer.sendParts(2, TYPE_AUDIO, payload)
    return
  }
  if (type !== 3) return
  let message
  try {
    message = JSON.parse(payload.toString("utf8"))
  } catch {
    return
  }
  if (message.type === "reply") {
    const asked = desktop.pending.get(message.id)
    desktop.pending.delete(message.id)
    if (message.apps) for (const app of message.apps) if (app.icon) desktop.icons.add(app.icon)
    if (message.oneScreen !== undefined) {
      desktop.cache.oneScreen = { type: "oneScreen", on: message.oneScreen }
      for (const viewer of desktop.viewers) viewer.send(JSON.stringify(desktop.cache.oneScreen))
    }
    if (asked) asked.viewer.send(JSON.stringify({ ...message, id: asked.id }))
    return
  }
  if (["hello", "screens", "view", "status"].includes(message.type)) desktop.cache[message.type] = message
  const text = JSON.stringify(message)
  for (const viewer of desktop.viewers) viewer.send(text)
}

function onViewerText(viewer, text) {
  let message
  try {
    message = JSON.parse(text)
  } catch {
    return
  }
  if (message.cmd === "hello") {
    const quality = { cmd: "quality", maxw: Number(message.maxw) || 1920, maxh: Number(message.maxh) || 1080, bitrate: Number(message.bitrate) || 8000 }
    const sig = JSON.stringify(quality)
    if (sig !== desktop.quality) {
      desktop.quality = sig
      helperSend(quality)
    }
    for (const key of ["hello", "screens", "view", "status", "oneScreen"]) if (desktop.cache[key]) viewer.send(JSON.stringify(desktop.cache[key]))
    viewer.needKey = true
    askKeyframe()
    return
  }
  if (!COMMANDS.has(message.cmd)) return
  if (message.cmd === "quality") desktop.quality = ""
  if (message.id !== undefined) {
    const id = desktop.nextId++
    desktop.pending.set(id, { viewer, id: message.id })
    message = { ...message, id }
  }
  helperSend(message)
}

function onViewerBinary(viewer, data) {
  if (data.length < 2) return
  helperSend({ cmd: "micdata", data: data.subarray(1).toString("base64") })
}

// -- A small WebSocket (RFC 6455) endpoint: no library needed for one route ---------------------------------------

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

function upgrade(request, socket) {
  const url = new URL(request.url ?? "/", "http://acode")
  const ip = request.socket.remoteAddress ?? ""
  if (url.pathname !== "/api/desktop/ws" || String(request.headers.upgrade ?? "").toLowerCase() !== "websocket" || !request.headers["sec-websocket-key"]) return socket.destroy()
  if ((failures.get(ip) ?? 0) > 20 || !authorized(request, url)) {
    failures.set(ip, (failures.get(ip) ?? 0) + 1)
    return socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n")
  }
  if (!phoneSettings().desktop) return socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n")
  const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}${WS_GUID}`).digest("base64")
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
  socket.setNoDelay(true)
  const viewer = webSocket(socket, {
    text: (text) => onViewerText(viewer, text),
    binary: (data) => onViewerBinary(viewer, data),
    close: () => {
      desktop.viewers.delete(viewer)
      for (const [id, item] of desktop.pending) if (item.viewer === viewer) desktop.pending.delete(id)
      if (!desktop.viewers.size) {
        helperSend({ cmd: "mic", on: false })
        scheduleDesktopStop()
      }
    },
  })
  desktop.viewers.add(viewer)
  try {
    startDesktop()
  } catch (error) {
    viewer.send(JSON.stringify({ type: "status", state: "error", text: String(error?.message ?? error) }))
  }
}

function webSocket(socket, on) {
  let buffer = Buffer.alloc(0)
  let fragments = []
  let opcode = 0
  let closed = false
  const frame = (code, ...parts) => {
    if (closed || socket.destroyed) return
    const length = parts.reduce((sum, part) => sum + part.length, 0)
    let header
    if (length < 126) header = Buffer.from([0x80 | code, length])
    else if (length < 65536) {
      header = Buffer.alloc(4)
      header[1] = 126
      header.writeUInt16BE(length, 2)
    } else {
      header = Buffer.alloc(10)
      header[1] = 127
      header.writeBigUInt64BE(BigInt(length), 2)
    }
    header[0] = 0x80 | code
    socket.cork()
    socket.write(header)
    for (const part of parts) socket.write(part)
    socket.uncork()
  }
  const finish = () => {
    if (closed) return
    closed = true
    clearInterval(ping)
    on.close()
  }
  const peer = {
    socket,
    needKey: true,
    send: (text) => frame(1, Buffer.from(text)),
    sendParts: (code, ...parts) => frame(code, ...parts),
    close: (code = 1000) => {
      const body = Buffer.alloc(2)
      body.writeUInt16BE(code)
      frame(8, body)
      socket.end()
      finish()
    },
  }
  const ping = setInterval(() => frame(9), 20_000)
  socket.on("data", (chunk) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk
    while (buffer.length >= 2) {
      const fin = (buffer[0] & 0x80) !== 0
      const code = buffer[0] & 0x0f
      let length = buffer[1] & 0x7f
      let offset = 2
      if (!(buffer[1] & 0x80)) return peer.close(1002)
      if (length === 126) {
        if (buffer.length < 4) return
        length = buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (buffer.length < 10) return
        const big = buffer.readBigUInt64BE(2)
        if (big > 4_000_000n) return peer.close(1009)
        length = Number(big)
        offset = 10
      }
      if (buffer.length < offset + 4 + length) return
      const mask = buffer.subarray(offset, offset + 4)
      const data = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length))
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3]
      buffer = buffer.subarray(offset + 4 + length)
      if (code === 8) return peer.close()
      if (code === 9) {
        frame(10, data)
        continue
      }
      if (code === 10) continue
      if (code !== 0) {
        opcode = code
        fragments = []
      }
      fragments.push(data)
      if (!fin) continue
      const message = fragments.length === 1 ? fragments[0] : Buffer.concat(fragments)
      fragments = []
      try {
        if (opcode === 1) on.text(message.toString("utf8"))
        else if (opcode === 2) on.binary(message)
      } catch (error) {
        log("desktop viewer message", error)
      }
    }
  })
  socket.on("close", finish)
  socket.on("end", finish)
  socket.on("error", finish)
  return peer
}

// -- Voice typing: the phone records, faster-whisper (the local speech-to-text Agent Code's /voice uses) writes it,
// -- and the text is typed where the PC's cursor is.

function readRaw(request, limit = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on("data", (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error("too large"))
        request.destroy()
      } else chunks.push(chunk)
    })
    request.on("end", () => resolve(Buffer.concat(chunks)))
    request.on("error", reject)
  })
}

function whisper() {
  if (desktop.whisper && !desktop.whisper.dead) return desktop.whisper
  const python = whisperPython()
  if (!python || !VOICE_SCRIPT) throw new Error("Voice typing needs faster-whisper: on the PC open /voice → Check & set up")
  const model = vc().sttModel ?? "small"
  const device = vc().sttDevice ?? (machine().gpu ? "cuda" : "cpu")
  const proc = spawn(python, [VOICE_SCRIPT, "whisper", "--model", model, "--device", device], { stdio: ["pipe", "pipe", "pipe"] })
  const worker = { proc, dead: false, next: 1, pending: new Map() }
  let readyDone
  worker.ready = new Promise((resolve, reject) => (readyDone = { resolve, reject }))
  let rest = ""
  proc.stdout.on("data", (chunk) => {
    rest += chunk.toString()
    let index
    while ((index = rest.indexOf("\n")) >= 0) {
      const line = rest.slice(0, index)
      rest = rest.slice(index + 1)
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      if (message.id === 0) readyDone.resolve()
      const waiter = worker.pending.get(message.id)
      if (!waiter) continue
      worker.pending.delete(message.id)
      if (message.ok) waiter.resolve(message)
      else waiter.reject(new Error(message.error ?? "speech recognition failed"))
    }
  })
  proc.stderr.on("data", () => {})
  proc.stdin.on("error", () => {})
  proc.on("exit", () => {
    worker.dead = true
    readyDone.reject(new Error("speech recognition stopped"))
    for (const waiter of worker.pending.values()) waiter.reject(new Error("speech recognition stopped"))
  })
  worker.request = async (body) => {
    await worker.ready
    const id = worker.next++
    return new Promise((resolve, reject) => {
      worker.pending.set(id, { resolve, reject })
      proc.stdin.write(`${JSON.stringify({ id, ...body })}\n`)
    })
  }
  desktop.whisper = worker
  return worker
}

function stopWhisper() {
  desktop.whisper?.proc.kill()
  desktop.whisper = undefined
}

const AUDIO_EXT = { "audio/webm": ".webm", "audio/ogg": ".ogg", "audio/mp4": ".m4a", "audio/aac": ".aac", "audio/wav": ".wav", "audio/mpeg": ".mp3" }

async function desktopApi(request, response, url, parts) {
  if (request.method === "GET" && parts[2] === "state") return json(response, 200, { ...desktopState(), secure: phoneSettings().tls !== "off" })
  if (request.method === "GET" && parts[2] === "icon") {
    const file = url.searchParams.get("path") ?? ""
    if (!desktop.icons.has(file) || !existsSync(file)) return json(response, 404, { error: "no icon" })
    response.writeHead(200, { "content-type": file.endsWith(".svg") ? "image/svg+xml" : "image/png", "cache-control": "max-age=86400" })
    return createReadStream(file).pipe(response)
  }
  if (request.method === "POST" && parts[2] === "dictate") {
    if (!desktop.proc) return json(response, 409, { error: "open the Desktop view first" })
    const audio = await readRaw(request)
    if (audio.length < 200) return json(response, 400, { error: "nothing recorded" })
    mkdirSync(uploadDir, { recursive: true })
    const type = String(request.headers["content-type"] ?? "").split(";")[0].trim()
    const file = path.join(uploadDir, `dictate-${Date.now()}${AUDIO_EXT[type] ?? ".webm"}`)
    writeFileSync(file, audio)
    try {
      const result = await whisper().request({ audio: file, language: vc().language === "pl" ? "pl" : undefined })
      const text = String(result.text ?? "").trim()
      if (text && url.searchParams.get("type") !== "0") helperSend({ cmd: "text", text: `${text} ` })
      return json(response, 200, { text })
    } finally {
      rmSync(file, { force: true })
    }
  }
  return json(response, 404, { error: "unknown" })
}
