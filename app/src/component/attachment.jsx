import { FrameBufferRenderable, RGBA } from "@opentui/core"
import { extend, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createResource, createSignal, on, onCleanup, Show } from "solid-js"
import { addThumb, sizeText, displayPath } from "../context/attachments"
import { config } from "../context/config"
import { canDecode, canPlaySound, durationText, mediaSource, playFrames, playSound, probe, stillFrame } from "../context/media"
import { filetype } from "../routes/tools"
import { syntax, theme } from "../context/theme"

// Attachment chips and previews, shared by the prompt (what will be sent) and the transcript (what was sent).
// Pictures, GIFs, videos and sound show as a soft (blurred) picture; a click shows the picture sharp at the
// size of the chat, or plays the GIF/video (with its sound) or the sound in a loop; another click stops it.

/**
 * A frame buffer Solid can create: @opentui/solid constructs an element first and sets width/height after, but
 * FrameBufferRenderable needs them in its constructor (it threw on every picture). Starts at 1×1, redraws on resize.
 */
class PixelsRenderable extends FrameBufferRenderable {
  constructor(ctx, options) {
    super(ctx, { ...options, width: Number.isSafeInteger(options?.width) && options.width > 0 ? options.width : 1, height: Number.isSafeInteger(options?.height) && options.height > 0 ? options.height : 1 })
  }
  onResize(width, height) {
    super.onResize(width, height)
    this.redraw?.()
  }
}
extend({ pixels: PixelsRenderable })

const BADGE = { image: "img", pdf: "pdf", text: "file", dir: "dir", binary: "bin", video: "vid", audio: "aud" }

function facts(item) {
  return [
    item.width && item.height ? `${item.width}×${item.height}` : "",
    item.duration ? durationText(item.duration) : "",
    item.lines ? `${item.lines} lines` : "",
    sizeText(item.size),
  ]
    .filter(Boolean)
    .join(" · ")
}

/** One chip: kind badge, name, size; `onRemove` adds a ✕. */
export function AttachmentChip(props) {
  const media = () => ["image", "pdf", "video", "audio"].includes(props.item.kind)
  return (
    <text fg={theme.text} wrapMode="none" onMouseUp={() => (props.onRemove ?? props.onPress)?.()}>
      <span style={{ bg: media() ? theme.secondary : theme.accent, fg: theme.backgroundPanel, bold: true }}>
        {" "}
        {BADGE[props.item.kind] ?? "file"}{" "}
      </span>
      <span style={{ bg: theme.backgroundElement, fg: theme.text }}>
        {" "}
        {props.item.token && (props.item.kind === "image" || props.item.kind === "pdf") ? `${props.item.token} ` : ""}
        {props.item.path ? displayPath(props.item.path) : props.item.name}{" "}
      </span>
      <Show when={facts(props.item)}>
        <span style={{ bg: theme.backgroundElement, fg: theme.textMuted }}>{facts(props.item)} </span>
      </Show>
      <Show when={props.onRemove}>
        <span style={{ bg: theme.backgroundElement, fg: theme.error }}>✕ </span>
      </Show>
    </text>
  )
}

/** Raw RGB pixels (w × h, h even) drawn as w × h/2 half-block cells straight into a frame buffer. */
function Pixels(props) {
  let view
  const draw = () => {
    const frame = props.frame
    if (!view || view.isDestroyed || !frame) return
    const buffer = view.frameBuffer
    const rows = Math.floor(frame.h / 2)
    // Until layout gives the buffer its size, a drawing would be cut: onResize draws again.
    if (buffer.width < frame.w || buffer.height < rows) return
    const rgb = frame.rgb
    for (let y = 0; y < rows; y++) {
      const top = y * 2 * frame.w * 3
      const bottom = (y * 2 + 1) * frame.w * 3
      for (let x = 0; x < frame.w; x++) {
        const t = top + x * 3
        const b = bottom + x * 3
        buffer.setCell(x, y, "▀", RGBA.fromInts(rgb[t], rgb[t + 1], rgb[t + 2], 255), RGBA.fromInts(rgb[b], rgb[b + 1], rgb[b + 2], 255))
      }
    }
    view.requestRender()
  }
  createEffect(on(() => props.frame, draw))
  return (
    <pixels
      width={props.frame.w}
      height={Math.floor(props.frame.h / 2)}
      flexShrink={0}
      ref={(r) => {
        view = r
        r.redraw = draw
        setTimeout(draw, 0)
      }}
    />
  )
}

/**
 * A frame that can be drawn: whole positive pixel sizes and enough bytes. Anything else (a thumbnail saved by
 * an older occ in another shape, a cut-off decode) is skipped: a frame buffer of NaN width throws while the
 * transcript is drawn, which used to stop the saved tabs from coming back.
 */
function drawable(frame) {
  if (!frame?.rgb || !Number.isSafeInteger(frame.w) || !Number.isSafeInteger(frame.h)) return false
  if (frame.w < 1 || frame.h < 2 || frame.w > 2000 || frame.h > 4000) return false
  return frame.rgb.length >= frame.w * Math.floor(frame.h / 2) * 2 * 3
}

/** A thumbnail as stored ({ w, h rows, rgb base64 }), as a frame, when it is in that shape. */
function thumbFrame(thumb) {
  if (!thumb || typeof thumb.rgb !== "string") return undefined
  const frame = { w: thumb.w, h: thumb.h * 2, rgb: Buffer.from(thumb.rgb, "base64") }
  return drawable(frame) ? frame : undefined
}

/** A frame at its size: a new size gets a new buffer (the old one can't change size under a drawing). */
function Frame(props) {
  const size = createMemo(() => (drawable(props.frame) ? `${props.frame.w}x${props.frame.h}` : ""))
  return (
    <Show when={size()} keyed>
      {() => <Pixels frame={props.frame} />}
    </Show>
  )
}

/** The small prompt-time thumbnail (base64 RGB) as pixels; kept for plugins that used it. */
export function ThumbView(props) {
  const frame = createMemo(() => thumbFrame(props.thumb))
  return <Frame frame={frame()} />
}

const stills = new Map()
async function cachedStill(key, make) {
  if (!stills.has(key)) stills.set(key, make().catch(() => undefined))
  return stills.get(key)
}

/** Pictures, GIFs, video and sound: soft until clicked, then sharp or playing; a second click goes back. */
function MediaPreview(props) {
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  const [open, setOpen] = createSignal(false)
  const [playing, setPlaying] = createSignal()
  // Sharp: as wide as the chat column allows (in steps of 8 columns, so a resize doesn't redo it for every
  // column) and up to 60 % of the window's height. Soft: a small picture.
  const full = createMemo(() => ({
    columns: Math.max(16, Math.min(240, Math.floor((dimensions().width - 14) / 8) * 8)),
    rows: Math.max(8, Math.floor(dimensions().height * 0.6)),
  }))
  const small = createMemo(() => ({ columns: Math.min(32, full().columns), rows: Math.min(10, full().rows) }))
  const source = createMemo(() => mediaSource(props.item))
  const [info] = createResource(source, async (file) => (canDecode() ? await probe(file) : undefined))
  const animated = () => props.item.kind === "video" || (props.item.kind === "image" && /gif|webp/.test(props.item.mime ?? "") && (info()?.frames ?? 0) > 1)
  const audio = () => props.item.kind === "audio"
  const sound = () => audio() || (props.item.kind === "video" && info()?.hasAudio)

  const [still] = createResource(
    () => (info.loading ? undefined : { file: source(), open: open(), ...(open() ? full() : small()) }),
    async ({ file, open, columns, rows }) => {
      const blur = !open
      if (file && canDecode()) {
        const key = `${file}:${columns}x${rows}:${blur}`
        const frame = await cachedStill(key, () => stillFrame(file, info(), columns, rows, { blur, at: props.item.kind === "video" ? 1 : undefined, audio: audio() }))
        if (frame) return frame
      }
      // No ffmpeg: ImageMagick's thumbnail, as before.
      if (props.item.kind !== "image" || !props.item.data) return thumbFrame(props.item.thumb)
      const copy = { ...props.item, thumb: undefined }
      await addThumb(copy, columns, rows)
      return thumbFrame(copy.thumb)
    },
  )

  // Playing: frames at the sharp size, and the sound, until the next click (or the message leaves the screen).
  let stops = []
  const stop = () => {
    for (const fn of stops) fn()
    stops = []
    setPlaying(undefined)
  }
  createEffect(
    on(open, (isOpen) => {
      stop()
      const file = source()
      if (!isOpen || !file) return
      if (animated() && canDecode()) {
        const { w, h } = fitFrame(info(), full().columns, full().rows)
        stops.push(playFrames(file, w, h, (rgb) => setPlaying({ w, h, rgb }), Math.min(24, Math.max(8, Math.round(info()?.fps ?? 15)))))
      }
      if (sound() && canPlaySound()) stops.push(playSound(file))
    }),
  )
  onCleanup(stop)

  const picture = () => (open() && playing()) || still.latest
  const label = () => {
    const what = animated() ? (sound() ? "play" : "play") : audio() ? "play sound" : "view full size"
    if (!open()) return `▶ ${what}`
    return animated() || audio() ? "■ playing · click to stop" : "▲ click to make it small"
  }
  return (
    <box
      flexDirection="column"
      flexShrink={0}
      paddingTop={1}
      onMouseUp={(event) => {
        // The message's own click opens its actions; this one only toggles the picture.
        event.stopPropagation()
        if (renderer.getSelection()?.getSelectedText()) return
        setOpen((value) => !value)
      }}
    >
      <Show when={picture()} fallback={<text fg={theme.textMuted}>{audio() ? "♪ " : ""}{label()}</text>}>
        <Frame frame={picture()} />
        <text fg={theme.textMuted}>
          {audio() ? "♪ " : ""}
          {label()}
          {!canPlaySound() && sound() ? " (no sound: install mpv)" : ""}
        </text>
      </Show>
    </box>
  )
}

function fitFrame(info, columns, rows) {
  const width = info?.width ?? columns
  const height = info?.height ?? rows * 2
  const scale = Math.min(columns / width, (rows * 2) / height, 1)
  return { w: Math.max(2, Math.floor((width * scale) / 2) * 2), h: Math.max(2, Math.floor((height * scale) / 2) * 2) }
}

/** What a sent prompt carried: chips, pictures and media (soft until clicked), the head of text files. */
export function AttachmentPreview(props) {
  const [open, setOpen] = createSignal(false)
  const media = () => ["image", "video", "audio"].includes(props.item.kind)
  const head = () => {
    const lines = (props.item.text ?? "").split("\n")
    return open() ? lines.slice(0, 200).join("\n") : lines.slice(0, 6).join("\n")
  }
  const more = () => Math.max(0, (props.item.lines ?? 0) - (open() ? 200 : 6))
  return (
    <box flexDirection="column" flexShrink={0} gap={0}>
      <AttachmentChip item={props.item} onPress={() => setOpen((value) => !value)} />
      <Show when={config.attachmentPreviews !== false}>
        <Show when={media() && (props.item.path || props.item.data || props.item.thumb)}>
          <MediaPreview item={props.item} />
        </Show>
        <Show when={props.item.kind === "text" && props.item.text}>
          <box paddingTop={1} paddingLeft={1} border={["left"]} borderColor={theme.border} onMouseUp={() => setOpen((value) => !value)}>
            <code filetype={filetype(props.item.name)} content={head()} syntaxStyle={syntax()} drawUnstyledText={true} fg={theme.textMuted} />
            <Show when={more() > 0}>
              <text fg={theme.textMuted}>… {more()} more lines (click to {open() ? "collapse" : "expand"})</text>
            </Show>
          </box>
        </Show>
      </Show>
    </box>
  )
}
