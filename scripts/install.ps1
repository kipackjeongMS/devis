#requires -Version 5.1
<#
.SYNOPSIS
  Install, upgrade or repair Devis from its newest GitHub release, in one line.

.DESCRIPTION
  With the GitHub CLI signed in to an account that can see the repository, in PowerShell:

    gh release download -R kipackjeongMS/devis -p install.ps1 -O - | Out-String | iex

  The same line upgrades an installed Devis, or repairs a broken one.

  1. Find the GitHub CLI and check it's signed in.
  2. Pick the release: the newest stable one, the newest of all with DEVIS_CHANNEL=preview,
     or the one DEVIS_VERSION names.
  3. Download its latest.json and its Setup into a temporary folder.
  4. Check Setup's size and SHA-512 against latest.json, and stop when they differ.
  5. Run Setup and wait for it. Setup stops a running Devis first (asking when it's busy) and
     keeps your data in %APPDATA%\ADO PR Ops.
  6. Delete the temporary folder.

.INPUTS
  Environment variables, since `iex` passes no parameters:
  DEVIS_REPO             The repository. Defaults to kipackjeongMS/devis.
  DEVIS_CHANNEL          stable (the default) or preview.
  DEVIS_VERSION          A version to install instead of the newest, like 1.2.0.
  DEVIS_SILENT           1 runs Setup with /S: no window, and it waits up to 10 minutes for a busy Devis.
  DEVIS_INSTALL_DRY_RUN  1 stops after the check, without running Setup.

.OUTPUTS
  Progress lines on the console. It throws, so a script run exits non-zero, when the GitHub CLI
  is missing or signed out, the release can't be found, the download doesn't match latest.json,
  or Setup fails. A silent Setup that exits 2 found Devis busy and installed nothing.
#>

& {
    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'

    $repo = if ($env:DEVIS_REPO) { $env:DEVIS_REPO.Trim() } else { 'kipackjeongMS/devis' }
    $channel = if ($env:DEVIS_CHANNEL -eq 'preview') { 'preview' } else { 'stable' }
    $silent = $env:DEVIS_SILENT -eq '1'
    $dryRun = $env:DEVIS_INSTALL_DRY_RUN -eq '1'

    function Find-Gh {
        $cmd = Get-Command gh -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($cmd) { return $cmd.Source }
        foreach ($root in @($env:ProgramFiles, (Join-Path $env:LOCALAPPDATA 'Programs'))) {
            if (-not $root) { continue }
            $exe = Join-Path $root 'GitHub CLI\gh.exe'
            if (Test-Path -LiteralPath $exe) { return $exe }
        }
        return $null
    }

    function Invoke-Gh([string[]]$GhArgs) {
        # gh's stdout as one string; throws with its stderr when it fails.
        # Windows PowerShell turns a native command's stderr into error records, which Stop would throw on.
        $ErrorActionPreference = 'Continue'
        $all = @(& $gh @GhArgs 2>&1)
        $errors = @($all | Where-Object { $_ -is [Management.Automation.ErrorRecord] } | ForEach-Object { $_.Exception.Message })
        $out = @($all | Where-Object { $_ -isnot [Management.Automation.ErrorRecord] })
        if ($LASTEXITCODE -ne 0) {
            $why = ($errors -join ' ').Trim()
            if (-not $why) { $why = "gh exited $LASTEXITCODE" }
            throw "gh $($GhArgs[0]) $($GhArgs[1]) failed: $why"
        }
        return ($out -join "`n").Trim()
    }

    function Test-GhSignedIn {
        $ErrorActionPreference = 'Continue'
        & $gh auth status *> $null
        return $LASTEXITCODE -eq 0
    }

    $gh = Find-Gh
    if (-not $gh) {
        throw 'The GitHub CLI (gh) is needed to install Devis. Install it with "winget install GitHub.cli" (or the zip from https://github.com/cli/cli/releases), run "gh auth login", then run this again.'
    }
    if (-not (Test-GhSignedIn)) {
        throw "The GitHub CLI isn't signed in. Run ""gh auth login"" with the account that was invited to $repo, then run this again."
    }

    if ($env:DEVIS_VERSION) {
        $tag = 'v' + $env:DEVIS_VERSION.Trim().TrimStart('v')
    } elseif ($channel -eq 'preview') {
        $tag = Invoke-Gh @('release', 'list', '-R', $repo, '--exclude-drafts', '--limit', '1', '--json', 'tagName', '-q', '.[0].tagName')
    } else {
        $tag = Invoke-Gh @('release', 'view', '-R', $repo, '--json', 'tagName', '-q', '.tagName')
    }
    if (-not $tag) { throw "$repo has no $channel release yet." }
    Write-Host ">> Devis $($tag.TrimStart('v')) from $repo"

    $dir = Join-Path ([IO.Path]::GetTempPath()) ('devis-install-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    try {
        Write-Host '>> Downloading...'
        Invoke-Gh @('release', 'download', $tag, '-R', $repo, '-p', 'latest.json', '-D', $dir, '--clobber') | Out-Null
        $manifest = Get-Content -LiteralPath (Join-Path $dir 'latest.json') -Raw | ConvertFrom-Json
        $file = [string]$manifest.file
        if ($file -notmatch '^[\w.+-]+\.exe$') { throw "$tag's latest.json doesn't name a Setup." }
        Invoke-Gh @('release', 'download', $tag, '-R', $repo, '-p', $file, '-D', $dir, '--clobber') | Out-Null
        $setup = Join-Path $dir $file

        Write-Host '>> Checking it...'
        if (-not (Test-Path -LiteralPath $setup)) { throw "$file didn't download." }
        $size = (Get-Item -LiteralPath $setup).Length
        # .NET, not Get-FileHash: Windows PowerShell started from pwsh may not load the module that has it.
        $sha = [Security.Cryptography.SHA512]::Create()
        $stream = [IO.File]::OpenRead($setup)
        try { $hash = -join ($sha.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') }) } finally { $stream.Dispose(); $sha.Dispose() }
        if ($size -ne [int64]$manifest.size -or $hash -ne ([string]$manifest.sha512)) {
            throw "$file doesn't match its SHA-512 in latest.json, so it wasn't run. Try again; if it keeps happening, tell whoever publishes Devis."
        }

        if ($dryRun) {
            Write-Host ">> Setup checks out: $file (dry run, not installed)."
            return
        }

        Write-Host ">> Running $file$(if ($silent) { ' silently' })..."
        $p = if ($silent) { Start-Process -FilePath $setup -ArgumentList '/S' -PassThru } else { Start-Process -FilePath $setup -PassThru }
        $null = $p.Handle  # Keep the handle, or ExitCode is empty once it exits.
        # Not Start-Process -Wait: it would also wait for the Devis that Setup opens.
        $p.WaitForExit()
        if ($p.ExitCode -eq 2) { throw 'Devis was busy, so Setup installed nothing. Run this again once its work is done.' }
        if ($p.ExitCode -ne 0) { throw "Setup exited $($p.ExitCode)." }
        Write-Host ">> Devis $($tag.TrimStart('v')) is installed. Open it from the Start menu."
    } finally {
        Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
