# Agent OS: make this Windows computer report to the My devices page every 5 minutes.
# Run once in PowerShell opened with "Run as administrator". To undo:
#   Unregister-ScheduledTask -TaskName 'Agent OS report' -Confirm:$false; Remove-Item -Recurse "$env:ProgramData\AgentOS"
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$base = '__BASE__'; $token = '__TOKEN__'
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Write-Host 'Open PowerShell with "Run as administrator" and run the command again.' -ForegroundColor Yellow; return }
$dir = Join-Path $env:ProgramData 'AgentOS'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
# Only SYSTEM and Administrators may read the folder: it holds this computer's report token.
& icacls $dir /inheritance:r /grant:r 'SYSTEM:(OI)(CI)F' 'BUILTIN\Administrators:(OI)(CI)F' | Out-Null
Invoke-WebRequest -UseBasicParsing -Uri "$base/api/connectors/devices/reporter/$token/report.ps1" -OutFile (Join-Path $dir 'report.ps1')
@{ url = "$base/api/connectors/devices/report"; token = $token } | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $dir 'config.json')
$act = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + (Join-Path $dir 'report.ps1') + '"')
$trg = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$set = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 4) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'Agent OS report' -Action $act -Trigger $trg -Settings $set -User 'SYSTEM' -RunLevel Highest -Force | Out-Null
try {
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $dir 'report.ps1')
    if ($LASTEXITCODE -ne 0) { throw 'the first report was not accepted' }
    Write-Host 'Done. This computer now reports to Agent OS every 5 minutes. Look at My devices.' -ForegroundColor Green
} catch {
    Write-Host "Installed, but the first report failed: $_ . Check this computer can open $base ." -ForegroundColor Yellow
}
