# Stops DEODScan: the dashboard, the API, the worker and the database. Safe to run when nothing is running.
#
#   .\stop.cmd

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
function Say($m) { Write-Host "    $m" }

Write-Host 'DEODScan: stopping' -ForegroundColor White
$killed = 0
function Kill-Tree($procId) {
  & taskkill.exe /PID $procId /T /F 2>$null | Out-Null
  $script:killed++
}

# The windows opened by .\run.cmd (closing a window stops what runs in it)
Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -match 'title DEODScan' } | ForEach-Object { Kill-Tree $_.ProcessId }

# Anything still listening on the dashboard or API ports (for example a copy started another way)
foreach ($port in 3000, 4000) {
  Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Kill-Tree $_ }
}

# The worker has no port: find it by its command line
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'worker[\\/]src[\\/]index' } | ForEach-Object { Kill-Tree $_.ProcessId }
Say "stopped $killed process group(s) (dashboard, API, worker)"

# The database: a clean shutdown (asked of the server itself), so the next start is quick. Only a MongoDB on this PC is stopped.
$uri = 'mongodb://127.0.0.1:27018/deod_monitor'
$envFile = Join-Path $root 'backend\.env'
if (Test-Path $envFile) { $t = Get-Content $envFile -Raw; if ($t -match '(?m)^MONGODB_URI=(\S+)') { $uri = $Matches[1].Trim('"', "'") } }
if ($uri -match '^mongodb://(?:[^@/]*@)?(\[[^\]]+\]|[^:/,?]+)(?::(\d+))?' -and @('127.0.0.1', 'localhost', '[::1]') -contains $Matches[1]) {
  $dbPort = if ($Matches[2]) { [int]$Matches[2] } else { 27017 }
  if (Get-NetTCPConnection -LocalPort $dbPort -State Listen -ErrorAction SilentlyContinue) {
    $js = "const {MongoClient}=require('mongodb');(async()=>{const c=new MongoClient('mongodb://127.0.0.1:$dbPort',{directConnection:true,serverSelectionTimeoutMS:5000});try{await c.db('admin').command({shutdown:1,timeoutSecs:30})}catch(e){}finally{await c.close().catch(()=>{})}})()"
    Push-Location (Join-Path $root 'backend')
    & node -e $js 2>&1 | Out-Null
    Pop-Location
    $end = (Get-Date).AddSeconds(60)
    while ((Get-Date) -lt $end -and (Get-NetTCPConnection -LocalPort $dbPort -State Listen -ErrorAction SilentlyContinue)) { Start-Sleep -Milliseconds 500 }
    if (Get-NetTCPConnection -LocalPort $dbPort -State Listen -ErrorAction SilentlyContinue) { Say 'database did not stop within 60 seconds' } else { Say 'database stopped cleanly' }
  } else {
    Say 'database was not running'
  }
} else {
  Say 'the database is not on this PC, so it was left alone'
}
# A backend started by hand with 'npm run dev' (after the clean stop above, so the database is never force-killed; this only removes the leftover wrapper process)
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'scripts[\/]dev\.ts' } | ForEach-Object { Kill-Tree $_.ProcessId }

Write-Host 'Done.' -ForegroundColor Green
