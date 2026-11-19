#!/usr/bin/env node
// acode-web: Agent Code as a desktop app in a browser window. It starts Agent Code without a terminal (the same
// program, drawing into memory, with a web server on 127.0.0.1) and opens its page in an app window of the browser
// engine you chose: Chromium-based (Chromium, Chrome, Brave, Edge, Vivaldi) or Firefox. Closing the window ends it.
//   acode-web [folder] [--engine chromium|firefox] [--user NAME] [--port N] [--no-window]
import { spawn, spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const args = process.argv.slice(2)
const flag = (name) => {
  const at = args.indexOf(`--${name}`)
  if (at < 0) return undefined
  const value = args[at + 1]
  args.splice(at, 2)
  return value
}
const noWindow = args.includes("--no-window") && args.splice(args.indexOf("--no-window"), 1)
let engine = flag("engine")
let user = flag("user")
const wantedPort = Number(flag("port")) || 0
const folder = path.resolve(args.find((arg) => !arg.startsWith("-")) ?? process.cwd())

const win = process.platform === "win32"
const mac = process.platform === "darwin"
const home = os.homedir()
const dataHome = win ? process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local") : process.env.XDG_DATA_HOME ?? path.join(home, ".local", "share")
const configHome = win ? process.env.APPDATA ?? path.join(home, "AppData", "Roaming") : process.env.XDG_CONFIG_HOME ?? path.join(home, ".config")
const base = path.join(dataHome, "agent-code")
const usersDir = path.join(base, "users")
const prefsFile = path.join(configHome, "agent-code", "web.json")
const prefs = (() => {
  try {
    return JSON.parse(readFileSync(prefsFile, "utf8"))
  } catch {
    return {}
  }
})()
const savePrefs = () => {
  mkdirSync(path.dirname(prefsFile), { recursive: true })
  writeFileSync(prefsFile, JSON.stringify(prefs, null, 2))
}
engine = engine ?? prefs.engine
// A user given on the command line (e.g. a box's "main") is for this start only: it isn't saved as the default.
const userGiven = !!user
user = user ?? prefs.user ?? "main"

// --- the browser ---------------------------------------------------------------------------------------------------
const which = (name) => {
  if (path.isAbsolute(name)) return existsSync(name) ? name : undefined
  const result = spawnSync(win ? "where" : "which", [name], { encoding: "utf8" })
  return result.status === 0 ? result.stdout.split(/\r?\n/)[0].trim() : undefined
}
const CHROMIUM = mac
  ? ["/Applications/Chromium.app/Contents/MacOS/Chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "/Applications/Vivaldi.app/Contents/MacOS/Vivaldi"]
  : win
    ? ["chrome", "msedge", "brave", "chromium", path.join(process.env["ProgramFiles"] ?? "", "Google/Chrome/Application/chrome.exe"), path.join(process.env["ProgramFiles(x86)"] ?? "", "Microsoft/Edge/Application/msedge.exe"), path.join(process.env["ProgramFiles"] ?? "", "BraveSoftware/Brave-Browser/Application/brave.exe")]
    : ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome", "brave", "brave-browser", "microsoft-edge-stable", "microsoft-edge", "vivaldi-stable", "vivaldi", "ungoogled-chromium"]
const FIREFOX = mac
  ? ["/Applications/Firefox.app/Contents/MacOS/firefox", "/Applications/LibreWolf.app/Contents/MacOS/librewolf"]
  : win
    ? ["firefox", path.join(process.env["ProgramFiles"] ?? "", "Mozilla Firefox/firefox.exe")]
    : ["firefox", "firefox-esr", "librewolf", "firefox-developer-edition", "floorp", "zen-browser"]
const find = (list) => list.map(which).find(Boolean)
if (!engine) engine = find(CHROMIUM) ? "chromium" : find(FIREFOX) ? "firefox" : undefined
let browser = prefs.browser && existsSync(prefs.browser) && prefs.engine === engine ? prefs.browser : engine === "firefox" ? find(FIREFOX) : find(CHROMIUM)
// The chosen engine's browser isn't there but the other one is: use that (and remember it).
if (!browser && !noWindow) {
  const other = engine === "firefox" ? find(CHROMIUM) : find(FIREFOX)
  if (other) {
    console.error(`acode-web: no ${engine === "firefox" ? "Firefox" : "Chromium-based"} browser found; using ${path.basename(other)} instead.`)
    engine = engine === "firefox" ? "chromium" : "firefox"
    browser = other
  }
}
if (!noWindow && !browser) {
  console.error(`acode-web: no ${engine === "firefox" ? "Firefox" : "Chromium-based"} browser found. Install one (see the README, "Web app"), or pass --engine chromium|firefox.`)
  process.exit(1)
}
prefs.engine = engine
savePrefs()

/** The browser profile for this window: one per user, and a separate one when that one is in use (a second window). */
function profileDir() {
  const name = user.replace(/[^\p{L}\p{N}_.-]/gu, "_")
  // Snap browsers can't open profiles in hidden folders of the home: theirs go under ~/snap/<name>/common.
  const snap = browser?.startsWith("/snap/") ? path.join(home, "snap", path.basename(browser), "common", "agent-code-web") : undefined
  const parent = snap ?? path.join(base, `web-${engine}`)
  let dir = path.join(parent, name)
  const lock = (folder) => path.join(folder, ".acode-web.pid")
  try {
    const pid = Number(readFileSync(lock(dir), "utf8"))
    process.kill(pid, 0)
    if (pid !== process.pid) dir = path.join(parent, `${name}-${process.pid}`)
  } catch {}
  mkdirSync(dir, { recursive: true })
  writeFileSync(lock(dir), String(process.pid))
  return dir
}

function openWindow(url) {
  const profile = profileDir()
  if (engine === "firefox") {
    // Firefox has no "app window" switch: its own profile hides the tabs and the address bar instead.
    mkdirSync(path.join(profile, "chrome"), { recursive: true })
    writeFileSync(
      path.join(profile, "user.js"),
      [
        'user_pref("toolkit.legacyUserProfileCustomizations.stylesheets", true);',
        'user_pref("browser.tabs.inTitlebar", 0);',
        'user_pref("browser.shell.checkDefaultBrowser", false);',
        'user_pref("browser.aboutwelcome.enabled", false);',
        'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
        'user_pref("browser.startup.homepage_override.mstone", "ignore");',
        'user_pref("browser.sessionstore.resume_from_crash", false);',
        'user_pref("browser.link.open_newwindow", 2);',
        "",
      ].join("\n"),
    )
    writeFileSync(path.join(profile, "chrome", "userChrome.css"), "#TabsToolbar, #nav-bar, #PersonalToolbar, #sidebar-box, #sidebar-splitter { visibility: collapse !important; }\n")
    return spawn(browser, ["--profile", profile, "--no-remote", "--new-instance", "--name", "agent-code", "--class", "agent-code", url], { stdio: "ignore" })
  }
  return spawn(browser, [`--app=${url}`, `--user-data-dir=${profile}`, "--class=agent-code", "--no-first-run", "--no-default-browser-check", "--disable-features=Translate", "--window-size=1320,860"], { stdio: "ignore" })
}

// --- Agent Code, without a terminal --------------------------------------------------------------------------------
const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(wantedPort, "127.0.0.1", () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })

const token = randomBytes(18).toString("base64url")
// The address the browser opens (and that other users can see in the process list) carries a one-time code only.
let code = randomBytes(12).toString("base64url")
const port = await freePort()
// A private folder for the note Agent Code leaves when it wants a restart (another user) or to quit.
const control = path.join(mkdtempSync(path.join(os.tmpdir(), "acode-web-")), "control.json")
let core
let window
let quitting = false

function userEnv(name) {
  // "main" is the Agent Code you already have; any other user is a setup of its own (settings, keys, tabs, chats).
  if (name === "main") return { cwd: folder, env: {} }
  const dir = path.join(usersDir, name)
  for (const part of ["config", "state", "data", "workspace"]) mkdirSync(path.join(dir, part), { recursive: true })
  return { cwd: path.join(dir, "workspace"), env: { XDG_CONFIG_HOME: path.join(dir, "config"), XDG_STATE_HOME: path.join(dir, "state"), XDG_DATA_HOME: path.join(dir, "data") } }
}

function startCore() {
  const { cwd, env } = userEnv(user)
  const index = path.join(root, "dist", "index.js")
  if (!existsSync(index)) {
    console.error("acode-web: Agent Code isn't built yet. Run: npm ci && npm run build   (in " + root + ")")
    process.exit(1)
  }
  rmSync(control, { force: true })
  core = spawn(process.execPath, ["--experimental-ffi", "--no-warnings", index], {
    cwd,
    env: { ...process.env, ...env, ACODE_HEADLESS: "1", ACODE_WEB_PORT: String(port), ACODE_WEB_TOKEN: token, ACODE_WEB_CODE: code, ACODE_WEB_CONTROL: control, ACODE_WEB_USERS: usersDir, ACODE_WEB_USER: user },
    stdio: ["ignore", "ignore", "pipe"],
  })
  let ready = false
  core.stderr.on("data", (chunk) => {
    const text = chunk.toString()
    if (!ready && text.includes("ACODE_WEB_READY")) {
      ready = true
      started = Date.now()
      if (noWindow) console.log(`Agent Code web: http://127.0.0.1:${port}/#c=${code}`)
      else if (!window) {
        window = openWindow(`http://127.0.0.1:${port}/#c=${code}`)
        const opened = Date.now()
        // The window closing ends Agent Code. A browser that handed the window to one already running exits at
        // once: then the page going away (below) is what ends it.
        window.on("exit", () => {
          if (Date.now() - opened < 4000) return
          quit()
        })
      }
    }
  })
  core.on("exit", (exitCode) => {
    if (quitting) return process.exit(0)
    // Agent Code left a note: another user, a restart, or quit.
    let next
    try {
      next = JSON.parse(readFileSync(control, "utf8"))
    } catch {}
    rmSync(control, { force: true })
    // No note: it quit (/exit) or crashed. Either way this ends here (no restart loop).
    if (!next || next.quit) {
      if (!next && exitCode) console.error(`acode-web: Agent Code stopped (exit ${exitCode}); see its log in your state folder (agent-code/log.txt).`)
      return quit()
    }
    if (next.user) {
      user = next.user
      prefs.user = user
      savePrefs()
    }
    // The page reconnects by itself (same address, the key it already has).
    setTimeout(() => !quitting && startCore(), 300)
  })
}

function quit() {
  if (quitting) return
  quitting = true
  core?.kill("SIGTERM")
  window?.kill()
  setTimeout(() => process.exit(0), 600)
}

// Whether the page is still open (for browsers that keep running after the window closes, e.g. on macOS, or that
// handed the window to an instance already running): once a page was there and none is for 40 s, Agent Code ends.
let started = 0
let seenPage = false
let lastPage = Date.now()
setInterval(async () => {
  if (quitting || noWindow || !started) return
  try {
    const answer = await fetch(`http://127.0.0.1:${port}/api/web/alive`, { headers: { authorization: `Bearer ${token}` } })
    const { pages } = await answer.json()
    if (pages > 0) {
      seenPage = true
      lastPage = Date.now()
    } else if (seenPage && Date.now() - lastPage > 40_000) quit()
  } catch {}
}, 5000).unref()

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, quit)
if (!userGiven) {
  prefs.user = user
  savePrefs()
}
startCore()
