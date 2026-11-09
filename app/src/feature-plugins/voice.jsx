// occ-voice: talk to Claude and hear it, after OpenCodeBox's AgentMixer talking feature.
// Optional (off by default). One engine at a time — Kokoro, Kokoro + RVC, or OpenUtau —
// each with its own pool of voices. A Haiku agent (low effort) does the speaking.
import { createMemo, Show } from "solid-js"

import { onSessionEvent } from "../context/session"
import { active, newSession } from "../context/tabs"
import { theme } from "../context/theme"
import {
  components,
  condense,
  ENGINES,
  kokoroLabel,
  kokoroVoices,
  refreshDetection,
  rvcModels,
  setupPrompt,
  setVc,
  singers,
  speak,
  startRecording,
  stopRecording,
  stopSpeaking,
  stopWorkers,
  STT_MODELS,
  styles,
  talk,
  vc,
  voice,
  warmUp,

  preferred,
} from "../context/voice"

import { dialog, DialogSelect } from "../ui/dialog"
import { toast } from "../ui/toast"

const on = (value                     ) => (value ? "on" : "off")
const engineTitle = (id              ) => ENGINES.find((item) => item.id === (id ?? "kokoro"))?.title ?? "Kokoro"

function modelTitle() {
  const engine = vc().engine ?? "kokoro"
  if (engine === "kokoro") return kokoroLabel(vc().kokoroVoice ?? "jf_alpha")
  if (engine === "kokoro-rvc") return (rvcModels().find((item) => item.pth === vc().rvcModel) ?? rvcModels()[0])?.name ?? "no RVC models"
  return (singers().find((item) => item.dir === vc().utauSinger) ?? singers()[0])?.name ?? "no voicebanks"
}

function lastReply(messages       ) {
  const turn = messages.findLast((m)                        => m.type === "assistant")
  return turn?.parts
    .filter((part) => part.type === "text")
    .map((part) => (part                    ).text)
    .join("\n\n")
}

function context() {
  const store = active().store
  const reply = lastReply(store.messages)
  return [store.title && `Session: ${store.title}`, store.status === "running" && "Status: working right now", reply && `Last reply:\n${reply}`]
    .filter(Boolean)
    .join("\n")
}

// ---------------------------------------------------------------------------
// Push to talk
// ---------------------------------------------------------------------------

async function toggleTalk() {
  if (!vc().enabled) {
    toast.show({ variant: "warning", message: "Voice is off — turn it on in /voice" })
    return
  }
  if (!voice.recording) {
    try {
      startRecording()
      toast.show({ variant: "info", message: "🎙 Listening… press ctrl+x v again to send", duration: 60_000 })
    } catch (error) {
      toast.show({ variant: "error", message: (error         ).message })
    }
    return
  }
  toast.show({ variant: "info", message: "Transcribing…", duration: 20_000 })
  try {
    const heard = await stopRecording()
    if (!heard) {
      toast.show({ variant: "warning", message: "Didn't catch that" })
      return
    }
    if (vc().talkTarget === "tab") {
      toast.show({ variant: "info", message: `🎙 ${heard}`, duration: 4000 })
      active().send(heard)
      return
    }
    const reply = await talk(heard, context())
    toast.show({ variant: "info", message: `🎙 ${heard}\n🔊 ${reply.say}`, duration: 8000 })
    void speak(reply.say, reply.style)
  } catch (error) {
    toast.show({ variant: "error", message: (error         ).message })
  }
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

function DialogEngine() {
  return (
    <DialogSelect
      title="Voice engine (one at a time)"
      current={vc().engine ?? "kokoro"}
      options={ENGINES.map((item) => ({ title: item.title, value: item.id, description: item.description }))}
      onSelect={(option) => {
        setVc({ engine: option.value })
        stopWorkers()
        if (vc().enabled) warmUp()
        dialog.replace(() => <DialogVoice />)
      }}
    />
  )
}

function DialogModel() {
  const engine = vc().engine ?? "kokoro"
  const back = () => dialog.replace(() => <DialogVoice />)
  if (engine === "kokoro")
    return (
      <DialogSelect
        title="Kokoro voice"
        current={vc().kokoroVoice ?? "jf_alpha"}
        options={kokoroVoices().map((id) => ({
          title: kokoroLabel(id),
          value: id,
          description: { a: "US English", b: "British English", j: "Japanese timbre", z: "Chinese", e: "Spanish", f: "French", h: "Hindi", i: "Italian", p: "Portuguese" }[id[0]],
          category: id[1] === "f" ? "Female" : "Male",
        }))}
        onSelect={(option) => {
          setVc({ kokoroVoice: option.value })
          back()
        }}
      />
    )
  if (engine === "kokoro-rvc")
    return (
      <DialogSelect
        title="RVC voice"
        current={vc().rvcModel ?? rvcModels()[0]?.pth}
        emptyText="No RVC models found — use Check & set up"
        options={rvcModels().map((item) => ({ title: item.name, value: item.pth, description: item.source, category: preferred(item.name) ? "Preferred" : "Other" }))}
        onSelect={(option) => {
          setVc({ rvcModel: option.value })
          back()
        }}
      />
    )
  return (
    <DialogSelect
      title="OpenUtau voicebank"
      current={vc().utauSinger ?? singers()[0]?.dir}
      emptyText="No voicebanks found — use Check & set up"
      options={singers().map((item) => ({ title: item.name, value: item.dir, description: item.dir }))}
      onSelect={(option) => {
        setVc({ utauSinger: option.value })
        back()
      }}
    />
  )
}

function DialogRvcBase() {
  return (
    <DialogSelect
      title="Kokoro voice fed into RVC"
      current={vc().rvcBase ?? "jf_alpha"}
      options={kokoroVoices()
        .filter((id) => id[1] === "f" || id[1] === "m")
        .map((id) => ({ title: kokoroLabel(id), value: id, category: id[1] === "f" ? "Female" : "Male" }))}
      onSelect={(option) => {
        setVc({ rvcBase: option.value })
        dialog.replace(() => <DialogVoice />)
      }}
    />
  )
}

function DialogStyle() {
  const all = styles()
  return (
    <DialogSelect
      title="OpenUtau style"
      current={vc().utauStyle ?? "talking"}
      options={[
        { title: "Auto", value: "auto", description: "the talking agent picks a style per reply", category: "Auto" },
        ...Object.entries(all).map(([id, item]) => ({ title: item.title, value: id, description: item.instructions, category: "Styles" })),
      ]}
      onSelect={(option) => {
        setVc({ utauStyle: option.value })
        dialog.replace(() => <DialogVoice />)
      }}
    />
  )
}

function DialogStt() {
  return (
    <DialogSelect
      title="Speech recognition (faster-whisper)"
      current={`${vc().sttModel ?? "small"}:${vc().sttDevice ?? "auto"}`}
      options={STT_MODELS.flatMap((model) =>
        (["cuda", "cpu"]         ).map((device) => ({
          title: model,
          value: `${model}:${device}`,
          category: device === "cuda" ? "GPU" : "CPU",
          description: { tiny: "fastest", base: "fast", small: "balanced", medium: "accurate", "large-v3-turbo": "accurate, fast on GPU", "large-v3": "most accurate" }[model],
        })),
      )}
      onSelect={(option) => {
        const [model, device] = option.value.split(":")
        setVc({ sttModel: model, sttDevice: device                   })
        stopWorkers()
        dialog.replace(() => <DialogVoice />)
      }}
    />
  )
}

function DialogSetup() {
  const list = components()
  return (
    <DialogSelect
      title="Voice — check & set up"
      options={[
        {
          title: "Set up with Claude",
          value: "__setup",
          description: "opens a new tab that installs what's missing for this machine",
          category: "Actions",
        },
        { title: "Check again", value: "__refresh", category: "Actions" },
        ...list.map((item) => ({
          title: `${item.ok ? "✓" : "✗"} ${item.title}`,
          value: item.id,
          description: item.detail,
          category: item.needed ? "Needed for this engine" : "Other engines",
        })),
      ]}
      onSelect={async (option) => {
        if (option.value === "__refresh") {
          refreshDetection()
          dialog.replace(() => <DialogSetup />)
          return
        }
        if (option.value === "__setup") {
          dialog.clear()
          const session = await newSession()
          session.send(setupPrompt())
        }
      }}
    />
  )
}

function DialogVoice() {
  const engine = vc().engine ?? "kokoro"
  const options = [
    { title: "Voice", value: "enabled", footer: on(vc().enabled), description: "talk with ctrl+x v, hear replies", category: "Voice" },
    { title: "Engine", value: "engine", footer: engineTitle(engine), description: "Kokoro · Kokoro + RVC · OpenUtau", category: "Voice" },
    { title: "Voice model", value: "model", footer: modelTitle(), description: "pool of the selected engine", category: "Voice" },
    ...(engine === "kokoro-rvc"
      ? [
          { title: "RVC base voice", value: "rvcBase", footer: kokoroLabel(vc().rvcBase ?? "jf_alpha"), description: "Kokoro voice converted by RVC", category: "Voice" },
          { title: "RVC pitch", value: "rvcPitch", footer: `${vc().rvcPitch ?? 0 > 0 ? "+" : ""}${vc().rvcPitch ?? 0}`, description: "cycle −6 … +12 semitones", category: "Voice" },
        ]
      : []),
    ...(engine === "openutau"
      ? [{ title: "Style", value: "style", footer: styles()[vc().utauStyle ?? "talking"]?.title ?? "Auto", description: "singing, rapping, whispering, angry, happy, sad…", category: "Voice" }]
      : []),
    { title: "Read replies aloud", value: "readReplies", footer: on(vc().readReplies), description: "Haiku condenses each finished reply", category: "Talking" },
    {
      title: "Push-to-talk goes to",
      value: "talkTarget",
      footer: vc().talkTarget === "tab" ? "current tab" : "talking agent",
      description: "talking agent = quick Haiku chat · current tab = sent as a prompt",
      category: "Talking",
    },
    { title: "Spoken language", value: "language", footer: vc().language === "pl" ? "Polish" : "English", description: "Kokoro speaks English only; OpenUtau can read Polish", category: "Talking" },
    { title: "Speech recognition", value: "stt", footer: `${vc().sttModel ?? "small"} · ${vc().sttDevice ?? "auto"}`, category: "Talking" },
    { title: "Test voice", value: "test", description: "speak a sample line", category: "Tools" },
    { title: "Stop speaking", value: "stop", category: "Tools" },
    { title: "Check & set up…", value: "setup", description: "status of every component, install what's missing", category: "Tools" },
  ]
  return (
    <DialogSelect
      title="Voice"
      options={options}
      onSelect={(option) => {
        switch (option.value) {
          case "enabled":
            setVc({ enabled: !vc().enabled })
            if (vc().enabled) warmUp()
            else {
              stopSpeaking()
              stopWorkers()
            }
            return dialog.replace(() => <DialogVoice />)
          case "engine":
            return dialog.replace(() => <DialogEngine />)
          case "model":
            return dialog.replace(() => <DialogModel />)
          case "rvcBase":
            return dialog.replace(() => <DialogRvcBase />)
          case "rvcPitch": {
            const next = (vc().rvcPitch ?? 0) + 2
            setVc({ rvcPitch: next > 12 ? -6 : next })
            return dialog.replace(() => <DialogVoice />)
          }
          case "style":
            return dialog.replace(() => <DialogStyle />)
          case "readReplies":
            setVc({ readReplies: !vc().readReplies })
            return dialog.replace(() => <DialogVoice />)
          case "talkTarget":
            setVc({ talkTarget: vc().talkTarget === "tab" ? "agent" : "tab" })
            return dialog.replace(() => <DialogVoice />)
          case "language":
            setVc({ language: vc().language === "pl" ? "en" : "pl" })
            return dialog.replace(() => <DialogVoice />)
          case "stt":
            return dialog.replace(() => <DialogStt />)
          case "test":
            toast.show({ variant: "info", message: "Rendering a sample…" })
            void speak(
              vc().language === "pl" && engine === "openutau" ? "Cześć! Tu twój głos. Jak ci się podoba?" : "Hi! This is your voice. How does it sound?",
            )
            return
          case "stop":
            stopSpeaking()
            return
          case "setup":
            return dialog.replace(() => <DialogSetup />)
        }
      }}
    />
  )
}

/** Footer badge while listening / thinking / speaking. */
function VoiceBadge() {
  const label = createMemo(() => (voice.recording ? "🎙 listening" : voice.thinking ? "… thinking" : voice.speaking ? "🔊 speaking" : ""))
  return (
    <Show when={vc().enabled && label()}>
      <text fg={voice.recording ? theme.error : theme.accent}>{label()}</text>
    </Show>
  )
}

export const voicePlugin         = (api) => {
  api.keymap.registerLayer({
    commands: [
      { name: "voice.menu", title: "Voice settings", category: "Voice", slashName: "voice", run: () => dialog.replace(() => <DialogVoice />) },
      { name: "voice.talk", title: "Push to talk", category: "Voice", slashName: "talk", run: () => void toggleTalk() },
      { name: "voice.stop", title: "Stop speaking", category: "Voice", slashName: "hush", run: () => stopSpeaking() },
    ],
    bindings: { "voice.talk": "<leader>v" },
  })
  api.slots.register({ id: "occ-voice", order: 50, slots: { session_prompt_right: () => <VoiceBadge />, home_prompt_right: () => <VoiceBadge /> } })
  // Read finished replies of the focused tab aloud.
  const off = onSessionEvent((event) => {
    if (event.type !== "idle" || event.error || !vc().enabled || !vc().readReplies || event.session !== active()) return
    const text = lastReply(event.session.store.messages)
    if (!text) return
    void condense(text)
      .then((reply) => speak(reply.say, reply.style))
      .catch((error) => toast.show({ variant: "error", message: `Voice: ${(error         ).message}` }))
  })
  api.lifecycle.onDispose(() => {
    off()
    stopSpeaking()
    stopWorkers()
  })
  if (vc().enabled) warmUp()
}
