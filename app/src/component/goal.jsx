import { Show } from "solid-js"
import { active, store } from "../context/tabs"
import { theme } from "../context/theme"
import { dialog, DialogSelect } from "../ui/dialog"
import { setPromptText } from "./prompt"

// Claude Code's /goal, shown under the prompt like opencode's goal pill: the condition Claude keeps working
// toward and how many times it checked. A click offers to clear or change it.

function DialogGoal() {
  return (
    <DialogSelect
      title="Goal"
      flatten
      options={[
        { title: "Clear goal", value: "clear", description: "stop working toward it (/goal clear)" },
        { title: "Change goal", value: "change", description: "set a new condition (/goal …)" },
      ]}
      onSelect={(option) => {
        dialog.clear()
        if (option.value === "clear") active().send("/goal clear")
        else setPromptText(`/goal ${store.goal?.condition ?? ""}`)
      }}
    />
  )
}

export function GoalStatus() {
  return (
    <Show when={store.goal}>
      {(goal) => (
        <box flexShrink={0} paddingLeft={2} onMouseUp={() => dialog.replace(() => <DialogGoal />)}>
          <text fg={theme.textMuted} wrapMode="none">
            <span style={{ fg: theme.accent }}>◎ goal</span> {goal().condition.replace(/\s+/g, " ")}
            {goal().iterations ? ` · ${goal().iterations} check${goal().iterations === 1 ? "" : "s"}` : ""}
            {goal().last_reason ? ` · ${goal().last_reason.replace(/\s+/g, " ")}` : ""}
          </text>
        </box>
      )}
    </Show>
  )
}
