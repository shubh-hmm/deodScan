# Starts DEODScan: the database, then the API, the dashboard and the daily-sync worker.
#
#   .\run.cmd                  (from the project folder; or double-click it)
#   .\run.cmd -NoWorker        everything except the worker (no Dune credits are used)
#   .\run.cmd -NoBrowser       do not open the browser
#   .\run.cmd -Hidden          run the three services in hidden windows instead of visible ones
#
# Safe to run twice: anything already running is left alone.

param([switch]$NoWorker, [switch]$NoBrowser, [switch]$Hidden)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Ok($m) { Write-Host "    $m" -ForegroundColor Green }
function Test-Port($p) { [bool](Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue) }
function Wait-Until($seconds, [scriptblock]$test) {
  $end = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $end) { try { if (& $test) { return $true } } catch { } Start-Sleep -Milliseconds 1500 }
  return $false
}

Write-Host "DEODScan: starting from $root" -ForegroundColor White

# ---- checks -------------------------------------------------------------------------------------
if (-not (Test-Path (Join-Path $root 'backend\node_modules')) -or -not (Test-Path (Join-Path $root 'frontend\node_modules'))) {
  Step 'First run: installing packages for the backend and the frontend (one time, a few minutes)'
  npm run install:all
}
if (-not (Test-Path (Join-Path $root 'backend\.env'))) {
  throw "backend\.env is missing. Copy backend\.env.example to backend\.env and fill in DUNE_API_KEY, MONGODB_URI and ADMIN_TOKEN."
}
$envText = Get-Content (Join-Path $root 'backend\.env') -Raw
if ($envText -notmatch '(?m)^DUNE_API_KEY=\S+') { Write-Host "    WARNING: DUNE_API_KEY is empty in backend\.env; the worker cannot fetch new data." -ForegroundColor Yellow }

# ---- 1. database --------------------------------------------------------------------------------
# MongoDB. The address comes from MONGODB_URI in backend\.env (default: this PC, port 27018, started here from the data folder backend\.mongodata).
$uri = 'mongodb://127.0.0.1:27018/deod_monitor'
if ($envText -match '(?m)^MONGODB_URI=(\S+)') { $uri = $Matches[1].Trim('"', "'") }
if ($uri -notmatch '^mongodb://(?:[^@/]*@)?(\[[^\]]+\]|[^:/,?]+)(?::(\d+))?') { throw "MONGODB_URI in backend\.env does not look like mongodb://127.0.0.1:27018/deod_monitor" }
$dbHost = $Matches[1]; $dbPort = if ($Matches[2]) { [int]$Matches[2] } else { 27017 }
$localDb = @('127.0.0.1', 'localhost', '[::1]') -contains $dbHost
Step "Database (MongoDB on port $dbPort)"
if (-not $localDb) {
  Ok "using the database at $dbHost (from MONGODB_URI); nothing to start on this PC"
} elseif (Test-Port $dbPort) {
  Ok 'already running'
} else {
  $data = Join-Path $root 'backend\.mongodata'
  New-Item -ItemType Directory -Force -Path $data | Out-Null
  # The mongod program: MONGOD_PATH, one on the PATH, or the copy the project keeps in its cache (downloaded once, then reused).
  $mongod = $env:MONGOD_PATH
  if (-not $mongod) { $found = Get-Command mongod -ErrorAction SilentlyContinue; if ($found) { $mongod = $found.Source } }
  if (-not $mongod) {
    Write-Host '    locating the MongoDB program (the first time this downloads it, about 100 MB)...'
    Push-Location (Join-Path $root 'backend')
    $mongod = (& node -e "import('mongodb-memory-server-core').then(m=>m.MongoBinary.getPath()).then(p=>console.log(p))" | Select-Object -Last 1)
    Pop-Location
  }
  if (-not $mongod -or -not (Test-Path $mongod)) { throw 'Could not find or download the MongoDB program (mongod). Install MongoDB Community Server, or set MONGOD_PATH.' }
  $log = Join-Path $data 'mongod.log'
  Start-Process -FilePath $mongod -ArgumentList @('--dbpath', "`"$data`"", '--port', $dbPort, '--bind_ip', '127.0.0.1', '--logpath', "`"$log`"", '--logappend') -WindowStyle Hidden | Out-Null
  Write-Host '    starting (after a PC restart this can take a little while: it repairs itself first)...'
  $ready = Wait-Until 150 { Test-Port $dbPort }
  if (-not $ready) { throw "The database did not become ready. Look at $log" }
  Ok 'ready'
}

# ---- 2. services --------------------------------------------------------------------------------
$style = if ($Hidden) { 'Hidden' } else { 'Normal' }
function Start-Svc($title, $script) {
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', "title $title && npm run $script" -WorkingDirectory $root -WindowStyle $style | Out-Null
}

Step 'API (port 4000)'
if (Test-Port 4000) { Ok 'already running' } else { Start-Svc 'DEODScan API' 'api'; Ok 'starting' }

Step 'Dashboard (port 3000)'
if (Test-Port 3000) { Ok 'already running' } else { Start-Svc 'DEODScan Web' 'web'; Ok 'starting' }

Step 'Worker (daily sync from Dune)'
if ($NoWorker) {
  Ok 'skipped (-NoWorker)'
} else {
  $w = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'worker[\\/]src[\\/]index' }
  if ($w) { Ok 'already running' }
  else {
    Start-Svc 'DEODScan Worker' 'worker'
    Ok 'starting. It fetches any finished days it missed while the PC was off (usually well under 1 Dune credit per day)'
  }
}

# ---- 3. wait until it answers --------------------------------------------------------------------
Step 'Waiting for the API and the dashboard'
$apiUp = Wait-Until 120 { (Invoke-WebRequest 'http://localhost:4000/api/health' -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200 }
$webUp = Wait-Until 120 { (Invoke-WebRequest 'http://localhost:3000' -UseBasicParsing -TimeoutSec 20).StatusCode -eq 200 }
if ($apiUp) { Ok 'API is up' } else { Write-Host '    API did not answer; look at its window.' -ForegroundColor Red }
if ($webUp) { Ok 'Dashboard is up' } else { Write-Host '    Dashboard did not answer; look at its window.' -ForegroundColor Red }

Write-Host "`nDEODScan is running:  http://localhost:3000" -ForegroundColor Green
Write-Host '  To stop everything:  .\stop.cmd   (or close the three DEODScan windows)'
if ($webUp -and -not $NoBrowser) { Start-Process 'http://localhost:3000' }
