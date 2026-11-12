#requires -Version 5.1
<#
.SYNOPSIS
  Stop a running Devis before Setup replaces or removes its files.

.DESCRIPTION
  Devis-Setup.exe and its uninstaller run this (build\installer.nsh) in place of electron-builder's
  own check, which force-kills everything in the install folder: the background service too, with
  its work in flight. This stops Devis the way scripts\deploy-desktop.ps1 does.

  1. Ask the background service what it's doing. With work in flight (and no -Force), wait up to
     -WaitMinutes for it, then exit 2 listing that work. Nothing is closed.
  2. Close the Devis windows that run from the install folder: gracefully, then by PID.
  3. Ask the service to stop (once idle, unless -Force). If it took on new work meanwhile, exit 2.
  4. Stop anything still running from the install folder.

  The service is found through service.json in the data folder: %APPDATA%\ADO PR Ops, or
  $env:ADO_PR_OPS_USER_DATA when that's set (a test install).

.PARAMETER InstallDir
  The Devis install folder.

.PARAMETER WaitMinutes
  How long to wait for work in flight. 0, the default, checks once.

.PARAMETER Force
  Stop the service now, work in flight or not. Reviews in progress are queued again and
  workers continue from the next message.

.OUTPUTS
  Exit 0 when nothing runs from the install folder any more, or the folder isn't there yet. Exit 2 when the service is busy,
  with up to five lines of its work on stdout, in plain ASCII for the installer's prompt.
  Exit 1, with the error on stdout, when Devis couldn't be stopped.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$InstallDir,
    [int]$WaitMinutes = 0,
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$dataDir = if ($env:ADO_PR_OPS_USER_DATA) { $env:ADO_PR_OPS_USER_DATA } else { Join-Path $env:APPDATA 'ADO PR Ops' }
$serviceInfoPath = Join-Path $dataDir 'service.json'
# A first install: nothing can run from a folder that isn't there yet.
if (-not (Test-Path -LiteralPath $InstallDir -PathType Container)) { exit 0 }

function Get-LongPath([string]$Path) {
    # Process paths can keep 8.3 names (KIPACK~1); Get-Item expands them.
    if ($Path -notlike '*~*') { return $Path }
    try { return (Get-Item -LiteralPath $Path -Force).FullName } catch { return $Path }
}

$installRoot = (Get-LongPath ([IO.Path]::GetFullPath($InstallDir))).TrimEnd('\') + '\'
# Setup's caller: an old uninstaller can run from the install folder itself.
$callerPid = [int](Get-CimInstance Win32_Process -Filter "ProcessId = $PID").ParentProcessId

function Get-ServiceStatus {
    # The running service's status, or $null when none answers.
    if (-not (Test-Path -LiteralPath $serviceInfoPath)) { return $null }
    try { $info = Get-Content -LiteralPath $serviceInfoPath -Raw | ConvertFrom-Json } catch { return $null }
    if (-not (Get-Process -Id $info.pid -ErrorAction SilentlyContinue)) { return $null }
    try {
        $status = Invoke-RestMethod -Uri "$($info.url)api/service/status" -TimeoutSec 10
        if ($status.pid -eq $info.pid) { return $status }
    } catch { }
    return $null
}

function Wait-ServiceIdle {
    # The work still in flight once the wait is over: none when the service is idle or gone.
    $deadline = (Get-Date).AddMinutes($WaitMinutes)
    while ($true) {
        $status = Get-ServiceStatus
        if (-not $status) { return @() }
        $work = @($status.work | ForEach-Object { [string]$_.label })
        if (-not $work.Count -or (Get-Date) -ge $deadline) { return $work }
        Start-Sleep -Seconds 10
    }
}

function Exit-Busy([string[]]$Work) {
    # The installer shows these lines in a message box, and reads them in the ANSI code page.
    $lines = @($Work | Select-Object -First 5 | ForEach-Object {
        $label = $_ -replace '[\u2013\u2014]', '-' -replace '[\u2018\u2019]', "'" -replace '[\u201C\u201D]', '"' -replace '\u2026', '...'
        $label = $label.Normalize([Text.NormalizationForm]::FormD) -replace '\p{Mn}', ''
        '- ' + ($label -replace '[^\x20-\x7E]', '?')
    })
    if ($Work.Count -gt 5) { $lines += "- and $($Work.Count - 5) more" }
    $lines | ForEach-Object { Write-Output $_ }
    exit 2
}

function Get-InstallProcess {
    Get-CimInstance Win32_Process | Where-Object {
        $_.ProcessId -ne $callerPid -and $_.ExecutablePath -and
        (Get-LongPath $_.ExecutablePath).StartsWith($installRoot, [StringComparison]::OrdinalIgnoreCase)
    }
}

try {
    $service = Get-ServiceStatus
    if ($service -and -not $Force) {
        $work = @(Wait-ServiceIdle)
        if ($work.Count) { Exit-Busy $work }
        $service = Get-ServiceStatus
    }

    # The windows. The service runs the same executable, so leave it and its own processes for the next step.
    $servicePid = if ($service) { [int]$service.pid } else { 0 }
    $windows = @(Get-InstallProcess | Where-Object {
        $_.Name -eq 'devis.exe' -and $_.ProcessId -ne $servicePid -and $_.ParentProcessId -ne $servicePid
    })
    foreach ($proc in $windows) {
        $p = Get-Process -Id $proc.ProcessId -ErrorAction SilentlyContinue
        # Closing the main window takes its helper processes down with it, so one may exit mid-loop.
        try { if ($p -and $p.MainWindowHandle -ne [IntPtr]::Zero) { [void]$p.CloseMainWindow() } } catch { }
    }
    $deadline = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $deadline -and @($windows | Where-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }).Count) {
        Start-Sleep -Milliseconds 500
    }
    foreach ($proc in $windows) { Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue }

    # The service. With the window gone, nothing restarts it.
    $unanswered = 0
    while ($true) {
        $service = Get-ServiceStatus
        if (-not $service) { break }
        $body = if ($Force) { '{}' } else { '{"whenIdle":true}' }
        try {
            Invoke-RestMethod -Method Post -Uri "$($service.url)api/service/stop" -ContentType 'application/json' -Body $body -TimeoutSec 10 | Out-Null
        } catch {
            $code = 0
            try { $code = [int]$_.Exception.Response.StatusCode } catch { }
            if ($code -eq 409) {
                # It took on new work since the first check.
                $work = @(Wait-ServiceIdle)
                if ($work.Count) { Exit-Busy $work }
                continue
            }
            if (-not $Force) {
                # No clear answer: it may be busy, so never force it.
                $unanswered++
                if ($unanswered -lt 3) { Start-Sleep -Seconds 5; continue }
                throw "The background service (PID $($service.pid)) didn't answer the stop request."
            }
        }
        $deadline = (Get-Date).AddSeconds(30)
        while ((Get-Date) -lt $deadline -and (Get-Process -Id $service.pid -ErrorAction SilentlyContinue)) { Start-Sleep -Milliseconds 250 }
        Stop-Process -Id $service.pid -Force -ErrorAction SilentlyContinue
        break
    }

    # Whatever is left in the install folder: helpers, a Copilot runtime, Git.
    $deadline = (Get-Date).AddSeconds(10)
    while ($true) {
        $left = @(Get-InstallProcess)
        if (-not $left.Count) { break }
        if ((Get-Date) -ge $deadline) {
            throw "Still running from ${installRoot}: $(($left | ForEach-Object { "$($_.Name) ($($_.ProcessId))" }) -join ', ')."
        }
        $left | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        Start-Sleep -Milliseconds 500
    }
    exit 0
} catch {
    Write-Output $_.Exception.Message
    exit 1
}
