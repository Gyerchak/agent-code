import { execFile, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { log } from "./log"

// ---------------------------------------------------------------------------
// Media in the transcript: stills, looping video/GIF frames and looping sound, through ffmpeg/ffprobe and
// mpv (ffplay as a fallback). A frame is drawn with half blocks (▀): one cell is one pixel wide and two tall.
// ---------------------------------------------------------------------------

export const VIDEO = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".mpg": "video/mpeg",
  ".mpeg": "video/mpeg",
  ".wmv": "video/x-ms-wmv",
  ".flv": "video/x-flv",
  ".3gp": "video/3gpp",
}
export const AUDIO = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/opus",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".wma": "audio/x-ms-wma",
  ".aiff": "audio/aiff",
  ".aif": "audio/aiff",
}

const which = new Map()
function tool(name) {
  if (!which.has(name)) {
    const found = (process.env.PATH ?? "").split(path.delimiter).map((dir) => path.join(dir, name)).find((file) => existsSync(file))
    which.set(name, found ?? null)
  }
  return which.get(name) ?? undefined
}

export const canDecode = () => !!tool("ffmpeg")
export const canPlaySound = () => !!(tool("mpv") || tool("ffplay"))

/** A file to hand to ffmpeg/mpv: the attachment's own path, or its bytes written once to a temp file. */
export function mediaSource(item) {
  if (item.path && existsSync(item.path)) return item.path
  if (!item.data) return undefined
  const dir = path.join(os.tmpdir(), "occ-media")
  mkdirSync(dir, { recursive: true })
  const ext = (item.mime?.split("/")[1] ?? "bin").replace(/[^a-z0-9]/gi, "")
  const file = path.join(dir, `${createHash("sha1").update(item.data).digest("hex").slice(0, 16)}.${ext}`)
  if (!existsSync(file)) writeFileSync(file, Buffer.from(item.data, "base64"))
  return file
}

function run(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { encoding: "buffer", maxBuffer: 256 * 1024 * 1024, timeout: 30_000 }, (error, stdout) => {
      if (error) log("media tool failed", path.basename(command), String(error).slice(0, 200))
      resolve(error ? undefined : stdout)
    })
  })
}

/** Size, duration, frame rate and streams of a media file. */
export async function probe(file) {
  const ffprobe = tool("ffprobe")
  if (!ffprobe) return undefined
  const out = await run(ffprobe, ["-v", "error", "-show_entries", "stream=codec_type,width,height,avg_frame_rate,nb_frames:stream_disposition=attached_pic:format=duration", "-of", "json", file])
  try {
    const json = JSON.parse(String(out))
    const video = json.streams?.find((stream) => stream.codec_type === "video" && !stream.disposition?.attached_pic)
    const cover = json.streams?.find((stream) => stream.codec_type === "video" && stream.disposition?.attached_pic)
    const [num, den] = String(video?.avg_frame_rate ?? "0/1").split("/").map(Number)
    return {
      width: video?.width ?? cover?.width,
      height: video?.height ?? cover?.height,
      duration: Number(json.format?.duration) || undefined,
      fps: den ? num / den : undefined,
      frames: Number(video?.nb_frames) || undefined,
      hasVideo: !!video,
      hasCover: !!cover,
      hasAudio: !!json.streams?.some((stream) => stream.codec_type === "audio"),
    }
  } catch {
    return undefined
  }
}

/** Pixel size for `columns` × `rows` cells keeping the aspect ratio (two pixels per row), never enlarged. */
export function fit(width, height, columns, rows) {
  if (!width || !height) return { w: columns, h: rows * 2 }
  const scale = Math.min(columns / width, (rows * 2) / height, 1)
  const w = Math.max(2, Math.floor((width * scale) / 2) * 2)
  const h = Math.max(2, Math.floor((height * scale) / 2) * 2)
  return { w, h }
}

/**
 * One frame as raw RGB of w×h pixels: a still of an image, a video's frame at `at` seconds, or for sound
 * its cover art, else its waveform. `blur` softens it (the collapsed look).
 */
export async function stillFrame(file, info, columns, rows, { blur = false, at, audio = false } = {}) {
  const ffmpeg = tool("ffmpeg")
  if (!ffmpeg) return undefined
  if (audio && !info?.hasCover) {
    const { w, h } = { w: Math.max(8, Math.floor(columns / 2) * 2), h: Math.max(4, Math.min(rows, 8) * 2) }
    const filter = `showwavespic=s=${w}x${h}:colors=0xfab283|0x5c9cf5:split_channels=0${blur ? ",boxblur=1:1" : ""},format=rgb24`
    const out = await run(ffmpeg, ["-v", "error", "-i", file, "-filter_complex", filter, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
    return out?.length >= w * h * 3 ? { w, h, rgb: out } : undefined
  }
  const { w, h } = fit(info?.width, info?.height, columns, rows)
  const filters = [`scale=${w}:${h}:flags=lanczos`, ...(blur ? [`boxblur=${Math.max(1, Math.round(w / 40))}:1`] : []), "format=rgb24"].join(",")
  const seek = at !== undefined && info?.duration ? ["-ss", String(Math.min(at, Math.max(0, info.duration - 0.1)))] : []
  const out = await run(ffmpeg, ["-v", "error", ...seek, "-i", file, "-map", "0:v:0", "-frames:v", "1", "-vf", filters, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
  return out?.length >= w * h * 3 ? { w, h, rgb: out.subarray(0, w * h * 3) } : undefined
}

const children = new Set()
process.on("exit", () => {
  for (const child of children) child.kill("SIGKILL")
})

function track(child) {
  children.add(child)
  child.on("exit", () => children.delete(child))
  child.on("error", () => children.delete(child))
  return child
}

/** Decode a video/GIF in a loop at its own pace, handing each w×h RGB frame to `onFrame`; returns stop(). */
export function playFrames(file, w, h, onFrame, fps = 15) {
  const ffmpeg = tool("ffmpeg")
  if (!ffmpeg) return () => {}
  const child = track(
    spawn(
      ffmpeg,
      ["-v", "error", "-stream_loop", "-1", "-re", "-i", file, "-map", "0:v:0", "-an", "-vf", `fps=${fps},scale=${w}:${h}:flags=bilinear,format=rgb24`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
      { stdio: ["ignore", "pipe", "ignore"] },
    ),
  )
  const size = w * h * 3
  let pending = Buffer.alloc(0)
  child.stdout.on("data", (chunk) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
    // Only the newest whole frame is drawn: if drawing falls behind, frames are skipped, not queued.
    let last
    while (pending.length >= size) {
      last = pending.subarray(0, size)
      pending = pending.subarray(size)
    }
    if (last) onFrame(Buffer.from(last))
  })
  return () => child.kill("SIGKILL")
}

/** Play a file's sound in a loop (mpv, else ffplay); returns stop(). */
export function playSound(file) {
  const mpv = tool("mpv")
  const ffplay = tool("ffplay")
  const child = mpv
    ? spawn(mpv, ["--no-video", "--loop-file=inf", "--really-quiet", "--no-terminal", file], { stdio: "ignore" })
    : ffplay
      ? spawn(ffplay, ["-nodisp", "-loop", "0", "-loglevel", "quiet", file], { stdio: "ignore" })
      : undefined
  if (!child) return () => {}
  track(child)
  return () => child.kill("SIGTERM")
}

/** "1:05" for a duration in seconds. */
export function durationText(seconds) {
  if (!seconds) return ""
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, "0")
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`
}
