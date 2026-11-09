# occ for Windows (PowerShell): the same steps as bin/occ — find Node.js 26+, build when needed, run.
$ErrorActionPreference = "Stop"
$Dir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

function Get-NodeMajor($node) {
  try { return [int](& $node -p "process.versions.node.split('.')[0]" 2>$null) } catch { return 0 }
}

$candidates = @()
if ($env:OCC_NODE) { $candidates += $env:OCC_NODE }
$onPath = Get-Command node -ErrorAction SilentlyContinue
if ($onPath) { $candidates += $onPath.Source }
$candidates += Get-ChildItem "$env:APPDATA\nvm\v*\node.exe" -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | ForEach-Object { $_.FullName }
$candidates += "$env:ProgramFiles\nodejs\node.exe"

$Node = $null
foreach ($c in $candidates) {
  if ($c -and (Test-Path $c) -and ((Get-NodeMajor $c) -ge 26)) { $Node = $c; break }
}
if (-not $Node) {
  Write-Host "occ needs Node.js 26 or newer. Install it from https://nodejs.org (or: winget install OpenJS.NodeJS) and run occ again." -ForegroundColor Red
  exit 1
}

# A fresh copy has no build yet, and an update leaves an old one: build here.
$dist = Join-Path $Dir "dist\index.js"
$stale = -not (Test-Path $dist)
if (-not $stale) {
  $built = (Get-Item $dist).LastWriteTime
  $stale = [bool](Get-ChildItem (Join-Path $Dir "src") -Recurse -File | Where-Object { $_.LastWriteTime -gt $built } | Select-Object -First 1)
}
if ($stale) {
  Write-Host "occ: building..."
  Push-Location $Dir
  try {
    $env:Path = (Split-Path -Parent $Node) + ";" + $env:Path
    if (-not (Test-Path "node_modules")) { npm ci | Out-Host }
    npm run build | Out-Host
  } finally { Pop-Location }
  if (-not (Test-Path $dist)) { Write-Host "occ: the build failed (run npm ci; npm run build in $Dir)." -ForegroundColor Red; exit 1 }
}

& $Node --experimental-ffi --no-warnings $dist @args
exit $LASTEXITCODE
