import { RGBA, SyntaxStyle,                                                } from "@opentui/core"
import { createMemo, createSignal } from "solid-js"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { config, saveConfig } from "./config"

// Themes are opencode's own theme files (MIT, see OPENCODE-LICENSE), resolved in dark mode.



const KEYS = [
  "primary",
  "secondary",
  "accent",
  "error",
  "warning",
  "success",
  "info",
  "text",
  "textMuted",
  "background",
  "backgroundPanel",
  "backgroundElement",
  "border",
  "borderActive",
  "borderSubtle",
  "diffAdded",
  "diffRemoved",
  "diffContext",
  "diffHunkHeader",
  "diffHighlightAdded",
  "diffHighlightRemoved",
  "diffAddedBg",
  "diffRemovedBg",
  "diffContextBg",
  "diffLineNumber",
  "diffAddedLineNumberBg",
  "diffRemovedLineNumberBg",
  "markdownText",
  "markdownHeading",
  "markdownLink",
  "markdownLinkText",
  "markdownCode",
  "markdownBlockQuote",
  "markdownEmph",
  "markdownStrong",
  "markdownHorizontalRule",
  "markdownListItem",
  "markdownListEnumeration",
  "markdownImage",
  "markdownImageText",
  "markdownCodeBlock",
  "syntaxComment",
  "syntaxKeyword",
  "syntaxFunction",
  "syntaxVariable",
  "syntaxString",
  "syntaxNumber",
  "syntaxType",
  "syntaxOperator",
  "syntaxPunctuation",
]








function ansi(code        ) {
  if (code < 16) {
    const table = [
      "#000000", "#800000", "#008000", "#808000", "#000080", "#800080", "#008080", "#c0c0c0",
      "#808080", "#ff0000", "#00ff00", "#ffff00", "#0000ff", "#ff00ff", "#00ffff", "#ffffff",
    ]
    return RGBA.fromHex(table[code] ?? "#000000")
  }
  if (code < 232) {
    const index = code - 16
    const val = (x        ) => (x === 0 ? 0 : x * 40 + 55)
    return RGBA.fromInts(val(Math.floor(index / 36)), val(Math.floor(index / 6) % 6), val(index % 6))
  }
  const gray = (code - 232) * 10 + 8
  return RGBA.fromInts(gray, gray, gray)
}

export function resolveTheme(json           , mode                   = "dark")        {
  const defs = json.defs ?? {}
  const resolve = (value            , chain           = [])       => {
    if (typeof value === "number") return ansi(value)
    if (typeof value === "object") return resolve(value[mode], chain)
    if (value === "transparent" || value === "none") return RGBA.fromInts(0, 0, 0, 0)
    if (value.startsWith("#")) return RGBA.fromHex(value)
    if (chain.includes(value)) throw new Error(`Circular color reference ${value}`)
    const next = defs[value] ?? json.theme[value]
    if (next === undefined) throw new Error(`Unknown color ${value}`)
    return resolve(next, [...chain, value])
  }
  const out = {}
  for (const key of KEYS) {
    const value = json.theme[key]
    out[key] = value === undefined ? RGBA.fromHex("#ff00ff") : resolve(value)
  }
  out.backgroundMenu = json.theme.backgroundMenu !== undefined ? resolve(json.theme.backgroundMenu) : out.backgroundElement
  out.selectedListItemText =
    json.theme.selectedListItemText !== undefined ? resolve(json.theme.selectedListItemText) : out.background
  out.thinkingOpacity = typeof json.theme.thinkingOpacity === "number" ? json.theme.thinkingOpacity : 0.6
  return out
}

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "themes")

function loadThemes() {
  const result                            = {}
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue
    try {
      result[file.replace(/\.json$/, "")] = JSON.parse(readFileSync(path.join(dir, file), "utf8"))
    } catch {}
  }
  return result
}

export const themes = loadThemes()
const [name, setName] = createSignal(themes[config.theme ?? ""] ? config.theme  : "opencode")
export const themeName = name

const current = createMemo(() => resolveTheme(themes[name()] ?? themes.opencode))

const [themeList, setThemeList] = createSignal(Object.keys(themes))
export { themeList }

/** Add a theme at runtime (plugins); returns false if the name is taken. */
export function installTheme(next        , json           ) {
  if (themes[next]) return false
  themes[next] = json
  setThemeList(Object.keys(themes))
  return true
}

export function setTheme(next        , persist = true) {
  if (!themes[next]) return
  setName(next)
  if (persist) {
    config.theme = next
    saveConfig()
  }
}

/** Reactive theme proxy: reading `theme.text` inside JSX tracks the current theme. */
export const theme = new Proxy({}         , {
  get(_, key        ) {
    return current()[key               ]
  },
})

/** Agent colors follow opencode's categorical order (blue, purple, green, orange, red). */
export function agentColor(index        ) {
  const list = [theme.secondary, theme.accent, theme.success, theme.warning, theme.error]
  return list[((index % list.length) + list.length) % list.length]
}

export function tint(base      , overlay      , alpha        ) {
  const mix = (a        , b        ) => Math.round((a + (b - a) * alpha) * 255)
  return RGBA.fromInts(mix(base.r, overlay.r), mix(base.g, overlay.g), mix(base.b, overlay.b))
}

export function alpha(color      , value        ) {
  return RGBA.fromValues(color.r, color.g, color.b, color.a * value)
}

function rule(scope          , foreground      , style                                               = {})                  {
  return { scope, style: { foreground, ...style } }
}

let owner
/** Syntax styles are native resources owned by the renderer; set before rendering. */
export function setSyntaxOwner(value                     ) {
  owner = value
}

function generateSyntax(t       , muted = false) {
  const fg = (c      ) => (muted ? t.textMuted : c)
  return SyntaxStyle.fromTheme([
    rule(["default"], fg(t.text)),
    rule(["prompt"], t.accent),
    rule(["extmark.file"], t.warning, { bold: true }),
    rule(["extmark.agent"], t.secondary, { bold: true }),
    rule(["extmark.paste"], t.background, { background: t.warning, bold: true }),
    rule(["comment", "comment.documentation"], fg(t.syntaxComment), { italic: true }),
    rule(["string", "symbol", "character.special", "character"], fg(t.syntaxString)),
    rule(["number", "boolean", "constant", "float"], fg(t.syntaxNumber)),
    rule(["keyword.return", "keyword.conditional", "keyword.repeat", "keyword.coroutine"], fg(t.syntaxKeyword), {
      italic: true,
    }),
    rule(["keyword.type"], fg(t.syntaxType), { bold: true, italic: true }),
    rule(["keyword.function", "function.method"], fg(t.syntaxFunction)),
    rule(["keyword"], fg(t.syntaxKeyword), { italic: true }),
    rule(["keyword.import", "string.escape", "string.regexp", "tag.attribute", "keyword.export"], fg(t.syntaxKeyword)),
    rule(["operator", "keyword.operator", "punctuation.delimiter", "keyword.conditional.ternary"], fg(t.syntaxOperator)),
    rule(
      ["variable", "variable.parameter", "function.method.call", "function.call", "property", "parameter", "field"],
      fg(t.syntaxVariable),
    ),
    rule(["variable.member", "function", "constructor"], fg(t.syntaxFunction)),
    rule(["type", "module", "class", "namespace"], fg(t.syntaxType)),
    rule(["type.definition"], fg(t.syntaxType), { bold: true }),
    rule(["punctuation", "punctuation.bracket"], fg(t.syntaxPunctuation)),
    rule(
      ["variable.builtin", "type.builtin", "function.builtin", "module.builtin", "constant.builtin", "variable.super"],
      fg(t.error),
    ),
    rule(["keyword.directive", "keyword.modifier", "keyword.exception"], fg(t.syntaxKeyword), { italic: true }),
    rule(["punctuation.special", "tag.delimiter"], fg(t.syntaxOperator)),
    rule(
      ["markup.heading", "markup.heading.2", "markup.heading.3", "markup.heading.4", "markup.heading.5", "markup.heading.6"],
      fg(t.markdownHeading),
      { bold: true },
    ),
    rule(["markup.heading.1"], fg(t.markdownHeading), { bold: true, underline: true }),
    rule(["markup.bold", "markup.strong"], fg(t.markdownStrong), { bold: true }),
    rule(["markup.italic"], fg(t.markdownEmph), { italic: true }),
    rule(["markup.list"], fg(t.markdownListItem)),
    rule(["markup.quote"], fg(t.markdownBlockQuote), { italic: true }),
    rule(["markup.raw", "markup.raw.block"], fg(t.markdownCode)),
    rule(["markup.raw.inline"], fg(t.markdownCode), { background: t.background }),
    rule(["markup.link", "markup.link.url", "string.special", "string.special.url"], fg(t.markdownLink), {
      underline: true,
    }),
    rule(["markup.link.label"], fg(t.markdownLinkText), { underline: true }),
    rule(["label"], fg(t.markdownLinkText)),
    rule(["spell", "nospell"], fg(t.text)),
    rule(["markup.underline"], fg(t.text), { underline: true }),
    rule(["comment.error"], fg(t.error), { italic: true, bold: true }),
    rule(["comment.warning"], fg(t.warning), { italic: true, bold: true }),
    rule(["comment.todo", "comment.note"], fg(t.info), { italic: true, bold: true }),
    rule(["attribute", "annotation"], fg(t.warning)),
    rule(["tag"], fg(t.error)),
    rule(["markup.strikethrough", "markup.list.unchecked", "debug"], t.textMuted),
    rule(["markup.list.checked"], fg(t.success)),
    rule(["diff.plus"], t.diffAdded, { background: t.diffAddedBg }),
    rule(["diff.minus"], t.diffRemoved, { background: t.diffRemovedBg }),
    rule(["diff.delta"], t.diffContext, { background: t.diffContextBg }),
    rule(["error"], t.error, { bold: true }),
    rule(["warning"], t.warning, { bold: true }),
    rule(["info"], t.info),
  ], owner )
}

const syntaxCache = new Map                     ()
function cachedSyntax(key        , factory                   ) {
  let style = syntaxCache.get(key)
  if (!style) {
    style = factory()
    syntaxCache.set(key, style)
  }
  return style
}

export const syntax = () => cachedSyntax(name(), () => generateSyntax(current()))
export const mutedSyntax = () => cachedSyntax(name() + ":muted", () => generateSyntax(current(), true))
