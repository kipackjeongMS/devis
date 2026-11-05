#requires -Version 5.1
<#
.SYNOPSIS
  Deploy one ship of a change Devis made to itself, check the new build came up,
  and roll back to the previous build when it didn't.

.DESCRIPTION
  Devis starts this detached (through WMI, so it outlives the service it replaces)
  right after it fast-forwards master in its source folder to a change the user
  shipped. Devis runs the copy from the commit before the ship, which is known to work.

  1. Wait a few seconds, so the worker's turn that shipped can end.
  2. Copy the install folder to Devis.prev: the build to roll back to.
  3. npm install in the source folder, when the ship changed package.json or package-lock.json.
  4. Run scripts\deploy-desktop.ps1 from the source folder in a child PowerShell:
     -Force for "ship now", else it waits for the work in flight first.
  5. Check the new service answers with the shipped commit.
  6. When it doesn't:
     - if the deploy stopped before replacing anything and the old build still
       runs, leave it running ("failed");
     - otherwise stop what runs, copy Devis.prev back and start it ("rolled-back").
     Either way, put master back to -Before when it's still at -Commit and clean,
     and write the result before the old build starts, so its service reads it.
  7. Write ship-N.result.json, which the service reads to settle the ship.

.PARAMETER Source
  Devis' source folder, on master at -Commit.

.PARAMETER Ship
  The ship's number, N.

.PARAMETER Commit
  Master after the ship: the commit the new build must report.

.PARAMETER Before
  Master before the ship, which a failed ship resets to.

.PARAMETER Mode
  idle (deploy once the service has no work in flight) or now (stop it at once).

.PARAMETER StateDir
  Where the log and the result go.

.PARAMETER DelaySeconds
  How long to wait before starting. Defaults to 8.

.PARAMETER HealthSeconds
  How long the new service has to come up. Defaults to 120.

.PARAMETER NpmInstall
  Run npm install in the source folder first.

.OUTPUTS
  StateDir\ship-N.log: the updater's steps.
  StateDir\ship-N.deploy.out.log and ship-N.deploy.err.log: the deploy's output.
  StateDir\ship-N.result.json: {state: live|rolled-back|failed, commit, note, logTail}.
  Exit code 0 when the ship is live, 1 otherwise.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Source,
    [Parameter(Mandatory)][int]$Ship,
    [Parameter(Mandatory)][string]$Commit,
    [Parameter(Mandatory)][string]$Before,
    [ValidateSet('idle', 'now')][string]$Mode = 'idle',
    [Parameter(Mandatory)][string]$StateDir,
    [int]$DelaySeconds = 8,
    [int]$HealthSeconds = 120,
    [switch]$NpmInstall
)

Set-StrictMode -Version Latest
# Native commands report through exit codes here; their stderr must not stop the script.
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\Devis'
$PrevDir = Join-Path $env:LOCALAPPDATA 'Programs\Devis.prev'
$ExeName = 'devis.exe'
$ServiceInfoPath = Join-Path $env:APPDATA 'ADO PR Ops\service.json'
$Main = 'master'

New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
$LogPath = Join-Path $StateDir "ship-$Ship.log"
$DeployOut = Join-Path $StateDir "ship-$Ship.deploy.out.log"
$DeployErr = Join-Path $StateDir "ship-$Ship.deploy.err.log"
$ResultPath = Join-Path $StateDir "ship-$Ship.result.json"

function Write-Log([string]$Text) {
    Add-Content -LiteralPath $LogPath -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Text" -Encoding UTF8
}

function Read-Tail([string]$Path, [int]$Lines) {
    # The deploy's window may still hold its log open, so read with sharing.
    if (-not (Test-Path -LiteralPath $Path)) { return @() }
    try {
        $stream = [IO.File]::Open($Path, 'Open', 'Read', 'ReadWrite, Delete')
        try { $text = (New-Object IO.StreamReader($stream, $true)).ReadToEnd() } finally { $stream.Dispose() }
        return @($text -split "\r?\n" | Where-Object { $_.Trim() } | Select-Object -Last $Lines)
    } catch { return @() }
}

function Write-Result([string]$State, [string]$Note) {
    $tail = @(Read-Tail $DeployOut 30) + @(Read-Tail $DeployErr 20) + @(Read-Tail $LogPath 15)
    $json = [pscustomobject]@{ state = $State; commit = $Commit; note = $Note; logTail = ($tail -join "`n") } | ConvertTo-Json
    $tmp = "$ResultPath.tmp"
    Set-Content -LiteralPath $tmp -Value $json -Encoding UTF8
    Move-Item -LiteralPath $tmp -Destination $ResultPath -Force
    Write-Log "Result: $State. $Note"
}

function Invoke-Git([string[]]$GitArgs) {
    # stdout of a git command in the source folder, or $null when it fails.
    $out = & git -C $Source -c core.longpaths=true @GitArgs 2>$null
    if ($LASTEXITCODE -ne 0) { return $null }
    return (@($out) -join "`n").Trim()
}

function Get-ServiceStatus {
    # The running service's status, or $null when none answers.
    if (-not (Test-Path -LiteralPath $ServiceInfoPath)) { return $null }
    try { $info = Get-Content -LiteralPath $ServiceInfoPath -Raw | ConvertFrom-Json } catch { return $null }
    if (-not (Get-Process -Id $info.pid -ErrorAction SilentlyContinue)) { return $null }
    try {
        $status = Invoke-RestMethod -Uri "$($info.url)api/service/status" -TimeoutSec 10
        if ($status.pid -eq $info.pid) { return $status }
    } catch { }
    return $null
}

function Get-StatusCommit($Status) {
    if (-not $Status) { return $null }
    $prop = $Status.PSObject.Properties['commit']
    if ($prop) { return [string]$prop.Value }
    return $null
}

function Wait-NewService {
    # True once a running service reports the shipped commit.
    $deadline = (Get-Date).AddSeconds($HealthSeconds)
    while ((Get-Date) -lt $deadline) {
        $status = Get-ServiceStatus
        if ($status -and $status.state -eq 'running' -and (Get-StatusCommit $status) -eq $Commit) { return $true }
        Start-Sleep -Seconds 3
    }
    return $false
}

function Start-Hidden([string]$File, [string]$Arguments, [string]$WorkDir, [string]$OutLog, [string]$ErrLog) {
    # Start a process and wait for it alone. Start-Process -Wait would also wait for the app the deploy launches.
    $p = Start-Process -FilePath $File -ArgumentList $Arguments -WorkingDirectory $WorkDir -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog
    $null = $p.Handle  # Keep the handle, or ExitCode is empty once it exits.
    $p.WaitForExit()
    return $p.ExitCode
}

function Invoke-Npm([string]$What) {
    Write-Log "npm install ($What)..."
    $out = Join-Path $StateDir "ship-$Ship.npm.out.log"
    $err = Join-Path $StateDir "ship-$Ship.npm.err.log"
    $code = Start-Hidden 'cmd.exe' '/d /c npm install --no-audit --no-fund' $Source $out $err
    Write-Log "npm install exited $code."
    if ($code -ne 0) { foreach ($line in @(Read-Tail $err 15)) { Write-Log "npm: $line" } }
    return $code -eq 0
}

function Stop-Running {
    # Stop the service and every window of the installed app.
    $status = Get-ServiceStatus
    if ($status) {
        Write-Log "Stopping the service (PID $($status.pid))..."
        try { Invoke-RestMethod -Method Post -Uri "$($status.url)api/service/stop" -ContentType 'application/json' -Body '{}' -TimeoutSec 10 | Out-Null } catch { }
        $deadline = (Get-Date).AddSeconds(30)
        while ((Get-Date) -lt $deadline -and (Get-Process -Id $status.pid -ErrorAction SilentlyContinue)) { Start-Sleep -Milliseconds 250 }
        Stop-Process -Id $status.pid -Force -ErrorAction SilentlyContinue
    }
    $root = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\') + '\'
    $procs = @(Get-CimInstance Win32_Process -Filter "Name = '$ExeName'" |
        Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) })
    foreach ($proc in $procs) { Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue }
    $deadline = (Get-Date).AddSeconds(15)
    while ((Get-Date) -lt $deadline -and @($procs | Where-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }).Count) {
        Start-Sleep -Milliseconds 250
    }
}

function Reset-Master {
    # Put master back where it was, when it's still on the ship and nothing else is in the way.
    $head = Invoke-Git @('rev-parse', 'HEAD')
    $branch = Invoke-Git @('symbolic-ref', '--short', '-q', 'HEAD')
    $dirty = Invoke-Git @('status', '--porcelain', '--untracked-files=no')
    if ($head -ne $Commit -or $branch -ne $Main -or $dirty) {
        Write-Log "Master left as is (HEAD $head on '$branch'$(if ($dirty) { ', with changes' }))."
        return
    }
    & git -C $Source reset -q --keep $Before 2>&1 | ForEach-Object { Write-Log "git: $_" }
    if ($LASTEXITCODE -eq 0) {
        Write-Log "Master is back at $Before."
        if ($NpmInstall) { [void](Invoke-Npm 'back to the previous dependencies') }
    } else {
        Write-Log "Couldn't reset master (exit $LASTEXITCODE)."
    }
}

function Restore-Previous([string]$Why) {
    if (-not (Test-Path -LiteralPath (Join-Path $PrevDir $ExeName))) {
        Reset-Master
        Write-Result 'failed' "$Why There was no previous build to roll back to; deploy it again by hand."
        return
    }
    Write-Log "Rolling back: $Why"
    Stop-Running
    robocopy $PrevDir $InstallDir /MIR /NFL /NDL /NJH /NJS /NP /R:3 /W:1 | Out-Null
    $copied = $LASTEXITCODE -lt 8
    Reset-Master
    if (-not $copied) {
        Write-Result 'failed' "$Why Copying the previous build back failed too (robocopy exit $LASTEXITCODE); deploy it again by hand."
        return
    }
    # The result goes first: the old service reads it as it starts.
    Write-Result 'rolled-back' $Why
    Start-Process -FilePath (Join-Path $InstallDir $ExeName) | Out-Null
}

Write-Log "Ship $Ship of $Commit (before: $Before), mode $Mode, from $Source."
$deploying = $false
try {
    Start-Sleep -Seconds $DelaySeconds

    if (Test-Path -LiteralPath (Join-Path $InstallDir $ExeName)) {
        Write-Log 'Keeping the running build in Devis.prev...'
        robocopy $InstallDir $PrevDir /MIR /NFL /NDL /NJH /NJS /NP /R:3 /W:1 | Out-Null
        if ($LASTEXITCODE -ge 8) {
            Reset-Master
            Write-Result 'failed' "Couldn't keep a copy of the running build (robocopy exit $LASTEXITCODE), so nothing was deployed."
            exit 1
        }
    } else {
        Write-Log "There's no installed build to keep."
    }

    if ($NpmInstall -and -not (Invoke-Npm 'the ship changed the dependencies')) {
        Reset-Master
        Write-Result 'failed' 'npm install failed, so nothing was deployed.'
        exit 1
    }

    $deploy = Join-Path $Source 'scripts\deploy-desktop.ps1'
    $wait = if ($Mode -eq 'now') { '-Force' } else { '-WaitMinutes 60' }
    Write-Log "Deploying ($wait)..."
    $deploying = $true
    $code = Start-Hidden 'powershell.exe' "-NoProfile -ExecutionPolicy Bypass -File `"$deploy`" $wait" $Source $DeployOut $DeployErr
    Write-Log "The deploy exited $code."

    if ($code -eq 0 -and (Wait-NewService)) {
        Write-Result 'live' ''
        exit 0
    }

    $old = Get-ServiceStatus
    if ($code -ne 0 -and $old -and (Get-StatusCommit $old) -ne $Commit) {
        # It stopped before anything was replaced: the running build stays.
        Reset-Master
        Write-Result 'failed' 'The deploy stopped before replacing anything, so the running build stayed.'
        exit 1
    }
    $why = if ($code -ne 0) { "The deploy failed (exit $code) partway." } else { "The new build didn't come up within $HealthSeconds seconds." }
    Restore-Previous $why
    exit 1
} catch {
    $message = $_.Exception.Message
    Write-Log "Updater error: $message"
    try {
        if (-not (Test-Path -LiteralPath $ResultPath)) {
            if ($deploying) { Restore-Previous "The updater hit an error: $message" }
            else {
                Reset-Master
                Write-Result 'failed' "The updater hit an error before deploying, so the running build stayed: $message"
            }
        }
    } catch { Write-Log "Rollback error: $($_.Exception.Message)" }
    exit 1
}
