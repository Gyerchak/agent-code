import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, For, Show } from "solid-js"
import { runCommand, shortcut } from "../context/keymap"
import { active, closeTab, focusTab, moveTabTo, tabs } from "../context/tabs"
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
  // Dragging a tab works like grabbing a browser tab: the grabbed cell stays under the pointer (the tab floats along
  // the strip, its place shown as an empty slot), neighbours give way once its middle passes theirs, and moving off
  // the strip vertically doesn't drop it.
  const boxes = new Map()
  let bar
  const [dragging, setDragging] = createSignal()
  const [floatX, setFloatX] = createSignal()
  let dragged = false
  let grabOffset = 0
  let downX = 0
  const floatLeft = (session, x) => {
    const box = boxes.get(session)
    const width = box?.width ?? MAX_TITLE
    // It slides within the tabs, as in a browser: from the first tab's start to the last one's end.
    const places = visible().map((item) => boxes.get(item)).filter((place) => place && !place.isDestroyed)
    const min = places.length ? Math.min(...places.map((place) => place.x)) : (bar?.x ?? 0) + 1
    const max = places.length ? Math.max(...places.map((place) => place.x + place.width)) - width : (bar?.x ?? 0) + (bar?.width ?? dimensions().width) - width - 1
    return Math.max(min, Math.min(Math.max(min, max), x - grabOffset))
  }
  const dragOver = (session, event) => {
    if (dragging() !== session) return
    if (!dragged && event.x === downX) return
    dragged = true
    setFloatX(event.x)
    const box = boxes.get(session)
    if (!box || box.isDestroyed) return
    const middle = floatLeft(session, event.x) + box.width / 2
    const from = tabs().indexOf(session)
    // The farthest neighbour whose middle the floating tab has passed: take its place.
    let target = from
    for (const [other, place] of boxes) {
      if (other === session || place.isDestroyed) continue
      const to = tabs().indexOf(other)
      if (to < 0) continue
      const center = place.x + place.width / 2
      if (to > from && middle > center && to > target) target = to
      if (to < from && middle < center && (target === from || to < target)) target = to
    }
    if (target !== from) moveTabTo(session, target)
  }
  const drop = () => {
    setDragging(undefined)
    setFloatX(undefined)
  }
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
    <box ref={(r) => (bar = r)} height={1} flexShrink={0} flexDirection="row" backgroundColor={theme.backgroundPanel} paddingLeft={1} paddingRight={1}>
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
          // While it floats, the tab's own place in the strip is an empty slot of the same width.
          const slot = () => dragging() === session && floatX() !== undefined
          const ink = (color) => (slot() ? theme.background : color)
          return (
            <box
              flexDirection="row"
              paddingLeft={1}
              paddingRight={1}
              gap={1}
              backgroundColor={slot() ? theme.background : dragging() === session ? theme.backgroundElement : focused() ? theme.backgroundElement : undefined}
              ref={(r) => boxes.set(session, r)}
              onMouseDown={(event) => {
                dragged = false
                downX = event.x
                grabOffset = event.x - (boxes.get(session)?.x ?? event.x)
                setDragging(session)
              }}
              onMouseDrag={(event) => dragOver(session, event)}
              onMouseDragEnd={drop}
              onMouseOver={over}
              onMouseOut={() => {
                // Out of the box then over one of its children arrives as out → over: wait a tick before collapsing.
                const seq = ++events
                setTimeout(() => lastOver < seq && hover() === session.key && setHover(undefined), 40)
              }}
              onMouseUp={() => {
                const held = dragging()
                drop()
                // Released on another tab: the held tab goes there (and stays the one in front).
                if (held && held !== session && !held.disposed) {
                  moveTabTo(held, tabs().indexOf(session))
                  focusTab(held)
                  return
                }
                focusTab(held && dragged ? held : session)
              }}
            >
              <text selectable={false} fg={ink(theme.textMuted)}>{index() <= 9 ? index() : "·"}</text>
              <Show
                when={running()}
                fallback={
                  <Show when={attention() || session.store.unseen === "done"}>
                    <text selectable={false} fg={ink(attention() ? theme.warning : theme.success)}>●</text>
                  </Show>
                }
              >
                <Spinner color={ink(attention() ? theme.warning : theme.textMuted)} />
              </Show>
              <text selectable={false} fg={ink(focused() ? theme.text : theme.textMuted)} attributes={focused() ? TextAttributes.BOLD : undefined} wrapMode="none">
                {label(session)}
              </text>
              {/* The ✕ cell always exists, so moving onto it never collapses the tab under the pointer. */}
              <text
                fg={ink(hovered() ? theme.error : theme.textMuted)}
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
      {/* The grabbed tab, drawn where the pointer holds it. */}
      <Show when={dragging() && floatX() !== undefined}>
        <box
          position="absolute"
          zIndex={20}
          top={0}
          left={floatLeft(dragging(), floatX()) - (bar?.x ?? 0)}
          width={boxes.get(dragging())?.width}
          height={1}
          flexDirection="row"
          paddingLeft={1}
          paddingRight={1}
          gap={1}
          backgroundColor={theme.backgroundElement}
        >
          <text selectable={false} fg={theme.primary}>{tabs().indexOf(dragging()) + 1 <= 9 ? tabs().indexOf(dragging()) + 1 : "·"}</text>
          <text selectable={false} fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none">
            {label(dragging())}
          </text>
          <text selectable={false} fg={theme.textMuted}>{" "}</text>
        </box>
      </Show>
      <Show when={hidden() > 0}>
        <text selectable={false} fg={theme.textMuted} onMouseUp={() => runCommand("session.list")}>
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
        <text selectable={false} fg={theme.textMuted}>+</text>
      </box>
      <box flexGrow={1} />
      <Show when={dimensions().width >= 110}>
        <text selectable={false} fg={theme.textMuted}>{shortcut("tab.next")} next  </text>
      </Show>
      <box
        paddingLeft={1}
        paddingRight={1}
        backgroundColor={hover() === "sessions" ? theme.backgroundElement : undefined}
        onMouseOver={() => setHover("sessions")}
        onMouseOut={() => setHover(undefined)}
        onMouseUp={() => runCommand("session.list")}
      >
        <text selectable={false} fg={theme.text}>
          ≡ sessions <span style={{ fg: theme.textMuted }}>{shortcut("session.list")}</span>
        </text>
      </box>
    </box>
  )
}
