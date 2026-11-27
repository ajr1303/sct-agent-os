# Agent OS: make this Windows computer report to the My devices page every 5 minutes.
# Run as administrator, or push it with your MDM (Intune: run as SYSTEM, 64-bit PowerShell).
# Safe to run again. To undo:
#   Unregister-ScheduledTask -TaskName 'Agent OS report' -Confirm:$false; Remove-Item -Recurse "$env:ProgramData\AgentOS"
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$base = '__BASE__'; $token = '__TOKEN__'; $enroll = '__ENROLL__'
$failed = $false
try {
    $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $admin) { throw 'Open PowerShell with "Run as administrator" and run it again.' }
    $dir = Join-Path $env:ProgramData 'AgentOS'
    $cfg = Join-Path $dir 'config.json'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    # Only SYSTEM and Administrators may read the folder: it holds this computer's report token.
    & icacls $dir /inheritance:r /grant:r 'SYSTEM:(OI)(CI)F' 'BUILTIN\Administrators:(OI)(CI)F' | Out-Null
    if (-not $token) {
        if (Test-Path $cfg) {
            $token = (Get-Content -Raw $cfg | ConvertFrom-Json).token       # already enrolled: keep its token
        } else {
            # Pushed to many computers: this one signs itself up and gets its own token.
            $r = Invoke-RestMethod -Method Post -Uri "$base/api/connectors/devices/enroll" -Headers @{ Authorization = 'Bearer ' + $enroll } `
                -ContentType 'application/json' -Body (@{ host = $env:COMPUTERNAME; os = 'windows' } | ConvertTo-Json) -TimeoutSec 30
            $token = $r.token
        }
    }
    if (-not $token) { throw 'Agent OS did not issue a token.' }
    Invoke-WebRequest -UseBasicParsing -Uri "$base/api/connectors/devices/reporter/$token/report.ps1" -OutFile (Join-Path $dir 'report.ps1')
    @{ url = "$base/api/connectors/devices/report"; token = $token } | ConvertTo-Json | Set-Content -Encoding UTF8 $cfg
    $act = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + (Join-Path $dir 'report.ps1') + '"')
    $trg = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
    $set = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 4) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName 'Agent OS report' -Action $act -Trigger $trg -Settings $set -User 'SYSTEM' -RunLevel Highest -Force | Out-Null
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $dir 'report.ps1')
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Installed. The first report was not accepted yet; it retries every 5 minutes. Check this computer can open $base ." -ForegroundColor Yellow
    } else {
        Write-Host 'Done. This computer now reports to Agent OS every 5 minutes. Look at My devices.' -ForegroundColor Green
    }
} catch {
    Write-Host "Agent OS reporter was not installed: $_" -ForegroundColor Yellow
    $failed = $true
}
# Pushed as a script file (MDM), report the outcome in the exit code. Pasted into a window, leave the window open.
if ($enroll -and $MyInvocation.MyCommand.Path) { if ($failed) { exit 1 } else { exit 0 } }
