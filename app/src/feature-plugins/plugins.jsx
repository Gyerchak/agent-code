// Plugin manager dialog (port of opencode's feature-plugins/system/plugins.tsx).
import { createMemo } from "solid-js"
import { theme } from "../context/theme"
import { dialog, DialogPrompt, DialogSelect } from "../ui/dialog"
import { toast } from "../ui/toast"


export function DialogPlugins(props                    ) {
  const options = createMemo(() =>
    props.api.plugins.list().map((plugin) => ({
      title: plugin.id,
      value: plugin.id,
      description: plugin.source === "internal" ? undefined : plugin.spec,
      category: plugin.source === "internal" ? "Internal" : "External",
      footer: plugin.error ? "error" : plugin.active ? "active" : plugin.enabled ? "inactive" : "disabled",
      gutter: (
        <text fg={plugin.error ? theme.error : plugin.active ? theme.success : theme.textMuted}>
          {plugin.active ? "●" : "○"}
        </text>
      ),
    })),
  )
  const install = () =>
    dialog.replace(() => (
      <DialogPrompt
        title="Install plugin (npm spec or file path)"
        placeholder="occ-plugin-example or ~/my-plugin.tsx"
        onConfirm={(spec) => {
          const value = spec.trim()
          dialog.replace(() => <DialogPlugins api={props.api} />, undefined, "large")
          if (!value) return
          void (async () => {
            if (!/^(\.|\/|~|file:)/.test(value)) {
              toast.show({ variant: "info", message: `Installing ${value}…`, duration: 60_000 })
              const result = await props.api.plugins.install(value)
              if (!result.ok) {
                toast.show({ variant: "error", message: `Install failed: ${result.message ?? "unknown error"}` })
                return
              }
            }
            const ok = await props.api.plugins.add(value)
            toast.show({ variant: ok ? "success" : "warning", message: ok ? `Added ${value}` : `Could not add ${value}` })
          })()
        }}
      />
    ))
  return (
    <DialogSelect
      title="Plugins"
      options={options()}
      emptyText="No plugins"
      onSelect={(option) => {
        const plugin = props.api.plugins.list().find((item) => item.id === option.value)
        if (!plugin) return
        if (plugin.error) toast.show({ variant: "error", title: plugin.id, message: plugin.error })
        void (plugin.active ? props.api.plugins.deactivate(plugin.id) : props.api.plugins.activate(plugin.id))
      }}
      actions={[{ keybind: "ctrl+i", label: "install", run: () => install() }]}
      footer={
        <text fg={theme.text}>
          enter <span style={{ fg: theme.textMuted }}>toggle</span>
        </text>
      }
    />
  )
}
