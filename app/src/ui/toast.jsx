import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createSignal, Show } from "solid-js"
import { theme } from "../context/theme"
import { SplitBorder } from "./border"
import { tabBarVisible } from "../component/tabs"



const [current, setCurrent] = createSignal       ()
let timer

export const toast = {
  show(next       ) {
    clearTimeout(timer)
    setCurrent(next)
    timer = setTimeout(() => setCurrent(undefined), next.duration ?? 4000)
  },
  error(error         ) {
    toast.show({ variant: "error", message: error instanceof Error ? error.message : String(error) })
  },
  clear() {
    setCurrent(undefined)
  },
}

export function ToastHost() {
  const dimensions = useTerminalDimensions()
  const color = (variant                  ) =>
    variant === "error" ? theme.error : variant === "warning" ? theme.warning : variant === "success" ? theme.success : theme.info
  return (
    <Show when={current()}>
      {(item             ) => (
        <box
          position="absolute"
          zIndex={4000}
          top={tabBarVisible() ? 2 : 1}
          right={2}
          maxWidth={Math.min(60, dimensions().width - 6)}
          border={["left", "right"]}
          customBorderChars={SplitBorder.customBorderChars}
          borderColor={color(item().variant)}
          onMouseUp={() => toast.clear()}
        >
          <box paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1} backgroundColor={theme.backgroundElement}>
            <Show when={item().title}>
              <text attributes={TextAttributes.BOLD} fg={theme.text} marginBottom={1}>
                {item().title}
              </text>
            </Show>
            <text fg={theme.text} wrapMode="word">
              {item().message}
            </text>
          </box>
        </box>
      )}
    </Show>
  )
}
