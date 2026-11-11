#!/usr/bin/env bash
# Stopgap until the hub publisher ships (hivecommons/hive#17694): pull evidence
# bundles from every hive-hosted-* spoke on the given kube contexts, convert
# them to benchmark records and write them under data/fleet/<hive_hash>/.
#
#   scripts/backfill-from-cluster.sh [--contexts "hive-oke lke648397-ctx"] [--since YYYY-MM-DD] [--work DIR]
#
# Needs kubectl (exec access to the spoke pods), python3, gh (repo visibility).
# Also pulls /data/launch-cost.json so records get cost.basis=tokens_x_pricing
# where hive attributed kick spend to the PR/issue (see scripts/costlib.py).
# Repo names are kept only for repositories GitHub reports as public; the
# hive id is hashed (see convert-evidence.py). Re-running is idempotent: files
# for a hive/month are overwritten, record ids are stable.
set -euo pipefail
cd "$(dirname "$0")/.."

CONTEXTS="hive-oke lke648397-ctx"
SINCE=""
WORK=".cache/backfill"
while [ $# -gt 0 ]; do
  case "$1" in
    --contexts) CONTEXTS=$2; shift 2;;
    --since) SINCE=$2; shift 2;;
    --work) WORK=$2; shift 2;;
    *) echo "unknown flag $1" >&2; exit 2;;
  esac
done
mkdir -p "$WORK"

pull() { # ctx ns
  local ctx=$1 ns=$2 dir="$WORK/$2" pod
  pod=$(kubectl --context "$ctx" -n "$ns" get pods -o jsonpath='{.items[?(@.status.phase=="Running")].metadata.name}' 2>/dev/null | tr ' ' '\n' | grep '^hive-' | head -1 || true)
  [ -z "$pod" ] && return 0
  mkdir -p "$dir/tree"
  kubectl --context "$ctx" -n "$ns" exec "$pod" -c hive -- sh -c 'cd /data && tar czf - evidence 2>/dev/null' 2>/dev/null | tar xzf - -C "$dir/tree" 2>/dev/null || true
  # launch attribution store: per-kick token spend keyed by issue/PR ref (cost tier tokens_x_pricing)
  kubectl --context "$ctx" -n "$ns" exec "$pod" -c hive -- sh -c 'cd /data && tar czf - launch-cost.json 2>/dev/null' 2>/dev/null | tar xzf - -C "$dir" 2>/dev/null || true
  kubectl --context "$ctx" -n "$ns" exec "$pod" -c hive -- sh -c 'grep -E "^hive_id:|^agent_sandbox:" -A3 /etc/hive/hive.yaml; (hive --version || /hive --version) 2>/dev/null' > "$dir/meta.txt" 2>/dev/null || true
  kubectl --context "$ctx" -n "$ns" get deploy hive -o jsonpath='{.spec.template.spec.containers[?(@.name=="hive")].image}' > "$dir/image.txt" 2>/dev/null || true
  echo "$ctx" > "$dir/ctx.txt"
}

for ctx in $CONTEXTS; do
  for ns in $(kubectl --context "$ctx" --request-timeout=30s get ns -o name | sed 's#namespace/##' | grep '^hive-hosted-'); do
    pull "$ctx" "$ns" &
  done
  wait
done

# Repo visibility: one GraphQL call per 60 repos.
find "$WORK" -path '*/tree/evidence/*' -mindepth 5 -maxdepth 5 -type d | awk -F/ '{print $(NF-1)"/"$NF}' | sort -u > "$WORK/repos.txt"
: > "$WORK/public-repos.txt"
if [ -s "$WORK/repos.txt" ] && command -v gh >/dev/null; then
  split -l 60 "$WORK/repos.txt" "$WORK/repos.chunk."
  for chunk in "$WORK"/repos.chunk.*; do
    q="{ $(i=0; while read -r r; do i=$((i+1)); printf 'r%d: repository(owner:"%s", name:"%s") { nameWithOwner isPrivate } ' $i "${r%%/*}" "${r##*/}"; done < "$chunk") }"
    gh api graphql -f query="$q" 2>/dev/null | python3 -c 'import json,sys
d=json.load(sys.stdin).get("data") or {}
for v in d.values():
    if v and v.get("isPrivate") is False: print(v["nameWithOwner"])' >> "$WORK/public-repos.txt" || true
  done
fi
echo "public repos: $(wc -l < "$WORK/public-repos.txt") of $(wc -l < "$WORK/repos.txt")" >&2

for dir in "$WORK"/hive-hosted-*/; do
  [ -d "$dir/tree/evidence" ] || continue
  [ "$(find "$dir/tree/evidence" -name '*.json' | head -1)" ] || continue
  ns=$(basename "$dir")
  hid=$(awk '/^hive_id:/{print $2}' "$dir/meta.txt" 2>/dev/null | head -1); [ -z "$hid" ] && hid=${ns#hive-hosted-}
  ver=$(awk '/^hive /{print $2}' "$dir/meta.txt" 2>/dev/null | head -1); [ -z "$ver" ] && ver=$(sed 's/.*://' "$dir/image.txt" 2>/dev/null)
  runtime=$(awk '/^agent_sandbox:/,0' "$dir/meta.txt" | awk '/runtime:/{print $2}' | head -1); [ -z "$runtime" ] && runtime=none
  case "$(cat "$dir/ctx.txt")" in *lke*) cluster=lke;; *oke*) cluster=oke;; *) cluster=$(cat "$dir/ctx.txt");; esac
  LC=""; [ -f "$dir/launch-cost.json" ] && LC="$dir/launch-cost.json"
  hash=$(python3 -c "import hashlib,sys;print(hashlib.sha256(('hivecommons-benchmarks/v1/'+sys.argv[1]).encode()).hexdigest()[:16])" "$hid")
  python3 scripts/convert-evidence.py --evidence "$dir/tree/evidence" --hive-id "$hid" --hive-version "$ver" --cluster "$cluster" \
    --sandbox-runtime "$runtime" --public-repos "$WORK/public-repos.txt" --out "data/fleet/$hash" ${SINCE:+--since "$SINCE"} \
    ${LC:+--launch-cost "$LC"}
done
echo "done; now run scripts/build-index.sh and commit data/fleet" >&2
