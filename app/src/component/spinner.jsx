
import { createMemo, createSignal, For, onCleanup, Show,          } from "solid-js"
import { config } from "../context/config"
import { theme } from "../context/theme"
import { createColors, createFrames } from "../ui/scanner"

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

function useFrame(count        , interval        ) {
  const [frame, setFrame] = createSignal(0)
  const timer = setInterval(() => setFrame((value) => (value + 1) % count), interval)
  onCleanup(() => clearInterval(timer))
  return frame
}

/** Braille spinner with optional label (opencode component/spinner.tsx). */
export function Spinner(props                                          ) {
  const color = () => props.color ?? theme.textMuted
  if (config.animations === false)
    return <text fg={color()}>{props.children ? <>⋯ {props.children}</> : "⋯"}</text>
  const frame = useFrame(SPINNER_FRAMES.length, 80)
  return (
    <box flexDirection="row" gap={1} flexShrink={props.children ? 1 : 0}>
      <text flexShrink={0} fg={color()}>
        {SPINNER_FRAMES[frame()]}
      </text>
      <Show when={props.children}>
        <text fg={color()}>{props.children}</text>
      </Show>
    </box>
  )
}

/** Knight-rider "blocks" scanner shown in the prompt footer while a session runs. */
export function Scanner(props                 ) {
  if (config.animations === false) return <text fg={theme.textMuted}>[⋯]</text>
  const def = createMemo(() => {
    const options = { color: props.color, style: "blocks"         , inactiveFactor: 0.6, minAlpha: 0.3 }
    return { frames: createFrames(options), colors: createColors(options) }
  })
  const frame = useFrame(def().frames.length, 40)
  return (
    <text>
      <For each={Array.from(def().frames[frame() % def().frames.length])}>
        {(char, index) => (
          <span style={{ fg: def().colors(frame() % def().frames.length, index(), def().frames.length, 8)         }}>{char}</span>
        )}
      </For>
    </text>
  )
}
