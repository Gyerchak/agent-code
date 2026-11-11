import { RGBA, TextAttributes } from "@opentui/core"
import { openCommand } from "../context/platform"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createResource, createSignal, For, Match, Show, Switch,          } from "solid-js"
import { spawn } from "node:child_process"
import { modsShows } from "../context/mods"

import { active, store } from "../context/tabs"
import { syntax, theme } from "../context/theme"
import { DiffView, filetype } from "../routes/tools"
import { SplitBorder } from "../ui/border"

// Claude Code mods, drawn by Agent Code: the engine runs each mod's `ui.render` hooks for the `desktop`
// surface and answers a plain tree (Box, Text, Button, Input, Select, Link, Code, Markdown, Svg, …),
// which this file draws with OpenTUI. Presses, edits and picks go back as ui_press / ui_input / ui_select.




const NAMED                             = {
  red: () => theme.error,
  green: () => theme.success,
  yellow: () => theme.warning,
  blue: () => theme.secondary,
  magenta: () => theme.accent,
  cyan: () => theme.info,
  white: () => theme.text,
  black: () => theme.background,
  gray: () => theme.textMuted,
  grey: () => theme.textMuted,
  // Claude Code's theme names, as mods written for its terminal use them.
  claude: () => theme.primary,
  permission: () => theme.secondary,
  suggestion: () => theme.accent,
  subtle: () => theme.textMuted,
  inactive: () => theme.textMuted,
  secondaryText: () => theme.textMuted,
}

function color(value         )                   {
  if (typeof value !== "string" || !value) return undefined
  if (/^#[0-9a-f]{3,8}$/i.test(value)) return RGBA.fromHex(value)
  const rgb = value.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/)
  if (rgb) return RGBA.fromInts(Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), 255)
  const key = value.replace(/^ansi:/, "").replace(/Bright$/, "").replace(/_.*$/, "")
  if (NAMED[key]) return NAMED[key]()
  const own = (theme       )[key]
  return own instanceof RGBA ? own : undefined
}

const STEP                         = { xs: 0, sm: 1, md: 1, lg: 2, xl: 3 }
const cells = (value         ) => (typeof value === "string" && value in STEP ? STEP[value] : value)
const BORDER                         = { round: "rounded", bold: "heavy", double: "double", single: "single" }

/** Box props the engine allows, translated to OpenTUI's. */
function boxProps(props                      = {}) {
  const out                      = {}
  for (const key of [
    "flexDirection",
    "flexGrow",
    "flexShrink",
    "flexWrap",
    "flexBasis",
    "alignItems",
    "alignSelf",
    "justifyContent",
    "width",
    "height",
    "minWidth",
    "maxWidth",
    "minHeight",
    "maxHeight",
    "position",
    "top",
    "left",
    "right",
    "bottom",
  ])
    if (props[key] !== undefined) out[key] = props[key]
  for (const key of ["gap", "padding", "paddingTop", "paddingBottom", "paddingLeft", "paddingRight", "margin", "marginTop", "marginBottom", "marginLeft", "marginRight"])
    if (props[key] !== undefined) out[key] = cells(props[key])
  if (props.paddingX !== undefined) out.paddingLeft = out.paddingRight = cells(props.paddingX)
  if (props.paddingY !== undefined) out.paddingTop = out.paddingBottom = cells(props.paddingY)
  if (props.marginX !== undefined) out.marginLeft = out.marginRight = cells(props.marginX)
  if (props.marginY !== undefined) out.marginTop = out.marginBottom = cells(props.marginY)
  if (props.columnGap !== undefined || props.rowGap !== undefined) out.gap = cells(props.columnGap ?? props.rowGap)
  const background = color(props.backgroundColor)
  if (background) out.backgroundColor = background
  if (props.borderStyle && BORDER[props.borderStyle] !== undefined) {
    out.border = true
    out.borderStyle = BORDER[props.borderStyle]
    out.borderColor = color(props.borderColor) ?? theme.border
  } else if (props.borderStyle) {
    out.border = true
    out.borderColor = color(props.borderColor) ?? theme.border
  }
  return out
}



/** Text and its nested Text/span/b as flat styled runs. */
function runs(node               , inherited                    = {})        {
  if (typeof node === "string") return [{ text: node, ...inherited }]
  const props = node.props ?? {}
  const style                    = {
    ...inherited,
    fg: color(props.color) ?? inherited.fg,
    bg: color(props.backgroundColor) ?? inherited.bg,
    bold: props.bold || node.type === "b" || props.weight === "bold" || props.weight === "semibold" || inherited.bold,
    italic: props.italic || inherited.italic,
    underline: props.underline || inherited.underline,
    dim: props.dimColor || inherited.dim,
    strikethrough: props.strikethrough || inherited.strikethrough,
  }
  if (props.inverse) [style.fg, style.bg] = [style.bg ?? theme.background, style.fg ?? theme.text]
  return (node.children ?? []).flatMap((child) => runs(child, style))
}

function RunsText(props                                                      ) {
  return (
    <text fg={theme.text} wrapMode={props.wrap === "truncate" || props.wrap === "truncate-end" ? "none" : "word"} onMouseUp={() => props.onPress?.()}>
      <For each={props.runs}>
        {(run) => (
          <span
            style={{
              fg: run.dim ? theme.textMuted : (run.fg ?? theme.text),
              bg: run.bg,
              bold: run.bold,
              italic: run.italic,
              underline: run.underline,
              ...(run.strikethrough ? { attributes: TextAttributes.STRIKETHROUGH } : {}),
            }}
          >
            {run.text}
          </span>
        )}
      </For>
    </text>
  )
}

function openURL(url        ) {
  try {
    const [command, args] = openCommand(url)
    spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true }).unref()
  } catch {}
}

function ModInput(props                                              ) {
  let timer
  const p = () => props.node.props ?? {}
  const at = () => ({ key: p().key, component: props.site.component, instanceId: props.site.instanceId })
  return (
    <box flexDirection="row" gap={1} flexShrink={0}>
      <Show when={p().label}>
        <text fg={theme.textMuted}>{p().label}</text>
      </Show>
      <input
        flexGrow={1}
        value={p().value ?? ""}
        placeholder={p().placeholder ?? ""}
        backgroundColor={theme.backgroundElement}
        focusedBackgroundColor={theme.backgroundElement}
        textColor={theme.text}
        onMouseDown={(event     ) => event.target?.focus?.()}
        onInput={(value        ) => {
          clearTimeout(timer)
          timer = setTimeout(() => props.node.press && void props.session.modInput(props.node.press, "change", value, at()), 150)
        }}
        // An input's submit passes its value (the JSX type also allows a DOM SubmitEvent).
        onSubmit={
          ((value        ) => {
            clearTimeout(timer)
            if (props.node.press) void props.session.modInput(props.node.press, "submit", value, at())
          })
        }
      />
      <Show when={p().submitLabel}>
        <text fg={theme.textMuted}>↵ {p().submitLabel}</text>
      </Show>
    </box>
  )
}

/** One element of a mod's tree. */
function ModNode(props                                                       )              {
  const node = () => props.node
  const n = () => node()
  const p = () => n().props ?? {}
  return (
    <Switch fallback={null}>
      <Match when={typeof node() === "string"}>
        <text fg={theme.text}>{node()          }</text>
      </Match>
      <Match when={p().display === "none"}>{null}</Match>
      <Match when={n().type === "Box" || n().type === "div"}>
        <box {...boxProps(p())} flexShrink={p().flexShrink ?? 0}>
          <For each={n().children ?? []}>{(child) => <ModNode node={child} site={props.site} session={props.session} />}</For>
        </box>
      </Match>
      <Match when={n().type === "Text" || n().type === "span" || n().type === "b"}>
        <RunsText runs={runs(n())} wrap={p().wrap} />
      </Match>
      <Match when={n().type === "Button"}>
        {(() => {
          const press = () => n().press && void props.session.modPress(n().press , p().key)
          const label = ()        => (n().children?.length ? runs({ type: "Text", children: n().children }) : [{ text: String(p().label ?? "") }])
          const fg = () => (p().variant === "primary" ? theme.primary : p().dimColor ? theme.textMuted : theme.text)
          return (
            <RunsText
              onPress={press}
              runs={
                p().plain
                  ? [...(p().hotkey ? [{ text: `${p().hotkey}: `, fg: theme.textMuted }] : []), ...label().map((run) => ({ ...run, fg: run.fg ?? fg() }))]
                  : [{ text: "[ ", fg: fg() }, ...label().map((run) => ({ ...run, fg: run.fg ?? fg() })), { text: " ]", fg: fg() }]
              }
            />
          )
        })()}
      </Match>
      <Match when={n().type === "Input"}>
        <ModInput node={n()} site={props.site} session={props.session} />
      </Match>
      <Match when={n().type === "Select"}>
        <box flexDirection="row" flexWrap="wrap" gap={1} flexShrink={0}>
          <Show when={p().label}>
            <text fg={theme.textMuted}>{p().label}</text>
          </Show>
          <For each={(p().options ?? [])                                       }>
            {(option) => (
              <text
                fg={option.value === p().value ? theme.primary : theme.text}
                onMouseUp={() =>
                  n().press && void props.session.modSelect(n().press , option.value, { key: p().key, component: props.site.component, instanceId: props.site.instanceId })
                }
              >
                {option.value === p().value ? "● " : "○ "}
                {option.label ?? option.value}
              </text>
            )}
          </For>
        </box>
      </Match>
      <Match when={n().type === "Link"}>
        <RunsText
          runs={(n().children?.length ? runs(n()) : [{ text: String(p().label ?? p().href ?? "") }]).map((run) => ({ ...run, fg: theme.secondary, underline: true }))}
          onPress={() => (n().press ? void props.session.modPress(n().press , p().key, p().href) : openURL(String(p().href)))}
        />
      </Match>
      <Match when={n().type === "Code"}>
        <Show
          when={p().format === "diff"}
          fallback={
            <code
              filetype={p().language ?? filetype(p().path)}
              content={String(p().source ?? "")}
              syntaxStyle={syntax()}
              drawUnstyledText={true}
              fg={theme.text}
            />
          }
        >
          <DiffView patch={String(p().source ?? "")} file={p().path} />
        </Show>
      </Match>
      <Match when={n().type === "Markdown"}>
        <markdown
          syntaxStyle={syntax()}
          content={String(p().text ?? "")}
          fg={p().dimColor ? theme.textMuted : theme.markdownText}
          bg={theme.background}
          conceal={true}
        />
      </Match>
      <Match when={n().type === "Svg"}>
        <text fg={theme.textMuted}>▣ {String(p().alt ?? "image")}</text>
      </Match>
      <Match when={n().type === "Client"}>
        <text fg={theme.textMuted}>(an interactive region of this mod that Agent Code can't run)</text>
      </Match>
    </Switch>
  )
}

/** Ask the engine for one site's tree and draw it; nothing while no mod draws there. */
function ModSite(props                                                ) {
  const session = active()
  const [drawn] = createResource(
    () => (store.mods.attached ? { version: store.mods.version, key: JSON.stringify(props.props), site: props.site.instanceId } : undefined),
    () => session.modRender(props.site.component, props.site.instanceId, props.props),
  )
  const tree = () => {
    const result = drawn.latest
    if (!result?.hooked || !result.tree || result.tree.type === "engine") return undefined
    return result.tree
  }
  return (
    <Show when={tree()}>
      {(root            ) => <ModNode node={root()} site={props.site} session={session} />}
    </Show>
  )
}

const scroll = (rows        ) => ({ offset: 0, bodyRows: rows })

/** The band above the prompt (a mod's `AbovePrompt` drawing). */
export function ModBand(props                     ) {
  return (
    <Show when={store.mods.attached && modsShows("band")}>
      <box flexShrink={0} maxHeight={12} overflow="hidden">
        <ModSite
          site={{ component: "AbovePrompt", instanceId: "above-prompt" }}
          props={{ hasSurvey: false, isWorking: store.status === "running", maxRows: 12, bodyColumns: Math.max(10, props.columns - 5), scroll: scroll(11), view: {} }}
        />
      </box>
    </Show>
  )
}

/** The status lines mods pin under the prompt, one per mod. */
export function ModStatus() {
  const lines = createMemo(() => (modsShows("status") ? Object.entries(store.mods.status) : []))
  return (
    <Show when={lines().length}>
      <box flexShrink={0} paddingLeft={2}>
        <For each={lines()}>
          {([plugin, text]) => (
            <text fg={theme.textMuted} wrapMode="none">
              <span style={{ fg: theme.accent }}>{plugin}</span> {text}
            </text>
          )}
        </For>
      </box>
    </Show>
  )
}

export function modPanesVisible() {
  return store.mods.attached && modsShows("panes") && store.mods.panes.length > 0
}

/** Mods' panes: tabs when several, the shown one's body, a close mark. Docked beside the transcript or inline. */
export function ModPanes(props                                                   ) {
  const session = active()
  const dimensions = useTerminalDimensions()
  const [focused] = createSignal(false)
  const shown = createMemo(() => store.mods.panes.find((pane) => pane.id === store.mods.shown) ?? store.mods.panes.at(-1))
  const bodyRows = () => (props.placement === "dock" ? Math.max(5, dimensions().height - 6) : 12)
  return (
    <Show when={shown()}>
      {(pane                                         ) => (
        <box
          flexShrink={0}
          flexDirection="column"
          border={["left"]}
          customBorderChars={SplitBorder.customBorderChars}
          borderColor={theme.borderActive}
          backgroundColor={theme.backgroundPanel}
          maxHeight={props.placement === "inline" ? 16 : undefined}
          height={props.placement === "dock" ? "100%" : undefined}
          marginBottom={props.placement === "inline" ? 1 : 0}
        >
          <box flexDirection="row" paddingLeft={1} paddingRight={1} flexShrink={0} justifyContent="space-between">
            <box flexDirection="row" gap={2} flexShrink={1}>
              <For each={store.mods.panes}>
                {(item) => (
                  <text
                    fg={item.id === pane().id ? theme.text : theme.textMuted}
                    attributes={item.id === pane().id ? TextAttributes.BOLD : 0}
                    wrapMode="none"
                    onMouseUp={() => void session.modPaneShow(item.id)}
                  >
                    {item.title}
                  </text>
                )}
              </For>
            </box>
            <text fg={theme.textMuted} onMouseUp={() => void session.modPaneClose(pane().id)}>
              ✕
            </text>
          </box>
          {(() => {
            const body = () => (
              <ModSite
                site={{ component: "Pane", instanceId: pane().id }}
                props={{
                  title: pane().title,
                  isFocused: focused(),
                  bodyColumns: Math.max(10, props.columns - 4),
                  placement: props.placement,
                  scroll: scroll(bodyRows()),
                  view: {},
                }}
              />
            )
            return (
              <Show
                when={props.placement === "dock"}
                fallback={
                  <box paddingLeft={1} paddingRight={1} paddingTop={1} paddingBottom={1} flexShrink={0}>
                    {body()}
                  </box>
                }
              >
                <scrollbox flexGrow={1} paddingLeft={1} paddingRight={1} paddingTop={1}>
                  {body()}
                </scrollbox>
              </Show>
            )
          })()}
        </box>
      )}
    </Show>
  )
}
