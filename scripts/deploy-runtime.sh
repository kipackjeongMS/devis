#!/usr/bin/env bash
# Deploy this worktree's built extension output to the live Copilot CLI /
# GitHub Desktop runtime location so changes appear in the app.
#
# The desktop app loads the `ado-pr-ops` canvas extension from
#   ~/.copilot/extensions/ado-pr-ops
# which is a *separate* git worktree from your dev checkout. Committing to your
# branch alone does NOT update the running app -- you must copy the compiled
# output into that location and then reload the extension.
#
# Usage:
#   scripts/deploy-runtime.sh              # build, then deploy
#   scripts/deploy-runtime.sh --no-build   # deploy current build output only
#
# Override the destination (e.g. for testing) with:
#   ADO_PR_OPS_EXT_DIR=/path/to/ext scripts/deploy-runtime.sh
#
# NOTE: This script cannot reload the extension. After it runs, reload the
# `ado-pr-ops` extension in the app and reopen the ADO DevOps canvas so the
# webview refetches the new frontend.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEST="${ADO_PR_OPS_EXT_DIR:-$HOME/.copilot/extensions/ado-pr-ops}"

BUILD=1
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=0 ;;
    -h|--help)
      grep '^#' "$0" | grep -v '^#!' | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

if [[ ! -d "$DEST" ]]; then
  echo "ERROR: runtime extension dir not found: $DEST" >&2
  echo "Set ADO_PR_OPS_EXT_DIR if the extension is installed elsewhere." >&2
  exit 1
fi

cd "$REPO_ROOT"

if [[ "$BUILD" -eq 1 ]]; then
  echo ">> Building (npm run build)..."
  npm run build
else
  echo ">> Skipping build (--no-build)."
fi

echo ">> Deploying to: $DEST"
mkdir -p "$DEST/web"

shopt -s nullglob

# Compiled backend output (src/*.mts -> root *.mjs)
backend=( "$REPO_ROOT"/*.mjs )
if (( ${#backend[@]} )); then
  cp -f "${backend[@]}" "$DEST/"
  echo "   backend:  ${#backend[@]} .mjs file(s)"
else
  echo "   backend:  none found (did the build run?)"
fi

# Compiled frontend output + static assets
web=( "$REPO_ROOT"/web/*.js "$REPO_ROOT"/web/*.css "$REPO_ROOT"/web/*.html )
if (( ${#web[@]} )); then
  cp -f "${web[@]}" "$DEST/web/"
  echo "   web:      ${#web[@]} file(s) (.js/.css/.html)"
else
  echo "   web:      none found (did the build run?)"
fi

echo ""
echo "Deployed. Next steps (do these in the app, not this script):"
echo "  1. Reload the 'ado-pr-ops' extension."
echo "  2. Reopen the ADO DevOps canvas so the webview refetches."
