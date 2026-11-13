# Devis

Devis is a desktop app for reviewing Azure DevOps pull requests with GitHub Copilot, with a Workspace where a lead agent and its workers take on tasks.

## Install

You need Windows, the GitHub CLI, and access to this repository. Invites only work for personal GitHub accounts, so sign `gh` in with the one that was invited. Copilot can stay on your work account.

1. Install the GitHub CLI: `winget install GitHub.cli`. If that asks for admin, use the zip from [GitHub CLI releases](https://github.com/cli/cli/releases) and put `gh.exe` on your PATH.
2. Sign in: `gh auth login`.
3. In PowerShell, run:

   ```powershell
   gh release download -R kipackjeongMS/devis -p install.ps1 -O - | Out-String | iex
   ```

Setup installs Devis for you only, without admin, and opens it. The first run walks you through the rest: the Azure CLI and its sign-in, Agency, and the Azure DevOps orgs to watch. The same line upgrades or repairs an install.

- For the newest preview build, set `$env:DEVIS_CHANNEL = 'preview'` first.
- Releases aren't signed yet, so SmartScreen may ask the first time. The install checks the Setup's SHA-512 before it runs it.
- Your data stays in `%APPDATA%\ADO PR Ops`. Uninstalling or updating keeps it.

## Updates

Devis checks for a new release every 4 hours, through the GitHub CLI's sign-in. It installs once the workers are done, and goes back to the build before if the new one doesn't come up. Settings › Updates has the channel, Ask me, and Check now.

## Working on Devis

```powershell
npm ci
npm run build
npm run checks     # every scripts/*-harness.mjs; failures master already has don't count
npm start          # build and run from source
npm run deploy     # package and install this build for you
```

Pull requests run the same checks in GitHub Actions. A merge to master publishes a preview release, and a `v*` tag that matches `package.json`'s version publishes a stable one. [DESIGN.md](DESIGN.md) explains how it all fits together.
