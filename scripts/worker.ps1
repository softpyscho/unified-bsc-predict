# Keeps the server + worker running on Windows: restarts it 10 s after any exit (crash or otherwise) and records
# each restart in logs/worker-supervisor.log. Started by the "BSC Predict worker" scheduled task at logon;
# stop both with scripts/worker-stop.ps1. Build first (npm run build); a rebuild takes effect on the next restart.
$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
New-Item -ItemType Directory -Force (Join-Path $repo 'logs') | Out-Null
$log = Join-Path $repo 'logs\worker-supervisor.log'
$node = (Get-Command node -ErrorAction Stop).Source

while ($true) {
  Add-Content $log "$(Get-Date -Format o) starting server"
  $p = Start-Process -FilePath $node `
    -ArgumentList '--disable-warning=ExperimentalWarning', 'apps/server/dist/main.js' `
    -WorkingDirectory $repo -NoNewWindow -PassThru -Wait
  Add-Content $log "$(Get-Date -Format o) server exited with code $($p.ExitCode); restarting in 10 s"
  Start-Sleep -Seconds 10
}
