// The control rows of a tab, as data: the terminal's sidebar draws them, the web app's side panel too, so both show
// and do the same. Each row: { id, icon, label, extra, on, highlight, click, right, ctrl, hint } — click / right /
// ctrl are command ids (a click, a right click, ctrl+click).
import { accessEngineName } from "./access"
import { config } from "./config"
import { describeEntry, fableFallback, fableUpgrade, orchestrator, scheduleOf, subagentRouting, untilText, whenText } from "./session"

const nextOf = (list) => list.filter((entry) => entry.at).sort((a, b) => a.at - b.at)[0]

/** Schedules, Resume at, Stop at and Break of a tab (its store). */
export function scheduleControls(s) {
  const planned = scheduleOf(s.sessionID)
  const live = planned.filter((entry) => !entry.frozen)
  const count = new Set(live.map((entry) => entry.group ?? entry.id)).size
  const frozen = planned.length - live.length
  const resumes = planned.filter((entry) => entry.kind === "resume" && !entry.group)
  const nextResume = nextOf(resumes.filter((entry) => !entry.frozen))
  const stops = planned.filter((entry) => entry.kind === "stop" && !entry.group)
  const liveStops = stops.filter((entry) => !entry.frozen)
  const firstStop = nextOf(liveStops) ?? liveStops.find((entry) => entry.window) ?? liveStops.find((entry) => entry.guard)
  const guard = liveStops.find((entry) => entry.guard)
  const breaks = live.filter((entry) => entry.group)
  const breakStop = nextOf(breaks.filter((entry) => entry.kind === "stop"))
  const breakBack = breakStop && breaks.find((entry) => entry.group === breakStop.group && entry.kind === "resume")
  const pause = s.pause
  return [
    {
      id: "schedules",
      icon: "☰",
      on: count > 0,
      color: "primary",
      label: `Schedules · ${count ? `${count} planned` : "none"}`,
      extra: frozen ? ` · ${frozen} frozen` : "",
      hint: "list · right click: freeze all",
      click: "schedules",
      right: "schedule.freeze.all",
    },
    {
      id: "resume",
      icon: "⏵",
      on: !!nextResume,
      color: "success",
      label: nextResume ? `Resume at ${whenText(nextResume.at)}` : resumes.length ? "Resume at: frozen" : "Resume at: none",
      extra: nextResume ? ` · ${untilText(nextResume.at)}` : "",
      hint: "plan · right click: freeze",
      click: "schedule.resume",
      right: "schedule.freeze.resume",
    },
    {
      id: "stop",
      icon: "⏹",
      on: !!firstStop,
      color: "warning",
      label: firstStop ? describeEntry(firstStop) : stops.length ? "Stop at: frozen" : "Stop at: none",
      extra: firstStop?.at
        ? ` · ${untilText(firstStop.at)}${guard ? ` · any ${guard.guard}%` : ""}`
        : firstStop && !firstStop.guard && guard
          ? ` · any ${guard.guard}%`
          : "",
      hint: "plan · right click: freeze",
      click: "schedule.stop",
      right: "schedule.freeze.stop",
    },
    {
      id: "break",
      icon: pause ? "▶" : "⏸",
      on: !!pause || !!breakStop,
      highlight: !!pause,
      color: "warning",
      label: pause
        ? `${pause.reason === "break" ? "On break" : pause.reason === "limit" || pause.reason === "stop" ? "Stopped" : "Paused"} · ${pause.until ? `until ${whenText(pause.until)}` : "until you resume"}`
        : "Break",
      extra: !pause && breakStop ? ` · ${whenText(breakStop.at)} → ${breakBack ? whenText(breakBack.at) : "until resumed"}` : "",
      hint: pause ? (pause.reason === "limit" ? "click: go on to 100%" : "click: go on now") : "plan · ctrl+click: now · right click: freeze",
      click: "session.pause",
      ctrl: pause ? "session.pause" : "pause.now",
      right: "schedule.freeze.break",
    },
  ]
}

/** Every control row of a tab: the schedule rows, then the switches and Access. */
export function controlRows(s, phone) {
  const fallback = fableFallback()
  const back = fableUpgrade()
  const orch = orchestrator().enabled
  const routing = subagentRouting().enabled
  const resumeOn = config.autoResume !== false
  return [
    ...scheduleControls(s),
    {
      id: "autoresume",
      icon: resumeOn ? "◉" : "○",
      on: resumeOn,
      color: "success",
      label: resumeOn ? `Auto-resume on · ${config.autoResumeMode === "one" ? "one at a time" : "all tabs"}` : "Auto-resume off",
      click: "auto.resume.toggle",
      right: "auto.resume.mode",
    },
    { id: "fallback", icon: fallback.enabled ? "◉" : "○", on: fallback.enabled, color: "success", label: fallback.enabled ? "Fable fallback on" : "Fable fallback off", click: "fable.fallback.toggle", right: "fable.fallback.settings" },
    { id: "backtofable", icon: back.enabled ? "◉" : "○", on: back.enabled, color: "success", label: back.enabled ? "Back to Fable on" : "Back to Fable off", click: "fable.upgrade.toggle", right: "fable.upgrade.settings" },
    {
      id: "orchestrator",
      icon: orch || routing ? "◉" : "○",
      on: orch || routing,
      color: "success",
      label: `Orchestrator mode ${orch ? "on" : "off"}${routing ? " · routing on" : ""}`,
      hint: "settings · right click: on/off",
      click: "orchestrator.settings",
      right: "orchestrator.toggle",
    },
    ...(phone ? [{ id: "phone", icon: phone.running ? "◉" : "○", on: phone.running, color: "success", label: phone.running ? `Phone on · ${phone.clients} connected` : "Phone app off", click: "phone.show", right: "phone.show" }] : []),
    { id: "access", icon: "⚙", on: true, color: "primary", label: `Access · ${accessEngineName(s.engine)}`, hint: "right click: copy to the others", click: "access.settings", right: "access.sync" },
  ]
}
