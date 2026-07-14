#requires -Version 5.1
<#
.SYNOPSIS
  Deploy this worktree's built extension output to the live Copilot CLI /
  GitHub Desktop runtime location so changes appear in the app.

.DESCRIPTION
  The desktop app loads the `ado-pr-ops` canvas extension from
    $HOME\.copilot\extensions\ado-pr-ops
  which is a *separate* git worktree from your dev checkout. Committing to your
  branch alone does NOT update the running app -- you must copy the compiled
  output into that location and then reload the extension.

  This script cannot reload the extension. After it runs, reload the
  `ado-pr-ops` extension in the app and reopen the ADO DevOps canvas so the
  webview refetches the new frontend.

.PARAMETER NoBuild
  Deploy the current build output without running `npm run build` first.

.PARAMETER Dest
  Override the destination extension directory. Defaults to
  $env:ADO_PR_OPS_EXT_DIR, then $HOME\.copilot\extensions\ado-pr-ops.

.EXAMPLE
  .\scripts\deploy-runtime.ps1
  Build, then deploy.

.EXAMPLE
  .\scripts\deploy-runtime.ps1 -NoBuild
  Deploy the current build output only.
#>
[CmdletBinding()]
param(
    [switch]$NoBuild,
    [string]$Dest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot

if (-not $Dest) {
    if ($env:ADO_PR_OPS_EXT_DIR) {
        $Dest = $env:ADO_PR_OPS_EXT_DIR
    }
    else {
        $Dest = Join-Path $HOME '.copilot\extensions\ado-pr-ops'
    }
}

if (-not (Test-Path -LiteralPath $Dest -PathType Container)) {
    Write-Error "Runtime extension dir not found: $Dest`nSet -Dest or `$env:ADO_PR_OPS_EXT_DIR if the extension is installed elsewhere."
    exit 1
}

Push-Location $RepoRoot
try {
    if (-not $NoBuild) {
        Write-Host '>> Building (npm run build)...'
        npm run build
        if ($LASTEXITCODE -ne 0) { throw "npm run build failed (exit $LASTEXITCODE)" }
    }
    else {
        Write-Host '>> Skipping build (-NoBuild).'
    }

    $webDest = Join-Path $Dest 'web'
    New-Item -ItemType Directory -Force -Path $webDest | Out-Null

    Write-Host ">> Deploying to: $Dest"

    # Compiled backend output (src/*.mts -> root *.mjs)
    $backend = Get-ChildItem -LiteralPath $RepoRoot -File -Filter '*.mjs'
    if ($backend) {
        $backend | Copy-Item -Destination $Dest -Force
        Write-Host "   backend:  $($backend.Count) .mjs file(s)"
    }
    else {
        Write-Host '   backend:  none found (did the build run?)'
    }

    # Compiled frontend output + static assets
    $web = Get-ChildItem -LiteralPath (Join-Path $RepoRoot 'web') -File |
        Where-Object { $_.Extension -in '.js', '.css', '.html' }
    if ($web) {
        $web | Copy-Item -Destination $webDest -Force
        Write-Host "   web:      $($web.Count) file(s) (.js/.css/.html)"
    }
    else {
        Write-Host '   web:      none found (did the build run?)'
    }
}
finally {
    Pop-Location
}

Write-Host ''
Write-Host 'Deployed. Next steps (do these in the app, not this script):'
Write-Host "  1. Reload the 'ado-pr-ops' extension."
Write-Host '  2. Reopen the ADO DevOps canvas so the webview refetches.'
