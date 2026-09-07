#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  printf '\nNode.js 22.16+ or 24+ with npm is required.\n\n' >&2
  exit 1
fi
if ! command -v git >/dev/null 2>&1; then
  printf '\nGit is required for automatic updates.\n\n' >&2
  exit 1
fi
exec npm run update
