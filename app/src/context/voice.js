import { findBinary } from "./platform"
import { query } from "@anthropic-ai/claude-agent-sdk"
import { execFileSync, spawn,                   } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createStore } from "solid-js/store"
import { config, saveConfig } from "./config"
import { log } from "./log"
import { stateDir } from "./paths"

// ---------------------------------------------------------------------------
// Voice: talk to Claude and hear replies. Three mutually exclusive engines, each
// with its own model pool:
//   kokoro      Kokoro TTS voices
//   kokoro-rvc  Kokoro → RVC voice conversion (Applio) with RVC models
//   openutau    UTAU voicebanks (OpenUtau singers) with expressive styles
// Speech recognition is faster-whisper. A small Haiku agent (low effort) does the
// talking and condenses replies into speech.
// ---------------------------------------------------------------------------



















export const ENGINES                                                            = [
  { id: "kokoro", title: "Kokoro", description: "fast neural TTS · Kokoro voices" },
  { id: "kokoro-rvc", title: "Kokoro + RVC", description: "Kokoro → RVC voice conversion · character voices" },
  { id: "openutau", title: "OpenUtau", description: "UTAU voicebank · expressive styles (sing, rap, whisper…)" },
]

export const STT_MODELS = ["tiny", "base", "small", "medium", "large-v3-turbo", "large-v3"]

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = [path.join(HERE, "..", "voice", "occ_voice.py"), path.join(HERE, "..", "..", "voice", "occ_voice.py")].find(existsSync)
const STYLES_FILE = SCRIPT ? path.join(path.dirname(SCRIPT), "styles.json") : undefined
const STATE = path.join(stateDir, "voice")
const HOME = os.homedir()

export const [voice, setVoice] = createStore





  ({ recording: false, thinking: false, speaking: false })

export function vc()              {
  return (config       ).voice ?? {}
}
export function setVc(patch                      ) {
  ;(config       ).voice = { ...vc(), ...patch }
  saveConfig()
}

// ---------------------------------------------------------------------------
// Detection (cached per run; `refreshDetection` clears it)
// ---------------------------------------------------------------------------

const cache = new Map             ()
export function refreshDetection() {
  cache.clear()
}
function cached   (key        , fn         )    {
  if (!cache.has(key)) cache.set(key, fn())
  return cache.get(key)
}

function which(bin        ) {
  return findBinary(bin)
}

function hasModule(python        , module        ) {
  if (!existsSync(python) && !which(python)) return false
  try {
    execFileSync(python, ["-c", `import ${module}`], { stdio: "ignore", timeout: 60_000 })
    return true
  } catch {
    return false
  }
}

function findPython(key                                  , module        , candidates          ) {
  return cached(key, () => {
    const list = [vc().paths?.[key], ...candidates].filter((item)                 => !!item)
    return list.find((python) => hasModule(python, module))
  })
}

export const kokoroPython = () =>
  findPython("kokoroPython", "kokoro", [
    path.join(HOME, ".local/share/occ-voice/kokoro/bin/python"),
    path.join(HOME, "ai-tools/kokoro/bin/python"),
    "python3",
  ])

export const whisperPython = () =>
  findPython("whisperPython", "faster_whisper", [
    path.join(HOME, ".local/share/occ-voice/whisper/bin/python"),
    path.join(HOME, "ai-tools/faster-whisper/bin/python"),
    "python3",
  ])

export function applio()                                              {
  return cached("applio", () => {
    const dirs = [vc().paths?.applio, path.join(HOME, "Applio"), path.join(HOME, ".local/share/occ-voice/Applio")].filter(
      (item)                 => !!item,
    )
    for (const dir of dirs) {
      if (!existsSync(path.join(dir, "rvc", "infer", "infer.py"))) continue
      const python = [vc().paths?.applioPython, path.join(dir, ".venv/bin/python"), path.join(dir, "env/bin/python")].find(
        (item) => item && existsSync(item),
      )
      if (python) return { dir, python }
    }
    return undefined
  })
}


export function rvcModels()             {
  return cached("rvc", () => {
    const list             = []
    const slots = path.join(HOME, "voice-changer/server/model_dir")
    if (existsSync(slots))
      for (const slot of readdirSync(slots)) {
        try {
          const params = JSON.parse(readFileSync(path.join(slots, slot, "params.json"), "utf8"))
          if (params.voiceChangerType !== "RVC" || !params.modelFile) continue
          const pth = path.join(slots, slot, params.modelFile)
          if (!existsSync(pth)) continue
          const index = params.indexFile ? path.join(slots, slot, params.indexFile) : undefined
          list.push({ name: params.name ?? `slot ${slot}`, pth, index: index && existsSync(index) ? index : undefined, source: "voice-changer" })
        } catch {}
      }
    for (const root of [path.join(HOME, ".local/share/occ-voice/rvc"), applio() && path.join(applio() .dir, "logs")].filter(
      (item)                 => !!item && existsSync(item),
    ))
      for (const name of readdirSync(root)) {
        const dir = path.join(root, name)
        try {
          if (!statSync(dir).isDirectory()) continue
          const files = readdirSync(dir)
          const pth = files.find((file) => file.endsWith(".pth") && !/^[GD]_/.test(file))
          if (!pth) continue
          const index = files.find((file) => file.endsWith(".index"))
          list.push({ name, pth: path.join(dir, pth), index: index ? path.join(dir, index) : undefined, source: path.basename(root) })
        } catch {}
      }
    // Voices matching the user's `voice.prefer` (a regular expression) lead the list.
    return list.sort((a, b) => Number(preferred(b.name)) - Number(preferred(a.name)))
  })
}

export function singers()                                  {
  return cached("singers", () => {
    const roots = [
      ...(vc().paths?.singers ?? []),
      path.join(HOME, ".local/share/OpenUtau/Singers"),
      path.join(HOME, "Library/OpenUtau/Singers"),
      "/opt/openutau/Singers",
    ]
    const list                                  = []
    for (const root of roots) {
      if (!existsSync(root)) continue
      for (const name of readdirSync(root)) {
        const dir = path.join(root, name)
        try {
          if (statSync(dir).isDirectory()) list.push({ name: singerName(dir) ?? name, dir })
        } catch {}
      }
    }
    return list.sort((a, b) => Number(preferred(b.name)) - Number(preferred(a.name)))
  })
}

function singerName(dir        ) {
  try {
    const yaml = readFileSync(path.join(dir, "character.yaml"), "utf8")
    const en = yaml.match(/en-US:\s*(.+)/)?.[1]?.trim()
    return en ?? yaml.match(/^﻿?name:\s*(.+)$/m)?.[1]?.trim()
  } catch {
    return undefined
  }
}

/** Kokoro voice ids (from the downloaded model if present, else the published list). */
export function kokoroVoices()           {
  return cached("kokoro-voices", () => {
    const hub = path.join(process.env.HF_HOME ?? path.join(HOME, ".cache/huggingface"), "hub", "models--hexgrad--Kokoro-82M", "snapshots")
    try {
      for (const snap of readdirSync(hub)) {
        const dir = path.join(hub, snap, "voices")
        if (existsSync(dir)) {
          const found = readdirSync(dir).filter((file) => file.endsWith(".pt")).map((file) => file.slice(0, -3))
          if (found.length) return sortVoices(found)
        }
      }
    } catch {}
    return sortVoices(
      "af_heart af_alloy af_aoede af_bella af_jessica af_kore af_nicole af_nova af_river af_sarah af_sky am_adam am_echo am_eric am_fenrir am_liam am_michael am_onyx am_puck bf_alice bf_emma bf_isabella bf_lily bm_daniel bm_fable bm_george bm_lewis jf_alpha jf_gongitsune jf_nezumi jf_tebukuro jm_kumo".split(" "),
    )
  })
}
/** Whether a voice name matches the user's `voice.prefer` pattern (none set: no voice is preferred). */
export function preferred(name        ) {
  const pattern = vc().prefer
  if (!pattern) return false
  try {
    return new RegExp(pattern, "i").test(name)
  } catch {
    return false
  }
}
function sortVoices(list          ) {
  return list.sort((a, b) => Number(preferred(b)) - Number(preferred(a)) || a.localeCompare(b))
}
/** A Kokoro voice's name as shown: the user's own label (`voice.labels`) or its id. */
export function kokoroLabel(id        ) {
  return vc().labels?.[id] ?? id
}

export const styles = ()                                                          =>
  cached("styles", () => {
    try {
      return STYLES_FILE ? JSON.parse(readFileSync(STYLES_FILE, "utf8")) : {}
    } catch {
      return {}
    }
  })

const recorder = () => cached("recorder", () => ["pw-record", "parecord", "arecord"].find(which))
const player = () => cached("player", () => ["pw-play", "paplay", "aplay", "ffplay"].find(which))


export function machine()          {
  return cached("machine", () => {
    let gpu
    let vramGB
    try {
      const out = execFileSync("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
      const [name, mem] = out.split("\n")[0].split(",").map((item) => item.trim())
      gpu = name
      vramGB = Math.round(Number(mem) / 1024)
    } catch {}
    return {
      platform: `${os.type()} ${os.release()} (${os.arch()})`,
      cpu: os.cpus()[0]?.model ?? "unknown",
      cores: os.cpus().length,
      ramGB: Math.round(os.totalmem() / 2 ** 30),
      gpu,
      vramGB,
    }
  })
}


/** What the chosen setup needs and whether it is installed. */
export function components()              {
  const engine = vc().engine ?? "kokoro"
  const kp = kokoroPython()
  const wp = whisperPython()
  const ap = applio()
  return [
    { id: "kokoro", title: "Kokoro TTS", ok: !!kp, detail: kp ?? "python package `kokoro` not found", needed: engine !== "openutau" },
    { id: "whisper", title: "faster-whisper (speech → text)", ok: !!wp, detail: wp ?? "python package `faster_whisper` not found", needed: true },
    { id: "applio", title: "Applio (RVC conversion)", ok: !!ap, detail: ap?.dir ?? "Applio not found", needed: engine === "kokoro-rvc" },
    {
      id: "rvc-models",
      title: "RVC voice models",
      ok: rvcModels().length > 0,
      detail: rvcModels().length ? `${rvcModels().length} models` : "no .pth models found",
      needed: engine === "kokoro-rvc",
    },
    {
      id: "openutau",
      title: "OpenUtau voicebank",
      ok: singers().length > 0,
      detail: singers().length ? singers().map((item) => item.name).join(", ") : "no singers in ~/.local/share/OpenUtau/Singers",
      needed: engine === "openutau",
    },
    { id: "rubberband", title: "rubberband (UTAU pitch/time)", ok: !!which("rubberband"), detail: which("rubberband") ?? "missing", needed: engine === "openutau" },
    { id: "recorder", title: "Microphone recorder", ok: !!recorder(), detail: recorder() ?? "pw-record / parecord / arecord missing", needed: true },
    { id: "player", title: "Audio player", ok: !!player(), detail: player() ?? "pw-play / paplay / aplay missing", needed: true },
  ]
}

// ---------------------------------------------------------------------------
// Workers: persistent Python processes speaking JSON lines
// ---------------------------------------------------------------------------

class Worker {
          proc
          next = 1
          pending = new Map                                                                           ()
          buffer = ""
  ready
  dead = false
           key

  constructor(key        , python        , args          , cwd         ) {
    this.key = key
    this.proc = spawn(python, [SCRIPT , ...args], { cwd, stdio: ["pipe", "pipe", "pipe"], env: process.env })
    let readyResolve
    let readyReject
    this.ready = new Promise((resolve, reject) => ((readyResolve = resolve), (readyReject = reject)))
    this.pending.set(0, { resolve: readyResolve, reject: readyReject })
    this.proc.stdout .on("data", (chunk) => {
      this.buffer += chunk.toString()
      let index
      while ((index = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, index)
        this.buffer = this.buffer.slice(index + 1)
        try {
          const message = JSON.parse(line)
          const waiter = this.pending.get(message.id)
          if (!waiter) continue
          this.pending.delete(message.id)
          if (message.ok) waiter.resolve(message)
          else waiter.reject(new Error(message.error ?? "voice worker error"))
        } catch {}
      }
    })
    let stderr = ""
    this.proc.stderr .on("data", (chunk) => (stderr = (stderr + chunk.toString()).slice(-4000)))
    this.proc.on("exit", (code) => {
      this.dead = true
      for (const waiter of this.pending.values()) waiter.reject(new Error(`${key} worker exited (${code}): ${stderr.split("\n").slice(-3).join(" ")}`))
      this.pending.clear()
      workers.delete(key)
    })
  }

  async request(body                         ) {
    await this.ready
    const id = this.next++
    return new Promise     ((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.proc.stdin .write(JSON.stringify({ id, ...body }) + "\n")
    })
  }

  kill() {
    this.dead = true
    this.proc.kill()
  }
}

const workers = new Map                ()
function worker(key        , make              ) {
  const existing = workers.get(key)
  if (existing && !existing.dead) return existing
  const created = make()
  workers.set(key, created)
  return created
}

export function stopWorkers() {
  for (const item of workers.values()) item.kill()
  workers.clear()
}
process.on("exit", () => {
  stopWorkers()
  stopSpeaking()
})

function need   (value               , what        )    {
  if (!value) throw new Error(`${what} is not installed — open /voice → Check & set up`)
  return value
}

const kokoroWorker = () => worker("kokoro", () => new Worker("kokoro", need(kokoroPython(), "Kokoro"), ["kokoro"]))
const rvcWorker = () => {
  const ap = need(applio(), "Applio")
  return worker("rvc", () => new Worker("rvc", ap.python, ["rvc", "--applio", ap.dir], ap.dir))
}
const utauWorker = () => worker("utau", () => new Worker("utau", "python3", ["utau", "--styles", STYLES_FILE ]))
const whisperWorker = () => {
  const model = vc().sttModel ?? "small"
  const device = vc().sttDevice ?? (machine().gpu ? "cuda" : "cpu")
  return worker(`whisper:${model}:${device}`, () => new Worker(`whisper:${model}:${device}`, need(whisperPython(), "faster-whisper"), ["whisper", "--model", model, "--device", device]))
}

/** Start the workers the current setup needs so the first reply is fast. */
export function warmUp() {
  if (!SCRIPT) return
  try {
    const engine = vc().engine ?? "kokoro"
    if (engine !== "openutau") kokoroWorker()
    if (engine === "kokoro-rvc") rvcWorker()
    if (engine === "openutau") utauWorker()
    whisperWorker()
  } catch (error) {
    log("voice warm up", error)
  }
}

// ---------------------------------------------------------------------------
// Speaking
// ---------------------------------------------------------------------------

let playing
let queue                = Promise.resolve()
let generation = 0

let lastSweep = 0
function tmpWav(name        ) {
  mkdirSync(STATE, { recursive: true })
  // Drop rendered/recorded audio older than 10 minutes.
  if (Date.now() - lastSweep > 60_000) {
    lastSweep = Date.now()
    for (const file of readdirSync(STATE))
      try {
        const full = path.join(STATE, file)
        if (Date.now() - statSync(full).mtimeMs > 600_000) rmSync(full)
      } catch {}
  }
  return path.join(STATE, `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.wav`)
}

function play(file        ) {
  const bin = player()
  if (!bin) return Promise.resolve()
  const args = bin === "ffplay" ? ["-nodisp", "-autoexit", "-loglevel", "quiet", file] : [file]
  return new Promise      ((resolve) => {
    playing = spawn(bin, args, { stdio: "ignore" })
    playing.on("exit", () => {
      playing = undefined
      resolve()
    })
    playing.on("error", () => resolve())
  })
}

export function stopSpeaking() {
  generation++
  playing?.kill()
  playing = undefined
  setVoice("speaking", false)
}

function kokoroLang(voiceId        ) {
  const lang = vc().language ?? "en"
  // Kokoro has no Polish; English text uses the American (a) or British (b) frontend whatever the timbre.
  if (lang === "en" || lang === "pl") return voiceId.startsWith("b") ? "b" : "a"
  return voiceId[0]
}

/** Render `text` with the active engine; returns the wav path. */
export async function synthesize(text        , style         )                  {
  if (!SCRIPT) throw new Error("voice/occ_voice.py is missing from the Agent Code install")
  const engine = vc().engine ?? "kokoro"
  if (engine === "openutau") {
    const singer = singers().find((item) => item.dir === vc().utauSinger) ?? singers()[0]
    need(singer, "An OpenUtau voicebank")
    const out = tmpWav("utau")
    const chosen = style && styles()[style] ? style : vc().utauStyle && vc().utauStyle !== "auto" ? vc().utauStyle : "talking"
    await utauWorker().request({ text, singer: singer .dir, style: chosen, lang: vc().language ?? "en", out })
    return out
  }
  const voiceId = engine === "kokoro-rvc" ? (vc().rvcBase ?? "jf_alpha") : (vc().kokoroVoice ?? "jf_alpha")
  const raw = tmpWav("kokoro")
  await kokoroWorker().request({ text, voice: voiceId, lang: kokoroLang(voiceId), out: raw })
  if (engine !== "kokoro-rvc") return raw
  const model = rvcModels().find((item) => item.pth === vc().rvcModel) ?? rvcModels()[0]
  need(model, "An RVC voice model")
  const out = tmpWav("rvc")
  await rvcWorker().request({ in: raw, out, model: model .pth, index: model .index, pitch: vc().rvcPitch ?? 0 })
  return out
}

/** Queue a line to be spoken (sequentially). */
export function speak(text        , style         ) {
  const clean = text.replace(/```[\s\S]*?```/g, " ").replace(/[*_`#>|]/g, "").trim()
  if (!clean) return queue
  const gen = generation
  queue = queue.then(async () => {
    if (gen !== generation) return
    try {
      setVoice("speaking", true)
      const file = await synthesize(clean, style)
      if (gen !== generation) return
      await play(file)
    } catch (error) {
      setVoice("status", String((error         ).message ?? error))
      log("voice speak", error)
    } finally {
      setVoice("speaking", false)
    }
  })
  return queue
}

// ---------------------------------------------------------------------------
// Listening
// ---------------------------------------------------------------------------

let rec

export function startRecording() {
  const bin = recorder()
  if (!bin) throw new Error("No microphone recorder (pw-record / parecord / arecord)")
  stopSpeaking()
  const file = tmpWav("mic")
  const args =
    bin === "arecord" ? ["-q", "-f", "S16_LE", "-r", "16000", "-c", "1", file] : bin === "parecord" ? ["--rate=16000", "--channels=1", "--file-format=wav", file] : ["--rate", "16000", "--channels", "1", file]
  const proc = spawn(bin, args, { stdio: "ignore" })
  rec = { proc, file }
  setVoice("recording", true)
  // Warm the recognizer while the user talks.
  try {
    whisperWorker()
  } catch {}
}

export async function stopRecording()                  {
  const current = rec
  rec = undefined
  setVoice("recording", false)
  if (!current) return ""
  await new Promise      ((resolve) => {
    current.proc.on("exit", () => resolve())
    current.proc.kill("SIGINT")
    setTimeout(resolve, 1500)
  })
  const result = await whisperWorker().request({ audio: current.file, language: vc().language === "pl" ? "pl" : undefined })
  return String(result.text ?? "").trim()
}

export const isRecording = () => !!rec

// ---------------------------------------------------------------------------
// The talking agent: Haiku, low effort, no tools — fastest settings for speech.
// ---------------------------------------------------------------------------

const history                                                 = []

function spokenLanguage() {
  const engine = vc().engine ?? "kokoro"
  if (vc().language === "pl" && engine === "openutau") return "Polish"
  return "English" + (vc().language === "pl" ? " (Kokoro voices cannot speak Polish; the user understands English)" : "")
}

function stylesPrompt() {
  if ((vc().engine ?? "kokoro") !== "openutau") return ""
  const all = styles()
  const chosen = vc().utauStyle ?? "talking"
  if (chosen !== "auto") return `\nVoice style: ${all[chosen]?.title ?? chosen}. ${all[chosen]?.instructions ?? ""}`
  const list = Object.entries(all)
    .map(([id, item]) => `- ${id}: ${item.instructions}`)
    .join("\n")
  return `\nPick the voice style that fits the emotion of your reply and phrase it accordingly:\n${list}`
}

async function haiku(prompt        , system        ) {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 30_000)
  try {
    const q = query({
      prompt,
      options: {
        model: "haiku",
        effort: "low",
        maxTurns: 1,
        tools: [],
        settingSources: [],
        persistSession: false,
        abortController: abort,
        systemPrompt: system,
        env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "agent-code" },
      }       ,
    })
    let text = ""
    for await (const message of q) if (message.type === "result" && message.subtype === "success") text = message.result
    return text
  } finally {
    clearTimeout(timer)
  }
}

function parseReply(text        )                                  {
  const match = text.match(/\{[\s\S]*\}/)
  if (match) {
    try {
      const parsed = JSON.parse(match[0])
      if (typeof parsed.say === "string") return { say: parsed.say, style: typeof parsed.style === "string" ? parsed.style : undefined }
    } catch {}
  }
  return { say: text.trim() }
}

const SPEECH_RULES = `Rules for speech: at most 3 short sentences, plain spoken words only — no markdown, code, lists, URLs, file paths or emoji. Numbers and symbols written as words. Reply with JSON only: {"say":"<what to speak>","style":"<style id or empty>"}.`

/** A spoken conversation turn with the talking agent. `context` = what the focused tab is working on. */
export async function talk(userText        , context        ) {
  setVoice("thinking", true)
  try {
    const system = `You are the voice of Agent Code, a terminal UI for Claude Code. You chat with the user out loud while the main Claude session works. You can't run tools; if the user asks for real work, tell them to say "send to the tab" or type it in the prompt. Speak ${spokenLanguage()}.${stylesPrompt()}\n${SPEECH_RULES}`
    const transcript = history.map((item) => `${item.role === "user" ? "User" : "You"}: ${item.text}`).join("\n")
    const prompt = `${context ? `What the main session is doing:\n${context.slice(0, 2500)}\n\n` : ""}${transcript ? `Conversation so far:\n${transcript}\n\n` : ""}User says: ${userText}`
    const reply = parseReply(await haiku(prompt, system))
    history.push({ role: "user", text: userText }, { role: "assistant", text: reply.say })
    while (history.length > 16) history.shift()
    setVoice("last", { heard: userText, said: reply.say })
    return reply
  } finally {
    setVoice("thinking", false)
  }
}

/** Turn a finished assistant reply into a short spoken summary. */
export async function condense(reply        ) {
  setVoice("thinking", true)
  try {
    const system = `You read Claude Code's replies aloud to the user. Say the gist: the answer or what was done, and anything the user must decide. Speak ${spokenLanguage()}.${stylesPrompt()}\n${SPEECH_RULES}`
    return parseReply(await haiku(`Reply to read aloud:\n${reply.slice(0, 6000)}`, system))
  } finally {
    setVoice("thinking", false)
  }
}

// ---------------------------------------------------------------------------
// Setup conversation: a prompt for a normal Claude tab that installs what is missing.
// ---------------------------------------------------------------------------

export function setupPrompt() {
  const m = machine()
  const engine = vc().engine ?? "kokoro"
  const missing = components().filter((item) => item.needed && !item.ok)
  const lines = components().map((item) => `- ${item.ok ? "OK " : "MISSING"} ${item.title}: ${item.detail}${item.needed ? "" : " (not needed for this engine)"}`)
  return `Set up Agent Code's voice feature on this machine. Talk me through it step by step and ask before every download or install.

Machine: ${m.platform}; CPU ${m.cpu} (${m.cores} threads); RAM ${m.ramGB} GB; GPU ${m.gpu ? `${m.gpu} with ${m.vramGB} GB VRAM` : "none detected (CPU only)"}.
Chosen engine: ${ENGINES.find((item) => item.id === engine)?.title}. Spoken language: ${vc().language ?? "en"}.

Current state:
${lines.join("\n")}

Rules:
1. Use ONLY these components: Kokoro (TTS, pip package \`kokoro\` + \`misaki[en]\`, model hexgrad/Kokoro-82M), faster-whisper (speech-to-text), Applio for RVC conversion (only for "Kokoro + RVC"), OpenUtau + a UTAU voicebank (only for "OpenUtau"). Do not substitute other TTS/STT engines.
2. Install into ~/.local/share/occ-voice/ (one venv per tool: kokoro/, whisper/; Applio in ~/.local/share/occ-voice/Applio; extra RVC models in ~/.local/share/occ-voice/rvc/<name>/ with the .pth and .index). Use the system package manager only for system tools (rubberband, pipewire tools, espeak-ng for Kokoro).
3. Fit the machine: with an NVIDIA GPU (≥4 GB VRAM) install CUDA builds; without one use CPU builds, recommend whisper "small"/"base" int8, and say plainly that RVC on CPU is slow (several seconds per sentence). If something does not fit (too little RAM/VRAM, unsupported OS), explain why and show the alternatives within these components (smaller whisper model, plain Kokoro instead of RVC, OpenUtau without RVC) — let me choose.
4. Voice models: Kokoro voices download automatically. RVC models and UTAU voicebanks must come from their official/licensed sources — show me where to download, check the licence/terms with me, then place them in the folders above. Never download from unofficial mirrors.
5. Verify each part by running the worker: \`<python> ${SCRIPT ?? "voice/occ_voice.py"} probe\`.
6. Finally write the paths you used into ~/.config/agent-code/config.json under "voice"."paths" (keys: kokoroPython, whisperPython, applio, applioPython, singers[]) and tell me to reopen /voice.
${missing.length ? `\nMissing for the chosen engine: ${missing.map((item) => item.title).join(", ")}.` : "\nEverything for the chosen engine is installed; just verify it."}`
}
