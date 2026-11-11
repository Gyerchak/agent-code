# agentcode installer for Windows.
#
#   irm https://raw.githubusercontent.com/Gyerchak/agent-code/main/install.ps1 | iex
#   .\install.ps1            (from a downloaded copy of the repository; or double-click install.cmd)
#
# Environment: OCC_REPO (owner/name, default Gyerchak/agent-code), OCC_HOME (install folder, default %LOCALAPPDATA%\agent-code).
$ErrorActionPreference = "Stop"
$Repo = if ($env:OCC_REPO) { $env:OCC_REPO } else { "Gyerchak/agent-code" }
$HomeDir = if ($env:OCC_HOME) { $env:OCC_HOME } else { Join-Path $env:LOCALAPPDATA "agent-code" }
$BinDir = Join-Path $HomeDir "bin"

function Say($text) { Write-Host $text -ForegroundColor Cyan }
function Warn($text) { Write-Host $text -ForegroundColor Yellow }

Say "agentcode installer"

# 1. Node.js 26 or newer.
$node = Get-Command node -ErrorAction SilentlyContinue
$major = 0
if ($node) { try { $major = [int](& $node.Source -p "process.versions.node.split('.')[0]") } catch {} }
if ($major -lt 26) {
  Warn "agentcode needs Node.js 26 or newer. Install it from https://nodejs.org or with: winget install OpenJS.NodeJS"
  Warn "Then open a new terminal and run this installer again."
  exit 1
}
Say "Node.js $(& $node.Source --version) found."

# 2. The code: from this copy of the repository, or downloaded from GitHub.
New-Item -ItemType Directory -Force -Path $HomeDir | Out-Null
$here = if ($PSScriptRoot) { $PSScriptRoot } else { "" }
$staging = Join-Path $HomeDir "app.new"
if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
if ($here -and (Test-Path (Join-Path $here "app\package.json"))) {
  Say "Copying agentcode from $here\app"
  Copy-Item -Recurse (Join-Path $here "app") $staging
} else {
  Say "Downloading agentcode from github.com/$Repo"
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("agent-code-" + [Guid]::NewGuid())
  New-Item -ItemType Directory -Path $tmp | Out-Null
  $zip = Join-Path $tmp "agent-code.zip"
  Invoke-WebRequest -UseBasicParsing "https://codeload.github.com/$Repo/zip/refs/heads/main" -OutFile $zip
  Expand-Archive $zip -DestinationPath $tmp
  $root = Get-ChildItem $tmp -Directory | Select-Object -First 1
  Copy-Item -Recurse (Join-Path $root.FullName "app") $staging
  Remove-Item -Recurse -Force $tmp
}
$app = Join-Path $HomeDir "app"
if (Test-Path $app) { Remove-Item -Recurse -Force $app }
Move-Item $staging $app

# 3. Dependencies and build.
Say "Installing dependencies and building (a minute)"
Push-Location $app
try {
  npm ci --no-audit --no-fund --loglevel=error
  if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
  npm run build --silent
  if ($LASTEXITCODE -ne 0) { throw "the build failed" }
} finally { Pop-Location }

# 4. The command: a small agentcode.cmd in a folder on the user's PATH.
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
Set-Content -Encoding ASCII -Path (Join-Path $BinDir "agentcode.cmd") -Value "@echo off`r`ncall `"$app\bin\agentcode.cmd`" %*"
Set-Content -Encoding ASCII -Path (Join-Path $BinDir "occ.cmd") -Value "@echo off`r`ncall `"$app\bin\agentcode.cmd`" %*" # the earlier name keeps working
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not ($userPath -split ";" | Where-Object { $_ -eq $BinDir })) {
  [Environment]::SetEnvironmentVariable("Path", ($userPath.TrimEnd(";") + ";" + $BinDir), "User")
  Warn "Added $BinDir to your PATH: open a new terminal to use agentcode."
}
Say "Installed: $BinDir\agentcode.cmd"

# 5. The engines.
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  Warn "Claude Code is not installed. For the Claude Code engine: npm i -g @anthropic-ai/claude-code, then run claude once to log in."
}
Write-Host "Optional harnesses: opencode (npm i -g opencode-ai), DeepSeek Harness (npm i -g @deepseek-ai/dsh),"
Write-Host "Codex (npm i -g @openai/codex @agentclientprotocol/codex-acp)."
Say "Done. Start with: agentcode"
