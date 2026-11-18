// Several Agent Code windows on one folder work like one set of tabs, as browser windows do: a second `acode` opens
// with a new empty tab (its tab numbers go on from the first window's), a window that closes hands its tabs to the
// one that stays (in order: the older window's tabs first), a tab can be moved to another window or into a new one.
// Each window keeps a small file in <state>/windows/; an acode-box has its own state folder, so boxes and the main
// Agent Code never mix.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createSignal } from "solid-js"
import { log } from "./log"
import { stateDir } from "./paths"

const dir = path.join(stateDir, "windows")
const mine = path.join(dir, `${process.pid}.json`)
const me = { pid: process.pid, cwd: "", started: Date.now(), tabs: [] }
let registered = false

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === "EPERM"
  }
}

function readAll() {
  let names = []
  try {
    names = readdirSync(dir)
  } catch {}
  const out = []
  for (const name of names) {
    if (!name.endsWith(".json")) continue
    try {
      out.push({ ...JSON.parse(readFileSync(path.join(dir, name), "utf8")), file: path.join(dir, name), name })
    } catch {}
  }
  return out
}

function write() {
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(mine, JSON.stringify(me))
  } catch (error) {
    log("windows", error)
  }
}

/** Other running windows on this folder, oldest first. */
export function otherWindows() {
  return readAll()
    .filter((item) => item.pid && item.pid !== me.pid && item.cwd === me.cwd && !item.closed && !item.request && alive(item.pid))
    .sort((a, b) => a.started - b.started)
}

/** Join the folder's windows; returns the windows that were already there. */
export function registerWindow(cwd) {
  me.cwd = cwd
  registered = true
  const others = otherWindows()
  write()
  return others
}

const [offset, setOffset] = createSignal(0)
/** How many tabs the windows opened before this one hold: this window's tab numbers go on from there. */
export const tabOffset = offset

/** This window's tabs, for the others (and for the tabs saved for the next start). */
export function publishTabs(list) {
  if (!registered) return
  me.tabs = list
  write()
}

/** Every window's tabs on this folder in window order (this one's included), for saving. */
export function allWindowTabs() {
  const windows = [...otherWindows(), me].sort((a, b) => a.started - b.started)
  const seen = new Set()
  const out = []
  for (const window of windows) for (const tab of window.tabs ?? []) if (tab?.id && !seen.has(tab.id) && seen.add(tab.id)) out.push(tab.id)
  return out
}

/** Hand tabs to another window (it opens them; this one lets them go). */
export function sendTabs(pid, tabs) {
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, `move-${pid}-${Date.now()}.json`), JSON.stringify({ request: true, target: pid, cwd: me.cwd, tabs }))
    return true
  } catch (error) {
    log("windows", error)
    return false
  }
}

/** This window closes: its tabs stay on file for the window that remains (none: the saved tabs cover it). */
export function closeWindow() {
  if (!registered) return
  registered = false
  try {
    if (otherWindows().length && me.tabs.length) writeFileSync(mine, JSON.stringify({ ...me, closed: true }))
    else rmSync(mine, { force: true })
  } catch {}
}

/**
 * Watch for tabs coming this way: a window that closed (or died) leaves its tabs to the oldest window that remains,
 * and another window may send some. `adopt(tabs, where)` opens them; `where` is "before" for an older window's tabs.
 */
export function watchWindows(adopt) {
  const check = () => {
    if (!registered) return
    const all = readAll().filter((item) => item.cwd === me.cwd)
    const live = all.filter((item) => item.pid && !item.closed && !item.request && alive(item.pid)).sort((a, b) => a.started - b.started)
    setOffset(live.filter((item) => item.started < me.started && item.pid !== me.pid).reduce((sum, item) => sum + (item.tabs?.length ?? 0), 0))
    const oldest = live[0]?.pid === me.pid
    for (const item of all) {
      // Tabs sent to this window.
      if (item.request) {
        if (item.target === me.pid) {
          rmSync(item.file, { force: true })
          adopt(item.tabs ?? [], "after")
        } else if (!alive(item.target)) rmSync(item.file, { force: true })
        continue
      }
      // A window that closed or died: the oldest one left takes its tabs.
      if (item.pid === me.pid || (!item.closed && alive(item.pid))) continue
      if (!oldest) continue
      rmSync(item.file, { force: true })
      if (item.tabs?.length) adopt(item.tabs, item.started < me.started ? "before" : "after")
    }
  }
  const timer = setInterval(check, 1500)
  timer.unref?.()
  setTimeout(check, 300)
  return () => clearInterval(timer)
}

export const windowsDir = dir
export const hasWindowsDir = () => existsSync(dir)
