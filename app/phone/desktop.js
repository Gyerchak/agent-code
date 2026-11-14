// The PC on the phone: its screen (H.264, decoded with WebCodecs) and sound (Opus) live, touches as the mouse, the
// phone keyboard and voice typing into the focused place, the phone microphone as a PC microphone, screens and
// virtual desktops, open windows, apps and files, and game controls. Everything runs only while this view is open:
// leaving it (or locking the phone) ends the stream, and the PC stops sharing a few seconds later.

const $ = (id) => document.getElementById(id)

// Linux key codes (evdev), by the names the keyboard row and the game buttons use.
const KEY = {
  esc: 1, 1: 2, 2: 3, 3: 4, 4: 5, 5: 6, 6: 7, 7: 8, 8: 9, 9: 10, 0: 11, "-": 12, "=": 13, backspace: 14, tab: 15,
  q: 16, w: 17, e: 18, r: 19, t: 20, y: 21, u: 22, i: 23, o: 24, p: 25, "[": 26, "]": 27, enter: 28, ctrl: 29,
  a: 30, s: 31, d: 32, f: 33, g: 34, h: 35, j: 36, k: 37, l: 38, ";": 39, "'": 40, "`": 41, shift: 42, "\\": 43,
  z: 44, x: 45, c: 46, v: 47, b: 48, n: 49, m: 50, ",": 51, ".": 52, "/": 53, alt: 56, space: 57, capslock: 58,
  f1: 59, f2: 60, f3: 61, f4: 62, f5: 63, f6: 64, f7: 65, f8: 66, f9: 67, f10: 68, f11: 87, f12: 88,
  home: 102, up: 103, pageup: 104, left: 105, right: 106, end: 107, down: 108, pagedown: 109, insert: 110, delete: 111,
  super: 125, mute: 113, volumedown: 114, volumeup: 115, playpause: 164,
}
const BROWSER_KEYS = { Escape: "esc", Tab: "tab", ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down", Delete: "delete", Home: "home", End: "end", PageUp: "pageup", PageDown: "pagedown", F5: "f5" }
const DEFAULT_GAME_KEYS = ["space", "shift", "e", "r", "q", "esc"]

const store = (key, fallback) => {
  try {
    const value = localStorage.getItem(`acode.desk.${key}`)
    return value === null ? fallback : JSON.parse(value)
  } catch {
    return fallback
  }
}
const save = (key, value) => localStorage.setItem(`acode.desk.${key}`, JSON.stringify(value))

const prefs = {
  mode: store("mode", "touchpad"), // touchpad | touch
  saver: store("saver", false),
  sound: store("sound", true),
  gameKeys: store("gameKeys", DEFAULT_GAME_KEYS),
  lookSpeed: store("lookSpeed", 1.5),
}

const s = {
  token: "",
  open: false,
  ws: undefined,
  decoder: undefined,
  waitKey: true,
  frame: undefined,
  drawing: false,
  audio: undefined,
  audioDecoder: undefined,
  playAt: 0,
  screens: [],
  desktops: { rows: 1, list: [] },
  view: 0,
  oneScreen: false,
  pending: new Map(),
  nextId: 1,
  game: false,
  keyboard: false,
  mods: new Set(),
  mic: undefined,
  rec: undefined,
  apps: undefined,
  folder: "~",
}
const view = { fw: 0, fh: 0, z: 1, cx: 0.5, cy: 0.5, W: 0, H: 0, left: 0, top: 0 }
const cursor = { u: 0.5, v: 0.5 }

// ---------------------------------------------------------------------------
// Open / close
// ---------------------------------------------------------------------------

export function openDesktop(token) {
  s.token = token
  s.open = true
  $("desk").hidden = false
  document.body.classList.add("desk-open")
  setGame(false)
  showBar(true)
  if (!window.isSecureContext) {
    return status(
      "The remote desktop needs HTTPS (phones only decode live video and use the microphone on secure pages). On the PC: Agent Code → /phone → turn on HTTPS, then open the new link or scan the new QR code here and accept the certificate once.",
      "error",
    )
  }
  if (!("VideoDecoder" in window)) return status("This browser can't decode live video (WebCodecs). Use Chrome on Android, or Safari 16.4 or newer on iPhone.", "error")
  // Sound has to start from this tap (browsers block audio that starts on its own).
  try {
    s.audio ??= new AudioContext({ sampleRate: 48000, latencyHint: "interactive" })
    void s.audio.resume()
  } catch {}
  void document.documentElement.requestFullscreen?.({ navigationUI: "hide" })?.then(() => screen.orientation?.lock?.("landscape").catch(() => {})).catch(() => {})
  connect()
}

export function closeDesktop() {
  s.open = false
  disconnect()
  stopMic()
  stopRecording(false)
  setKeyboard(false)
  closeSheet()
  $("desk").hidden = true
  document.body.classList.remove("desk-open")
  try {
    screen.orientation?.unlock?.()
  } catch {}
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
}

// Leaving the app (or locking the phone) ends the stream; coming back starts it again.
document.addEventListener("visibilitychange", () => {
  if (!s.open) return
  if (document.hidden) {
    stopMic()
    stopRecording(false)
    disconnect()
  } else if (!s.ws) connect()
})

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

function quality() {
  const dpr = Math.min(devicePixelRatio || 1, 3)
  const long = Math.round(Math.max(screen.width, screen.height) * dpr)
  const short = Math.round(Math.min(screen.width, screen.height) * dpr)
  return prefs.saver ? { maxw: Math.min(long, 1280), maxh: Math.min(short, 720), bitrate: 2500 } : { maxw: Math.min(long, 2560), maxh: Math.min(short, 1440), bitrate: 8000 }
}

function connect() {
  disconnect()
  status("Connecting to the PC…")
  const base = location.pathname.replace(/[^/]*$/, "")
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${base}api/desktop/ws?t=${encodeURIComponent(s.token)}`)
  ws.binaryType = "arraybuffer"
  s.ws = ws
  ws.onopen = () => {
    send({ cmd: "hello", ...quality() })
    if (!prefs.sound) send({ cmd: "audio", on: false })
  }
  ws.onmessage = (event) => (typeof event.data === "string" ? onEvent(JSON.parse(event.data)) : onBinary(event.data))
  ws.onclose = () => {
    if (s.ws !== ws) return
    s.ws = undefined
    resetDecoder()
    if (s.open && !document.hidden) {
      status("Connection lost · reconnecting…")
      setTimeout(() => s.open && !s.ws && !document.hidden && connect(), 2000)
    }
  }
}

function disconnect() {
  const ws = s.ws
  s.ws = undefined
  ws?.close()
  resetDecoder()
  for (const waiter of s.pending.values()) waiter.reject(new Error("disconnected"))
  s.pending.clear()
}

function send(message) {
  if (s.ws?.readyState === 1) s.ws.send(JSON.stringify(message))
}

function request(message) {
  const id = s.nextId++
  send({ ...message, id })
  return new Promise((resolve, reject) => {
    s.pending.set(id, { resolve, reject })
    setTimeout(() => s.pending.delete(id) && reject(new Error("the PC did not answer")), 15000)
  })
}

function onEvent(message) {
  switch (message.type) {
    case "hello":
      s.desktops = message.desktops ?? s.desktops
      break
    case "screens":
      s.screens = message.screens ?? []
      break
    case "view":
      s.view = message.view
      resetDecoder()
      if (!view.fw) Object.assign(view, { fw: message.width, fh: message.height })
      break
    case "oneScreen":
      s.oneScreen = !!message.on
      break
    case "status":
      if (message.state === "live") {
        status("")
        // The bar would cover the PC's taskbar: tuck it away once the picture is there (⋯ brings it back).
        if (!s.barTucked) {
          s.barTucked = true
          setTimeout(() => s.open && !s.game && showBar(false), 3500)
        }
      }
      else status(message.text, message.state === "error" || message.state === "stopped" ? "error" : message.state === "approval" ? "approval" : "")
      break
    case "reply": {
      const waiter = s.pending.get(message.id)
      s.pending.delete(message.id)
      if (!waiter) break
      if (message.ok) waiter.resolve(message)
      else waiter.reject(new Error(message.error ?? "failed"))
      break
    }
  }
  if (!$("desk-sheet").hidden && $("desk-sheet").dataset.kind === "screens") renderScreens()
}

// ---------------------------------------------------------------------------
// Video and sound
// ---------------------------------------------------------------------------

/** "avc1.PPCCLL" from the stream's SPS (profile, constraints, level). */
function codecOf(data) {
  for (let i = 0; i + 4 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1 && (data[i + 3] & 0x1f) === 7) {
      const hex = (n) => n.toString(16).padStart(2, "0")
      return `avc1.${hex(data[i + 4])}${hex(data[i + 5])}${hex(data[i + 6])}`
    }
  }
  return "avc1.640028"
}

function resetDecoder() {
  try {
    if (s.decoder?.state !== "closed") s.decoder?.close()
  } catch {}
  s.decoder = undefined
  s.waitKey = true
}

function onBinary(buffer) {
  const bytes = new Uint8Array(buffer)
  if (bytes[0] === 1) {
    const key = (bytes[1] & 1) === 1
    const timestamp = Number(new DataView(buffer).getBigUint64(2))
    const data = bytes.subarray(10)
    if (s.waitKey && !key) return
    if (!s.decoder) {
      s.decoder = new VideoDecoder({
        output: onFrame,
        error: (error) => {
          console.warn("video", error)
          resetDecoder()
          send({ cmd: "keyframe" })
        },
      })
      try {
        s.decoder.configure({ codec: codecOf(data), optimizeForLatency: true })
      } catch (error) {
        resetDecoder()
        return status(`This phone can't decode the stream: ${error.message}`, "error")
      }
    }
    // Falling behind: skip to the next keyframe instead of piling up delay.
    if (!key && s.decoder.decodeQueueSize > 3) {
      s.waitKey = true
      send({ cmd: "keyframe" })
      return
    }
    s.waitKey = false
    try {
      s.decoder.decode(new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp, data }))
    } catch {
      resetDecoder()
      send({ cmd: "keyframe" })
    }
    return
  }
  if (bytes[0] === 2 && prefs.sound) playOpus(bytes.subarray(10), Number(new DataView(buffer).getBigUint64(1)))
}

function onFrame(frame) {
  s.frame?.close()
  s.frame = frame
  if (s.drawing) return
  s.drawing = true
  requestAnimationFrame(() => {
    s.drawing = false
    const current = s.frame
    s.frame = undefined
    if (!current) return
    const canvas = $("desk-canvas")
    if (canvas.width !== current.displayWidth || canvas.height !== current.displayHeight) {
      canvas.width = current.displayWidth
      canvas.height = current.displayHeight
      view.fw = current.displayWidth
      view.fh = current.displayHeight
      layout()
    }
    canvas.getContext("2d").drawImage(current, 0, 0)
    current.close()
  })
}

function playOpus(data, timestamp) {
  if (!s.audio || !("AudioDecoder" in window)) return
  if (!s.audioDecoder || s.audioDecoder.state === "closed") {
    s.audioDecoder = new AudioDecoder({ output: playAudio, error: () => (s.audioDecoder = undefined) })
    s.audioDecoder.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: 2 })
  }
  try {
    s.audioDecoder.decode(new EncodedAudioChunk({ type: "key", timestamp, data }))
  } catch {}
}

function playAudio(data) {
  const ctx = s.audio
  const frames = data.numberOfFrames
  const channels = data.numberOfChannels
  const buffer = ctx.createBuffer(channels, frames, data.sampleRate)
  try {
    for (let c = 0; c < channels; c++) data.copyTo(buffer.getChannelData(c), { planeIndex: c, format: "f32-planar" })
  } catch {
    const all = new Float32Array(frames * channels)
    data.copyTo(all, { planeIndex: 0, format: "f32" })
    for (let c = 0; c < channels; c++) {
      const out = buffer.getChannelData(c)
      for (let i = 0; i < frames; i++) out[i] = all[i * channels + c]
    }
  }
  data.close()
  const now = ctx.currentTime
  // Keep the delay small: start over when the queue runs dry or grows past a third of a second.
  if (s.playAt < now + 0.01 || s.playAt > now + 0.3) s.playAt = now + 0.05
  const source = ctx.createBufferSource()
  source.buffer = buffer
  source.connect(ctx.destination)
  source.start(s.playAt)
  s.playAt += buffer.duration
}

// ---------------------------------------------------------------------------
// The picture on the phone: fit, pinch zoom, pan
// ---------------------------------------------------------------------------

const clamp = (value, low, high) => Math.min(high, Math.max(low, value))

function layout() {
  const stage = $("desk-stage")
  const vw = stage.clientWidth
  const vh = stage.clientHeight
  if (!view.fw || !vw) return
  const fit = Math.min(vw / view.fw, vh / view.fh)
  view.W = view.fw * fit * view.z
  view.H = view.fh * fit * view.z
  view.cx = view.W <= vw ? 0.5 : clamp(view.cx, vw / 2 / view.W, 1 - vw / 2 / view.W)
  view.cy = view.H <= vh ? 0.5 : clamp(view.cy, vh / 2 / view.H, 1 - vh / 2 / view.H)
  view.left = vw / 2 - view.cx * view.W
  view.top = vh / 2 - view.cy * view.H
  const canvas = $("desk-canvas")
  canvas.style.width = `${view.W}px`
  canvas.style.height = `${view.H}px`
  canvas.style.transform = `translate(${view.left}px, ${view.top}px)`
  $("desk-zoom").hidden = view.z <= 1.01
}
window.addEventListener("resize", () => s.open && layout())

function toFrame(x, y) {
  const box = $("desk-stage").getBoundingClientRect()
  return { u: (x - box.left - view.left) / view.W, v: (y - box.top - view.top) / view.H }
}

function zoomAt(z, x, y) {
  const point = toFrame(x, y)
  const box = $("desk-stage").getBoundingClientRect()
  const fit = Math.min(box.width / view.fw, box.height / view.fh)
  view.z = clamp(z, 1, 6)
  const W = view.fw * fit * view.z
  const H = view.fh * fit * view.z
  view.cx = (box.width / 2 - (x - box.left - point.u * W)) / W
  view.cy = (box.height / 2 - (y - box.top - point.v * H)) / H
  layout()
}

/** Touchpad mode, zoomed in: the picture follows the cursor. */
function follow() {
  if (view.z <= 1.01) return
  const box = $("desk-stage").getBoundingClientRect()
  const x = view.left + cursor.u * view.W
  const y = view.top + cursor.v * view.H
  const mx = box.width * 0.18
  const my = box.height * 0.18
  if (x < mx) view.cx -= (mx - x) / view.W
  if (x > box.width - mx) view.cx += (x - (box.width - mx)) / view.W
  if (y < my) view.cy -= (my - y) / view.H
  if (y > box.height - my) view.cy += (y - (box.height - my)) / view.H
  layout()
}

let movePending = false
function queueMove() {
  if (movePending) return
  movePending = true
  requestAnimationFrame(() => {
    movePending = false
    send({ cmd: "move", x: cursor.u, y: cursor.v })
  })
}

// ---------------------------------------------------------------------------
// Touches on the picture
//   touchpad (default): drag = move the cursor · tap = click · hold then drag = drag · two-finger tap = right click ·
//                       two-finger drag = scroll · pinch = zoom
//   touch:              tap = click there · drag = drag · hold = right click · two fingers = scroll or pan, pinch = zoom
// ---------------------------------------------------------------------------

const touches = new Map()
let gesture

function midpoint() {
  const list = [...touches.values()]
  const a = list[0]
  const b = list[1] ?? list[0]
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) || 1 }
}

function stageDown(event) {
  if (s.game) return
  event.preventDefault()
  $("desk-stage").setPointerCapture(event.pointerId)
  touches.set(event.pointerId, { x: event.clientX, y: event.clientY })
  if (touches.size === 1) {
    const g = { kind: "one", x0: event.clientX, y0: event.clientY, x: event.clientX, y: event.clientY, t: performance.now(), moved: false, dragging: false, done: false }
    gesture = g
    if (prefs.mode === "touch") {
      Object.assign(cursor, clampPoint(toFrame(event.clientX, event.clientY)))
      queueMove()
      g.timer = setTimeout(() => {
        if (g.moved || gesture !== g) return
        g.done = true
        send({ cmd: "click", button: "right" })
        navigator.vibrate?.(15)
      }, 550)
    } else
      g.timer = setTimeout(() => {
        if (g.moved || gesture !== g) return
        g.dragging = true
        send({ cmd: "button", button: "left", down: true })
        navigator.vibrate?.(15)
      }, 450)
  } else if (touches.size === 2) {
    clearTimeout(gesture?.timer)
    if (gesture?.dragging) send({ cmd: "button", button: "left", down: false })
    const m = midpoint()
    gesture = { kind: "two", t: performance.now(), d0: m.d, z0: view.z, x: m.x, y: m.y, mode: undefined, scrollX: 0, scrollY: 0 }
  }
}

const clampPoint = (p) => ({ u: clamp(p.u, 0, 1), v: clamp(p.v, 0, 1) })

function stageMove(event) {
  if (!touches.has(event.pointerId) || !gesture) return
  event.preventDefault()
  const touch = touches.get(event.pointerId)
  const dx = event.clientX - touch.x
  const dy = event.clientY - touch.y
  touch.x = event.clientX
  touch.y = event.clientY
  const g = gesture
  if (g.kind === "one") {
    if (Math.hypot(event.clientX - g.x0, event.clientY - g.y0) > 9) g.moved = true
    if (!g.moved && !g.dragging) return
    clearTimeout(g.timer)
    if (prefs.mode === "touch") {
      if (g.done) return
      if (!g.dragging) {
        g.dragging = true
        send({ cmd: "button", button: "left", down: true })
      }
      Object.assign(cursor, clampPoint(toFrame(event.clientX, event.clientY)))
    } else {
      const now = performance.now()
      const speed = Math.hypot(dx, dy) / Math.max(1, now - (g.last ?? now - 16))
      g.last = now
      const gain = 1.3 * (1 + Math.min(2.5, speed * 0.7))
      cursor.u = clamp(cursor.u + (dx * gain) / view.W, 0, 1)
      cursor.v = clamp(cursor.v + (dy * gain) / view.H, 0, 1)
      follow()
    }
    queueMove()
    return
  }
  if (g.kind !== "two" || touches.size < 2) return
  const m = midpoint()
  const mdx = m.x - g.x
  const mdy = m.y - g.y
  g.x = m.x
  g.y = m.y
  if (!g.mode) {
    if (Math.abs(m.d / g.d0 - 1) > 0.12) g.mode = "pinch"
    else if (Math.hypot(mdx, mdy) > 0 && performance.now() - g.t > 60) g.mode = prefs.mode === "touch" && view.z > 1.01 ? "pan" : "scroll"
  }
  if (g.mode === "pinch") {
    zoomAt(g.z0 * (m.d / g.d0), m.x, m.y)
    view.cx -= mdx / view.W
    view.cy -= mdy / view.H
    layout()
  } else if (g.mode === "pan") {
    view.cx -= mdx / view.W
    view.cy -= mdy / view.H
    layout()
  } else if (g.mode === "scroll") {
    g.scrollY += mdy
    g.scrollX += mdx
    const step = 26
    while (Math.abs(g.scrollY) >= step) {
      send({ cmd: "scroll", dy: g.scrollY > 0 ? -1 : 1 })
      g.scrollY -= Math.sign(g.scrollY) * step
    }
    while (Math.abs(g.scrollX) >= step * 1.5) {
      send({ cmd: "scroll", dx: g.scrollX > 0 ? -1 : 1 })
      g.scrollX -= Math.sign(g.scrollX) * step * 1.5
    }
  }
}

function stageUp(event) {
  if (!touches.has(event.pointerId)) return
  touches.delete(event.pointerId)
  const g = gesture
  if (!g) return
  if (g.kind === "one" && touches.size === 0) {
    clearTimeout(g.timer)
    if (g.dragging) send({ cmd: "button", button: "left", down: false })
    else if (!g.moved && !g.done && performance.now() - g.t < 350) send({ cmd: "click", button: "left" })
    gesture = undefined
  } else if (g.kind === "two") {
    if (!g.mode && performance.now() - g.t < 350) send({ cmd: "click", button: "right" })
    // The rest of the gesture is over; a finger still down starts nothing until all are lifted.
    gesture = touches.size ? { kind: "done" } : undefined
  } else if (!touches.size) gesture = undefined
}

function stageWheel(event) {
  event.preventDefault()
  if (event.ctrlKey) return zoomAt(view.z * (event.deltaY < 0 ? 1.15 : 1 / 1.15), event.clientX, event.clientY)
  send({ cmd: "scroll", dy: Math.sign(event.deltaY), dx: Math.sign(event.deltaX) })
}

// ---------------------------------------------------------------------------
// Keyboard: the phone's own keyboard types where the PC's cursor is; a row of keys a phone keyboard lacks
// ---------------------------------------------------------------------------

const BASE = "  "
let typed = BASE
let composing = false

function setKeyboard(on) {
  s.keyboard = on
  $("desk-keys").hidden = !on
  $("b-keys").classList.toggle("on", on)
  const input = $("desk-input")
  if (on) {
    input.value = BASE
    typed = BASE
    input.focus()
    input.setSelectionRange(BASE.length, BASE.length)
  } else input.blur()
}

function sendKey(name) {
  const code = KEY[name]
  if (!code) return
  const mods = [...s.mods].map((mod) => KEY[mod])
  send({ cmd: "combo", codes: [...mods, code] })
  clearMods()
}

function clearMods() {
  s.mods.clear()
  for (const button of $("desk-keys").querySelectorAll("[data-mod]")) button.classList.remove("on")
}

function sendText(text) {
  const parts = text.split("\n")
  parts.forEach((part, index) => {
    if (index) sendKey("enter")
    if (!part) return
    // With Ctrl/Alt/Super held, a letter is a shortcut (Ctrl+C), not text.
    if (s.mods.size && part.length === 1 && KEY[part.toLowerCase()]) return sendKey(part.toLowerCase())
    send({ cmd: "text", text: part })
  })
}

function onInput() {
  const input = $("desk-input")
  const now = input.value
  let same = 0
  while (same < typed.length && same < now.length && typed[same] === now[same]) same++
  for (let i = same; i < typed.length; i++) send({ cmd: "combo", codes: [KEY.backspace] })
  if (now.length > same) sendText(now.slice(same))
  typed = now
  if (!composing && (now.length > 40 || now.length < BASE.length || now.includes("\n"))) {
    input.value = BASE
    typed = BASE
  }
}

function onKeyDown(event) {
  const name = BROWSER_KEYS[event.key]
  if (!name) return
  event.preventDefault()
  sendKey(name)
}

// ---------------------------------------------------------------------------
// Voice typing (faster-whisper on the PC) and the phone microphone as a PC microphone
// ---------------------------------------------------------------------------

async function startRecording() {
  if (s.rec) return
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } })
    const type = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find((item) => window.MediaRecorder?.isTypeSupported?.(item))
    const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined)
    const chunks = []
    recorder.ondataavailable = (event) => event.data.size && chunks.push(event.data)
    s.rec = { recorder, stream, chunks, t: performance.now() }
    recorder.start()
    $("b-voice").classList.add("rec")
    toast("Listening… tap 🎙 again to type it")
  } catch (error) {
    toast(`Microphone: ${error.message}`)
  }
}

function stopRecording(type = true) {
  const rec = s.rec
  if (!rec) return
  s.rec = undefined
  $("b-voice").classList.remove("rec")
  rec.recorder.onstop = async () => {
    rec.stream.getTracks().forEach((track) => track.stop())
    if (!type) return
    const blob = new Blob(rec.chunks, { type: rec.recorder.mimeType || "audio/webm" })
    toast("Writing…")
    try {
      const response = await fetch("api/desktop/dictate", { method: "POST", headers: { authorization: `Bearer ${s.token}`, "content-type": blob.type.split(";")[0] }, body: blob })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`)
      toast(data.text ? `⌨ ${data.text}` : "Nothing heard")
    } catch (error) {
      toast(`Voice typing: ${error.message}`)
    }
  }
  rec.recorder.stop()
}

const MIC_WORKLET = `class AcodeMic extends AudioWorkletProcessor {
  process(inputs) { const channel = inputs[0][0]; if (channel) this.port.postMessage(channel.slice(0)); return true }
}
registerProcessor("acode-mic", AcodeMic)`

async function startMic() {
  if (s.mic) return
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } })
    const ctx = new AudioContext({ sampleRate: 48000 })
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([MIC_WORKLET], { type: "text/javascript" })))
    const node = new AudioWorkletNode(ctx, "acode-mic")
    const mute = ctx.createGain()
    mute.gain.value = 0
    ctx.createMediaStreamSource(stream).connect(node)
    node.connect(mute).connect(ctx.destination)
    const mic = { stream, ctx, node, t: 0, pcm: [] }
    if ("AudioEncoder" in window && ctx.sampleRate === 48000) {
      mic.encoder = new AudioEncoder({
        output: (chunk) => {
          const out = new Uint8Array(chunk.byteLength + 1)
          out[0] = 1
          chunk.copyTo(out.subarray(1))
          if (s.ws?.readyState === 1 && s.ws.bufferedAmount < 200_000) s.ws.send(out)
        },
        error: () => stopMic(),
      })
      mic.encoder.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: 1, bitrate: 48000 })
    }
    send({ cmd: "mic", on: true, format: mic.encoder ? "opus" : "pcm" })
    node.port.onmessage = (event) => micBlock(mic, event.data)
    s.mic = mic
    $("b-mic").classList.add("rec")
    toast("Phone microphone is on: the PC hears it as “Phone microphone”")
  } catch (error) {
    toast(`Microphone: ${error.message}`)
  }
}

function micBlock(mic, block) {
  if (mic.encoder) {
    mic.encoder.encode(new AudioData({ format: "f32-planar", sampleRate: 48000, numberOfFrames: block.length, numberOfChannels: 1, timestamp: mic.t, data: block }))
    mic.t += (block.length / 48000) * 1e6
    return
  }
  // No Opus encoder here: plain 16-bit samples at 48 kHz (resampled when the phone runs at another rate).
  const ratio = mic.ctx.sampleRate / 48000
  for (let i = 0; i < block.length / ratio; i++) mic.pcm.push(block[Math.min(block.length - 1, Math.floor(i * ratio))])
  if (mic.pcm.length < 960) return
  const out = new Uint8Array(1 + mic.pcm.length * 2)
  out[0] = 2
  const view16 = new DataView(out.buffer)
  mic.pcm.forEach((sample, index) => view16.setInt16(1 + index * 2, clamp(sample, -1, 1) * 32767, true))
  mic.pcm = []
  if (s.ws?.readyState === 1 && s.ws.bufferedAmount < 400_000) s.ws.send(out)
}

function stopMic() {
  const mic = s.mic
  if (!mic) return
  s.mic = undefined
  send({ cmd: "mic", on: false })
  mic.stream.getTracks().forEach((track) => track.stop())
  try {
    mic.encoder?.close()
  } catch {}
  void mic.ctx.close()
  $("b-mic").classList.remove("rec")
}

// ---------------------------------------------------------------------------
// Game mode: a joystick (W A S D), a mouse-look area (relative moves), mouse buttons and a few keys you choose
// ---------------------------------------------------------------------------

let editingKeys = false
const held = new Set()

function setGame(on) {
  s.game = on
  $("desk-game").hidden = !on
  $("b-game").classList.toggle("on", on)
  if (on) {
    renderGameKeys()
    showBar(false)
  } else releaseAll()
}

function releaseAll() {
  for (const code of held) send({ cmd: "key", code, down: false })
  held.clear()
}

function press(code, down) {
  if (down === held.has(code)) return
  if (down) held.add(code)
  else held.delete(code)
  send({ cmd: "key", code, down })
}

function renderGameKeys() {
  const box = $("game-keys")
  box.innerHTML = ""
  for (const button of ["left", "right"]) {
    const el = document.createElement("button")
    el.className = "gk mouse"
    el.textContent = button === "left" ? "L" : "R"
    el.onpointerdown = (event) => {
      event.preventDefault()
      send({ cmd: "button", button, down: true })
    }
    el.onpointerup = el.onpointercancel = () => send({ cmd: "button", button, down: false })
    box.append(el)
  }
  prefs.gameKeys.forEach((name, index) => {
    const el = document.createElement("button")
    el.className = `gk${editingKeys ? " edit" : ""}`
    el.textContent = name.length > 3 ? name[0].toUpperCase() + name.slice(1) : name.toUpperCase()
    el.onpointerdown = (event) => {
      event.preventDefault()
      if (editingKeys) {
        const next = (prompt(`Key for this button (a letter, digit, space, shift, ctrl, alt, tab, esc, enter, f1…f12, up/down/left/right)`, name) ?? "").trim().toLowerCase()
        if (next && KEY[next]) {
          prefs.gameKeys[index] = next
          save("gameKeys", prefs.gameKeys)
        } else if (next) toast(`Unknown key: ${next}`)
        return renderGameKeys()
      }
      press(KEY[name], true)
    }
    el.onpointerup = el.onpointercancel = () => !editingKeys && press(KEY[name], false)
    box.append(el)
  })
  $("game-edit").textContent = editingKeys ? "✓ Done" : "✎ Keys"
  $("game-speed").hidden = !editingKeys
  $("game-speed-value").textContent = prefs.lookSpeed.toFixed(1)
}

function joystick() {
  const pad = $("game-joy")
  const knob = $("game-knob")
  let id
  const update = (event) => {
    const box = pad.getBoundingClientRect()
    const r = box.width / 2
    let x = (event.clientX - box.left - r) / r
    let y = (event.clientY - box.top - r) / r
    const len = Math.hypot(x, y)
    if (len > 1) {
      x /= len
      y /= len
    }
    knob.style.transform = `translate(${x * r * 0.6}px, ${y * r * 0.6}px)`
    press(KEY.w, y < -0.35)
    press(KEY.s, y > 0.35)
    press(KEY.a, x < -0.35)
    press(KEY.d, x > 0.35)
  }
  pad.onpointerdown = (event) => {
    event.preventDefault()
    id = event.pointerId
    pad.setPointerCapture(id)
    update(event)
  }
  pad.onpointermove = (event) => event.pointerId === id && update(event)
  pad.onpointerup = pad.onpointercancel = (event) => {
    if (event.pointerId !== id) return
    id = undefined
    knob.style.transform = ""
    for (const key of ["w", "a", "s", "d"]) press(KEY[key], false)
  }
}

function lookArea() {
  const area = $("game-look")
  const fingers = new Map()
  area.onpointerdown = (event) => {
    event.preventDefault()
    area.setPointerCapture(event.pointerId)
    fingers.set(event.pointerId, { x: event.clientX, y: event.clientY, x0: event.clientX, y0: event.clientY, t: performance.now() })
  }
  area.onpointermove = (event) => {
    const f = fingers.get(event.pointerId)
    if (!f) return
    const dx = (event.clientX - f.x) * prefs.lookSpeed
    const dy = (event.clientY - f.y) * prefs.lookSpeed
    f.x = event.clientX
    f.y = event.clientY
    if (dx || dy) send({ cmd: "rel", dx, dy })
  }
  area.onpointerup = area.onpointercancel = (event) => {
    const f = fingers.get(event.pointerId)
    fingers.delete(event.pointerId)
    if (f && event.type === "pointerup" && performance.now() - f.t < 220 && Math.hypot(event.clientX - f.x0, event.clientY - f.y0) < 10) send({ cmd: "click", button: "left" })
  }
}

// ---------------------------------------------------------------------------
// Sheets: screens and desktops, open windows, apps, files
// ---------------------------------------------------------------------------

const escape = (text) => String(text ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])

function openSheet(kind, title) {
  const sheet = $("desk-sheet")
  sheet.dataset.kind = kind
  $("sheet-title").textContent = title
  sheet.hidden = false
  showBar(false)
}

function closeSheet() {
  $("desk-sheet").hidden = true
  $("sheet-body").innerHTML = ""
}

function renderScreens() {
  const body = $("sheet-body")
  const viewButton = (value, label) => `<button class="chip ${s.view === value ? "on" : ""}" data-view="${value}">${escape(label)}</button>`
  const desks = s.desktops.list ?? []
  const columns = Math.max(1, Math.ceil(desks.length / Math.max(1, s.desktops.rows || 1)))
  body.innerHTML = `
    <div class="sheet-label">Show</div>
    <div class="chips">${s.screens.map((screen) => viewButton(screen.index, `${screen.index + 1} · ${screen.name}`)).join("")}${s.screens.length > 1 ? viewButton("all", "All screens") : ""}</div>
    <label class="check"><input type="checkbox" id="one-screen" ${s.oneScreen ? "checked" : ""}> Everything on one screen <span class="muted small">(the other screen turns off until you stop)</span></label>
    ${desks.length ? `<div class="sheet-label">Virtual desktops</div><div class="desks" style="grid-template-columns: repeat(${columns}, 1fr)">${desks.map((d) => `<button class="${d.current ? "on" : ""}" data-desk="${escape(d.id)}">${escape(d.name)}</button>`).join("")}</div>` : ""}
    <div class="sheet-label">Stream</div>
    <label class="check"><input type="checkbox" id="opt-sound" ${prefs.sound ? "checked" : ""}> PC sound on the phone</label>
    <label class="check"><input type="checkbox" id="opt-saver" ${prefs.saver ? "checked" : ""}> Data saver <span class="muted small">(720p, less data: for mobile data)</span></label>
    <label class="check"><input type="checkbox" id="opt-touch" ${prefs.mode === "touch" ? "checked" : ""}> Touch where you point <span class="muted small">(off: the screen is a touchpad)</span></label>`
  for (const button of body.querySelectorAll("[data-view]"))
    button.onclick = () => {
      const value = button.dataset.view === "all" ? "all" : Number(button.dataset.view)
      send({ cmd: "view", view: value })
      view.z = 1
      closeSheet()
    }
  for (const button of body.querySelectorAll("[data-desk]"))
    button.onclick = () =>
      request({ cmd: "desktop", desktop: button.dataset.desk })
        .then((reply) => {
          s.desktops = { rows: reply.rows, list: reply.list }
          closeSheet()
        })
        .catch((error) => toast(error.message))
  $("one-screen").onchange = (event) =>
    request({ cmd: "oneScreen", on: event.target.checked })
      .then((reply) => {
        s.oneScreen = !!reply.oneScreen
        toast(s.oneScreen ? "Everything is on one screen now" : "Screens are back")
      })
      .catch((error) => toast(error.message))
  $("opt-sound").onchange = (event) => {
    prefs.sound = event.target.checked
    save("sound", prefs.sound)
    send({ cmd: "audio", on: prefs.sound })
  }
  $("opt-saver").onchange = (event) => {
    prefs.saver = event.target.checked
    save("saver", prefs.saver)
    send({ cmd: "quality", ...quality() })
  }
  $("opt-touch").onchange = (event) => {
    prefs.mode = event.target.checked ? "touch" : "touchpad"
    save("mode", prefs.mode)
  }
}

async function showWindows() {
  openSheet("windows", "Open windows")
  $("sheet-body").innerHTML = `<div class="muted">Loading…</div>`
  try {
    const { windows } = await request({ cmd: "windows" })
    const body = $("sheet-body")
    body.innerHTML = windows.length
      ? windows
          .map(
            (w, index) =>
              `<button class="row-item ${w.active ? "on" : ""}" data-index="${index}"><b>${escape(w.title)}</b><span class="muted small">${escape(w.app)}${w.screen !== null && s.screens.length > 1 ? ` · screen ${w.screen + 1}` : ""}${w.minimized ? " · minimized" : ""}</span></button>`,
          )
          .join("")
      : `<div class="muted">No open windows</div>`
    for (const item of body.querySelectorAll("[data-index]"))
      item.onclick = () => {
        const w = windows[Number(item.dataset.index)]
        send({ cmd: "activate", window: w.id })
        // Show the screen the window is on.
        if (s.view !== "all" && w.screen !== null && w.screen !== s.view) send({ cmd: "view", view: w.screen })
        closeSheet()
      }
  } catch (error) {
    $("sheet-body").innerHTML = `<div class="muted">${escape(error.message)}</div>`
  }
}

async function showApps() {
  openSheet("apps", "Open an app")
  const body = $("sheet-body")
  body.innerHTML = `<input id="app-search" class="search" placeholder="Search apps" autocomplete="off"><div id="app-list"><div class="muted">Loading…</div></div>`
  try {
    s.apps ??= (await request({ cmd: "apps" })).apps
  } catch (error) {
    $("app-list").innerHTML = `<div class="muted">${escape(error.message)}</div>`
    return
  }
  const draw = () => {
    const needle = $("app-search").value.trim().toLowerCase()
    const list = s.apps.filter((app) => !needle || app.name.toLowerCase().includes(needle) || app.about.toLowerCase().includes(needle)).slice(0, 150)
    $("app-list").innerHTML = list
      .map(
        (app) =>
          `<button class="row-item app" data-id="${escape(app.id)}">${app.icon ? `<img src="api/desktop/icon?path=${encodeURIComponent(app.icon)}&t=${encodeURIComponent(s.token)}" alt="" loading="lazy">` : `<span class="letter">${escape(app.name[0] ?? "?")}</span>`}<span><b>${escape(app.name)}</b><span class="muted small">${escape(app.about)}</span></span></button>`,
      )
      .join("")
    for (const item of $("app-list").querySelectorAll("[data-id]"))
      item.onclick = () => {
        send({ cmd: "launch", app: item.dataset.id })
        toast(`Opening ${item.querySelector("b").textContent}…`)
        closeSheet()
      }
  }
  $("app-search").oninput = draw
  draw()
}

async function showFiles(folder = s.folder) {
  openSheet("files", "Files on the PC")
  const body = $("sheet-body")
  try {
    const listing = await request({ cmd: "files", path: folder })
    s.folder = listing.path
    const short = listing.path.replace(listing.home, "~")
    const size = (n) => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n > 1e3 ? `${Math.round(n / 1e3)} kB` : `${n} B`)
    body.innerHTML = `<div class="path"><button data-go="~">~</button>${listing.parent ? `<button data-go="${escape(listing.parent)}">⬆ Up</button>` : ""}<span class="muted small">${escape(short)}</span></div>
      ${listing.entries.map((entry, index) => `<button class="row-item file-row" data-index="${index}">${entry.dir ? "📁" : "📄"} <span>${escape(entry.name)}</span><span class="muted small">${entry.dir ? "" : size(entry.size)}</span></button>`).join("") || `<div class="muted">Empty folder</div>`}`
    for (const button of body.querySelectorAll("[data-go]")) button.onclick = () => showFiles(button.dataset.go)
    for (const item of body.querySelectorAll("[data-index]"))
      item.onclick = () => {
        const entry = listing.entries[Number(item.dataset.index)]
        const full = `${listing.path}/${entry.name}`
        if (entry.dir) return showFiles(full)
        send({ cmd: "open", path: full })
        toast(`Opening ${entry.name} on the PC…`)
        closeSheet()
      }
  } catch (error) {
    body.innerHTML = `<div class="muted">${escape(error.message)}</div>`
  }
}

// ---------------------------------------------------------------------------
// Chrome: status line, toast, the bar
// ---------------------------------------------------------------------------

function status(text, kind = "") {
  const box = $("desk-status")
  box.hidden = !text
  box.textContent = text ?? ""
  box.className = `desk-status ${kind}`
}

let toastTimer
function toast(text) {
  const box = $("desk-toast")
  box.textContent = text
  box.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (box.hidden = true), 2800)
}

function showBar(on) {
  $("desk-bar").hidden = !on
}

function wire() {
  const stage = $("desk-stage")
  stage.addEventListener("pointerdown", stageDown)
  stage.addEventListener("pointermove", stageMove)
  stage.addEventListener("pointerup", stageUp)
  stage.addEventListener("pointercancel", stageUp)
  stage.addEventListener("wheel", stageWheel, { passive: false })
  stage.addEventListener("contextmenu", (event) => event.preventDefault())
  $("desk-more").onclick = () => showBar($("desk-bar").hidden)
  $("desk-zoom").onclick = () => {
    view.z = 1
    layout()
  }
  $("b-close").onclick = () => closeDesktop()
  $("b-keys").onclick = () => setKeyboard(!s.keyboard)
  $("b-voice").onclick = () => (s.rec ? stopRecording(true) : void startRecording())
  $("b-mic").onclick = () => (s.mic ? stopMic() : void startMic())
  $("b-screens").onclick = () => {
    openSheet("screens", "Screens")
    renderScreens()
    void request({ cmd: "desktops" })
      .then((reply) => {
        s.desktops = { rows: reply.rows, list: reply.list }
        if ($("desk-sheet").dataset.kind === "screens" && !$("desk-sheet").hidden) renderScreens()
      })
      .catch(() => {})
  }
  $("b-windows").onclick = () => void showWindows()
  $("b-apps").onclick = () => void showApps()
  $("b-files").onclick = () => void showFiles()
  $("b-game").onclick = () => setGame(!s.game)
  $("sheet-close").onclick = closeSheet
  $("desk-sheet").onclick = (event) => event.target === $("desk-sheet") && closeSheet()
  const input = $("desk-input")
  input.addEventListener("input", onInput)
  input.addEventListener("keydown", onKeyDown)
  input.addEventListener("compositionstart", () => (composing = true))
  input.addEventListener("compositionend", () => {
    composing = false
    onInput()
  })
  input.addEventListener("blur", () => {
    // The phone keyboard was closed (back button): drop the key row too, unless a key-row tap took the focus.
    setTimeout(() => s.keyboard && document.activeElement !== input && !$("desk-keys").matches(":active") && setKeyboard(false), 200)
  })
  for (const button of $("desk-keys").querySelectorAll("button")) {
    button.onpointerdown = (event) => event.preventDefault() // keep the phone keyboard open
    button.onclick = () => {
      const mod = button.dataset.mod
      if (mod) {
        if (s.mods.has(mod)) s.mods.delete(mod)
        else s.mods.add(mod)
        button.classList.toggle("on", s.mods.has(mod))
        return
      }
      sendKey(button.dataset.key)
    }
  }
  $("game-edit").onclick = () => {
    editingKeys = !editingKeys
    renderGameKeys()
  }
  $("game-slower").onclick = () => {
    prefs.lookSpeed = Math.max(0.3, Math.round((prefs.lookSpeed - 0.25) * 100) / 100)
    save("lookSpeed", prefs.lookSpeed)
    renderGameKeys()
  }
  $("game-faster").onclick = () => {
    prefs.lookSpeed = Math.min(6, Math.round((prefs.lookSpeed + 0.25) * 100) / 100)
    save("lookSpeed", prefs.lookSpeed)
    renderGameKeys()
  }
  joystick()
  lookArea()
}

wire()
