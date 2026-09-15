# Stops the "BSC Predict worker" scheduled task and the server it supervises, so no orphaned server process is
# left holding the embedded database lock (data/pg.lock). Start again with:
#   Start-ScheduledTask -TaskName 'BSC Predict worker'
$task = Get-ScheduledTask -TaskName 'BSC Predict worker' -ErrorAction SilentlyContinue
if ($task) { Stop-ScheduledTask -TaskName 'BSC Predict worker' }
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -like '*apps/server/dist/main.js*' } |
  ForEach-Object {
    Write-Output "stopping server process $($_.ProcessId)"
    Stop-Process -Id $_.ProcessId -Force
  }
