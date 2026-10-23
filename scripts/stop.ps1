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

# The database: a clean shutdown, so the next start is quick
$pgctl = Join-Path $root 'backend\node_modules\@embedded-postgres\windows-x64\native\bin\pg_ctl.exe'
$data = Join-Path $root 'backend\.pgdata'
if (Get-NetTCPConnection -LocalPort 5433 -State Listen -ErrorAction SilentlyContinue) {
  & $pgctl -D $data stop -m fast -w -t 60 2>&1 | Out-Null
  Say 'database stopped cleanly'
} else {
  Say 'database was not running'
}
# A database started by hand with 'npm run db:dev' (after the clean stop above, so the database is never force-killed; this only removes the leftover wrapper window/process)
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'dev-postgres|scripts[\\/]dev\.ts' } | ForEach-Object { Kill-Tree $_.ProcessId }

Write-Host 'Done.' -ForegroundColor Green
