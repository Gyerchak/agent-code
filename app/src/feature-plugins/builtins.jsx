// Built-in features implemented on the plugin API, like opencode's packages/tui/src/feature-plugins.
import { createMemo, createSignal, Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { runCommand } from "../context/keymap"
import { active } from "../context/tabs"
import { theme } from "../context/theme"

import {
  ContextSection,
  FilesSection,
  McpSection,
  PlanSection,
  PluginsSection,
  TasksSection,
  TodoSection,
  UsageSection,
} from "../routes/sidebar"
import { DialogPlugins } from "./plugins"
import { FileTreeSection, openFileTree } from "../component/filetree"
import { agentsPlugin } from "./agents"
import { memoryPlugin } from "./memory"
import { voicePlugin } from "./voice"
import { toolsPlugin } from "./tools"



const section = (id        , order        , render           )          => ({
  id,
  tui: (api) => {
    api.slots.register({ id, order, slots: { sidebar_content: () => render() } })
  },
})

function HomeFooter() {
  const dimensions = useTerminalDimensions()
  const store = () => active().store
  const connected = () => store().mcp.filter((server) => server.status === "connected").length
  const failed = () => store().mcp.filter((server) => server.status === "failed").length
  return (
    <box
      width="100%"
      paddingTop={dimensions().height < 16 ? 0 : 1}
      paddingBottom={dimensions().height < 16 ? 0 : 1}
      paddingLeft={2}
      paddingRight={2}
      flexDirection="row"
      flexShrink={0}
      gap={2}
    >
      <Show when={store().mcp.length}>
        <box gap={1} flexDirection="row" flexShrink={0} onMouseUp={() => runCommand("mcp.list")}>
          <text fg={theme.text}>
            <Show
              when={failed()}
              fallback={
                <>
                  <span style={{ fg: connected() ? theme.success : theme.textMuted }}>⊙ </span>
                  {connected()} MCP
                </>
              }
            >
              <span style={{ fg: theme.error }}>⊙ </span>
              {failed()} MCP failed
            </Show>
          </text>
          <Show when={dimensions().width >= 64}>
            <text fg={theme.textMuted}>/mcps</text>
          </Show>
        </box>
      </Show>
      <box flexGrow={1} />
      <Show when={dimensions().width >= 64}>
        <text fg={theme.textMuted}>{store().version ? `claude code ${store().version}` : ""}</text>
      </Show>
    </box>
  )
}

const TIPS = [
  "Press {tab.next} to switch tabs; each tab runs its own Claude Code session",
  "Press {session.child.first} to open the first subagent, then ←/→ to cycle and ↑ to return",
  "Press {tasks.list} to see running subagents and background tasks",
  "Press {model.list} and ctrl+f to favourite a model",
  "Type ! to run a shell command; its output is added to Claude's context",
  "Use /settings to auto-allow tools, stop clarifying questions, or turn off tests",
  "Small sessions compacts automatically before the context gets expensive",
  "Turn on Auto model in /settings to let Haiku pick the model for each new session",
  "Press {variant.cycle} to cycle the effort variant",
  "Press {command.palette.show} for every command",
]

function HomeTips(props                                                           ) {
  const dimensions = useTerminalDimensions()
  const [index] = createSignal(Math.floor(Math.random() * TIPS.length))
  const text = createMemo(() => TIPS[index()].replace(/\{([\w.]+)\}/g, (_, id) => props.format(id) || id))
  return (
    <Show when={!props.hidden() && dimensions().height >= 24 && dimensions().width >= 60}>
      <box width="100%" maxWidth={75} paddingTop={2} flexDirection="row" gap={1}>
        <text fg={theme.warning} flexShrink={0}>
          ● Tip
        </text>
        <text fg={theme.textMuted} wrapMode="word">
          {text()}
        </text>
      </box>
    </Show>
  )
}

export const builtins            = [
  section("sidebar.context", 100, () => <ContextSection />),
  section("sidebar.usage", 150, () => <UsageSection />),
  section("sidebar.mcp", 200, () => <McpSection />),
  section("sidebar.tasks", 300, () => <TasksSection />),
  section("sidebar.plan", 350, () => <PlanSection />),
  section("sidebar.todo", 400, () => <TodoSection />),
  section("sidebar.files", 500, () => <FilesSection />),
  section("sidebar.tree", 550, () => <FileTreeSection />),
  { id: "occ-agents", tui: agentsPlugin },
  { id: "occ-memory", tui: memoryPlugin },
  { id: "occ-voice", tui: voicePlugin },
  { id: "occ-tools", tui: toolsPlugin },
  section("sidebar.plugins", 600, () => <PluginsSection />),
  {
    id: "files.tree",
    tui: (api) => {
      api.keymap.registerLayer({
        commands: [{ name: "files.tree", title: "Project files", category: "Session", slashName: "files", run: () => openFileTree() }],
      })
    },
  },
  {
    id: "home.footer",
    tui: (api) => {
      api.slots.register({ id: "home.footer", order: 100, slots: { home_footer: () => <HomeFooter /> } })
    },
  },
  {
    id: "home.tips",
    tui: (api) => {
      const hidden = () => api.kv.get         ("tips_hidden", false)
      api.slots.register({
        id: "home.tips",
        order: 100,
        slots: { home_bottom: () => <HomeTips format={api.keys.format} hidden={hidden} /> },
      })
      api.keymap.registerLayer({
        commands: [
          {
            name: "tips.toggle",
            title: hidden() ? "Show tips" : "Hide tips",
            category: "System",
            run: () => api.kv.set("tips_hidden", !hidden()),
          },
        ],
      })
    },
  },
  {
    id: "system.notifications",
    tui: (api) => {
      // Background tabs: toast + terminal bell when they need you or finish.
      const title = (tab        ) => api.client.tabs.list().find((item) => item.tab === tab)?.title ?? "Session"
      const background = (tab        ) => api.client.tabs.active() !== tab
      api.event.on("permission.asked", (event) => {
        process.stdout.write("\x07")
        if (background(event.properties.tab))
          api.ui.toast({ variant: "warning", title: title(event.properties.tab), message: "Needs permission" })
      })
      api.event.on("question.asked", (event) => {
        process.stdout.write("\x07")
        if (background(event.properties.tab))
          api.ui.toast({ variant: "warning", title: title(event.properties.tab), message: "Has a question" })
      })
      api.event.on("session.status", (event) => {
        if (event.properties.status.type !== "idle" || !background(event.properties.tab)) return
        process.stdout.write("\x07")
        api.ui.toast({ variant: "success", title: title(event.properties.tab), message: "Finished" })
      })
    },
  },
  {
    id: "system.plugins",
    locked: true,
    tui: (api) => {
      api.keymap.registerLayer({
        commands: [
          {
            name: "plugins.list",
            title: "Plugins",
            category: "System",
            slashName: "plugins",
            run: () => api.ui.dialog.replace(() => <DialogPlugins api={api} />, undefined, "large"),
          },
        ],
      })
    },
  },
]
