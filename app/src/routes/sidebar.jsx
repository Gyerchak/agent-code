import { TextAttributes } from "@opentui/core"
import { accessEngineName } from "../context/access"
import { scheduleControls } from "../context/controls"
import os from "node:os"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js"
import { catalog, planTitle } from "../context/catalog"
import { providerKind } from "../context/providers"
import { describeEntry, fableFallback, fableUpgrade, limits, liveWindow, orchestrator, scheduleOf, subagentRouting, untilText, whenText } from "../context/session"
import { active, store } from "../context/tabs"
import { theme, syntax } from "../context/theme"
import { runCommand } from "../context/keymap"
import { config, configRevision } from "../context/config"
import { appVersion } from "../context/version"
import { phoneServerState } from "../context/remote"
import { harnessById } from "../context/harnesses"
import { actions, clock } from "../context/app"
import { dialog } from "../ui/dialog"
import { Spinner } from "../component/spinner"
import { UsageBar } from "../component/prompt"
import { FileTreeSection } from "../component/filetree"
import { openChild, TASK_KINDS, taskEntries } from "./session"
import { Slot } from "../plugin/slots"
import { pluginStatus } from "../plugin/runtime"

export const SIDEBAR_WIDTH = 42

export const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

export function Section(props                                                                                      ) {
  const [open, setOpen] = createSignal(true)
  return (
    <box>
      <box flexDirection="row" gap={1} onMouseUp={() => props.collapsible && setOpen((value) => !value)}>
        <Show when={props.collapsible}>
          <text fg={theme.text}>{open() ? "▼" : "▶"}</text>
        </Show>
        <text fg={theme.text} flexGrow={1}>
          <b>{props.title}</b>
        </text>
        {props.right}
      </box>
      <Show when={open()}>{props.children}</Show>
    </box>
  )
}

export function resetsIn(at         ) {
  if (!at) return ""
  const ms = at - clock()
  if (ms <= 0) return "resets now"
  const minutes = Math.round(ms / 60000)
  if (minutes < 60) return `resets in ${minutes}m`
  const hours = Math.floor(minutes / 60)
  // The day and time as well, so it can be checked against claude.ai's "Resets Wed 00:59".
  const when = new Date(at).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })
  if (hours < 24) return `resets in ${hours}h ${minutes % 60}m · ${when}`
  return `resets ${when} · in ${Math.floor(hours / 24)}d ${hours % 24}h`
}

// ---------------------------------------------------------------------------
// Built-in sections (registered as built-in plugins in src/feature-plugins)
// ---------------------------------------------------------------------------

const span = (ms) => {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`
}

/**
 * Thinking time so far, all agents together (live while one thinks): two subagents thinking a minute each are two
 * minutes. The subagents' share after it.
 */
function ThinkingTime() {
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => (store.thinkingSince !== undefined || store.subThinkingOpen?.length) && setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(timer))
  const main = () => (store.thinkingMs ?? 0) + (store.thinkingSince !== undefined ? Math.max(0, now() - store.thinkingSince) : 0)
  const sub = () => (store.subThinkingMs ?? 0) + (store.subThinkingOpen ?? []).reduce((sum, start) => sum + Math.max(0, now() - start), 0)
  const thinkingNow = () => store.thinkingSince !== undefined || !!store.subThinkingOpen?.length
  return (
    <Show when={main() + sub() >= 1000}>
      <text fg={theme.textMuted}>
        {span(main() + sub())} thinking
        <Show when={sub() >= 1000}>
          <span> · {span(sub())} of it subagents</span>
        </Show>
        <Show when={thinkingNow()}>
          <span style={{ fg: theme.warning }}> · now</span>
        </Show>
      </text>
    </Show>
  )
}

export function ContextSection() {
  return (
    <Show when={store.context || (store.historyCost ?? 0) + store.cost + (store.liveCost ?? 0) > 0 || store.thinkingMs > 0 || store.subThinkingMs > 0}>
      <box>
        <text fg={theme.text}>
          <b>Context</b>
        </text>
        <Show when={store.context}>
          {(context                                                        ) => (
            <>
              <text fg={theme.textMuted}>{context().tokens.toLocaleString()} tokens</text>
              <Show when={context().percent}>
                <text fg={theme.textMuted}>{context().percent}% used</text>
              </Show>
            </>
          )}
        </Show>
        <ThinkingTime />
        <Show when={(store.historyCost ?? 0) + store.cost + (store.liveCost ?? 0) > 0}>
          <text fg={theme.textMuted}>
            {(store.historyCost ?? 0) + store.cost + (store.liveCost ?? 0) < 0.01 ? "<$0.01" : money.format((store.historyCost ?? 0) + store.cost + (store.liveCost ?? 0))} spent
            <Show when={(store.historySubCost ?? 0) + (store.subCost ?? 0) + (store.liveSubCost ?? 0) > 0}>
              <span style={{ fg: theme.textMuted }}>
                {" "}
                · subagents {(store.historySubCost ?? 0) + (store.subCost ?? 0) + (store.liveSubCost ?? 0) < 0.01 ? "<$0.01" : `≈${money.format((store.historySubCost ?? 0) + (store.subCost ?? 0) + (store.liveSubCost ?? 0))}`}
              </span>
            </Show>
          </text>
        </Show>
      </box>
    </Show>
  )
}

function Meter(props                                             ) {
  return (
    <Show when={props.window}>
      {(w                       ) => (
        <box>
          <UsageBar label={props.label} window={w()} width={18} reset={false} />
          <Show when={!w().resetsAt || w().resetsAt  > clock()}>
            <text fg={theme.textMuted}>{resetsIn(w().resetsAt)}</text>
          </Show>
        </box>
      )}
    </Show>
  )
}

const extraMoney = (minor        , exponent        , currency        ) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency }).format(minor / 10 ** exponent)

/** The meters of whoever pays for this tab's model: the Claude plan, the OpenCode Go plan, or nobody. */
export function UsageSection() {
  const kind = createMemo(() => providerKind(store.model))
  return (
    <Switch>
      <Match when={kind() === "anthropic" && limits.available && (limits.fiveHour || limits.week)}>
        <Section title="Usage" right={<text fg={theme.textMuted}>{catalog.plan ? planTitle() : ""}</text>}>
          <Show when={limits.rolling !== false}>
            <Meter label="5-hour " window={liveWindow(limits.fiveHour, "fiveHour")} />
          </Show>
          <Meter label="Weekly " window={liveWindow(limits.week, "week")} />
          {/* Per-model weekly limits (Fable on Max and up: at most a share of the weekly limit). */}
          <For each={limits.scoped ?? []}>
            {(w) => (
              <box>
                <Meter label={`${w.name} `.padEnd(7).slice(0, Math.max(7, w.name.length + 1))} window={w} />
                <Show when={w.allowance}>
                  <text fg={theme.textMuted}>up to {w.allowance}% of the weekly limit</text>
                </Show>
              </box>
            )}
          </For>
          <Show when={limits.offer && limits.rolling !== false}>
            <text fg={theme.warning} onMouseUp={() => runCommand("usage.reset")}>
              ↻ {limits.offer.label} available{limits.offer.weekly ? " (counts toward weekly)" : ""}
            </text>
          </Show>
          <Show when={limits.extra}>
            {(extra                                        ) => (
              <text fg={theme.textMuted} onMouseUp={() => runCommand("usage.extra")}>
                Extra usage{" "}
                <span style={{ fg: extra().enabled ? theme.warning : theme.textMuted }}>{extra().enabled ? "on" : "off"}</span>
                <Show when={extra().used > 0 || extra().enabled}>
                  {" · "}
                  {extraMoney(extra().used, extra().exponent, extra().currency)}
                  {extra().limit ? ` of ${extraMoney(extra().limit , extra().exponent, extra().currency)}` : ""} spent
                </Show>
              </text>
            )}
          </Show>
        </Section>
      </Match>
      <Match when={kind() === "go" && catalog.go}>
        <Section title="OpenCode Go">
          <Meter label="Rolling " window={catalog.go?.rolling} />
          <Meter label="Weekly  " window={catalog.go?.weekly} />
          <Meter label="Monthly " window={catalog.go?.monthly} />
        </Section>
      </Match>
      <Match when={kind() === "local"}>
        <Section title="Usage">
          <text fg={theme.textMuted}>Local model · free, no limits</text>
        </Section>
      </Match>
    </Switch>
  )
}

export function McpSection() {
  const mcp = createMemo(() => store.mcp.filter((server) => server.status !== "disabled"))
  return (
    <Show when={mcp().length}>
      <Section title="MCP" collapsible={mcp().length > 2}>
        <For each={mcp()}>
          {(server) => (
            <box flexDirection="row" gap={1}>
              <text
                flexShrink={0}
                fg={
                  server.status === "connected"
                    ? theme.success
                    : server.status === "failed"
                      ? theme.error
                      : server.status === "needs-auth"
                        ? theme.warning
                        : theme.textMuted
                }
              >
                •
              </text>
              <text fg={theme.text} wrapMode="word">
                {server.name}{" "}
                <span style={{ fg: theme.textMuted }}>
                  {server.status === "connected"
                    ? "Connected"
                    : server.status === "failed"
                      ? (server.error ?? "Failed")
                      : server.status === "needs-auth"
                        ? "Needs auth"
                        : "Connecting…"}
                </span>
              </text>
            </box>
          )}
        </For>
      </Section>
    </Show>
  )
}

export function TasksSection() {
  const entries = createMemo(() => taskEntries())
  const groups = createMemo(() =>
    TASK_KINDS.map((kind) => ({ ...kind, items: entries().filter((entry) => entry.kind === kind.id) })).filter((group) => group.items.length),
  )
  return (
    <Show when={entries().length}>
      <Section
        title="Tasks"
        collapsible={entries().length > 2}
        right={<text fg={theme.textMuted}>{entries().filter((entry) => entry.running).length || ""}</text>}
      >
        <For each={groups()}>
          {(group) => (
            <>
              <Show when={groups().length > 1}>
                <text fg={theme.textMuted}>{group.title}</text>
              </Show>
              <For each={group.items}>
                {(entry) => (
                  <box flexDirection="row" gap={1} onMouseUp={() => (entry.part ? openChild(entry.part) : runCommand("tasks.list"))}>
                    <Show
                      when={entry.running}
                      fallback={<text flexShrink={0} fg={entry.failed ? theme.error : theme.textMuted}>{entry.failed ? "✗" : "✓"}</text>}
                    >
                      <Spinner color={entry.kind === "subagent" || entry.kind === "remote" ? theme.secondary : theme.textMuted} />
                    </Show>
                    <text fg={entry.running ? theme.text : theme.textMuted} wrapMode="none" truncate flexShrink={1}>
                      {entry.title.replace(" Subagent — ", ": ")}
                    </text>
                  </box>
                )}
              </For>
            </>
          )}
        </For>
      </Section>
    </Show>
  )
}

/** Latest plan written in plan mode (ExitPlanMode), like opencode's plan panel. */
export function latestPlan() {
  for (let i = store.messages.length - 1; i >= 0; i--) {
    const message = store.messages[i]
    if (message.type !== "assistant") continue
    for (let j = message.parts.length - 1; j >= 0; j--) {
      const part = message.parts[j]
      if (part.type === "tool" && part.name === "ExitPlanMode" && typeof part.input.plan === "string") return part
    }
  }
  return undefined
}

export function PlanDialog(props                  ) {
  const dimensions = useTerminalDimensions()
  return (
    <box paddingLeft={4} paddingRight={4} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Plan
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.pop()}>
          esc
        </text>
      </box>
      <scrollbox maxHeight={Math.max(8, dimensions().height - 12)} scrollbarOptions={{ visible: false }}>
        <markdown syntaxStyle={syntax()} content={props.plan} fg={theme.markdownText} bg={theme.backgroundPanel} conceal={true} />
      </scrollbox>
    </box>
  )
}

export function PlanSection() {
  const plan = createMemo(() => latestPlan())
  const title = createMemo(() => {
    const text = String(plan()?.input.plan ?? "")
    const heading = text.match(/^#+\s+(.+)$/m)
    return (heading?.[1] ?? text.split("\n").find((line) => line.trim()) ?? "").trim()
  })
  return (
    <Show when={plan() || store.mode === "plan"}>
      <Section title="Plan">
        <Show
          when={plan()}
          fallback={<text fg={theme.textMuted}>Planning… (read-only)</text>}
        >
          <box onMouseUp={() => dialog.replace(() => <PlanDialog plan={String(plan() .input.plan)} />, undefined, "xlarge")}>
            <text fg={theme.text} wrapMode="word">
              {title()}
            </text>
            <text fg={theme.textMuted}>
              {plan() .status === "completed" ? "approved" : plan() .status === "error" ? "rejected" : "awaiting approval"} · click to view
            </text>
          </box>
        </Show>
      </Section>
    </Show>
  )
}

export function TodoSection() {
  return (
    <Show when={store.todos.length}>
      <Section
        title="Todo"
        collapsible={store.todos.length > 2}
        right={
          <text fg={theme.textMuted}>
            {store.todos.filter((todo) => todo.status === "completed").length}/{store.todos.length}
          </text>
        }
      >
        <For each={store.todos}>
          {(todo) => (
            <text
              fg={todo.status === "in_progress" ? theme.warning : todo.status === "completed" ? theme.textMuted : theme.text}
              wrapMode="word"
            >
              {todo.status === "completed" ? "[✓]" : todo.status === "in_progress" ? "[•]" : "[ ]"} {todo.content}
            </text>
          )}
        </For>
      </Section>
    </Show>
  )
}

export function FilesSection() {
  const files = createMemo(() => Object.entries(store.files))
  return (
    <Show when={files().length}>
      <Section title="Modified Files" collapsible={files().length > 2}>
        <For each={files()}>
          {([file, diff]) => (
            <box flexDirection="row" gap={1} justifyContent="space-between">
              <text fg={theme.textMuted} wrapMode="none" truncate flexShrink={1}>
                {file}
              </text>
              <box flexDirection="row" gap={1} flexShrink={0}>
                <Show when={diff.additions}>
                  <text fg={theme.diffAdded}>+{diff.additions}</text>
                </Show>
                <Show when={diff.deletions}>
                  <text fg={theme.diffRemoved}>-{diff.deletions}</text>
                </Show>
              </box>
            </box>
          )}
        </For>
      </Section>
    </Show>
  )
}

export function PluginsSection() {
  const external = createMemo(() => pluginStatus().filter((plugin) => plugin.source !== "internal"))
  const count = createMemo(() => store.plugins.length + external().length)
  return (
    <Show when={count() || store.skills.length}>
      <Section title="Plugins" collapsible={count() > 2}>
        <For each={store.plugins}>
          {(plugin) => (
            <text fg={theme.text} wrapMode="none" truncate>
              <span style={{ fg: theme.success }}>•</span> {plugin.name}
              <span style={{ fg: theme.textMuted }}> {plugin.version ?? ""} claude</span>
            </text>
          )}
        </For>
        <For each={external()}>
          {(plugin) => (
            <text fg={theme.text} wrapMode="none" truncate onMouseUp={() => runCommand("plugins.list")}>
              <span style={{ fg: plugin.active ? theme.success : plugin.enabled ? theme.error : theme.textMuted }}>•</span> {plugin.id}
              <span style={{ fg: theme.textMuted }}> Agent Code</span>
            </text>
          )}
        </For>
        <Show when={store.skills.length}>
          <text fg={theme.textMuted}>
            {store.skills.length} skill{store.skills.length === 1 ? "" : "s"}
            {store.agents.length ? ` · ${store.agents.length} agent${store.agents.length === 1 ? "" : "s"}` : ""}
          </text>
        </Show>
      </Section>
    </Show>
  )
}

const clockTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })

/** One schedule row: a click runs `click`, a right click `right` (freeze / unfreeze); ctrl+click `ctrl`. */
function PlanRow(props) {
  const [hover, setHover] = createSignal(false)
  return (
    <box
      flexShrink={0}
      paddingLeft={1}
      backgroundColor={hover() || props.highlight ? theme.backgroundElement : theme.backgroundPanel}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={(event) => runCommand(event?.button === 2 ? props.right : event?.modifiers?.ctrl && props.ctrl ? props.ctrl : props.click)}
    >
      <text fg={props.on ? theme.text : theme.textMuted} wrapMode="none" truncate>
        <span style={{ fg: props.on ? (props.color ?? theme.warning) : theme.textMuted }}>{props.icon}</span>
        {`  ${props.label}`}
        <Show when={props.extra}>
          <span style={{ fg: theme.textMuted }}>{props.extra}</span>
        </Show>
        <Show when={hover() && props.hint}>
          <span style={{ fg: theme.textMuted }}>{` (${props.hint})`}</span>
        </Show>
      </text>
    </box>
  )
}

/** One of the schedule rows (context/controls.js: the web app shows the same). */
function ControlRow(props) {
  const row = () => (clock(), configRevision(), scheduleControls(store).find((item) => item.id === props.id))
  return (
    <PlanRow
      icon={row().icon}
      on={row().on}
      highlight={row().highlight}
      color={theme[row().color] ?? theme.warning}
      label={row().label}
      extra={row().extra}
      hint={row().hint}
      click={row().click}
      right={row().right}
      ctrl={row().ctrl}
    />
  )
}

/** Schedules: how much is planned for this tab; a click lists it all, a right click freezes / unfreezes it all. */
export const SchedulesRow = () => <ControlRow id="schedules" />
/** Resume at: the next planned resume (a break's own is on the Break row). */
export const ResumeRow = () => <ControlRow id="resume" />
/** Stop at: the closest planned stop (a time, then a limit level, then near any limit). */
export const StopAfterRow = () => <ControlRow id="stop" />
/** Break (it was "Pause"): stop, then resume; ctrl+click stops at once; on a break a click goes on now. */
export const PauseBar = () => <ControlRow id="break" />

/** One switch row of the sidebar's footer: a click runs `toggle`, a right click `settings`. */
function SwitchRow(props) {
  const [hover, setHover] = createSignal(false)
  return (
    <box
      flexShrink={0}
      paddingLeft={1}
      backgroundColor={hover() ? theme.backgroundElement : theme.backgroundPanel}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={(event) => runCommand(event?.button === 2 ? props.settings : props.toggle)}
    >
      <text fg={props.on ? theme.text : theme.textMuted} wrapMode="none" truncate>
        <span style={{ fg: props.on ? theme.success : theme.textMuted }}>{props.on ? "◉" : "○"}</span>
        {"  " + props.label}
        <Show when={hover()}>
          <span style={{ fg: theme.textMuted }}>{` (right click: ${props.hint ?? "settings"})`}</span>
        </Show>
      </text>
    </box>
  )
}

/**
 * Auto-resume, right below the pause bar: a click turns it on or off (default on), a right click switches between
 * resuming all waiting tabs at once and one at a time (the same as Settings → "Auto resume" / "Resume").
 */
export function AutoResumeToggle() {
  const on = () => (configRevision(), config.autoResume !== false)
  const one = () => (configRevision(), config.autoResumeMode === "one")
  return (
    <SwitchRow
      on={on()}
      label={on() ? `Auto-resume on · ${one() ? "one at a time" : "all tabs"}` : "Auto-resume off"}
      hint={one() ? "all tabs" : "one at a time"}
      toggle="auto.resume.toggle"
      settings="auto.resume.mode"
    />
  )
}


/** Fable fallback: a Fable tab at the Fable limit goes on with another model, its level raised. */
export function FableFallbackToggle() {
  const rule = () => (configRevision(), fableFallback())
  return (
    <SwitchRow
      on={rule().enabled}
      label={rule().enabled ? "Fable fallback on" : "Fable fallback off"}
      toggle="fable.fallback.toggle"
      settings="fable.fallback.settings"
    />
  )
}

/** Back to Fable: after a used-up Fable limit resets, Opus/Sonnet/Haiku tabs return to Fable, their level lowered. */
export function FableReturnToggle() {
  const rule = () => (configRevision(), fableUpgrade())
  return (
    <SwitchRow
      on={rule().enabled}
      label={rule().enabled ? "Back to Fable on" : "Back to Fable off"}
      toggle="fable.upgrade.toggle"
      settings="fable.upgrade.settings"
    />
  )
}

/**
 * Orchestrator mode (with Subagent routing): a click opens its settings — the "Usage" and "Subagent routing" tabs —
 * a right click turns orchestrator mode on or off.
 */
export function OrchestratorToggle() {
  const on = () => (configRevision(), orchestrator().enabled)
  const routing = () => (configRevision(), subagentRouting().enabled)
  return (
    <SwitchRow
      on={on() || routing()}
      label={`Orchestrator mode ${on() ? "on" : "off"}${routing() ? " · routing on" : ""}`}
      hint="on/off"
      toggle="orchestrator.settings"
      settings="orchestrator.toggle"
    />
  )
}


/** The phone app, where it is seen every day: whether its server runs and how many phones are on; a click opens it. */
export function PhoneRow() {
  const [hover, setHover] = createSignal(false)
  const state = () => (clock(), configRevision(), phoneServerState())
  return (
    <box
      flexShrink={0}
      paddingLeft={1}
      backgroundColor={hover() ? theme.backgroundElement : theme.backgroundPanel}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={() => runCommand("phone.show")}
    >
      <text fg={state().running ? theme.text : theme.textMuted} wrapMode="none" truncate>
        <span style={{ fg: state().running ? theme.success : theme.textMuted }}>{state().running ? "◉" : "○"}</span>
        {state().running ? `  Phone on · ${state().clients} connected` : "  Phone app off"}
        <Show when={hover()}>
          <span style={{ fg: theme.textMuted }}>{state().running ? " (pair, settings)" : " (click to set up)"}</span>
        </Show>
      </text>
    </box>
  )
}

/**
 * Access settings of the tab's harness, right above the harness line: a click opens them (a tab per harness), a right
 * click copies them to the other harnesses (after a yes/no, with the harnesses to pick).
 */
export function AccessRow() {
  const [hover, setHover] = createSignal(false)
  return (
    <box
      flexShrink={0}
      paddingLeft={1}
      backgroundColor={hover() ? theme.backgroundElement : theme.backgroundPanel}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={(event) => runCommand(event?.button === 2 ? "access.sync" : "access.settings")}
    >
      <text fg={theme.text} wrapMode="none" truncate>
        <span style={{ fg: theme.primary }}>⚙</span>
        {`  Access · ${accessEngineName(store.engine)}`}
        <Show when={hover()}>
          <span style={{ fg: theme.textMuted }}> (right click: copy to the others)</span>
        </Show>
      </text>
    </box>
  )
}

/** The harness the tab's model runs in, with its version when it is known. */
function engineLabel() {
  if (!store.engine) return `Claude Code ${store.version ?? ""}`.trim()
  return `${harnessById(store.engine)?.name ?? store.engine} ${store.engineVersion ?? ""}`.trim()
}

export function SidebarFooter() {
  const dimensions = useTerminalDimensions()
  const location = createMemo(() => {
    const home = os.homedir()
    const dir = home && store.cwd.startsWith(home) ? "~" + store.cwd.slice(home.length) : store.cwd
    return store.branch ? `${dir}:${store.branch}` : dir
  })
  return (
    <>
      <box flexShrink={0}>
        <SchedulesRow />
        <ResumeRow />
        <StopAfterRow />
        <PauseBar />
        <AutoResumeToggle />
        <FableFallbackToggle />
        <FableReturnToggle />
        <OrchestratorToggle />
        <PhoneRow />
      </box>
      <text fg={theme.textMuted} wrapMode="none" truncate>
        {location()}
      </text>
      <AccessRow />
      <Show when={dimensions().height >= 20}>
        {/* This harness and its version; to the right, the harness the tab's model runs in. */}
        <box flexDirection="row" justifyContent="space-between" gap={1}>
          <text fg={theme.textMuted} wrapMode="none" flexShrink={0}>
            <span style={{ fg: theme.success }}>•</span> <b>Agent</b>
            <span style={{ fg: theme.text }}>
              <b>Code</b>
            </span>{" "}
            <span>{appVersion()}</span>
          </text>
          <text fg={theme.textMuted} wrapMode="none" truncate flexShrink={1}>
            {engineLabel()}
          </text>
        </box>
      </Show>
    </>
  )
}

// The side panel's tabs (as in opencode's desktop app): everything, the files, or the work in progress.
const SIDE_TABS = [
  { id: "session", title: "Session" },
  { id: "files", title: "Files" },
  { id: "work", title: "Work" },
]
const [sideTab, setSideTab] = createSignal("session")
export const nextSideTab = () => setSideTab((id) => SIDE_TABS[(SIDE_TABS.findIndex((tab) => tab.id === id) + 1) % SIDE_TABS.length].id)

function SideTabs() {
  return (
    <box flexShrink={0} flexDirection="row" gap={1} paddingBottom={1}>
      <For each={SIDE_TABS}>
        {(tab) => (
          <box paddingLeft={1} paddingRight={1} backgroundColor={sideTab() === tab.id ? theme.backgroundElement : undefined} onMouseUp={() => setSideTab(tab.id)}>
            <text fg={sideTab() === tab.id ? theme.text : theme.textMuted} attributes={sideTab() === tab.id ? TextAttributes.BOLD : undefined}>
              {tab.title}
            </text>
          </box>
        )}
      </For>
    </box>
  )
}

export function Sidebar() {
  const title = createMemo(() => store.title ?? "New session")
  return (
    <box
      backgroundColor={theme.backgroundPanel}
      width={SIDEBAR_WIDTH}
      height="100%"
      paddingTop={0}
      paddingBottom={0}
      paddingLeft={2}
      paddingRight={2}
    >
      <box flexShrink={0} paddingRight={2} paddingBottom={1}>
        <Slot name="sidebar_title" mode="single_winner" session_id={store.sessionID ?? ""} title={title()}>
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            {title()}
          </text>
        </Slot>
      </box>
      <SideTabs />
      <scrollbox flexGrow={1} minHeight={0} horizontalScrollbarOptions={{ visible: false }} verticalScrollbarOptions={{ visible: false }}>
        <box flexShrink={0} gap={1} paddingRight={1}>
          <Switch>
            <Match when={sideTab() === "files"}>
              <FilesSection />
              <FileTreeSection />
            </Match>
            <Match when={sideTab() === "work"}>
              <TasksSection />
              <PlanSection />
              <TodoSection />
              <Show when={!taskEntries().length && !store.todos?.length}>
                <text fg={theme.textMuted}>No tasks, plan or checklist in this session yet.</text>
              </Show>
            </Match>
            <Match when={true}>
              <Slot name="sidebar_content" session_id={store.sessionID ?? ""} />
            </Match>
          </Switch>
        </box>
      </scrollbox>
      <box flexShrink={0} gap={1} paddingTop={1}>
        <Slot name="sidebar_footer" mode="single_winner" session_id={store.sessionID ?? ""}>
          <SidebarFooter />
        </Slot>
      </box>
    </box>
  )
}
