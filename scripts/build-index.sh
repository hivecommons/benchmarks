#!/usr/bin/env bash
# Validate every record under data/**/*.json (except index.json) against
# schema/result.schema.json, then aggregate them into data/index.json
# (scripts/build-index.py).
#
# Requires jq. Validation uses `npx ajv-cli` when node is available and falls
# back to python3 + jsonschema (scripts/validate.py). Set SKIP_VALIDATE=1 to
# skip validation.
set -euo pipefail
cd "$(dirname "$0")/.."

SCHEMA=schema/result.schema.json
OUT=data/index.json

mapfile -t FILES < <(find data -name '*.json' ! -name 'index.json' | sort)
if [ "${#FILES[@]}" -eq 0 ]; then
  echo "no data files" >&2
  echo '{"generated_at":"'"$(date -u +%FT%TZ)"'","records":[]}' > "$OUT"
  exit 0
fi

# Each file is either one record (object) or an array of records. Pre-fix
# exporters (hive < v5.221 dev builds) published cost.basis "" where the
# schema wants "unknown"; the index builder already reads "" as unknown, so
# fold it here too rather than fail the whole deploy on one spoke.
RECORDS=$(jq -s '[ .[] | if type=="array" then .[] else . end
  | if (.cost|type)=="object" and ((.cost.basis // "")=="") then .cost.basis="unknown" else . end ]' "${FILES[@]}")

# Reject duplicate ids.
DUPES=$(printf '%s' "$RECORDS" | jq -r 'group_by(.id) | map(select(length>1) | .[0].id) | .[]')
if [ -n "$DUPES" ]; then
  echo "duplicate record ids:" >&2; echo "$DUPES" >&2; exit 1
fi

if [ "${SKIP_VALIDATE:-0}" != "1" ]; then
  TMP=$(mktemp -p . .records.XXXXXX.json)
  trap 'rm -f "$TMP"' EXIT
  printf '%s' "$RECORDS" | jq '.' > "$TMP"
  if command -v python3 >/dev/null && python3 -c 'import jsonschema' 2>/dev/null; then
    python3 scripts/validate.py "$SCHEMA" "$TMP"
  elif command -v npm >/dev/null; then
    [ -d .cache/node_modules/ajv-formats ] || npm install --silent --no-save --no-audit --no-fund --prefix .cache ajv@8 ajv-formats@3
    NODE_MODULES_DIR=.cache/node_modules node scripts/validate.mjs "$SCHEMA" "$TMP"
  else
    echo "no validator available (need python3+jsonschema or node); set SKIP_VALIDATE=1 to bypass" >&2
    exit 1
  fi
fi

python3 scripts/build-index.py data "$OUT"
