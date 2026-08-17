#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

checks_only=0
allow_dirty=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --checks-only) checks_only=1 ;;
    --allow-dirty) allow_dirty=1 ;;
    -h|--help)
      echo "Usage: scripts/validate-and-deploy.sh [--checks-only] [--allow-dirty]"
      exit 0
      ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

if [[ "$allow_dirty" -eq 0 ]] && [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree has uncommitted changes; commit or use --checks-only --allow-dirty." >&2
  exit 1
fi

npm ci --no-audit --no-fund
npm run check:threads
npm run build

if [[ "$checks_only" -eq 1 ]]; then
  echo "Checks completed; deploy skipped."
  exit 0
fi

npx wrangler deploy
npm run db:migrate:remote
echo "Standalone Threads deployment completed."
