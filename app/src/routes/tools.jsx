import { RGBA, TextAttributes } from "@opentui/core"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, For, Match, Show, Switch,          } from "solid-js"
import { createTwoFilesPatch } from "diff"
import path from "node:path"
import { isTodoTool, stripAnsi,               } from "../context/session"
import { active, relative, store } from "../context/tabs"
import { syntax, theme } from "../context/theme"
import { SplitBorder } from "../ui/border"
import { dialog } from "../ui/dialog"
import { Spinner } from "../component/spinner"

export const INLINE_TOOL_ICON_WIDTH = 2

function str(value         ) {
  return typeof value === "string" ? value : undefined
}
function num(value         ) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function usePermission(part                ) {
  return createMemo(() => store.permissions[0]?.id === part().id)
}

export function filetype(file         ) {
  if (!file) return undefined
  const ext = path.extname(file).slice(1).toLowerCase()
  const map                         = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    py: "python",
    rs: "rust",
    go: "go",
    md: "markdown",
    json: "json",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    css: "css",
    html: "html",
    yml: "yaml",
    yaml: "yaml",
    toml: "toml",
    c: "c",
    h: "c",
    cpp: "cpp",
    java: "java",
    rb: "ruby",
    lua: "lua",
    zig: "zig",
  }
  return map[ext] ?? ext
}

// ---------------------------------------------------------------------------
// Primitives (opencode InlineTool / BlockTool)
// ---------------------------------------------------------------------------

function InlineTool(props








 ) {
  const renderer = useRenderer()
  const [hover, setHover] = createSignal(false)
  const [errorExpanded, setErrorExpanded] = createSignal(false)
  const permission = usePermission(() => props.part)
  const error = createMemo(() => (props.part.status === "error" ? props.part.error : undefined))
  const denied = createMemo(
    () =>
      props.part.denied ||
      !!error()?.match(/rejected|doesn't want to proceed|denied|Interrupted|dismissed/i),
  )
  const failed = createMemo(() => !!error() && !denied())
  const fg = createMemo(() => {
    if (permission()) return theme.warning
    if (failed()) return theme.error
    if (hover() && (props.onClick || failed())) return theme.text
    return theme.textMuted
  })
  const complete = () => props.complete && props.part.status !== "pending"
  return (
    <box
      paddingLeft={3}
      onMouseOver={() => (props.onClick || failed()) && setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={() => {
        if (renderer.getSelection()?.getSelectedText()) return
        if (failed()) return setErrorExpanded((value) => !value)
        props.onClick?.()
      }}
    >
      <Switch>
        <Match when={props.spinner}>
          <box flexDirection="row" gap={1}>
            <Spinner color={fg()} />
            <box flexDirection="row" flexWrap="wrap" columnGap={1} flexGrow={1}>
              <text fg={fg()}>{props.children}</text>
              {props.status}
            </box>
          </box>
        </Match>
        <Match when={complete() || failed() || denied()}>
          <box flexDirection="row">
            <text
              width={INLINE_TOOL_ICON_WIDTH}
              flexShrink={0}
              fg={failed() ? theme.error : fg()}
              attributes={denied() ? TextAttributes.STRIKETHROUGH : undefined}
            >
              {props.icon}
            </text>
            <box flexDirection="row" flexWrap="wrap" columnGap={1} flexGrow={1}>
              <text fg={fg()} attributes={denied() ? TextAttributes.STRIKETHROUGH : undefined}>
                {props.children}
              </text>
              {props.status}
            </box>
          </box>
        </Match>
        <Match when={true}>
          <Spinner color={fg()}>{props.pending}</Spinner>
        </Match>
      </Switch>
      <Show when={failed() && errorExpanded()}>
        <box paddingLeft={INLINE_TOOL_ICON_WIDTH}>
          <text fg={theme.error}>{error()}</text>
        </box>
      </Show>
    </box>
  )
}

function StatusBadge(props                                        ) {
  return (
    <text flexShrink={0} bg={props.raised ? theme.backgroundElement : theme.backgroundPanel} fg={theme.textMuted}>
      {" "}
      {props.children}{" "}
    </text>
  )
}

function BlockTool(props







 ) {
  const renderer = useRenderer()
  const [hover, setHover] = createSignal(false)
  const permission = createMemo(() => (props.part ? store.permissions[0]?.id === props.part.id : false))
  const error = createMemo(() => props.error ?? (props.part?.status === "error" ? props.part.error : undefined))
  const headerColor = () => (permission() ? theme.warning : theme.textMuted)
  return (
    <box
      border={["left"]}
      flexShrink={0}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      gap={1}
      backgroundColor={hover() ? theme.backgroundElement : theme.backgroundPanel}
      customBorderChars={SplitBorder.customBorderChars}
      borderColor={theme.background}
      onMouseOver={() => props.onClick && setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={() => {
        if (renderer.getSelection()?.getSelectedText()) return
        props.onClick?.()
      }}
    >
      <Show
        when={props.path}
        fallback={
          <Show when={props.title}>
            <Show when={props.spinner} fallback={<text fg={headerColor()}>{props.title}</text>}>
              <Spinner color={headerColor()}>{props.title .replace(/^# /, "")}</Spinner>
            </Show>
          </Show>
        }
      >
        {(item                                        ) => (
          <box flexDirection="row" gap={1} minWidth={0}>
            <Show when={props.spinner} fallback={<text flexShrink={0} fg={headerColor()}>{item().label}</text>}>
              <Spinner color={headerColor()}>{item().label.replace(/^# /, "")}</Spinner>
            </Show>
            <text fg={headerColor()} wrapMode="none" truncate>
              {item().value}
            </text>
          </box>
        )}
      </Show>
      {props.children}
      <Show when={error()}>
        <text fg={theme.error}>{error()}</text>
      </Show>
    </box>
  )
}

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

export function ToolView(props                    ) {
  const name = () => props.part.name
  return (
    <Switch fallback={<GenericTool part={props.part} />}>
      <Match when={name() === "Bash"}>
        <Shell part={props.part} />
      </Match>
      <Match when={name() === "Read"}>
        <Read part={props.part} />
      </Match>
      <Match when={name() === "Write"}>
        <Write part={props.part} />
      </Match>
      <Match when={name() === "Edit" || name() === "MultiEdit"}>
        <Edit part={props.part} />
      </Match>
      <Match when={name() === "NotebookEdit"}>
        <InlineTool icon="←" pending="Preparing edit…" complete={props.part.input.notebook_path} part={props.part}>
          Edit {relative(str(props.part.input.notebook_path) ?? "")}
        </InlineTool>
      </Match>
      <Match when={name() === "Glob"}>
        <Glob part={props.part} />
      </Match>
      <Match when={name() === "Grep"}>
        <Grep part={props.part} />
      </Match>
      <Match when={name() === "WebFetch"}>
        <InlineTool icon="%" pending="Fetching from the web…" complete={props.part.input.url} part={props.part}>
          WebFetch {str(props.part.input.url)}
        </InlineTool>
      </Match>
      <Match when={name() === "WebSearch" || name() === "web_search"}>
        <InlineTool icon="◈" pending="Searching web…" complete={props.part.input.query} part={props.part}>
          Web Search "{str(props.part.input.query)}"
        </InlineTool>
      </Match>
      <Match when={name() === "Task" || name() === "Agent"}>
        <Subagent part={props.part} />
      </Match>
      <Match when={isTodoTool(name())}>
        <TodoWrite part={props.part} />
      </Match>
      <Match when={name() === "AskUserQuestion"}>
        <Question part={props.part} />
      </Match>
      <Match when={name() === "Skill"}>
        <InlineTool icon="→" pending="Loading skill…" complete={props.part.input.skill ?? props.part.input.command} part={props.part}>
          Skill "{str(props.part.input.skill) ?? str(props.part.input.command)}"
        </InlineTool>
      </Match>
      <Match when={name() === "ExitPlanMode"}>
        <Plan part={props.part} />
      </Match>
      <Match when={name() === "ToolSearch"}>
        <InlineTool icon="⚙" pending="Loading tools…" complete={props.part.status === "completed"} part={props.part}>
          Load tools {String(props.part.input.query ?? "").replace(/^select:/, "")}
        </InlineTool>
      </Match>
      <Match when={name() === "EnterPlanMode"}>
        <InlineTool icon="◇" pending="Entering plan mode…" complete={true} part={props.part}>
          Entered plan mode
        </InlineTool>
      </Match>
      <Match when={name() === "BashOutput" || name() === "TaskOutput"}>
        <InlineTool icon="$" pending="Reading output…" complete={true} part={props.part}>
          Output {str(props.part.input.bash_id) ?? str(props.part.input.task_id) ?? ""}
        </InlineTool>
      </Match>
      <Match when={name() === "KillShell" || name() === "KillBash" || name() === "TaskStop"}>
        <InlineTool icon="✗" pending="Stopping…" complete={true} part={props.part}>
          Stop {str(props.part.input.shell_id) ?? str(props.part.input.task_id) ?? ""}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function primitiveSummary(input                         ) {
  return Object.entries(input)
    .filter(([, value]) => typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    .map(([key, value]) => `${key}=${String(value).replace(/\s+/g, " ").slice(0, 60)}`)
    .join(" ")
}

function toolName(name        ) {
  const mcp = name.match(/^mcp__(.+?)__(.+)$/)
  if (mcp) return `${mcp[1]}_${mcp[2]}`
  return name
}

function GenericTool(props                    ) {
  const [expanded, setExpanded] = createSignal(false)
  const output = createMemo(() => props.part.output?.trim() ?? "")
  const entries = createMemo(() => Object.entries(props.part.input))
  return (
    <>
      <InlineTool
        icon={props.part.status === "error" ? "✗" : "⚙"}
        pending={toolName(props.part.name)}
        complete={props.part.status === "completed"}
        spinner={props.part.status === "running"}
        part={props.part}
        onClick={entries().length || output() ? () => setExpanded((value) => !value) : undefined}
      >
        {`${toolName(props.part.name)} ${primitiveSummary(props.part.input)}`.trim()}
      </InlineTool>
      <Show when={expanded()}>
        <box paddingLeft={3 + INLINE_TOOL_ICON_WIDTH}>
          <For each={entries()}>
            {([key, value]) => (
              <box flexDirection="row">
                <text flexShrink={0} fg={theme.textMuted}>
                  {key}:{" "}
                </text>
                <text flexGrow={1} wrapMode="word" fg={theme.text}>
                  {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
                </text>
              </box>
            )}
          </For>
          <Show when={output()}>
            <box flexDirection="row">
              <text flexShrink={0} fg={theme.textMuted}>
                output:{" "}
              </text>
              <text flexGrow={1} fg={theme.text} wrapMode="word">
                {output().slice(0, 5000)}
              </text>
            </box>
          </Show>
        </box>
      </Show>
    </>
  )
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

function collapse(text        , maxLines        , maxChars        ) {
  const lines = text.split("\n")
  let out = lines.slice(0, maxLines).join("\n")
  if (out.length > maxChars) out = out.slice(0, maxChars)
  return { text: out, overflow: out.length < text.length }
}

export function ShellDisplay(props







 ) {
  const dimensions = useTerminalDimensions()
  const [expanded, setExpanded] = createSignal(false)
  const permission = createMemo(() => (props.part ? store.permissions[0]?.id === props.part.id : false))
  const color = createMemo(() => (permission() ? theme.warning : theme.text))
  const output = createMemo(() => stripAnsi(props.output?.trim() ?? ""))
  const input = createMemo(() => (props.command ? `${props.running ? "" : "$ "}${props.command}` : ""))
  const maxChars = createMemo(() => 10 * Math.max(20, dimensions().width - 12))
  const collapsedOutput = createMemo(() => collapse(output(), 10, maxChars()))
  const shownOutput = createMemo(() => (expanded() ? output() : collapsedOutput().text))
  const expandable = createMemo(() => collapsedOutput().overflow || input().split("\n").length > 2)
  return (
    <BlockTool part={props.part} error={props.error} onClick={expandable() ? () => setExpanded((v) => !v) : undefined}>
      <box gap={1}>
        <Show
          when={props.command}
          fallback={props.running ? <Spinner color={color()}>Writing command…</Spinner> : <text fg={theme.textMuted}>Writing command…</text>}
        >
          <Show
            when={props.running}
            fallback={
              <text fg={theme.text} wrapMode={expanded() ? "word" : "char"} maxHeight={expanded() ? undefined : 2}>
                {input()}
              </text>
            }
          >
            <box flexDirection="row" gap={1}>
              <Spinner color={color()} />
              <text fg={color()} wrapMode={expanded() ? "word" : "char"} maxHeight={expanded() ? undefined : 2} flexGrow={1} minWidth={0}>
                {input()}
              </text>
            </box>
          </Show>
          <Show when={shownOutput()}>
            <text fg={theme.textMuted}>{shownOutput()}</text>
          </Show>
          <Show when={!expanded() && collapsedOutput().overflow}>
            <text fg={theme.textMuted}>… click to expand</text>
          </Show>
        </Show>
        <Show when={props.background}>
          <StatusBadge raised>Background</StatusBadge>
        </Show>
      </box>
    </BlockTool>
  )
}

function Shell(props                    ) {
  const output = createMemo(() => {
    const result = props.part.result
    if (result && typeof result === "object" && ("stdout" in result || "stderr" in result)) {
      return [result.stdout, result.stderr].filter((item         ) => typeof item === "string" && item).join("\n")
    }
    return props.part.output
  })
  return (
    <ShellDisplay
      part={props.part}
      command={str(props.part.input.command)}
      running={props.part.status === "running" || props.part.status === "pending"}
      output={props.part.status === "error" ? undefined : output()}
      error={props.part.status === "error" ? props.part.error : undefined}
      background={!!props.part.input.run_in_background || props.part.background}
    />
  )
}

// ---------------------------------------------------------------------------
// File tools
// ---------------------------------------------------------------------------

function Read(props                    ) {
  const file = () => relative(str(props.part.input.file_path) ?? "")
  const range = () => {
    const offset = num(props.part.input.offset)
    const limit = num(props.part.input.limit)
    if (offset === undefined && limit === undefined) return ""
    const start = offset || 1
    return `:${start}-${limit ? start + limit - 1 : ""}`
  }
  return (
    <InlineTool
      icon="→"
      pending="Reading file…"
      complete={props.part.input.file_path}
      spinner={props.part.status === "running" && !!props.part.input.file_path && false}
      part={props.part}
    >
      Read {file()}
      {range()}
    </InlineTool>
  )
}

function Write(props                    ) {
  const file = () => str(props.part.input.file_path) ?? ""
  return (
    <Switch>
      <Match when={props.part.status === "completed"}>
        <BlockTool path={{ label: "# Wrote", value: relative(file()) }} part={props.part}>
          <line_number fg={theme.textMuted} minWidth={3} paddingRight={1}>
            <code
              conceal={false}
              fg={theme.text}
              filetype={filetype(file())}
              syntaxStyle={syntax()}
              content={(str(props.part.input.content) ?? "").split("\n").slice(0, 400).join("\n")}
            />
          </line_number>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="←" pending="Preparing write…" complete={props.part.input.file_path} part={props.part}>
          Write {relative(file())}
        </InlineTool>
      </Match>
    </Switch>
  )
}

export function patchFromResult(part          ) {
  const result = part.result
  const file = str(part.input.file_path) ?? "file"
  if (result?.structuredPatch?.length) {
    const header = `--- a/${file}\n+++ b/${file}\n`
    return (
      header +
      result.structuredPatch
        .map(
          (hunk     ) =>
            `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.join("\n")}`,
        )
        .join("\n")
    )
  }
  return editPatch(part.name, part.input)
}

export function editPatch(name        , input                     ) {
  const file = str(input.file_path) ?? "file"
  if (name === "MultiEdit" && Array.isArray(input.edits)) {
    return input.edits
      .map((edit     ) => createTwoFilesPatch(file, file, edit.old_string ?? "", edit.new_string ?? "", "", "", { context: 3 }))
      .join("\n")
  }
  if (name === "Write") return createTwoFilesPatch(file, file, "", str(input.content) ?? "", "", "", { context: 3 })
  return createTwoFilesPatch(file, file, str(input.old_string) ?? "", str(input.new_string) ?? "", "", "", { context: 3 })
}

export function DiffView(props                                  ) {
  const dimensions = useTerminalDimensions()
  // Split only when the transcript column itself is wide and both sides have content.
  const view = createMemo(() => {
    const content = dimensions().width - (dimensions().width > 120 ? 42 : 0) - 8
    const lines = props.patch.split("\n")
    const removed = lines.some((line) => line.startsWith("-") && !line.startsWith("---"))
    const added = lines.some((line) => line.startsWith("+") && !line.startsWith("+++"))
    return content > 120 && removed && added ? "split" : "unified"
  })
  return (
    <diff
      diff={props.patch}
      view={view()}
      filetype={filetype(props.file)}
      syntaxStyle={syntax()}
      showLineNumbers={true}
      width="100%"
      wrapMode="word"
      fg={theme.text}
      addedBg={theme.diffAddedBg}
      removedBg={theme.diffRemovedBg}
      contextBg={theme.diffContextBg}
      addedSignColor={theme.diffHighlightAdded}
      removedSignColor={theme.diffHighlightRemoved}
      lineNumberFg={theme.diffLineNumber}
      lineNumberBg={theme.diffContextBg}
      addedLineNumberBg={theme.diffAddedLineNumberBg}
      removedLineNumberBg={theme.diffRemovedLineNumberBg}
    />
  )
}

function Edit(props                    ) {
  const file = () => str(props.part.input.file_path) ?? ""
  const patch = createMemo(() => (props.part.status === "pending" ? "" : patchFromResult(props.part)))
  return (
    <Switch>
      <Match when={patch() && props.part.status !== "pending"}>
        <BlockTool path={{ label: "← Edit", value: relative(file()) }} part={props.part}>
          <box paddingLeft={1}>
            <DiffView patch={patch()} file={file()} />
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <BlockTool
          path={file() ? { label: "← Edit", value: relative(file()) } : undefined}
          title={file() ? undefined : "# Preparing edit…"}
          part={props.part}
          spinner={props.part.status === "pending"}
        />
      </Match>
    </Switch>
  )
}

function Glob(props                    ) {
  const count = () => num(props.part.result?.numFiles) ?? num(props.part.result?.filenames?.length)
  return (
    <InlineTool icon="✱" pending="Finding files…" complete={props.part.input.pattern} part={props.part}>
      Glob "{str(props.part.input.pattern)}"{" "}
      <Show when={str(props.part.input.path)}>in {relative(str(props.part.input.path) )} </Show>
      <Show when={count() !== undefined}>
        ({count()} {count() === 1 ? "match" : "matches"})
      </Show>
    </InlineTool>
  )
}

function Grep(props                    ) {
  const count = () => num(props.part.result?.numMatches) ?? num(props.part.result?.numFiles) ?? num(props.part.result?.numLines)
  return (
    <InlineTool icon="✱" pending="Searching content…" complete={props.part.input.pattern} part={props.part}>
      Grep "{str(props.part.input.pattern)}"{" "}
      <Show when={str(props.part.input.path)}>in {relative(str(props.part.input.path) )} </Show>
      <Show when={count() !== undefined}>
        ({count()} {count() === 1 ? "match" : "matches"})
      </Show>
    </InlineTool>
  )
}

// ---------------------------------------------------------------------------
// Agentic tools
// ---------------------------------------------------------------------------

function titlecase(text        ) {
  return text
    .split(/[-_\s]/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ")
}

function findPart(id        ) {
  return active().findToolPart(id)
}

export function SubagentDialog(props                ) {
  const dimensions = useTerminalDimensions()
  const part = createMemo(() => findPart(props.id))
  const type = () => titlecase(str(part()?.input.subagent_type) ?? "General")
  return (
    <box paddingLeft={4} paddingRight={4} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          {type()} Subagent — {str(part()?.input.description) ?? ""}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.pop()}>
          esc
        </text>
      </box>
      <scrollbox maxHeight={Math.max(8, dimensions().height - 12)} stickyScroll stickyStart="bottom" scrollbarOptions={{ visible: false }}>
        <box gap={1}>
          <Show when={str(part()?.input.prompt)}>
            <box border={["left"]} customBorderChars={SplitBorder.customBorderChars} borderColor={theme.secondary} backgroundColor={theme.backgroundElement} paddingLeft={2} paddingTop={1} paddingBottom={1}>
              <text fg={theme.text}>{str(part()?.input.prompt)}</text>
            </box>
          </Show>
          <For each={part()?.childLog ?? []}>
            {(entry) => (
              <Show
                when={entry.name !== "text"}
                fallback={
                  <box paddingLeft={1}>
                    <markdown syntaxStyle={syntax()} content={entry.text ?? ""} fg={theme.markdownText} bg={theme.backgroundPanel} conceal={true} />
                  </box>
                }
              >
                <box flexDirection="row" paddingLeft={1}>
                  <Show when={entry.status !== "running"} fallback={<Spinner color={theme.textMuted} />}>
                    <text width={2} fg={entry.status === "error" ? theme.error : theme.textMuted}>
                      {entry.status === "error" ? "✗" : "✓"}
                    </text>
                  </Show>
                  <text fg={theme.textMuted} wrapMode="none" truncate>
                    {" "}
                    {entry.title}
                  </text>
                </box>
              </Show>
            )}
          </For>
          <Show when={part()?.status === "completed" && part()?.output}>
            <box border={["left"]} customBorderChars={SplitBorder.customBorderChars} borderColor={theme.success} paddingLeft={2}>
              <markdown syntaxStyle={syntax()} content={part() .output .replace(/agentId:[\s\S]*$/, "").trim()} fg={theme.markdownText} bg={theme.backgroundPanel} conceal={true} />
            </box>
          </Show>
        </box>
      </scrollbox>
    </box>
  )
}

function Subagent(props                    ) {
  const running = () => props.part.status === "running" || props.part.status === "pending"
  const type = () => titlecase(str(props.part.input.subagent_type) ?? "General")
  const description = () => str(props.part.input.description) ?? "Subagent"
  return (
    <box>
      <InlineTool
        onClick={() => {
          // Like opencode: open the subagent's own transcript (parent/prev/next to navigate).
          active().setStore("child", props.part.id)
        }}
        icon={props.part.status === "completed" ? "✓" : "│"}
        spinner={running()}
        complete={props.part.input.description}
        pending="Delegating…"
        part={props.part}
        status={props.part.background || props.part.input.run_in_background ? <StatusBadge>Background</StatusBadge> : undefined}
      >
        {`${type()} Subagent — ${description()}${props.part.children ? ` · ${props.part.children} tool${props.part.children === 1 ? "" : "s"}` : ""}`}
      </InlineTool>
      <Show when={running() && props.part.childTitle}>
        <box paddingLeft={3 + INLINE_TOOL_ICON_WIDTH}>
          <text fg={theme.textMuted} wrapMode="none" truncate>
            ↳ {props.part.childTitle}
          </text>
        </box>
      </Show>
    </box>
  )
}

function TodoWrite(props                    ) {
  const todos = () => (Array.isArray(props.part.input.todos) ? props.part.input.todos : [])
  return (
    <Show
      when={props.part.status !== "pending" && todos().length}
      fallback={
        <InlineTool icon="⚙" pending="Updating todos…" complete={false} part={props.part}>
          Todos
        </InlineTool>
      }
    >
      <BlockTool title="# Todos" part={props.part}>
        <box>
          <For each={todos()}>
            {(todo     ) => (
              <text
                fg={todo.status === "in_progress" ? theme.warning : todo.status === "completed" ? theme.textMuted : theme.text}
                attributes={todo.status === "completed" ? TextAttributes.STRIKETHROUGH : undefined}
              >
                {todo.status === "completed" ? "[✓]" : todo.status === "in_progress" ? "[•]" : "[ ]"}{" "}
                {todo.status === "in_progress" && todo.activeForm ? todo.activeForm : todo.content}
              </text>
            )}
          </For>
        </box>
      </BlockTool>
    </Show>
  )
}

function Question(props                    ) {
  const questions = () => (Array.isArray(props.part.input.questions) ? props.part.input.questions : [])
  const answers = () => (props.part.result?.answers ?? undefined)
  return (
    <Switch>
      <Match when={answers()}>
        <BlockTool title="# Questions" part={props.part}>
          <box gap={1}>
            <For each={questions()}>
              {(q     ) => (
                <box>
                  <text fg={theme.textMuted}>{q.question}</text>
                  <text fg={theme.text}>{answers()?.[q.question] ?? "(no answer)"}</text>
                </box>
              )}
            </For>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="→" pending="Asking questions…" complete={questions().length} part={props.part}>
          Asked {questions().length} question{questions().length !== 1 ? "s" : ""}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Plan(props                    ) {
  return (
    <Show
      when={str(props.part.input.plan)}
      fallback={
        <InlineTool icon="◇" pending="Writing plan…" complete={props.part.status === "completed"} part={props.part}>
          Exited plan mode
        </InlineTool>
      }
    >
      <BlockTool title="# Plan" part={props.part}>
        <markdown syntaxStyle={syntax()} content={str(props.part.input.plan) } fg={theme.markdownText} bg={theme.backgroundPanel} />
      </BlockTool>
    </Show>
  )
}

export { RGBA }
