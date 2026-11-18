#!/usr/bin/env bash
# Fail if a build left temp artifacts in the working tree: any file whose name
# contains a literal mktemp template (XXXXXX) or any untracked, non-ignored
# file. Cheap, no network. Run after scripts/build-index.sh.
set -euo pipefail
cd "$(dirname "$0")/.."

bad=$(find . -path ./.git -prune -o -path ./.cache -prune -o -path ./node_modules -prune -o -name '*XXXXXX*' -print)
if git rev-parse --git-dir >/dev/null 2>&1; then
  untracked=$(git ls-files --others --exclude-standard)
  [ -n "$untracked" ] && bad=$(printf '%s\n%s' "$bad" "$untracked")
fi
bad=$(printf '%s\n' "$bad" | sed '/^$/d' | sort -u)
if [ -n "$bad" ]; then
  echo "temp/untracked artifacts left in the repo after the build:" >&2
  printf '%s\n' "$bad" >&2
  exit 1
fi
echo "no temp artifacts"
