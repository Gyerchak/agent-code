import { execFile } from "node:child_process"
import { readdirSync } from "node:fs"
import path from "node:path"

let cache

function git(cwd        , args          ) {
  return new Promise          ((resolve) => {
    execFile("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      if (error) return resolve([])
      resolve(stdout.split("\n").filter(Boolean))
    })
  })
}

function walk(root        , limit = 5000) {
  const out           = []
  const skip = new Set(["node_modules", ".git", "dist", "build", ".cache", ".next", "target"])
  const visit = (dir        , depth        ) => {
    if (out.length >= limit || depth > 6) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".github") continue
      if (skip.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      const rel = path.relative(root, full)
      if (entry.isDirectory()) visit(full, depth + 1)
      else out.push(rel)
      if (out.length >= limit) return
    }
  }
  visit(root, 0)
  return out
}

export async function listFiles(cwd        , fresh = false) {
  if (!fresh && cache && cache.cwd === cwd && Date.now() - cache.at < 15_000) return cache.files
  let files = [...(await git(cwd, ["ls-files"])), ...(await git(cwd, ["ls-files", "--others", "--exclude-standard"]))]
  if (!files.length) files = walk(cwd)
  const dirs = new Set        ()
  for (const file of files) {
    let dir = path.dirname(file)
    while (dir && dir !== ".") {
      dirs.add(dir + "/")
      dir = path.dirname(dir)
    }
  }
  const all = [...dirs, ...files]
  cache = { cwd, files: all, at: Date.now() }
  return all
}

export function rankFiles(files          , query        , limit = 10) {
  if (!query) return files.filter((file) => !file.includes("/") || (file.endsWith("/") && file.split("/").length === 2)).slice(0, limit)
  const q = query.toLowerCase()
  const scored                                    = []
  for (const file of files) {
    const lower = file.toLowerCase()
    const base = path.basename(lower.replace(/\/$/, ""))
    let score = -1
    if (base.startsWith(q)) score = 1000 - base.length
    else if (base.includes(q)) score = 800 - base.indexOf(q)
    else if (lower.includes(q)) score = 600 - lower.indexOf(q)
    else {
      let index = 0
      let ok = true
      for (const char of q) {
        const found = lower.indexOf(char, index)
        if (found < 0) {
          ok = false
          break
        }
        index = found + 1
      }
      if (ok) score = 100 - lower.length / 10
    }
    if (score >= 0) scored.push({ file, score: score - file.split("/").length })
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.file)
}
