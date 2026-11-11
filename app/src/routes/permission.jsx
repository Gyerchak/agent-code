import { TextAttributes,                         } from "@opentui/core"
import { openCommand } from "../context/platform"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, For, Match, Show, Switch,          } from "solid-js"
import { createStore } from "solid-js/store"
import { useLayer } from "../context/keymap"

import { relative, replyElicitation, replyPermission, replyQuestion } from "../context/tabs"
import { syntax, theme } from "../context/theme"
import { SplitBorder } from "../ui/border"
import { dialog, DialogPrompt, DialogSelect } from "../ui/dialog"
import { toast } from "../ui/toast"
import { spawn } from "node:child_process"
import { DiffView, editPatch } from "./tools"



function Frame(props








 ) {
  const dimensions = useTerminalDimensions()
  const narrow = createMemo(() => dimensions().width < 80)
  return (
    <box
      backgroundColor={theme.backgroundPanel}
      border={["left"]}
      borderColor={props.borderColor}
      customBorderChars={SplitBorder.customBorderChars}
      maxHeight={Math.max(10, Math.floor(dimensions().height * 0.6))}
    >
      <box gap={1} paddingLeft={1} paddingRight={3} paddingTop={1} paddingBottom={1} flexShrink={1} minHeight={0}>
        <box paddingLeft={1} flexShrink={0}>
          {props.header}
        </box>
        <Show when={props.body}>
          <box flexShrink={1} minHeight={0} overflow="hidden">
            {props.body}
          </box>
        </Show>
      </box>
      <box
        flexDirection={narrow() ? "column" : "row"}
        flexShrink={0}
        gap={1}
        paddingTop={1}
        paddingLeft={2}
        paddingRight={3}
        paddingBottom={1}
        backgroundColor={theme.backgroundElement}
        justifyContent={narrow() ? "flex-start" : "space-between"}
        alignItems={narrow() ? "flex-start" : "center"}
      >
        <box flexDirection="row" gap={1} flexShrink={0}>
          <For each={props.options}>
            {(option) => (
              <box
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={option.key === props.selected ? theme.primary : undefined}
                onMouseMove={() => props.onHover(option.key)}
                onMouseUp={() => props.onSelect(option.key)}
              >
                <text fg={option.key === props.selected ? theme.selectedListItemText : theme.text}>{option.label}</text>
              </box>
            )}
          </For>
        </box>
        <box flexDirection="row" gap={2} flexShrink={0}>
          {props.hints}
          <Show when={props.options.length > 1}>
            <text fg={theme.text}>
              {"⇆"} <span style={{ fg: theme.textMuted }}>select</span>
            </text>
          </Show>
          <text fg={theme.text}>
            enter <span style={{ fg: theme.textMuted }}>confirm</span>
          </text>
        </box>
      </box>
    </box>
  )
}

function describe(request                   )                                  {
  const input = request.input
  switch (request.tool) {
    case "Bash":
      return { icon: "#", title: input.description ?? "Shell command" }
    case "Read":
      return { icon: "→", title: `Read ${relative(input.file_path ?? "")}` }
    case "Write":
      return { icon: "←", title: `Write ${relative(input.file_path ?? "")}` }
    case "Edit":
    case "MultiEdit":
      return { icon: "←", title: `Edit ${relative(input.file_path ?? "")}` }
    case "NotebookEdit":
      return { icon: "←", title: `Edit ${relative(input.notebook_path ?? "")}` }
    case "Glob":
      return { icon: "✱", title: `Glob "${input.pattern}"` }
    case "Grep":
      return { icon: "✱", title: `Grep "${input.pattern}"` }
    case "WebFetch":
      return { icon: "%", title: `WebFetch ${input.url}` }
    case "WebSearch":
      return { icon: "◈", title: `Web Search "${input.query}"` }
    case "Task":
    case "Agent":
      return { icon: "│", title: `${input.subagent_type ?? "General"} Subagent — ${input.description ?? ""}` }
    case "ExitPlanMode":
      return { icon: "◇", title: "Ready to code?" }
    default: {
      const mcp = request.tool.match(/^mcp__(.+?)__(.+)$/)
      if (mcp) return { icon: "⚙", title: `${mcp[1]} · ${mcp[2]}` }
      return { icon: "⚙", title: request.title ?? request.displayName ?? request.tool }
    }
  }
}

export function PermissionPrompt(props                                ) {
  const plan = () => props.request.tool === "ExitPlanMode"
  const options = createMemo(() => {
    if (plan())
      return [
        { key: "accept", label: "Yes, auto-accept edits" },
        { key: "manual", label: "Yes, manually approve" },
        { key: "reject", label: "No, keep planning" },
      ]
    const list = [{ key: "once", label: "Allow once" }]
    // Offer "Always allow" for every tool; without Claude Code suggestions Agent Code builds a session rule itself.
    if (!props.request.suppressAlways) list.push({ key: "always", label: "Always allow" })
    list.push({ key: "reject", label: "Reject" })
    return list
  })
  const [state, setState] = createStore({
    selected: props.request.defaultToNo ? "reject" : options()[0].key,
    stage: "permission"                           ,
  })
  let reason

  function choose(key        ) {
    if (key === "reject") {
      setState("stage", "reject")
      setTimeout(() => reason && !reason.isDestroyed && reason.focus(), 1)
      return
    }
    if (key === "accept") return replyPermission(props.request.id, "once", { mode: "acceptEdits" })
    if (key === "manual") return replyPermission(props.request.id, "once", { mode: "default" })
    replyPermission(props.request.id, key                     )
  }

  useLayer({
    enabled: () => !dialog.open,
    commands: () => [],
    handler: (event) => {
      if (state.stage === "reject") {
        if (event.name === "escape") {
          setState("stage", "permission")
          return true
        }
        if (event.name === "return" && !event.shift) {
          replyPermission(props.request.id, "reject", { message: reason?.plainText.trim() || undefined })
          return true
        }
        return false
      }
      const keys = options().map((option) => option.key)
      if (event.name === "left" || event.name === "h") {
        setState("selected", keys[(keys.indexOf(state.selected) - 1 + keys.length) % keys.length])
        return true
      }
      if (event.name === "right" || event.name === "l" || event.name === "tab") {
        setState("selected", keys[(keys.indexOf(state.selected) + 1) % keys.length])
        return true
      }
      if (event.name === "return") {
        choose(state.selected)
        return true
      }
      if (event.name === "escape") {
        replyPermission(props.request.id, "reject")
        return true
      }
      if (event.name === "y" && !props.request.defaultToNo) {
        choose(keys[0])
        return true
      }
      if (event.name === "n") {
        replyPermission(props.request.id, "reject")
        return true
      }
      return false
    },
  })

  const info = createMemo(() => describe(props.request))

  const body = () => {
    const input = props.request.input
    switch (props.request.tool) {
      case "Bash":
        return (
          <box paddingLeft={1}>
            <text fg={theme.text}>$ {input.command}</text>
          </box>
        )
      case "Edit":
      case "MultiEdit":
      case "Write":
        return (
          <box paddingLeft={1}>
            <DiffView patch={editPatch(props.request.tool, input)} file={input.file_path} />
          </box>
        )
      case "ExitPlanMode":
        return (
          <box paddingLeft={1}>
            <markdown syntaxStyle={syntax()} content={String(input.plan ?? "")} fg={theme.markdownText} bg={theme.backgroundPanel} conceal={true} />
          </box>
        )
      default: {
        const lines = Object.entries(input)
          .filter(([, value]) => value !== undefined && value !== null && value !== "")
          .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
        return (
          <box paddingLeft={1}>
            <For each={lines.slice(0, 12)}>{(line) => <text fg={theme.textMuted}>{line}</text>}</For>
          </box>
        )
      }
    }
  }

  return (
    <Switch>
      <Match when={state.stage === "reject"}>
        <box backgroundColor={theme.backgroundPanel} border={["left"]} borderColor={theme.error} customBorderChars={SplitBorder.customBorderChars}>
          <box gap={1} paddingLeft={1} paddingRight={3} paddingTop={1} paddingBottom={1}>
            <box flexDirection="row" gap={1} paddingLeft={1}>
              <text fg={theme.error}>△</text>
              <text fg={theme.text}>Reject permission</text>
            </box>
            <box paddingLeft={1}>
              <text fg={theme.textMuted}>Tell Claude what to do differently (or press enter to just stop)</text>
            </box>
          </box>
          <box
            flexDirection="row"
            paddingTop={1}
            paddingLeft={2}
            paddingRight={3}
            paddingBottom={1}
            backgroundColor={theme.backgroundElement}
            justifyContent="space-between"
            gap={1}
          >
            <textarea
              ref={(r                    ) => {
                reason = r
                setTimeout(() => !r.isDestroyed && r.focus(), 1)
              }}
              flexGrow={1}
              textColor={theme.text}
              focusedTextColor={theme.text}
              cursorColor={theme.text}
              keyBindings={[{ name: "return", action: "submit" }]}
            />
            <box flexDirection="row" gap={2} flexShrink={0}>
              <text fg={theme.text}>
                enter <span style={{ fg: theme.textMuted }}>confirm</span>
              </text>
              <text fg={theme.text}>
                esc <span style={{ fg: theme.textMuted }}>cancel</span>
              </text>
            </box>
          </box>
        </box>
      </Match>
      <Match when={true}>
        <Frame
          borderColor={theme.primary}
          header={
            <box flexDirection="column">
              <box flexDirection="row" gap={1}>
                <text fg={theme.warning}>△</text>
                <text fg={theme.text}>{plan() ? "Plan ready" : "Permission required"}</text>
                <Show when={props.request.agentID}>
                  <text fg={theme.textMuted}>· subagent</text>
                </Show>
              </box>
              <box flexDirection="row" gap={1} paddingLeft={2}>
                <text fg={theme.textMuted} flexShrink={0}>
                  {info().icon}
                </text>
                <text fg={theme.text}>{info().title}</text>
              </box>
              <Show when={props.request.decisionReason && props.request.tool !== "Bash"}>
                <box paddingLeft={2}>
                  <text fg={theme.textMuted}>{props.request.decisionReason}</text>
                </box>
              </Show>
            </box>
          }
          body={body()}
          options={options()}
          selected={state.selected}
          onHover={(key) => setState("selected", key)}
          onSelect={choose}
        />
      </Match>
    </Switch>
  )
}

// ---------------------------------------------------------------------------
// AskUserQuestion
// ---------------------------------------------------------------------------

export function QuestionPrompt(props                              ) {
  const [state, setState] = createStore({
    index: 0,
    cursor: 0,
    picked: {}                            ,
    custom: {}                          ,
    typing: false,
  })
  let custom
  const question = createMemo(() => props.request.questions[state.index])
  const count = () => props.request.questions.length
  const choices = createMemo(() => [...(question()?.options ?? []).map((option) => option.label), "Type your own answer"])

  function answers() {
    const out                         = {}
    props.request.questions.forEach((q, i) => {
      const picked = [...(state.picked[i] ?? [])]
      if (state.custom[i]?.trim()) picked.push(state.custom[i].trim())
      out[q.question] = picked.join(", ")
    })
    return out
  }

  function next() {
    if (state.index + 1 < count()) {
      setState({ index: state.index + 1, cursor: 0, typing: false })
      return
    }
    replyQuestion(props.request.id, answers())
  }

  function pick(i        ) {
    const q = question()
    if (!q) return
    if (i === choices().length - 1) {
      setState("typing", true)
      setTimeout(() => custom && !custom.isDestroyed && custom.focus(), 1)
      return
    }
    const label = choices()[i]
    if (q.multiSelect) {
      const current = state.picked[state.index] ?? []
      setState(
        "picked",
        state.index,
        current.includes(label) ? current.filter((item) => item !== label) : [...current, label],
      )
      return
    }
    setState("picked", state.index, [label])
    next()
  }

  useLayer({
    enabled: () => !dialog.open,
    commands: () => [],
    handler: (event) => {
      if (state.typing) {
        if (event.name === "escape") {
          setState("typing", false)
          return true
        }
        if (event.name === "return" && !event.shift) {
          setState("custom", state.index, custom?.plainText ?? "")
          if (!question()?.multiSelect) setState("picked", state.index, [])
          setState("typing", false)
          next()
          return true
        }
        return false
      }
      if (event.name === "up" || event.name === "k") {
        setState("cursor", (state.cursor - 1 + choices().length) % choices().length)
        return true
      }
      if (event.name === "down" || event.name === "j") {
        setState("cursor", (state.cursor + 1) % choices().length)
        return true
      }
      if (event.name === "left" && state.index > 0) {
        setState({ index: state.index - 1, cursor: 0 })
        return true
      }
      if ((event.name === "right" || event.name === "tab") && state.index + 1 < count()) {
        setState({ index: state.index + 1, cursor: 0 })
        return true
      }
      if (event.name === "space" && question()?.multiSelect) {
        pick(state.cursor)
        return true
      }
      if (event.name === "return") {
        if (question()?.multiSelect && state.cursor !== choices().length - 1) {
          next()
          return true
        }
        pick(state.cursor)
        return true
      }
      if (event.name === "escape") {
        replyQuestion(props.request.id, undefined)
        return true
      }
      if (/^[1-9]$/.test(event.name) && Number(event.name) <= choices().length) {
        setState("cursor", Number(event.name) - 1)
        pick(Number(event.name) - 1)
        return true
      }
      return false
    },
  })

  return (
    <box backgroundColor={theme.backgroundPanel} border={["left"]} borderColor={theme.primary} customBorderChars={SplitBorder.customBorderChars}>
      <box gap={1} paddingLeft={2} paddingRight={3} paddingTop={1} paddingBottom={1}>
        <box flexDirection="row" gap={1}>
          <text fg={theme.warning}>△</text>
          <text fg={theme.text}>{count() > 1 ? `Question ${state.index + 1} of ${count()}` : "Question"}</text>
          <Show when={count() > 1}>
            <box flexDirection="row" gap={1} paddingLeft={2}>
              <For each={props.request.questions}>
                {(q, i) => (
                  <text
                    fg={i() === state.index ? theme.selectedListItemText : state.picked[i()]?.length ? theme.success : theme.textMuted}
                    bg={i() === state.index ? theme.accent : undefined}
                  >
                    {" " + q.header + " "}
                  </text>
                )}
              </For>
            </box>
          </Show>
        </box>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          {question()?.question}
        </text>
        <box>
          <For each={choices()}>
            {(label, i) => {
              const option = () => question()?.options[i()]
              const checked = () => (state.picked[state.index] ?? []).includes(label)
              return (
                <box
                  flexDirection="row"
                  gap={1}
                  paddingLeft={1}
                  backgroundColor={i() === state.cursor ? theme.backgroundElement : undefined}
                  onMouseMove={() => setState("cursor", i())}
                  onMouseUp={() => pick(i())}
                >
                  <text fg={i() === state.cursor ? theme.primary : theme.textMuted} flexShrink={0}>
                    {question()?.multiSelect && i() < choices().length - 1 ? (checked() ? "[✓]" : "[ ]") : `${i() + 1}.`}
                  </text>
                  <text fg={i() === state.cursor ? theme.primary : theme.text} wrapMode="word">
                    {label}
                    <Show when={option()?.description}>
                      <span style={{ fg: theme.textMuted }}> — {option() .description}</span>
                    </Show>
                  </text>
                </box>
              )
            }}
          </For>
        </box>
        <Show when={state.typing}>
          <box backgroundColor={theme.backgroundElement} paddingLeft={1} paddingRight={1}>
            <textarea
              ref={(r                    ) => (custom = r)}
              placeholder="Type your answer…"
              placeholderColor={theme.textMuted}
              textColor={theme.text}
              focusedTextColor={theme.text}
              cursorColor={theme.text}
              initialValue={state.custom[state.index] ?? ""}
              keyBindings={[{ name: "return", action: "submit" }]}
            />
          </box>
        </Show>
        <Show when={question()?.options[state.cursor]?.preview}>
          <box backgroundColor={theme.backgroundElement} paddingLeft={1} paddingRight={1}>
            <text fg={theme.textMuted}>{question() .options[state.cursor].preview}</text>
          </box>
        </Show>
      </box>
      <box flexDirection="row" gap={2} paddingTop={1} paddingLeft={2} paddingRight={3} paddingBottom={1} backgroundColor={theme.backgroundElement}>
        <text fg={theme.text}>
          ↑↓ <span style={{ fg: theme.textMuted }}>select</span>
        </text>
        <Show when={question()?.multiSelect}>
          <text fg={theme.text}>
            space <span style={{ fg: theme.textMuted }}>toggle</span>
          </text>
        </Show>
        <Show when={count() > 1}>
          <text fg={theme.text}>
            ⇆ <span style={{ fg: theme.textMuted }}>question</span>
          </text>
        </Show>
        <text fg={theme.text}>
          enter <span style={{ fg: theme.textMuted }}>{state.index + 1 < count() ? "next" : "submit"}</span>
        </text>
        <text fg={theme.text}>
          esc <span style={{ fg: theme.textMuted }}>dismiss</span>
        </text>
      </box>
    </box>
  )
}

// ---------------------------------------------------------------------------
// MCP elicitation: a server asks for input during a tool call (like opencode 2.1.4). Forms are filled
// field by field in dialogs (text, number, choice, multiselect, yes/no, URL); "url" requests open a link.
// ---------------------------------------------------------------------------



function fieldsOf(schema     )          {
  const required = new Set        (Array.isArray(schema?.required) ? schema.required : [])
  return Object.entries     (schema?.properties ?? {}).map(([key, value]) => ({
    key,
    title: value?.title ?? key,
    description: value?.description,
    schema: value ?? {},
    required: required.has(key),
  }))
}

/** Choices of an enum field: enum (+ enumNames), oneOf/anyOf [{ const, title }]. */
function choicesOf(schema     )                                                 {
  if (Array.isArray(schema?.enum))
    return schema.enum.map((value     , i        ) => ({ value: String(value), label: String(schema.enumNames?.[i] ?? value) }))
  const list = schema?.oneOf ?? schema?.anyOf
  if (Array.isArray(list) && list.every((item     ) => item && "const" in item))
    return list.map((item     ) => ({ value: String(item.const), label: String(item.title ?? item.const) }))
  return undefined
}

/** One dialog that resolves with a value, or undefined when it was closed. */
function ask   (render                                           )                         {
  return new Promise((resolve) => {
    let settled = false
    const done = (value               ) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    dialog.replace(
      () => render((value) => {
        done(value)
        dialog.clear()
      }),
      () => done(undefined),
    )
  })
}

async function askField(field       )                                          {
  const schema = field.schema
  const label = `${field.title}${field.required ? "" : " (optional)"}${field.description ? ` — ${field.description}` : ""}`
  const choices = choicesOf(schema)
  if (schema.type === "boolean") {
    const options = [
      { title: "Yes", value: "true" },
      { title: "No", value: "false" },
      ...(field.required ? [] : [{ title: "Skip", value: "skip" }]),
    ]
    const picked = await ask        ((done) => <DialogSelectField title={label} options={options} onPick={done} />)
    if (picked === undefined) return undefined
    return { value: picked === "skip" ? undefined : picked === "true" }
  }
  if (choices && schema.type !== "array") {
    const options = [...choices.map((c) => ({ title: c.label, value: c.value })), ...(field.required ? [] : [{ title: "Skip", value: "\u0000skip" }])]
    const picked = await ask        ((done) => <DialogSelectField title={label} options={options} onPick={done} />)
    if (picked === undefined) return undefined
    return { value: picked === "\u0000skip" ? undefined : picked }
  }
  if (schema.type === "array") {
    const items = choicesOf(schema.items) ?? []
    const picked = await ask          ((done) => <DialogMultiField title={label} choices={items} onDone={done} />)
    if (picked === undefined) return undefined
    return { value: picked.length || field.required ? picked : undefined }
  }
  // Text and numbers: ask again until the value fits the schema.
  for (;;) {
    const hint = schema.format ? ` (${schema.format})` : schema.type === "integer" ? " (whole number)" : schema.type === "number" ? " (number)" : ""
    const raw = await ask        ((done) => (
      <DialogPrompt title={label + hint} value={schema.default !== undefined ? String(schema.default) : undefined} onConfirm={done} />
    ))
    if (raw === undefined) return undefined
    const text = raw.trim()
    if (!text) {
      if (!field.required) return { value: undefined }
      toast.show({ variant: "warning", message: `${field.title} is required` })
      continue
    }
    if (schema.type === "number" || schema.type === "integer") {
      const value = Number(text)
      const bad =
        !Number.isFinite(value) ||
        (schema.type === "integer" && !Number.isInteger(value)) ||
        (typeof schema.minimum === "number" && value < schema.minimum) ||
        (typeof schema.maximum === "number" && value > schema.maximum)
      if (bad) {
        toast.show({ variant: "warning", message: `${field.title}: enter a ${schema.type === "integer" ? "whole number" : "number"}${typeof schema.minimum === "number" ? ` ≥ ${schema.minimum}` : ""}${typeof schema.maximum === "number" ? ` ≤ ${schema.maximum}` : ""}` })
        continue
      }
      return { value }
    }
    if ((typeof schema.minLength === "number" && text.length < schema.minLength) || (typeof schema.maxLength === "number" && text.length > schema.maxLength)) {
      toast.show({ variant: "warning", message: `${field.title}: ${schema.minLength ?? 0}–${schema.maxLength ?? "∞"} characters` })
      continue
    }
    if (schema.format === "email" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(text)) {
      toast.show({ variant: "warning", message: `${field.title}: enter an e-mail address` })
      continue
    }
    if (schema.format === "uri" && !/^[a-z][a-z0-9+.-]*:\S+$/i.test(text)) {
      toast.show({ variant: "warning", message: `${field.title}: enter a URL` })
      continue
    }
    return { value: text }
  }
}

function DialogSelectField(props                                                                                                 ) {
  return <DialogSelect title={props.title} options={props.options} onSelect={(option) => props.onPick(option.value)} />
}

function DialogMultiField(props                                                                                                    ) {
  const [picked, setPicked] = createStore                      ({ values: [] })
  const options = createMemo(() => [
    { title: "✓ Done", value: "\u0000done", description: `${picked.values.length} selected` },
    ...props.choices.map((c) => ({
      title: c.label,
      value: c.value,
      gutter: <text fg={picked.values.includes(c.value) ? theme.primary : theme.textMuted}>{picked.values.includes(c.value) ? "[x]" : "[ ]"}</text>,
    })),
  ])
  return (
    <DialogSelect
      title={props.title}
      options={options()}
      onSelect={(option) => {
        if (option.value === "\u0000done") return props.onDone([...picked.values])
        setPicked("values", (values) => (values.includes(option.value) ? values.filter((v) => v !== option.value) : [...values, option.value]))
      }}
    />
  )
}

function openLink(url        ) {
  try {
    const [command, args] = openCommand(url)
    spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true }).unref()
  } catch {}
}

export function ElicitationPrompt(props                             ) {
  const request = () => props.entry.request
  const isUrl = () => request().mode === "url"
  const fields = createMemo(() => fieldsOf(request().requestedSchema))
  const [state, setState] = createStore({ selected: isUrl() ? "open" : "fill", opened: false })
  const options = createMemo(() =>
    isUrl()
      ? [
          { key: "open", label: state.opened ? "Open again" : "Open link" },
          { key: "done", label: "Done" },
          { key: "decline", label: "Decline" },
        ]
      : [
          { key: "fill", label: fields().length ? "Fill in" : "Accept" },
          { key: "decline", label: "Decline" },
          { key: "cancel", label: "Cancel" },
        ],
  )

  async function fill() {
    const content                          = {}
    for (const field of fields()) {
      const answer = await askField(field)
      // Closing a dialog stops filling; the request stays until answered.
      if (!answer) return
      if (answer.value !== undefined) content[field.key] = answer.value
    }
    replyElicitation(props.entry.id, { action: "accept", content: content        })
  }

  function choose(key        ) {
    if (key === "fill") return void fill()
    if (key === "open") {
      if (request().url) openLink(request().url )
      setState({ opened: true, selected: "done" })
      return
    }
    if (key === "done") return replyElicitation(props.entry.id, { action: "accept" })
    replyElicitation(props.entry.id, { action: key === "decline" ? "decline" : "cancel" })
  }

  useLayer({
    enabled: () => !dialog.open,
    commands: () => [],
    handler: (event) => {
      const keys = options().map((option) => option.key)
      const at = keys.indexOf(state.selected)
      if (event.name === "left" || event.name === "h") setState("selected", keys[(at - 1 + keys.length) % keys.length])
      else if (event.name === "right" || event.name === "l" || event.name === "tab") setState("selected", keys[(at + 1) % keys.length])
      else if (event.name === "return") choose(state.selected)
      else if (event.name === "escape") choose("cancel")
      else return false
      return true
    },
  })

  return (
    <Frame
      borderColor={theme.warning}
      header={
        <text fg={theme.text}>
          <span style={{ fg: theme.warning }}>△ </span>
          <b>{request().title ?? `${request().displayName ?? request().serverName} asks for input`}</b>
          <span style={{ fg: theme.textMuted }}> · MCP {request().serverName}</span>
        </text>
      }
      body={
        <box gap={1} paddingLeft={1}>
          <text fg={theme.text}>{request().message}</text>
          <Show when={request().description}>
            <text fg={theme.textMuted}>{request().description}</text>
          </Show>
          <Show when={isUrl() && request().url}>
            <text fg={theme.primary}>{request().url}</text>
          </Show>
          <Show when={!isUrl() && fields().length}>
            <text fg={theme.textMuted}>
              {fields()
                .map((field) => `${field.title}${field.required ? "*" : ""}`)
                .join(" · ")}
            </text>
          </Show>
        </box>
      }
      options={options()}
      selected={state.selected}
      onSelect={choose}
      onHover={(key) => setState("selected", key)}
    />
  )
}
