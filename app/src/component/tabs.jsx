import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, For, Show } from "solid-js"
import { runCommand, shortcut } from "../context/keymap"
import { active, closeTab, focusTab, tabs,              } from "../context/tabs"
import { theme } from "../context/theme"
import { Spinner } from "./spinner"

const MAX_TITLE = 22

function label(session         ) {
  const title = session.store.title?.replace(/\s+/g, " ").trim() || (session.store.messages.length ? "Session" : "New session")
  return title.length > MAX_TITLE ? title.slice(0, MAX_TITLE - 1) + "…" : title
}

export const tabBarVisible = () => true

/** One-row tab strip: open sessions, plus buttons for a new tab and the session list. */
export function TabBar() {
  const dimensions = useTerminalDimensions()
  const [hover, setHover] = createSignal        ()
  let events = 0
  let lastOver = 0
  // Keep a window of tabs around the focused one when they don't all fit.
  const visible = createMemo(() => {
    const list = tabs()
    const per = MAX_TITLE + 8
    const fit = Math.max(1, Math.floor((dimensions().width - 20) / per))
    if (list.length <= fit) return list
    const index = list.indexOf(active())
    const start = Math.max(0, Math.min(index - Math.floor(fit / 2), list.length - fit))
    return list.slice(start, start + fit)
  })
  const hidden = createMemo(() => tabs().length - visible().length)
  return (
    <box height={1} flexShrink={0} flexDirection="row" backgroundColor={theme.backgroundPanel} paddingLeft={1} paddingRight={1}>
      <For each={visible()}>
        {(session) => {
          const index = () => tabs().indexOf(session) + 1
          const focused = () => active() === session
          const running = () => session.store.status === "running" || session.store.booting
          const hovered = () => hover() === session.key
          // Children report "over" too: leaving the tab box for its own ✕ must not count as leaving the tab.
          const over = () => {
            lastOver = ++events
            setHover(session.key)
          }
          const attention = () => session.store.permissions.length > 0 || session.store.questions.length > 0 || session.store.unseen === "attention"
          return (
            <box
              flexDirection="row"
              paddingLeft={1}
              paddingRight={1}
              gap={1}
              backgroundColor={focused() ? theme.backgroundElement : undefined}
              onMouseOver={over}
              onMouseOut={() => {
                // Out of the box then over one of its children arrives as out → over: wait a tick before collapsing.
                const seq = ++events
                setTimeout(() => lastOver < seq && hover() === session.key && setHover(undefined), 40)
              }}
              onMouseUp={() => focusTab(session)}
            >
              <text fg={theme.textMuted}>{index() <= 9 ? index() : "·"}</text>
              <Show
                when={running()}
                fallback={
                  <Show when={attention() || session.store.unseen === "done"}>
                    <text fg={attention() ? theme.warning : theme.success}>●</text>
                  </Show>
                }
              >
                <Spinner color={attention() ? theme.warning : theme.textMuted} />
              </Show>
              <text fg={focused() ? theme.text : theme.textMuted} attributes={focused() ? TextAttributes.BOLD : undefined} wrapMode="none">
                {label(session)}
              </text>
              {/* The ✕ cell always exists, so moving onto it never collapses the tab under the pointer. */}
              <text
                fg={hovered() ? theme.error : theme.textMuted}
                onMouseOver={over}
                onMouseUp={(event                             ) => {
                  event.stopPropagation()
                  closeTab(session)
                }}
              >
                {hovered() || focused() ? "✕" : " "}
              </text>
            </box>
          )
        }}
      </For>
      <Show when={hidden() > 0}>
        <text fg={theme.textMuted} onMouseUp={() => runCommand("session.list")}>
          {" "}+{hidden()} more
        </text>
      </Show>
      <box
        paddingLeft={1}
        paddingRight={1}
        backgroundColor={hover() === "+" ? theme.backgroundElement : undefined}
        onMouseOver={() => setHover("+")}
        onMouseOut={() => setHover(undefined)}
        onMouseUp={() => runCommand("tab.new")}
      >
        <text fg={theme.textMuted}>+</text>
      </box>
      <box flexGrow={1} />
      <Show when={dimensions().width >= 110}>
        <text fg={theme.textMuted}>{shortcut("tab.next")} next  </text>
      </Show>
      <box
        paddingLeft={1}
        paddingRight={1}
        backgroundColor={hover() === "sessions" ? theme.backgroundElement : undefined}
        onMouseOver={() => setHover("sessions")}
        onMouseOut={() => setHover(undefined)}
        onMouseUp={() => runCommand("session.list")}
      >
        <text fg={theme.text}>
          ≡ sessions <span style={{ fg: theme.textMuted }}>{shortcut("session.list")}</span>
        </text>
      </box>
    </box>
  )
}
