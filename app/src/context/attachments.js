import { findBinary, isWindows } from "./platform"
import { execFile } from "node:child_process"
import { existsSync, readFileSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { log } from "./log"
import { AUDIO, probe, VIDEO } from "./media"

// ---------------------------------------------------------------------------
// Files dropped or pasted into the prompt. A terminal drops a file by pasting its path (quoted,
// backslash-escaped or as a file:// URI, several separated by spaces or newlines); like opencode,
// a pasted path that exists becomes an attachment instead of text.
// ---------------------------------------------------------------------------



/** What the prompt holds until sending (with the bytes) and the transcript keeps (without them). */






















const IMAGE                         = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
}
/** Kinds Claude accepts as image blocks; other image formats are converted to PNG on the way. */
const CONVERT = new Set([".avif", ".bmp", ".tif", ".tiff", ".heic", ".svg", ".ico"])
const MAX_INLINE_TEXT = 256 * 1024
const MAX_BINARY = 20 * 1024 * 1024

/** A pasted piece as an absolute path that exists (file:// URI, ~/, or an obvious relative path), else undefined. */
function existing(piece        , cwd        )                     {
  let file = piece.trim()
  if (!file) return undefined
  if (file.startsWith("file://")) {
    try {
      file = fileURLToPath(file)
    } catch {
      return undefined
    }
  }
  if (file.startsWith("~/")) file = path.join(os.homedir(), file.slice(2))
  if (!path.isAbsolute(file)) {
    if (!/^\.{1,2}\/|\//.test(file)) return undefined
    file = path.resolve(cwd, file)
  }
  return existsSync(file) ? file : undefined
}

/**
 * Terminals drop unquoted paths, so names with spaces arrive split ("/a/my screenshot.png"). Rebuild them:
 * join space-separated words left to right until they name an existing file; every word must be used.
 */
function rejoined(value        , cwd        )                       {
  const words = value.split(/ +/)
  const out           = []
  let start = 0
  while (start < words.length) {
    let found = -1
    // Longest match first, so "/a/b c" wins over "/a/b" when both exist.
    for (let end = words.length; end > start; end--) {
      if (existing(words.slice(start, end).join(" "), cwd)) {
        found = end
        break
      }
    }
    if (found < 0) return undefined
    out.push(existing(words.slice(start, found).join(" "), cwd) )
    start = found
  }
  return out.length ? out : undefined
}

/** Split a paste into file paths when every piece names an existing file or folder; otherwise undefined. */
export function pastedPaths(text        , cwd        )                       {
  const value = text.trim()
  if (!value || value.length > 8000) return undefined
  // The whole paste is one path (spaces and all), or one path per line.
  const whole = existing(value, cwd)
  if (whole) return [whole]
  const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (lines.length > 1) {
    const each = lines.map((line) => existing(line, cwd))
    if (each.every(Boolean)) return each
  }
  const pieces           = []
  // Quoted ('…' or "…"), file:// URIs, or backslash-escaped words.
  const pattern = /'([^']+)'|"([^"]+)"|((?:\\.|[^\s'"])+)/g
  for (const match of value.matchAll(pattern)) {
    const piece = match[1] ?? match[2] ?? match[3].replace(/\\(.)/g, "$1")
    if (piece) pieces.push(piece)
  }
  if (!pieces.length || pieces.length > 50) return undefined
  const paths           = []
  for (const piece of pieces) {
    let file = piece
    if (file.startsWith("file://")) {
      try {
        file = fileURLToPath(file)
      } catch {
        return undefined
      }
    }
    if (file.startsWith("~/")) file = path.join(os.homedir(), file.slice(2))
    if (!path.isAbsolute(file)) {
      // Only an obvious relative path (./x, ../x, a/b.ext) counts, so ordinary words stay text.
      if (!/^\.{1,2}\/|\//.test(file)) return !value.includes("\n") ? rejoined(value, cwd) : undefined
      file = path.resolve(cwd, file)
    }
    if (!existsSync(file)) return !value.includes("\n") ? rejoined(value, cwd) : undefined
    paths.push(file)
  }
  return paths
}

function isTextual(buffer        ) {
  const sample = buffer.subarray(0, 8000)
  if (sample.includes(0)) return false
  const text = sample.toString("utf8")
  return !text.includes("�") || text.length < 16
}

/** Read a file or folder as an attachment. */
export async function readAttachment(file        )                      {
  const name = path.basename(file)
  const stat = statSync(file)
  if (stat.isDirectory()) return { kind: "dir", name: name + "/", path: file, mime: "inode/directory" }
  const ext = path.extname(file).toLowerCase()
  const size = stat.size
  if (IMAGE[ext] || CONVERT.has(ext)) {
    const png = CONVERT.has(ext) ? await toPng(file) : undefined
    const data = png ?? (size <= MAX_BINARY ? readFileSync(file).toString("base64") : undefined)
    if (data) {
      const attachment             = { kind: "image", name, path: file, mime: png ? "image/png" : IMAGE[ext], size, data }
      await addThumb(attachment)
      return attachment
    }
  }
  // Video and sound: shown and played in Agent Code; the model gets the path (it can use ffmpeg on it).
  if (VIDEO[ext] || AUDIO[ext]) {
    const info = await probe(file)
    const kind = VIDEO[ext] && info?.hasVideo !== false ? "video" : "audio"
    return { kind, name, path: file, mime: VIDEO[ext] ?? AUDIO[ext], size, width: info?.width, height: info?.height, duration: info?.duration }
  }
  if (ext === ".pdf" && size <= MAX_BINARY) return { kind: "pdf", name, path: file, mime: "application/pdf", size, data: readFileSync(file).toString("base64") }
  const head = readFileSync(file).subarray(0, Math.min(size, MAX_INLINE_TEXT + 1))
  if (isTextual(head)) {
    const text = size <= MAX_INLINE_TEXT ? head.toString("utf8") : undefined
    return { kind: "text", name, path: file, mime: "text/plain", size, text, lines: text ? text.split("\n").length : undefined }
  }
  return { kind: "binary", name, path: file, mime: "application/octet-stream", size }
}

/** An image from the clipboard (bytes, no file). */
export async function clipboardImage(mime        , data        , index        )                      {
  const ext = mime.split("/")[1] ?? "png"
  const attachment             = { kind: "image", name: `clipboard-${index}.${ext}`, mime, data, size: Math.floor((data.length * 3) / 4) }
  await addThumb(attachment)
  return attachment
}

function run(command        , args          , input         )                              {
  return new Promise((resolve) => {
    const child = execFile(command, args, { encoding: "buffer", maxBuffer: 64 * 1024 * 1024, timeout: 15_000 }, (error, stdout) => {
      if (error) {
        log("attachment tool failed", command, String(error).slice(0, 200))
        resolve(undefined)
        return
      }
      resolve(stdout)
    })
    if (input) child.stdin?.end(input)
  })
}

let magick
function magickBinary() {
  if (magick !== undefined) return magick ?? undefined
  // `convert` is ImageMagick 6 on Linux/macOS; on Windows it is a disk tool, so only `magick` counts there.
  magick = findBinary("magick") ?? (isWindows ? undefined : findBinary("convert")) ?? null
  return magick ?? undefined
}

async function toPng(file        ) {
  const tool = magickBinary()
  if (!tool) return undefined
  const out = await run(tool, [`${file}[0]`, "png:-"])
  return out?.length ? out.toString("base64") : undefined
}

/** Thumbnail and pixel size through ImageMagick (none without it: the chip still shows). */
export async function addThumb(attachment            , maxColumns = 36, maxRows = 14) {
  const tool = magickBinary()
  if (!tool || !attachment.data) return
  const input = Buffer.from(attachment.data, "base64")
  const size = await run(tool, ["-", "-format", "%w %h", "info:"], input)
  const [width, height] = String(size ?? "").trim().split(/\s+/).map(Number)
  if (width && height) {
    attachment.width = width
    attachment.height = height
  }
  // One cell is one pixel wide and two tall (▀ with foreground on top, background below), so the pixels come
  // out about square. Plain box averaging (-scale): no sharpening, which drew bright halos; never enlarged (">").
  // Transparency is kept (RGBA, laid over the chat background when drawn): flattening put it on white.
  const pam = await run(
    tool,
    ["-", "-auto-orient", "-background", "none", "-flatten", "-scale", `${maxColumns}x${maxRows * 2}>`, "-strip", "-depth", "8", "pam:-"],
    input,
  )
  const parsed = pam && parsePam(pam)
  if (!parsed) return
  const rows = Math.floor(parsed.height / 2)
  if (!rows || !parsed.width) return
  const channels = parsed.depth
  attachment.thumb = { w: parsed.width, h: rows, channels, rgb: parsed.pixels.subarray(0, parsed.width * rows * 2 * channels).toString("base64") }
}

/** A PAM image (P7, RGB or RGB_ALPHA, 8 bits). */
function parsePam(buffer) {
  const end = buffer.indexOf("ENDHDR\n")
  if (end < 0 || buffer.subarray(0, 3).toString("latin1") !== "P7\n") return undefined
  const header = Object.fromEntries(
    buffer
      .subarray(3, end)
      .toString("latin1")
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .filter((parts) => parts.length >= 2),
  )
  const width = Number(header.WIDTH)
  const height = Number(header.HEIGHT)
  const depth = Number(header.DEPTH)
  if (!width || !height || (depth !== 3 && depth !== 4) || Number(header.MAXVAL) !== 255) return undefined
  const pixels = buffer.subarray(end + 7)
  return pixels.length >= width * height * depth ? { width, height, depth, pixels } : undefined
}

/** Human size: 900 B, 12 KB, 3.4 MB. */
export function sizeText(bytes         ) {
  if (bytes === undefined) return ""
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** The placeholder a prompt shows for an attachment, numbered per kind like opencode's [Image 1]. */
export function attachmentToken(attachment            , index        ) {
  switch (attachment.kind) {
    case "image":
      return `[Image ${index}]`
    case "pdf":
      return `[PDF ${index}]`
    case "dir":
      return `[Folder ${attachment.name}]`
    default:
      return `[File ${attachment.name}]`
  }
}

/** The transcript keeps what it shows, not the bytes. */
export function attachmentMeta(attachment            )             {
  const { data: _data, text, ...rest } = attachment
  return { ...rest, text: text ? text.split("\n").slice(0, 200).join("\n") : undefined }
}

/** A path as shown and copied: under the home folder as ~/…, quoted when it holds spaces or quotes. */
export function displayPath(file        ) {
  const home = os.homedir()
  const shown = file === home || file.startsWith(home + "/") ? "~" + file.slice(home.length) : file
  return /[\s'"]/.test(shown) ? `'${shown.replace(/'/g, "'\\''")}'` : shown
}

/**
 * A prompt's text with each attachment placeholder ("[File x.ts]", "[Image 1]") swapped for the file's path,
 * and attachments the text doesn't mention appended, so the copy pasted into another prompt attaches them again.
 */
export function textWithPaths(text        , attachments                          ) {
  let out = text
  const extra           = []
  for (const item of attachments ?? []) {
    if (!item.path) continue
    const path = displayPath(item.path)
    if (item.token && out.includes(item.token)) out = out.split(item.token).join(path)
    else if (!out.includes(item.path)) extra.push(path)
  }
  return extra.length ? `${out}${out.trim() ? "\n" : ""}${extra.join(" ")}` : out
}

/**
 * Text selected with the mouse, with placeholders swapped for paths. The prompts the selection came from
 * decide which file a placeholder means ("[Image 1]" exists in many prompts): first those whose own words are
 * in the selection, then the newest prompt holding that placeholder.
 */
export function selectionWithPaths(selected        , messages              ) {
  const prompts = messages.filter((message) => message.type === "user" && message.attachments?.length).reverse()
  const words = (message     ) =>
    message.text
      .split("\n")
      .map((line        ) => line.replace(/\[[^\]]*\]/g, "").trim())
      .filter((line        ) => line.length >= 8)
  const ordered = [...prompts.filter((message) => words(message).some((line) => selected.includes(line))), ...prompts]
  let out = selected
  for (const message of ordered)
    for (const item of message.attachments) if (item.path && item.token && out.includes(item.token)) out = out.split(item.token).join(displayPath(item.path))
  return out
}

/**
 * Whether this window can't receive dropped files: Alacritty on Wayland (winit 0.30 has no Wayland
 * drag-and-drop). agentcode-window starts it through XWayland instead (and sets OCC_WAYLAND_DISPLAY).
 */
export function dropsBlocked() {
  return !!process.env.ALACRITTY_WINDOW_ID && !!process.env.WAYLAND_DISPLAY && !process.env.OCC_WAYLAND_DISPLAY
}

