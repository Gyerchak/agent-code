import { findBinary, isWindows } from "./platform"
import { spawnSync } from "node:child_process"

function run(cmd        , args          , binary = false) {
  try {
    const result = spawnSync(cmd, args, { timeout: 2000, maxBuffer: 64 * 1024 * 1024, encoding: binary ? "buffer" : "utf8" })
    if (result.status !== 0) return undefined
    return result.stdout
  } catch {
    return undefined
  }
}

/**
 * Why the clipboard can't be read, if it can't: on Wayland only wl-clipboard's `wl-paste` can read it from a
 * background program (images included); terminals themselves only paste text.
 */
export function clipboardProblem()                     {
  if (process.platform !== "linux" || !process.env.WAYLAND_DISPLAY) return undefined
  if (findBinary("wl-paste")) return undefined
  return "Pasting images needs wl-clipboard: sudo pacman -S wl-clipboard (files and text work without it)."
}

/** Read an image or text from the system clipboard (Wayland, X11, macOS, Windows). */
export function readClipboard()                                             {
  if (isWindows) {
    const text = run("powershell", ["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard -Raw"])
    return typeof text === "string" ? { mime: "text/plain", data: text.replace(/\r\n$/, "") } : undefined
  }
  const wayland = !!process.env.WAYLAND_DISPLAY
  if (wayland) {
    const types = String(run("wl-paste", ["--list-types"]) ?? "")
    const image = types.split("\n").find((type) => /^image\/(png|jpeg|gif|webp)$/.test(type.trim()))
    if (image) {
      const data = run("wl-paste", ["--type", image.trim()], true)
      if (data?.length) return { mime: image.trim(), data: data.toString("base64") }
    }
    const text = run("wl-paste", ["--no-newline"])
    if (typeof text === "string") return { mime: "text/plain", data: text }
  }
  const targets = String(run("xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"]) ?? "")
  const image = targets.split("\n").find((type) => /^image\/(png|jpeg|gif|webp)$/.test(type.trim()))
  if (image) {
    const data = run("xclip", ["-selection", "clipboard", "-t", image.trim(), "-o"], true)
    if (data?.length) return { mime: image.trim(), data: data.toString("base64") }
  }
  const text = run("xclip", ["-selection", "clipboard", "-o"]) ?? run("pbpaste", [])
  if (typeof text === "string") return { mime: "text/plain", data: text }
  return undefined
}
