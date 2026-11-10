import { RGBA, TextAttributes } from "@opentui/core"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, Match, on, Show, Switch } from "solid-js"
import { actions, refs, SIDEBAR_DOCK_WIDTH, setSidebarOpen, showScrollbar, showThinking, sidebarShown } from "../context/app"
import { shortcut } from "../context/keymap"
import { dialog } from "../ui/dialog"
import { active, store } from "../context/tabs"
import {
  agentIndex,
  isSubagentTool,
  prettyModel,
} from "../context/session"
import { agentColor, alpha, mutedSyntax, syntax, theme } from "../context/theme"
import { Prompt } from "../component/prompt"
import { Spinner } from "../component/spinner"
import { SplitBorder } from "../ui/border"
import { ShellDisplay, ToolView } from "./tools"
import { AttachmentPreview } from "../component/attachment"
import { ModBand, ModPanes, ModStatus, modPanesVisible } from "../component/mods"
import { GoalStatus } from "../component/goal"
import { Sidebar, SIDEBAR_WIDTH } from "./sidebar"
import { ElicitationPrompt, PermissionPrompt, QuestionPrompt } from "./permission"
import { Slot } from "../plugin/slots"

export function duration(ms        ) {
  if (ms < 1000) return `${ms}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${Math.round(seconds % 60)}s`
}

/** Subagent (Task/Agent) tool calls of the transcript, in order. */
/** Kinds of work shown in Tasks, in display order. */
export const TASK_KINDS = [
  { id: "subagent", title: "Subagents" },
  { id: "remote", title: "Remote agents" },
  { id: "shell", title: "Shell processes" },
  { id: "terminal", title: "Terminals (! commands)" },
  { id: "monitor", title: "Monitors" },
  { id: "workflow", title: "Workflows" },
  { id: "other", title: "Other tasks" },
]















function kindOf(type                    )           {
  const value = (type ?? "").toLowerCase()
  if (/remote/.test(value)) return "remote"
  if (/bash|shell|command/.test(value)) return "shell"
  if (/monitor|watch/.test(value)) return "monitor"
  if (/workflow/.test(value)) return "workflow"
  if (/terminal|pty/.test(value)) return "terminal"
  if (/agent/.test(value)) return "subagent"
  return "other"
}

/** Every task of the focused tab, classified: subagents, shells, terminals, monitors, … */
export function taskEntries()              {
  const agents = subagentParts()
  const isRunning = (part          ) => part.status === "running" || part.status === "pending" || !!part.background
  const out              = agents.map((part) => ({
    kind: /remote/i.test(String(part.input?.subagent_type ?? "")) ? "remote" : "subagent",
    key: `agent:${part.id}`,
    title: subagentTitle(part),
    running: isRunning(part),
    failed: part.status === "error",
    detail: isRunning(part) ? part.childTitle?.slice(0, 30) : part.children ? `${part.children} tools` : undefined,
    part: part.id,
  }))
  for (const [id, task] of Object.entries(store.tasks)) {
    if (task.toolUseId && agents.some((part) => part.id === task.toolUseId)) continue
    out.push({ kind: kindOf(task.type), key: `task:${id}`, title: task.description, running: true, detail: task.type, task: id })
  }
  for (const message of store.messages)
    if (message.type === "shell" && message.running)
      out.push({ kind: "terminal", key: `shell:${message.id}`, title: `! ${message.command}`, running: true })
  return out
}

export function subagentParts()             {
  const out             = []
  for (const message of store.messages) {
    if (message.type !== "assistant") continue
    for (const part of message.parts) if (part.type === "tool" && isSubagentTool(part.name)) out.push(part)
  }
  return out
}

export function titlecase(text        ) {
  return text
    .split(/[-_\s]/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ")
}

export function subagentTitle(part          ) {
  const type = titlecase(typeof part.input.subagent_type === "string" ? part.input.subagent_type : "General")
  return `${type} Subagent — ${part.input.description ?? ""}`
}

/** Subagent result text without Claude Code's hand-back framing and trailing agent id. */
export function subagentResult(output        ) {
  let text = output.replace(/agentId:[\s\S]*$/, "")
  const marker = text.indexOf("The report follows:")
  if (marker >= 0) {
    text = text
      .slice(marker + "The report follows:".length)
      .split("\n")
      .map((line) => line.replace(/^ {2}/, ""))
      .join("\n")
  }
  return text.replace(/<usage>[\s\S]*?<\/usage>/g, "").trim()
}

export function openChild(id                    ) {
  const session = active()
  session.setStore("child", id)
  if (id) session.setStore("view", "session")
}

export function cycleChild(direction        ) {
  const list = subagentParts()
  if (!list.length) return
  const index = list.findIndex((part) => part.id === store.child)
  const next = index < 0 ? (direction === 1 ? 0 : list.length - 1) : (index + direction + list.length) % list.length
  openChild(list[next].id)
}

const MOD_PANE_WIDTH = 46
/**
 * Messages drawn at once. Every drawn message stays a live renderable that the renderer re-styles on each
 * frame (syntax highlighting), so a day-long transcript made occ crawl. Older ones load when scrolled to.
 */
const TRANSCRIPT_WINDOW = 60

export function Session() {
  const dimensions = useTerminalDimensions()
  const wide = createMemo(() => dimensions().width > SIDEBAR_DOCK_WIDTH)
  const sidebarVisible = createMemo(() => sidebarShown(dimensions().width))
  const [awayFromBottom, setAwayFromBottom] = createSignal(false)
  let scroll
  const childPart = createMemo(() => (store.child ? active().findToolPart(store.child) : undefined))
  const transcript = createMemo(() => (store.child ? (store.children[store.child] ?? []) : store.messages))
  // Only the newest messages are drawn (see TRANSCRIPT_WINDOW); scrolling to the top draws more.
  const [shown, setShown] = createSignal(TRANSCRIPT_WINDOW)
  const windowStart = createMemo(() => Math.max(0, transcript().length - shown()))
  const windowed = createMemo(() => transcript().slice(windowStart()))
  createEffect(on([() => store.child, () => store.sessionID], () => setShown(TRANSCRIPT_WINDOW), { defer: true }))
  // Jumping to a message: draw history back to it first if it is older than the drawn window.
  actions.reveal = (id        , highlight = false) => {
    const index = transcript().findIndex((m) => m.id === id)
    if (index >= 0 && index < windowStart()) setShown(transcript().length - index + 5)
    setTimeout(() => refs.scroll?.scrollChildIntoView(`msg-${id}`), 0)
    // A found message lights up for a moment, like a match in a text editor.
    if (highlight) {
      setHighlighted(id)
      setTimeout(() => highlighted() === id && setHighlighted(undefined), 2500)
    }
  }
  const showEarlier = () => {
    if (!windowStart()) return
    const before = scroll ? scroll.scrollHeight - scroll.scrollTop : 0
    setShown((count) => count + TRANSCRIPT_WINDOW)
    // Keep what was on screen in place while the earlier messages appear above it.
    setTimeout(() => {
      if (scroll) scroll.scrollTop = Math.max(0, scroll.scrollHeight - before)
    }, 0)
  }
  /** Cells across the transcript column (what a mod's band is laid out in). */
  const mainColumns = createMemo(
    () =>
      dimensions().width -
      (sidebarVisible() && wide() ? SIDEBAR_WIDTH : 0) -
      (modPanesVisible() && wide() && dimensions().width >= 120 ? MOD_PANE_WIDTH : 0) -
      (dimensions().width < 44 ? 2 : 4),
  )
  // opencode's revert: the reverted prompt becomes a banner and everything after it is hidden.
  const revertIndex = createMemo(() => {
    const point = store.revert?.messageID
    return point && !store.child ? store.messages.findIndex((m) => m.id === point) : -1
  })

  const updateAway = () => {
    if (!scroll) return
    const away = scroll.scrollTop + scroll.viewport.height < scroll.scrollHeight - 2
    setAwayFromBottom(away)
    if (scroll.scrollTop <= 0 && windowStart() > 0) showEarlier()
    // Back at the bottom: draw only the newest messages again.
    else if (!away && shown() > TRANSCRIPT_WINDOW) setShown(TRANSCRIPT_WINDOW)
  }

  return (
    <box flexDirection="row" flexGrow={1} minHeight={0}>
      <box flexGrow={1} minHeight={0} paddingBottom={1} paddingLeft={dimensions().width < 44 ? 1 : 2} paddingRight={dimensions().width < 44 ? 1 : 2}>
        <box flexGrow={1} minHeight={0} position="relative">
          <scrollbox
            ref={(r                     ) => {
              scroll = r
              refs.scroll = r
              r.verticalScrollBar.on("change", updateAway)
            }}
            viewportOptions={{ paddingRight: showScrollbar() ? 1 : 0 }}
            verticalScrollbarOptions={{
              paddingLeft: 1,
              visible: showScrollbar(),
              trackOptions: { backgroundColor: theme.backgroundElement, foregroundColor: theme.border },
            }}
            stickyScroll={true}
            stickyStart="bottom"
            flexGrow={1}
            onMouseScroll={updateAway}
          >
            <Show when={childPart()}>
              {(part                ) => <ChildHeader part={part()} />}
            </Show>
            <Show when={windowStart() > 0}>
              <box flexShrink={0} paddingBottom={1} onMouseUp={() => showEarlier()}>
                <text fg={theme.textMuted}>
                  ▲ {windowStart()} earlier message{windowStart() === 1 ? "" : "s"} · scroll up or click to show
                </text>
              </box>
            </Show>
            <For each={windowed()}>
              {(message, index) => (
                <Switch>
                  <Match when={revertIndex() >= 0 && index() + windowStart() === revertIndex()}>
                    <RevertBanner />
                  </Match>
                  <Match when={revertIndex() >= 0 && index() + windowStart() > revertIndex()}>
                    <></>
                  </Match>
                  <Match when={true}>
                    <MessageView message={message} />
                  </Match>
                </Switch>
              )}
            </For>
            <Show when={childPart() && childPart() .status === "completed" && childPart() .output}>
              <box marginTop={1} paddingLeft={3} flexShrink={0}>
                <box border={["left"]} customBorderChars={SplitBorder.customBorderChars} borderColor={theme.success} paddingLeft={2}>
                  <text fg={theme.textMuted}>Result</text>
                  <markdown
                    syntaxStyle={syntax()}
                    content={subagentResult(childPart() .output )}
                    fg={theme.markdownText}
                    bg={theme.background}
                    conceal={true}
                  />
                </box>
              </box>
            </Show>
            <Show when={!store.child && store.compacting}>
              <box marginTop={1}>
                <Divider color={theme.textMuted} label="Compacting" spinner />
              </box>
            </Show>
          </scrollbox>
        </box>
        <box height={1} flexShrink={0} flexDirection="row" justifyContent="flex-end">
          <Show when={awayFromBottom()}>
            <box
              paddingLeft={1}
              onMouseUp={() => {
                scroll?.scrollTo(scroll.scrollHeight)
                setAwayFromBottom(false)
              }}
            >
              <text fg={theme.textMuted}>Jump to latest ↓</text>
            </box>
          </Show>
        </box>
        <box flexShrink={0}>
          <Switch>
            <Match when={store.questions[0]}>{(request           ) => <QuestionPrompt request={request()} />}</Match>
            <Match when={store.elicitations[0]}>{(entry           ) => <ElicitationPrompt entry={entry()} />}</Match>
            <Match when={store.permissions[0]}>{(request           ) => <PermissionPrompt request={request()} />}</Match>
            <Match when={childPart()}>
              {(part                ) => <SubagentFooter part={part()} />}
            </Match>
            <Match when={true}>
              <Show when={modPanesVisible() && !(wide() && dimensions().width >= 120)}>
                <ModPanes placement="inline" columns={mainColumns()} />
              </Show>
              <ModBand columns={mainColumns()} />
              <Slot name="session_prompt" mode="replace" session_id={store.sessionID ?? ""}>
                <Prompt right={<Slot name="session_prompt_right" session_id={store.sessionID ?? ""} />} />
              </Slot>
              <ModStatus />
              <GoalStatus />
            </Match>
          </Switch>
        </box>
      </box>
      <Show when={modPanesVisible() && wide() && dimensions().width >= 120}>
        <box flexShrink={0} width={MOD_PANE_WIDTH} paddingBottom={1}>
          <ModPanes placement="dock" columns={MOD_PANE_WIDTH} />
        </box>
      </Show>
      <Show when={sidebarVisible() && wide()}>
        <box flexShrink={0} width={SIDEBAR_WIDTH}>
          <Sidebar />
        </box>
      </Show>
      <Show when={sidebarVisible() && !wide()}>
        <box
          position="absolute"
          top={0}
          left={0}
          right={0}
          bottom={0}
          alignItems="flex-end"
          backgroundColor={RGBA.fromInts(0, 0, 0, 70)}
          onMouseUp={() => setSidebarOpen(false)}
        >
          <Sidebar />
        </box>
      </Show>
    </box>
  )
}

function ChildHeader(props                    ) {
  return (
    <box marginTop={1} flexShrink={0} border={["left"]} customBorderChars={SplitBorder.customBorderChars} borderColor={theme.secondary}>
      <box paddingLeft={2} paddingTop={1} paddingBottom={1} backgroundColor={theme.backgroundPanel}>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          {subagentTitle(props.part)}
        </text>
        <text fg={theme.textMuted}>
          {props.part.status === "running" || props.part.status === "pending" || props.part.background ? "running" : props.part.status}
          {props.part.children ? ` · ${props.part.children} tool${props.part.children === 1 ? "" : "s"}` : ""}
        </text>
      </box>
    </box>
  )
}

/** Footer shown instead of the prompt while viewing a subagent (port of opencode's subagent-footer). */
function SubagentFooter(props                    ) {
  const list = createMemo(() => subagentParts())
  const index = createMemo(() => list().findIndex((part) => part.id === props.part.id))
  const running = () => props.part.status === "running" || props.part.status === "pending" || !!props.part.background
  return (
    <box border={["left"]} borderColor={theme.secondary} customBorderChars={SplitBorder.customBorderChars}>
      <box paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1} backgroundColor={theme.backgroundElement} gap={1}>
        <box flexDirection="row" gap={1}>
          <Show when={running()} fallback={<text fg={props.part.status === "error" ? theme.error : theme.success}>{props.part.status === "error" ? "✗" : "✓"}</text>}>
            <Spinner color={theme.secondary} />
          </Show>
          <text fg={theme.text} wrapMode="none" truncate flexShrink={1}>
            {subagentTitle(props.part)}
          </text>
          <text fg={theme.textMuted} flexShrink={0}>
            {index() + 1}/{list().length}
          </text>
        </box>
        <box flexDirection="row" gap={3}>
          <text fg={theme.text} onMouseUp={() => openChild(undefined)}>
            {shortcut("session.parent")} <span style={{ fg: theme.textMuted }}>Parent</span>
          </text>
          <Show when={list().length > 1}>
            <text fg={theme.text} onMouseUp={() => cycleChild(-1)}>
              {shortcut("session.child.prev")} <span style={{ fg: theme.textMuted }}>Prev</span>
            </text>
            <text fg={theme.text} onMouseUp={() => cycleChild(1)}>
              {shortcut("session.child.next")} <span style={{ fg: theme.textMuted }}>Next</span>
            </text>
          </Show>
        </box>
      </box>
    </box>
  )
}

/** Port of opencode's reverted-messages banner: click (or /redo) to bring them back. */
function RevertBanner() {
  const [hover, setHover] = createSignal(false)
  const reverted = createMemo(() => {
    const index = store.messages.findIndex((m) => m.id === store.revert?.messageID)
    return index < 0 ? 0 : store.messages.slice(index).filter((m) => m.type === "user").length
  })
  return (
    <box
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={() => actions.redo()}
      marginTop={1}
      flexShrink={0}
      border={["left"]}
      customBorderChars={SplitBorder.customBorderChars}
      borderColor={theme.backgroundPanel}
    >
      <box paddingTop={1} paddingBottom={1} paddingLeft={2} backgroundColor={hover() ? theme.backgroundElement : theme.backgroundPanel}>
        <text fg={theme.textMuted}>{reverted()} message reverted</text>
        <text fg={theme.textMuted}>
          <span style={{ fg: theme.text }}>{shortcut("session.redo")}</span> or /redo to restore
        </text>
        <Show when={store.revert?.files.length}>
          <box marginTop={1}>
            <For each={store.revert?.files ?? []}>
              {(file) => (
                <text fg={theme.text}>
                  {file.file}
                  <Show when={file.additions > 0}>
                    <span style={{ fg: theme.diffAdded }}> +{file.additions}</span>
                  </Show>
                  <Show when={file.deletions > 0}>
                    <span style={{ fg: theme.diffRemoved }}> -{file.deletions}</span>
                  </Show>
                </text>
              )}
            </For>
          </box>
        </Show>
      </box>
    </box>
  )
}

function Divider(props                                                   ) {
  return (
    <box flexDirection="row" alignItems="center">
      <box border={["top"]} borderColor={props.color} flexGrow={1} />
      <box flexDirection="row" gap={1} paddingLeft={1} paddingRight={1}>
        <Show when={props.spinner} fallback={<text fg={props.color}>◇</text>}>
          <Spinner color={props.color} />
        </Show>
        <text fg={props.color}>{props.label}</text>
      </box>
      <box border={["top"]} borderColor={props.color} flexGrow={1} />
    </box>
  )
}

/** The message a search jumped to (shown highlighted for a moment). */
const [highlighted, setHighlighted] = createSignal()

function MessageView(props                      ) {
  return (
    <Switch>
      <Match when={props.message.type === "user"}>
        <box marginTop={1} flexShrink={0} id={`msg-${props.message.id}`} backgroundColor={highlighted() === props.message.id ? theme.accent : undefined}>
          <UserMessageView message={props.message               } />
        </box>
      </Match>
      <Match when={props.message.type === "assistant"}>
        <box flexShrink={0} id={`msg-${props.message.id}`} backgroundColor={highlighted() === props.message.id ? theme.backgroundElement : undefined}>
          <AssistantView message={props.message                    } />
        </box>
      </Match>
      <Match when={props.message.type === "notice"}>
        <box marginTop={1} flexShrink={0}>
          <NoticeView message={props.message                 } />
        </box>
      </Match>
      <Match when={props.message.type === "shell"}>
        <box marginTop={1} flexShrink={0}>
          <ShellMessageView message={props.message                } />
        </box>
      </Match>
    </Switch>
  )
}

/** The prompt's text split around what was pasted collapsed, so each paste can show as its placeholder. */
function pasteSegments(text        , pastes           = [])                                     {
  let segments                                     = [{ text }]
  for (const paste of pastes) {
    if (!paste.trim()) continue
    const next                  = []
    let done = false
    for (const segment of segments) {
      const at = done || segment.paste !== undefined ? -1 : segment.text.indexOf(paste)
      if (at < 0) {
        next.push(segment)
        continue
      }
      done = true
      next.push({ text: segment.text.slice(0, at) }, { text: "", paste }, { text: segment.text.slice(at + paste.length) })
    }
    segments = next
  }
  return segments.filter((segment) => segment.paste !== undefined || segment.text)
}

/** A pasted block, collapsed to "[Pasted ~N lines]" like in the prompt; a click expands or collapses it. */
function PasteBlock(props                  ) {
  const renderer = useRenderer()
  const [open, setOpen] = createSignal(false)
  const lines = () => props.text.split("\n").length
  return (
    <box
      flexShrink={0}
      onMouseUp={(event            ) => {
        // The message's own click opens its actions; a click here only folds the paste.
        event.stopPropagation()
        if (renderer.getSelection()?.getSelectedText()) return
        setOpen((value) => !value)
      }}
    >
      <text fg={theme.text} wrapMode="none">
        {/* The same highlighted chip as in the prompt (opencode's "extmark.paste" look). */}
        <span style={{ bg: theme.warning, fg: theme.background, bold: true }}>[Pasted ~{lines()} lines]</span>
        <span style={{ fg: theme.textMuted }}> {open() ? "▾ click to collapse" : "▸ click to expand"}</span>
      </text>
      <Show when={open()}>
        <box marginTop={1} paddingLeft={1} border={["left"]} customBorderChars={SplitBorder.customBorderChars} borderColor={theme.border}>
          <text fg={theme.text}>{props.text}</text>
        </box>
      </Show>
    </box>
  )
}

function UserMessageView(props                          ) {
  const renderer = useRenderer()
  const [hover, setHover] = createSignal(false)
  const color = createMemo(() => agentColor(agentIndex(store.mode === "plan" ? "plan" : "build")))
  return (
    <Show when={props.message.text.trim() || props.message.attachments?.length}>
      <box
        border={["left"]}
        borderColor={props.message.queued ? theme.border : color()}
        customBorderChars={SplitBorder.customBorderChars}
        backgroundColor={theme.backgroundPanel}
      >
        <box
          onMouseOver={() => setHover(true)}
          onMouseOut={() => setHover(false)}
          onMouseUp={() => {
            // Like opencode: a click opens the message actions, unless it ended a text selection.
            // Queued (not yet delivered) messages open it too, with the actions that apply to them.
            if (renderer.getSelection()?.getSelectedText() || store.child || dialog.open) return
            actions.message(props.message.id)
          }}
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={2}
          backgroundColor={hover() ? theme.backgroundElement : theme.backgroundPanel}
          flexShrink={0}
        >
          <Show when={props.message.text.trim()}>
            <For each={pasteSegments(props.message.text, props.message.pastes)}>
              {(segment) => (
                <Show when={segment.paste !== undefined} fallback={<Show when={segment.text.trim()}><text fg={theme.text}>{segment.text.replace(/^\n+|\n+$/g, "")}</text></Show>}>
                  <PasteBlock text={segment.paste } />
                </Show>
              )}
            </For>
          </Show>
          <Show when={props.message.attachments?.length}>
            <box flexDirection="column" gap={1} paddingTop={props.message.text.trim() ? 1 : 0}>
              <For each={props.message.attachments ?? []}>{(item) => <AttachmentPreview item={item} />}</For>
            </box>
          </Show>
          <Show when={props.message.files.length || props.message.queued}>
            <box flexDirection="row" paddingTop={1} gap={1} flexWrap="wrap">
              <Show when={props.message.queued}>
                <text fg={theme.background}>
                  <span style={{ bg: theme.warning, fg: theme.background, bold: true }}> QUEUED </span>
                </text>
              </Show>
              <For each={props.message.files}>
                {(file) => (
                  <text fg={theme.text}>
                    <span style={{ bg: theme.accent, fg: theme.backgroundPanel, bold: true }}>
                      {file.endsWith("/") ? " dir " : " file "}
                    </span>
                    <span style={{ bg: theme.backgroundElement, fg: theme.textMuted }}> {file} </span>
                  </text>
                )}
              </For>
            </box>
          </Show>
        </box>
      </box>
    </Show>
  )
}

/** Steps drawn at once inside one reply (an hours-long turn can hold hundreds of tool calls). */
const PART_WINDOW = 80

function AssistantView(props                               ) {
  const allParts = createMemo(() =>
    props.message.parts.filter((part) => {
      if (part.type === "reasoning") return showThinking() && (part.text.trim() || !part.end)
      if (part.type === "text") return !!part.text.trim()
      return true
    }),
  )
  const [expanded, setExpanded] = createSignal(false)
  const hiddenParts = createMemo(() => (expanded() ? 0 : Math.max(0, allParts().length - PART_WINDOW)))
  const visibleParts = createMemo(() => (hiddenParts() ? allParts().slice(hiddenParts()) : allParts()))
  return (
    <>
      <Show when={hiddenParts() > 0}>
        <box marginTop={1} flexShrink={0} paddingLeft={3} onMouseUp={() => setExpanded(true)}>
          <text fg={theme.textMuted}>
            ▲ {hiddenParts()} earlier step{hiddenParts() === 1 ? "" : "s"} in this reply · click to show
          </text>
        </box>
      </Show>
      <For each={visibleParts()}>
        {(part) => (
          <box marginTop={1} flexShrink={0}>
            <PartView part={part} message={props.message} />
          </box>
        )}
      </For>
      <Show when={props.message.retry}>
        {(retry                                              ) => (
          <box marginTop={1} paddingLeft={3}>
            <text fg={theme.error}>
              {retry().error} · retrying in {Math.round(retry().delay / 1000)}s (attempt {retry().attempt}/{retry().max})
            </text>
          </box>
        )}
      </Show>
      <Show when={props.message.end !== undefined}>
        <box marginTop={1} flexShrink={0}>
          <AssistantFooter message={props.message} />
        </box>
      </Show>
    </>
  )
}

function AssistantFooter(props                               ) {
  const dimensions = useTerminalDimensions()
  const elapsed = createMemo(() => (props.message.end && props.message.start ? props.message.end - props.message.start : 0))
  const name = () => (props.message.agent === "plan" ? "Plan" : "Build")
  // tok/s over the time tokens were actually streaming (tools and waiting excluded), like opencode's Zen meter.
  const speed = createMemo(() => {
    const tokens = props.message.outputTokens ?? 0
    const ms = props.message.streamMs ?? 0
    if (!props.message.end || tokens < 20 || ms < 200) return undefined
    const tps = (tokens / ms) * 1000
    return `${tokens.toLocaleString()} tok · ${tps >= 100 ? Math.round(tps) : tps.toFixed(1)} tok/s`
  })
  return (
    <>
      <Show when={props.message.error && !props.message.interrupted}>
        <box paddingLeft={3} marginBottom={1}>
          <text fg={theme.error}>Error: {props.message.error}</text>
        </box>
      </Show>
      <box paddingLeft={3}>
        <text>
          <span style={{ fg: props.message.error ? theme.textMuted : agentColor(agentIndex(props.message.agent)) }}>{name()}</span>
          <Show when={dimensions().width >= 28 && props.message.model}>
            <span style={{ fg: theme.textMuted }}> · {prettyModel(props.message.model)}</span>
          </Show>
          <Show when={elapsed() > 0 && (dimensions().width < 28 || dimensions().width >= 36)}>
            <span style={{ fg: theme.textMuted }}> · {duration(elapsed())}</span>
          </Show>
          <Show when={speed() && dimensions().width >= 60}>
            <span style={{ fg: theme.textMuted }}> · {speed()}</span>
          </Show>
          <Show when={props.message.interrupted}>
            <span style={{ fg: theme.textMuted }}> · interrupted</span>
          </Show>
        </text>
      </box>
    </>
  )
}

function PartView(props                                           ) {
  return (
    <Switch>
      <Match when={props.part.type === "text"}>
        <TextPartView part={props.part            } />
      </Match>
      <Match when={props.part.type === "reasoning"}>
        <ReasoningView part={props.part                 } />
      </Match>
      <Match when={props.part.type === "tool"}>
        <ToolView part={props.part       } />
      </Match>
    </Switch>
  )
}

function TextPartView(props                    ) {
  return (
    <box paddingLeft={3} flexShrink={0}>
      <markdown
        syntaxStyle={syntax()}
        content={props.part.text.trim()}
        streaming={!props.part.done}
        internalBlockMode="top-level"
        tableOptions={{ style: "grid", cellPaddingX: 1 }}
        conceal={true}
        fg={theme.markdownText}
        bg={theme.background}
      />
    </box>
  )
}

function reasoningTitle(text        ) {
  const heading = text.match(/^\s*\*\*(.+?)\*\*/)
  if (heading) return heading[1]
  const first = text.trim().split("\n")[0] ?? ""
  return first.length > 60 ? first.slice(0, 59) + "…" : first
}

function ReasoningView(props                         ) {
  const [expanded, setExpanded] = createSignal(false)
  const done = () => props.part.end !== undefined
  const content = createMemo(() => props.part.text.replace("[REDACTED]", "").trim())
  const fg = () => (expanded() ? alpha(theme.warning, 0.6) : theme.warning)
  const elapsed = () => (props.part.end && props.part.start ? duration(props.part.end - props.part.start) : undefined)
  const header = () => (
        <Show
      when={done()}
      fallback={
        <box flexDirection="row">
          <Spinner color={fg()}>{content() ? "Thinking: " + reasoningTitle(content()) : "Thinking"}</Spinner>
        </box>
      }
    >
      <text fg={fg()} wrapMode="none">
        <span>{expanded() ? "- " : "+ "}</span>
        <span>Thought</span>
        <Show when={!expanded() && content()}>
          <span>: {reasoningTitle(content())}</span>
        </Show>
        <Show when={elapsed()}>
          <span>
            {!expanded() && content() ? " · " : ": "}
            {elapsed()}
          </span>
        </Show>
      </text>
    </Show>
  )
  return (
    <box paddingLeft={3} flexDirection="column" flexShrink={0}>
      <Show
        when={expanded()}
        fallback={<box onMouseUp={() => setExpanded(true)}>{header()}</box>}
      >
        <box
          border={["left"]}
          customBorderChars={SplitBorder.customBorderChars}
          borderColor={theme.backgroundElement}
          paddingLeft={1}
          onMouseUp={() => setExpanded(false)}
        >
          {header()}
        </box>
      </Show>
      <Show when={expanded() && content()}>
        <box marginTop={1}>
          <box border={["left"]} customBorderChars={SplitBorder.customBorderChars} borderColor={theme.backgroundElement} paddingLeft={1}>
            <code
              filetype="markdown"
              drawUnstyledText={false}
              streaming={!done()}
              syntaxStyle={mutedSyntax()}
              content={content()}
              conceal={true}
              fg={theme.textMuted}
            />
          </box>
        </box>
      </Show>
    </box>
  )
}

function NoticeView(props                            ) {
  return (
    <Switch>
      <Match when={props.message.variant === "compaction"}>
        <Divider color={theme.textMuted} label={props.message.text} />
      </Match>
      <Match when={props.message.variant === "command"}>
        <box
          border={["left"]}
          customBorderChars={SplitBorder.customBorderChars}
          borderColor={theme.background}
          backgroundColor={theme.backgroundPanel}
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={2}
          paddingRight={2}
        >
          <markdown syntaxStyle={syntax()} content={props.message.text.trim()} fg={theme.markdownText} bg={theme.backgroundPanel} conceal={true} />
        </box>
      </Match>
      <Match when={true}>
        <box paddingLeft={3}>
          <text
            fg={props.message.variant === "error" ? theme.error : props.message.variant === "warning" ? theme.warning : theme.textMuted}
          >
            {props.message.variant === "error" ? "Error: " : ""}
            {props.message.text}
          </text>
        </box>
      </Match>
    </Switch>
  )
}

function ShellMessageView(props                           ) {
  return (
    <ShellDisplay
      command={props.message.command}
      running={props.message.running}
      output={props.message.output}
      error={
        !props.message.running && props.message.exitCode !== null && props.message.exitCode !== 0
          ? `Command exited with code ${props.message.exitCode}`
          : undefined
      }
    />
  )
}

export function useRendererSafe() {
  return useRenderer()
}

export { TextAttributes }
