import { RGBA, TextAttributes,                                                } from "@opentui/core"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { batch, createEffect, createMemo, For, on, Show,          } from "solid-js"
import { createStore } from "solid-js/store"
import { theme } from "../context/theme"
import { matchesId, shortcut, useLayer,              } from "../context/keymap"



const [dialogStore, setDialogStore] = createStore({
  stack: []                                                          ,
  size: "medium"              ,
})

let refocus
export function setDialogRefocus(fn            ) {
  refocus = fn
}

export const dialog = {
  get open() {
    return dialogStore.stack.length > 0
  },
  get depth() {
    return dialogStore.stack.length
  },
  replace(element                   , onClose             , size             = "medium") {
    for (const item of dialogStore.stack) item.onClose?.()
    batch(() => {
      setDialogStore("size", size)
      setDialogStore("stack", [{ element, onClose }])
    })
  },
  push(element                   , onClose             ) {
    setDialogStore("stack", (stack) => [...stack, { element, onClose }])
  },
  pop() {
    const top = dialogStore.stack.at(-1)
    top?.onClose?.()
    setDialogStore("stack", (stack) => stack.slice(0, -1))
    if (dialogStore.stack.length === 0) setTimeout(() => refocus?.(), 1)
  },
  clear() {
    for (const item of dialogStore.stack) item.onClose?.()
    batch(() => {
      setDialogStore("size", "medium")
      setDialogStore("stack", [])
    })
    setTimeout(() => refocus?.(), 1)
  },
  setSize(size            ) {
    setDialogStore("size", size)
  },
}

function dialogWidth(size            ) {
  if (size === "xlarge") return 116
  if (size === "large") return 88
  return 60
}

export function DialogHost() {
  const dimensions = useTerminalDimensions()
  const renderer = useRenderer()
  useLayer({
    modal: true,
    priority: 100,
    enabled: () => dialog.open,
    commands: () => [
      {
        id: "dialog.close",
        title: "Close dialog",
        keybind: "dialog.close",
        palette: false,
        run: () => {
          if (renderer.getSelection()) {
            renderer.clearSelection()
            return
          }
          dialog.pop()
        },
      },
    ],
    handler: (event) => {
      if (event.name === "escape" || (event.ctrl && event.name === "c")) {
        if (renderer.getSelection()?.getSelectedText()) {
          renderer.clearSelection()
          return true
        }
        dialog.pop()
        return true
      }
      return false
    },
  })
  let dismiss = false
  return (
    <Show when={dialogStore.stack.length > 0}>
      <box
        onMouseDown={() => {
          dismiss = !!renderer.getSelection()
        }}
        onMouseUp={() => {
          if (dismiss) {
            dismiss = false
            return
          }
          dialog.clear()
        }}
        width={dimensions().width}
        height={dimensions().height}
        alignItems="center"
        position="absolute"
        zIndex={3000}
        paddingTop={Math.floor(dimensions().height / 4)}
        left={0}
        top={0}
        backgroundColor={RGBA.fromInts(0, 0, 0, 150)}
      >
        <box
          onMouseUp={(e                             ) => {
            if (renderer.getSelection()?.getSelectedText()) return
            dismiss = false
            e.stopPropagation()
          }}
          width={dialogWidth(dialogStore.size)}
          maxWidth={dimensions().width - 2}
          backgroundColor={theme.backgroundPanel}
          paddingTop={1}
        >
          {dialogStore.stack.at(-1) .element()}
        </box>
      </box>
    </Show>
  )
}

// ---------------------------------------------------------------------------
// DialogSelect (port of opencode's ui/dialog-select.tsx)
// ---------------------------------------------------------------------------


















function fuzzy(needle        , haystack        ) {
  const n = needle.toLowerCase()
  const h = haystack.toLowerCase()
  if (h.includes(n)) return 1000 - h.indexOf(n)
  let score = 0
  let index = 0
  for (const char of n) {
    const found = h.indexOf(char, index)
    if (found < 0) return -1
    score += found === index ? 2 : 1
    index = found + 1
  }
  return score
}

export function DialogSelect   (props











 ) {
  const dimensions = useTerminalDimensions()
  const [store, setStore] = createStore({ filter: "", selected: 0 })
  let input
  let scroll

  const filtered = createMemo(() => {
    const needle = store.filter.trim()
    const options = props.options.filter((option) => !option.disabled)
    // With `search` the caller finds the options for the typed text itself (e.g. full-text search).
    if (!needle || props.search) return options
    return options
      .map((option) => ({ option, score: fuzzy(needle, `${option.title} ${option.description ?? ""} ${option.category ?? ""}`) }))
      .filter((item) => item.score >= 0)
      .sort((a, b) => b.score - a.score)
      .map((item) => item.option)
  })

  const grouped = createMemo(() => {
    if (store.filter.trim() || props.flatten) return [["", filtered()]]
    const groups = new Map                           ()
    for (const option of filtered()) {
      const key = option.category ?? ""
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key) .push(option)
    }
    return [...groups.entries()]
  })
  const flat = createMemo(() => grouped().flatMap(([, options]) => options))
  const selected = createMemo(() => flat()[store.selected])
  const height = createMemo(() => Math.max(3, Math.floor(dimensions().height / 2) - 6))

  createEffect(
    on(
      () => store.filter,
      () => setStore("selected", 0),
      { defer: true },
    ),
  )

  // Start on the current value.
  createEffect(
    on(
      () => props.current,
      () => {
        if (props.current === undefined) return
        const index = flat().findIndex((option) => option.value === props.current)
        if (index >= 0) setStore("selected", index)
      },
    ),
  )

  function move(delta        ) {
    const count = flat().length
    if (!count) return
    const next = (store.selected + delta + count) % count
    setStore("selected", next)
    const option = flat()[next]
    if (option) props.onMove?.(option)
    scrollToSelected()
  }

  function scrollToSelected() {
    if (!scroll) return
    const option = flat()[store.selected]
    if (!option) return
    const target = scroll.getChildren().find((child) => child.id === optionId(option))
    if (!target) return
    const top = target.y - scroll.y
    if (top < 0) scroll.scrollBy(top)
    else if (top >= scroll.height) scroll.scrollBy(top - scroll.height + 1)
  }

  const optionId = (option                 ) => `dialog-option-${flat().indexOf(option)}`

  function choose(option                  ) {
    if (!option) return
    option.onSelect?.()
    props.onSelect?.(option)
  }

  useLayer({
    priority: 101,
    commands: () => [],
    handler: (event) => {
      if (matchesId(event, "dialog.select.prev")) {
        move(-1)
        return true
      }
      if (matchesId(event, "dialog.select.next")) {
        move(1)
        return true
      }
      if (matchesId(event, "dialog.select.page_up")) {
        move(-10)
        return true
      }
      if (matchesId(event, "dialog.select.page_down")) {
        move(10)
        return true
      }
      if (event.name === "return") {
        choose(selected())
        return true
      }
      for (const action of props.actions ?? []) {
        if (matchesId(event, action.keybind) || keyMatches(event, action.keybind)) {
          const option = selected()
          if (option) action.run(option)
          return true
        }
      }
      return false
    },
  })

  return (
    <box gap={1} paddingBottom={1}>
      <box paddingLeft={4} paddingRight={4}>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            {props.title}
          </text>
          <text fg={theme.textMuted} onMouseUp={() => dialog.pop()}>
            esc
          </text>
        </box>
        <Show when={props.filter !== false}>
          <box paddingTop={1}>
            <input
              onInput={(value        ) => {
                setStore("filter", value)
                props.search?.(value)
              }}
              focusedBackgroundColor={theme.backgroundPanel}
              cursorColor={theme.primary}
              focusedTextColor={theme.primary}
              textColor={theme.text}
              ref={(r                 ) => {
                input = r
                setTimeout(() => {
                  if (input && !input.isDestroyed) input.focus()
                }, 1)
              }}
              placeholder={props.placeholder ?? "Search"}
              placeholderColor={theme.textMuted}
            />
          </box>
        </Show>
      </box>
      <Show
        when={flat().length > 0}
        fallback={
          <box paddingLeft={4} paddingRight={4}>
            <text fg={theme.textMuted}>{store.filter ? "No results found" : (props.emptyText ?? "No items available")}</text>
          </box>
        }
      >
        <scrollbox
          paddingLeft={1}
          paddingRight={1}
          scrollbarOptions={{ visible: false }}
          ref={(r                     ) => (scroll = r)}
          maxHeight={height()}
        >
          <For each={grouped()}>
            {([category, options], index) => (
              <>
                <Show when={category}>
                  <box paddingTop={index() > 0 ? 1 : 0} paddingLeft={3}>
                    <text fg={theme.accent} attributes={TextAttributes.BOLD}>
                      {category}
                    </text>
                  </box>
                </Show>
                <For each={options}>
                  {(option) => {
                    const active = createMemo(() => selected() === option)
                    const current = createMemo(() => props.current !== undefined && option.value === props.current)
                    const fg = createMemo(() =>
                      active() ? theme.selectedListItemText : current() ? theme.primary : theme.text,
                    )
                    return (
                      <box
                        id={optionId(option)}
                        flexDirection="row"
                        paddingLeft={current() ? 1 : 3}
                        paddingRight={3}
                        gap={1}
                        backgroundColor={active() ? theme.primary : RGBA.fromInts(0, 0, 0, 0)}
                        onMouseMove={() => {
                          const i = flat().indexOf(option)
                          if (i >= 0 && i !== store.selected) setStore("selected", i)
                        }}
                        onMouseUp={() => choose(option)}
                      >
                        <Show when={current()}>
                          <text flexShrink={0} fg={fg()}>
                            ●
                          </text>
                        </Show>
                        <Show when={option.gutter}>{option.gutter}</Show>
                        <text
                          flexGrow={1}
                          fg={fg()}
                          attributes={active() ? TextAttributes.BOLD : undefined}
                          wrapMode="none"
                          overflow="hidden"
                        >
                          {truncate(option.title, 61)}
                          <Show when={option.description}>
                            <span style={{ fg: active() ? fg() : theme.textMuted }}>{" " + option.description}</span>
                          </Show>
                        </text>
                        <Show when={option.footer}>
                          <text flexShrink={0} fg={active() ? fg() : theme.textMuted}>
                            {option.footer}
                          </text>
                        </Show>
                      </box>
                    )
                  }}
                </For>
              </>
            )}
          </For>
        </scrollbox>
      </Show>
      <Show when={props.footer || props.actions?.length}>
        <box paddingRight={2} paddingLeft={4} flexDirection="row" gap={2} flexShrink={0}>
          {props.footer}
          <For each={props.actions ?? []}>
            {(action) => (
              <text fg={theme.text}>
                {shortcut(action.keybind) || action.keybind} <span style={{ fg: theme.textMuted }}>{action.label}</span>
              </text>
            )}
          </For>
        </box>
      </Show>
    </box>
  )
}

function keyMatches(event                                                   , key        ) {
  const parts = key.split("+")
  const name = parts.pop()
  return event.name === name && !!event.ctrl === parts.includes("ctrl") && !!event.shift === parts.includes("shift")
}

export function truncate(text        , width        ) {
  if (text.length <= width) return text
  return text.slice(0, Math.max(0, width - 1)) + "…"
}

// ---------------------------------------------------------------------------
// Simple prompt & confirm dialogs
// ---------------------------------------------------------------------------

export function DialogPrompt(props                                                                                             ) {
  let input
  useLayer({
    priority: 101,
    commands: () => [],
    handler: (event) => {
      if (event.name === "return") {
        props.onConfirm(input?.value ?? "")
        return true
      }
      return false
    },
  })
  return (
    <box gap={1} paddingBottom={1} paddingLeft={4} paddingRight={4}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          {props.title}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.pop()}>
          esc
        </text>
      </box>
      <input
        value={props.value ?? ""}
        placeholder={props.placeholder}
        placeholderColor={theme.textMuted}
        focusedBackgroundColor={theme.backgroundPanel}
        cursorColor={theme.primary}
        focusedTextColor={theme.primary}
        textColor={theme.text}
        ref={(r                 ) => {
          input = r
          setTimeout(() => !r.isDestroyed && r.focus(), 1)
        }}
      />
      <text fg={theme.text}>
        enter <span style={{ fg: theme.textMuted }}>confirm</span>
      </text>
    </box>
  )
}

export function DialogConfirm(props                                                                                  ) {
  const [state, setState] = createStore({ selected: "confirm"                         })
  const decide = (value                      ) => {
    if (value === "confirm") props.onConfirm()
    else if (props.onCancel) props.onCancel()
    else dialog.pop()
  }
  useLayer({
    priority: 101,
    commands: () => [],
    handler: (event) => {
      if (event.name === "left" || event.name === "right" || event.name === "tab") {
        setState("selected", state.selected === "confirm" ? "cancel" : "confirm")
        return true
      }
      if (event.name === "return") {
        decide(state.selected)
        return true
      }
      if (event.name === "y") {
        decide("confirm")
        return true
      }
      if (event.name === "n") {
        decide("cancel")
        return true
      }
      return false
    },
  })
  return (
    <box gap={1} paddingBottom={1} paddingLeft={4} paddingRight={4}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          {props.title}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.pop()}>
          esc
        </text>
      </box>
      <text fg={theme.textMuted} wrapMode="word">
        {props.message}
      </text>
      <box flexDirection="row" gap={1} justifyContent="flex-end">
        <For each={["cancel", "confirm"]         }>
          {(key) => (
            <box
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={state.selected === key ? theme.primary : undefined}
              onMouseUp={() => decide(key)}
            >
              <text fg={state.selected === key ? theme.selectedListItemText : theme.textMuted}>
                {key === "confirm" ? "Confirm" : "Cancel"}
              </text>
            </box>
          )}
        </For>
      </box>
    </box>
  )
}

export function DialogAlert(props                                    ) {
  return (
    <box gap={1} paddingBottom={1} paddingLeft={4} paddingRight={4}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          {props.title}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.pop()}>
          esc
        </text>
      </box>
      <text fg={theme.textMuted}>{props.message}</text>
    </box>
  )
}


