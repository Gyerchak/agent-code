import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { For } from "solid-js"
import { theme, tint } from "../context/theme"

// Same glyph language as opencode's logo, spelling "claude" + "code".
const logo = {
  left: [
    "     ▄              ▄     ",
    "█▀▀▀ █ ▀▀▀█ █  █ █▀▀█ █▀▀█",
    "█___ █ █▀▀█ █__█ █__█ █^^^",
    "▀▀▀▀ ▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀",
  ],
  right: ["             ▄     ", "█▀▀▀ █▀▀█ █▀▀█ █▀▀█", "█___ █__█ █__█ █^^^", "▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀"],
}

export function Logo() {
  const dimensions = useTerminalDimensions()
  const renderLine = (line        , fg      , bold         )                => {
    const shadow = tint(theme.background, fg, 0.25)
    const attrs = bold ? TextAttributes.BOLD : undefined
    return Array.from(line).map((char) => {
      if (char === "_")
        return (
          <text fg={fg} bg={shadow} attributes={attrs} selectable={false}>
            {" "}
          </text>
        )
      if (char === "^")
        return (
          <text fg={fg} bg={shadow} attributes={attrs} selectable={false}>
            ▀
          </text>
        )
      return (
        <text fg={fg} attributes={attrs} selectable={false}>
          {char}
        </text>
      )
    })
  }
  return (
    <box>
      {dimensions().height < 12 ? null : dimensions().width < 52 ? (
        <>
          <For each={logo.left.slice(1)}>
            {(line) => <box flexDirection="row">{renderLine(line, theme.textMuted, false)}</box>}
          </For>
          <For each={logo.right}>{(line) => <box flexDirection="row">{renderLine(line, theme.text, true)}</box>}</For>
        </>
      ) : (
        <For each={logo.left}>
          {(line, index) => (
            <box flexDirection="row" gap={1}>
              <box flexDirection="row">{renderLine(line, theme.textMuted, false)}</box>
              <box flexDirection="row">{renderLine(logo.right[index()], theme.text, true)}</box>
            </box>
          )}
        </For>
      )}
    </box>
  )
}
