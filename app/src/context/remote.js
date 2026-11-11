import { execFileSync } from "node:child_process"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
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
    return json(response, 200, { host: os.hostname(), version: acodeVersion(), files: phoneSettings().files, tabs: tabs().map(tabSummary) })
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
