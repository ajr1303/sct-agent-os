# Agent OS: send this computer's resources and Veeam Agent results to the My devices page.
# Reads only. Runs as SYSTEM from the 'Agent OS report' scheduled task.
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
try {
    $cfg = Get-Content -Raw (Join-Path $PSScriptRoot 'config.json') | ConvertFrom-Json
    $os = Get-CimInstance Win32_OperatingSystem
    $cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
    $disks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Where-Object { $_.Size -gt 0 } | ForEach-Object {
        @{ name = $_.DeviceID; size = [double]$_.Size; free = [double]$_.FreeSpace } })
    $reboot = (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending') -or
              (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired')
    $report = @{
        host = $env:COMPUTERNAME
        os_name = ($os.Caption + ' ' + $os.Version).Trim()
        uptime_s = [int]((Get-Date) - $os.LastBootUpTime).TotalSeconds
        cpu = [double]$cpu
        mem_total = [double]$os.TotalVisibleMemorySize * 1024
        mem_free = [double]$os.FreePhysicalMemory * 1024
        reboot_pending = [bool]$reboot
        tz = (Get-Date).ToString('zzz').Replace(':', '')
        disks = $disks
        veeam = @{ installed = $false }
    }
    $svc = Get-Service -Name 'VeeamEndpointBackupSvc' -ErrorAction SilentlyContinue
    if ($svc) {
        $ver = ''
        try { $ver = (Get-Item (Join-Path $env:ProgramFiles 'Veeam\Endpoint Backup\Veeam.EndPoint.Service.exe')).VersionInfo.ProductVersion } catch {}
        $events = @()
        try {
            # Job results are written to the "Veeam Agent" event log ("... finished with Success/Warning/Failed").
            $events = @(Get-WinEvent -FilterHashtable @{ LogName = 'Veeam Agent'; StartTime = (Get-Date).AddDays(-30) } -MaxEvents 1500 -ErrorAction Stop |
                Where-Object { $_.Message -match 'finished with' } | Select-Object -First 200 | ForEach-Object {
                    $m = [string]$_.Message; if ($m.Length -gt 380) { $m = $m.Substring(0, 380) }
                    @{ at = $_.TimeCreated.ToString('o'); level = [string]$_.LevelDisplayName; msg = $m } })
        } catch {}
        $report.veeam = @{ installed = $true; version = [string]$ver; service = [string]$svc.Status; events = $events }
    }
    $body = [Text.Encoding]::UTF8.GetBytes(($report | ConvertTo-Json -Depth 6 -Compress))
    Invoke-RestMethod -Method Post -Uri $cfg.url -Headers @{ Authorization = 'Bearer ' + $cfg.token } -ContentType 'application/json' -Body $body -TimeoutSec 30 | Out-Null
    exit 0
} catch {
    Write-Output ('Agent OS report failed: ' + $_)
    exit 1
}
