#requires -Version 5.1
<#
.SYNOPSIS
  Build, package, and install the ADO PR Ops desktop app for the current user.

.DESCRIPTION
  1. npm run build (unless -NoBuild)
  2. Package with @electron/packager into out\ADO PR Ops-win32-x64
  3. Close the installed app if it is running (graceful first, then by PID)
  4. Mirror the package into the install folder
  5. Create/refresh the Start menu shortcut
  6. Launch the app (unless -NoLaunch)

  User data (reviews, settings) lives in %APPDATA%\ADO PR Ops and is untouched.

.PARAMETER Dest
  Install folder. Defaults to %LOCALAPPDATA%\Programs\ADO PR Ops.
#>
[CmdletBinding()]
param(
    [switch]$NoBuild,
    [switch]$NoLaunch,
    [string]$Dest = (Join-Path $env:LOCALAPPDATA 'Programs\ADO PR Ops')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$ExeName = 'ado-pr-ops.exe'

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

$installRoot = [IO.Path]::GetFullPath($Dest).TrimEnd('\') + '\'
$running = @(Get-CimInstance Win32_Process -Filter "Name = '$ExeName'" |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($installRoot, [StringComparison]::OrdinalIgnoreCase) })
if ($running.Count) {
    Write-Host '>> Closing the running app...'
    foreach ($proc in $running) {
        $p = Get-Process -Id $proc.ProcessId -ErrorAction SilentlyContinue
        if ($p -and $p.MainWindowHandle -ne [IntPtr]::Zero) { [void]$p.CloseMainWindow() }
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

Write-Host ">> Installing to $Dest"
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
robocopy $packaged $Dest /MIR /NFL /NDL /NJH /NJS /NP /R:3 /W:1 | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed (exit $LASTEXITCODE)" }
$global:LASTEXITCODE = 0

$exe = Join-Path $Dest $ExeName
Write-Host '>> Refreshing the Start menu shortcut...'
$shortcut = Start-Process -FilePath $exe -ArgumentList '--install-shortcut' -Wait -PassThru
if ($shortcut.ExitCode -ne 0) { throw "Shortcut install failed (exit $($shortcut.ExitCode))" }

if (-not $NoLaunch) {
    Write-Host '>> Launching...'
    Start-Process -FilePath $exe | Out-Null
}
Write-Host 'Deployed.'
