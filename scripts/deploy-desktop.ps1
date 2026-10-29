#requires -Version 5.1
<#
.SYNOPSIS
  Build, package, and install the Devis desktop app (formerly ADO PR Ops) for the current user.

.DESCRIPTION
  1. npm run build (unless -NoBuild)
  2. Package with @electron/packager into out\Devis-win32-x64
  3. If the background service is running, wait until it has no work in flight
     (worker turns, reviews, pipeline runs), printing what it's waiting on. The
     window stays open meanwhile, so questions and approvals can be answered.
  4. Close the app window (graceful first, then by PID), leaving the service alone.
     A window still running from the old ADO PR Ops install folder closes too.
  5. Stop the service; if new work started in the meantime, wait for it first
  6. Mirror the package into the install folder
  7. Create/refresh the Start menu shortcut (the app removes the old ADO PR Ops one)
  8. Remove the old ADO PR Ops install folder, if there is one
  9. Launch the app (unless -NoLaunch), which starts a fresh service

  User data (reviews, settings, the Workspace) stays in %APPDATA%\ADO PR Ops, untouched:
  the app kept that folder's name when it was renamed.
  Exits non-zero, before anything is replaced, when the work doesn't finish in time.

.PARAMETER Dest
  Install folder. Defaults to %LOCALAPPDATA%\Programs\Devis.

.PARAMETER Force
  Don't wait for work in flight: stop the service at once. Reviews in progress
  are queued again and workers continue from the next message.

.PARAMETER WaitMinutes
  How long to wait for work in flight before giving up. Defaults to 60.

.OUTPUTS
  Progress lines on the console. Exit code 0 when deployed; non-zero (a thrown
  error) when building, packaging, stopping the service or copying fails.
#>
[CmdletBinding()]
param(
    [switch]$NoBuild,
    [switch]$NoLaunch,
    [switch]$Force,
    [int]$WaitMinutes = 60,
    [string]$Dest = (Join-Path $env:LOCALAPPDATA 'Programs\Devis')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$ExeName = 'devis.exe'
# The app's first install, under its old name: replaced by this one.
$LegacyRoot = Join-Path $env:LOCALAPPDATA 'Programs\ADO PR Ops'
$LegacyExeName = 'ado-pr-ops.exe'

Push-Location $RepoRoot
try {
    if (-not $NoBuild) {
        Write-Host '>> Building...'
        npm run build
        if ($LASTEXITCODE -ne 0) { throw "npm run build failed (exit $LASTEXITCODE)" }
    }

    Write-Host '>> Packaging...'
    $packaged = (node scripts\package-desktop.mjs | Select-Object -Last 1)
    if ($LASTEXITCODE -ne 0 -or -not $packaged -or -not (Test-Path -LiteralPath $packaged)) {
        throw "Packaging failed (exit $LASTEXITCODE)"
    }
    Write-Host "   $packaged"
}
finally {
    Pop-Location
}

# ---- the background service: let its work finish before anything is replaced ----
$serviceInfoPath = Join-Path $env:APPDATA 'ADO PR Ops\service.json'

function Get-AppServiceStatus {
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

function Wait-AppServiceIdle {
    # Waits until the service has no work in flight (or is gone). Throws when it takes too long.
    $deadline = (Get-Date).AddMinutes($WaitMinutes)
    $last = ''
    while ($true) {
        $status = Get-AppServiceStatus
        if (-not $status -or -not @($status.work).Count) { return }
        $now = (@($status.work) | ForEach-Object { $_.label }) -join '; '
        if ($now -ne $last) {
            Write-Host "   Waiting for work in flight: $now"
            $last = $now
        }
        if ((Get-Date) -gt $deadline) {
            throw "The background service still has work in flight after $WaitMinutes minutes ($now). Nothing was replaced. Rerun later, or with -Force to stop it now."
        }
        Start-Sleep -Seconds 10
    }
}

$service = Get-AppServiceStatus
if ($service) {
    if ($Force) { Write-Host '>> Stopping the background service now (-Force)...' }
    else {
        Write-Host '>> Letting the background service finish its work...'
        Wait-AppServiceIdle
    }
}

$installRoot = [IO.Path]::GetFullPath($Dest).TrimEnd('\') + '\'
$legacyInstallRoot = [IO.Path]::GetFullPath($LegacyRoot).TrimEnd('\') + '\'
$servicePid = if ($service) { [int]$service.pid } else { 0 }
# The service runs the same executable, so leave it out: it's stopped below, once its work is done.
# A window from the old install (the app's first name) closes too, or it would restart its old service.
$running = @(Get-CimInstance Win32_Process -Filter "Name = '$ExeName' OR Name = '$LegacyExeName'" |
    Where-Object { $_.ExecutablePath -and
        ($_.ExecutablePath.StartsWith($installRoot, [StringComparison]::OrdinalIgnoreCase) -or
         $_.ExecutablePath.StartsWith($legacyInstallRoot, [StringComparison]::OrdinalIgnoreCase)) -and
        $_.ProcessId -ne $servicePid -and $_.ParentProcessId -ne $servicePid })
if ($running.Count) {
    Write-Host '>> Closing the running app...'
    foreach ($proc in $running) {
        $p = Get-Process -Id $proc.ProcessId -ErrorAction SilentlyContinue
        # Closing the main window takes its helper processes down with it, so one may exit mid-loop.
        try { if ($p -and $p.MainWindowHandle -ne [IntPtr]::Zero) { [void]$p.CloseMainWindow() } } catch { }
    }
    $deadline = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $deadline -and @($running | Where-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }).Count) {
        Start-Sleep -Milliseconds 500
    }
    foreach ($proc in $running) {
        if (Get-Process -Id $proc.ProcessId -ErrorAction SilentlyContinue) {
            Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }
}

# The window is gone, so nothing restarts the service now. Stop it, once more waiting out any work that just started.
$unanswered = 0
while ($true) {
    $service = Get-AppServiceStatus
    if (-not $service) { break }
    Write-Host '>> Stopping the background service...'
    $body = if ($Force) { '{}' } else { '{"whenIdle":true}' }
    $accepted = $false
    try {
        Invoke-RestMethod -Method Post -Uri "$($service.url)api/service/stop" -ContentType 'application/json' -Body $body -TimeoutSec 10 | Out-Null
        $accepted = $true
    } catch {
        $code = 0
        try { $code = [int]$_.Exception.Response.StatusCode } catch { }
        if ($code -eq 409) { Wait-AppServiceIdle; continue }
    }
    if (-not $accepted -and -not $Force) {
        # No clear answer: it may be busy, so never force it. Ask again, then give up without replacing anything.
        $unanswered++
        if ($unanswered -lt 3) { Start-Sleep -Seconds 5; continue }
        throw "The background service (PID $($service.pid)) didn't answer the stop request. Nothing was replaced. Rerun later, or with -Force to stop it now."
    }
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline -and (Get-Process -Id $service.pid -ErrorAction SilentlyContinue)) { Start-Sleep -Milliseconds 250 }
    if (Get-Process -Id $service.pid -ErrorAction SilentlyContinue) { Stop-Process -Id $service.pid -Force -ErrorAction SilentlyContinue }
    break
}

Write-Host ">> Installing to $Dest"
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
robocopy $packaged $Dest /MIR /NFL /NDL /NJH /NJS /NP /R:3 /W:1 | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed (exit $LASTEXITCODE)" }
$global:LASTEXITCODE = 0

$exe = Join-Path $Dest $ExeName
Write-Host '>> Refreshing the Start menu shortcut...'
$shortcut = Start-Process -FilePath $exe -ArgumentList '--install-shortcut' -Wait -PassThru
if ($shortcut.ExitCode -ne 0) { throw "Shortcut install failed (exit $($shortcut.ExitCode))" }

# The app's first install, under its old name, is replaced by this one. Its data folder isn't touched.
if ((Test-Path -LiteralPath $LegacyRoot) -and $legacyInstallRoot -ne $installRoot) {
    Write-Host ">> Removing the old install at $LegacyRoot"
    try { Remove-Item -LiteralPath $LegacyRoot -Recurse -Force }
    catch { Write-Warning "Couldn't remove all of $LegacyRoot ($($_.Exception.Message)). Delete it once nothing uses it." }
}

if (-not $NoLaunch) {
    Write-Host '>> Launching...'
    Start-Process -FilePath $exe | Out-Null
}
Write-Host 'Deployed.'
