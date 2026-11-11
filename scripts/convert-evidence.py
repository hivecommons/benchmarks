#!/usr/bin/env python3
"""Convert hive evidence bundles (pkg/evidence.Bundle, schema v1) into
benchmark records (schema/result.schema.json).

usage: convert-evidence.py --evidence DIR --hive-id ID [--hive-version V]
                           [--public-repos FILE] [--out DIR] [--since YYYY-MM-DD]
                           [--sandbox-runtime none] [--exporter NAME]

One record per pull request per role:
  * role=author   when the PR author is a hive agent (author.kind == "agent")
  * role=reviewer when the PR carries swarm verdicts (any author kind)

Privacy: repo names are emitted only when the repo is listed in --public-repos
(owner/name per line); otherwise task.repo and source.org are omitted. The
hive is identified by a stable hash (see hive_hash). Logins, finding text and
paths are never read into the output.

Stdlib only.
"""
import argparse
import collections
import datetime as dt
import glob
import hashlib
import json
import os
import sys

HASH_DOMAIN = "hivecommons-benchmarks/v1/"
ZERO_TIME = "0001-01-01T00:00:00Z"
VERDICT_RANK = {"reject": 4, "changes_requested": 3, "requires_human": 2, "comment": 1, "approve": 0}
HARNESSES = {"agy", "aider", "bob", "claude", "cline", "codex", "copilot", "gemini", "goose", "kilo",
             "muse", "omnigent", "omp", "opencode", "openhands", "pi", "clanker"}
KIND_HINTS = [("doc", "docs"), ("sec", "security-fix"), ("ci", "ci-repair"), ("release", "release"),
              ("dep", "dependency-update"), ("renovate", "dependency-update"), ("triage", "triage"),
              ("refactor", "refactor")]


def hive_hash(hive_id: str) -> str:
    return hashlib.sha256((HASH_DOMAIN + hive_id).encode()).hexdigest()[:16]


def parse_time(s):
    if not s or s.startswith("0001-01-01"):
        return None
    try:
        return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


def iso(t):
    return t.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if t else None


def provider_of(model: str) -> str:
    m = (model or "").lower()
    if "/" in m:
        return m.split("/", 1)[0]
    for pfx, prov in (("claude", "anthropic"), ("gpt", "openai"), ("o1", "openai"), ("o3", "openai"), ("o4", "openai"),
                      ("gemini", "google"), ("granite", "ibm"), ("llama", "meta"), ("mistral", "mistral"),
                      ("qwen", "alibaba"), ("deepseek", "deepseek"), ("grok", "xai"), ("kimi", "moonshot")):
        if m.startswith(pfx):
            return prov
    return "unknown"


def harness_of(backend: str) -> str:
    b = (backend or "").lower()
    return b if b in HARNESSES else "other"


def kind_of(agent_name: str) -> str:
    n = (agent_name or "").lower()
    for hint, kind in KIND_HINTS:
        if hint in n:
            return kind
    return "unknown"


def worst_verdict(verdicts):
    best = None
    for v in verdicts:
        name = v.get("verdict")
        if name in VERDICT_RANK and (best is None or VERDICT_RANK[name] > VERDICT_RANK[best]):
            best = name
    return best or "none"


def load_bundles(root):
    groups = collections.defaultdict(list)
    bad = 0
    for path in glob.iglob(os.path.join(root, "*", "*", "*", "*.json")):
        try:
            with open(path) as f:
                b = json.load(f)
        except (OSError, ValueError):
            bad += 1
            continue
        if not b.get("repo") or not b.get("number"):
            bad += 1
            continue
        groups[(b["repo"], int(b["number"]))].append(b)
    return groups, bad


def pr_record_base(repo, number, bundles, hive, public_repos, now_iso):
    latest = max(bundles, key=lambda b: parse_time(b.get("updated_at")) or dt.datetime.min.replace(tzinfo=dt.timezone.utc))
    first = min(bundles, key=lambda b: parse_time(b.get("created_at")) or dt.datetime.max.replace(tzinfo=dt.timezone.utc))
    heads = {b.get("head_sha") for b in bundles if b.get("head_sha")}

    merge = latest.get("merge") or {}
    outcome = latest.get("outcome") or {}
    backfill = latest.get("backfill") or {}
    merged = bool(merge) or outcome.get("state") == "merged" or backfill.get("state") == "merged"
    closed = (not merged) and (outcome.get("state") == "closed" or backfill.get("state") == "closed")

    opened = parse_time(merge.get("opened_at")) or parse_time(first.get("created_at"))
    merged_at = parse_time(merge.get("at")) or parse_time(outcome.get("merged_at"))
    closed_at = parse_time(outcome.get("closed_at")) or parse_time(backfill.get("closed_at"))
    end = merged_at if merged else closed_at
    wall = (end - opened).total_seconds() if (opened and end and end >= opened) else None

    first_ci = (first.get("ci") or {}).get("status")
    ci_first = True if first_ci == "success" else False if first_ci == "failure" else None
    last_ci = (latest.get("ci") or {}).get("status")
    ci_at_merge = last_ci if last_ci in ("success", "failure", "pending") else "unknown"

    verdicts = latest.get("verdicts") or []
    method = merge.get("method") if merge.get("method") in ("merge", "squash", "rebase") else ("unrecorded" if merged else None)

    out = {
        "pr_opened": True,
        "pr_merged": merged,
        "pr_closed_unmerged": closed,
        "ci_green_first_try": ci_first,
        "ci_status_at_merge": ci_at_merge,
        "review_verdict": worst_verdict(verdicts),
        "human_interventions": len(latest.get("human_actions") or []),
        "retries": max(len(heads) - 1, 0),
    }
    if method:
        out["merge_method"] = method
    if verdicts:
        confs = [v.get("confidence") for v in verdicts if isinstance(v.get("confidence"), (int, float))]
        if confs:
            out["review_confidence"] = round(min(max(min(confs), 0.0), 1.0), 3)
        models = sorted({v.get("model") for v in verdicts if v.get("model")})
        if models:
            out["reviewer_models"] = models
    if wall is not None:
        out["wall_clock_s"] = round(wall)
    if opened:
        out["opened_at"] = iso(opened)
    if merged_at:
        out["merged_at"] = iso(merged_at)

    quality = {}
    if merged:
        quality["reverted_within_14d"] = bool(latest.get("reverted_by"))
        quality["followed_up_within_14d"] = bool(latest.get("followed_up_by"))
        quality["issue_reopened"] = bool(latest.get("issue_reopens"))
    acmm = (latest.get("policy") or {}).get("acmm_level")
    if isinstance(acmm, int) and 0 <= acmm <= 6:
        quality["acmm_level"] = acmm
    if latest.get("sentinel"):
        quality["sentinel_findings"] = len(latest["sentinel"])

    task = {"repo_consent": repo in public_repos, "repo_visibility": "public" if repo in public_repos else "private"}
    if repo in public_repos:
        task["repo"] = repo
    if isinstance(acmm, int) and 0 <= acmm <= 6:
        task["acmm_level"] = acmm

    source = {"hive_id": hive["hash"], "hive_version": hive["version"], "exporter": hive["exporter"]}
    if repo in public_repos:
        source["org"] = repo.split("/")[0]
    if hive.get("cluster"):
        source["cluster"] = hive["cluster"]

    month = (merged_at or end or opened or parse_time(latest.get("created_at")) or dt.datetime.now(dt.timezone.utc)).strftime("%Y-%m")
    return latest, out, quality, task, source, month


def convert(args):
    public_repos = set()
    if args.public_repos:
        with open(args.public_repos) as f:
            public_repos = {ln.split()[0] for ln in f if ln.strip() and not ln.startswith("#")}
    hive = {"hash": hive_hash(args.hive_id), "version": args.hive_version or "unknown", "exporter": args.exporter, "cluster": args.cluster}
    now = dt.datetime.now(dt.timezone.utc)
    now_iso = iso(now)
    since = parse_time(args.since + "T00:00:00Z") if args.since else None

    groups, bad = load_bundles(args.evidence)
    by_month = collections.defaultdict(list)
    stats = collections.Counter()
    for (repo, number), bundles in groups.items():
        latest, out, quality, task, source, month = pr_record_base(repo, number, bundles, hive, public_repos, now_iso)
        if since and (parse_time(latest.get("updated_at")) or now) < since:
            stats["skipped_old"] += 1
            continue
        author = latest.get("author") or {}
        base_id = f"{hive['hash']}|{repo}|{number}|"
        verdicts = latest.get("verdicts") or []

        if author.get("kind") == "agent" and author.get("model"):
            rec = {
                "schema_version": "1",
                "id": hashlib.sha256((base_id + "author").encode()).hexdigest()[:24],
                "published_at": now_iso,
                "source": source,
                "agent": {"name": author.get("agent") or "agent", "role": "author", "harness": harness_of(author.get("backend"))},
                "model": {"provider": provider_of(author["model"]), "name": author["model"]},
                "sandbox_runtime": args.sandbox_runtime,
                "task": dict(task, kind=kind_of(author.get("agent"))),
                "outcome": out,
            }
            if quality:
                rec["quality"] = quality
            by_month[month].append(rec)
            stats["author"] += 1

        if verdicts:
            counts = collections.Counter((v.get("backend"), v.get("model")) for v in verdicts if v.get("model"))
            if counts:
                (backend, model), _ = counts.most_common(1)[0]
                rec = {
                    "schema_version": "1",
                    "id": hashlib.sha256((base_id + "reviewer").encode()).hexdigest()[:24],
                    "published_at": now_iso,
                    "source": source,
                    "agent": {"name": "review-swarm", "role": "reviewer", "harness": harness_of(backend)},
                    "model": {"provider": provider_of(model), "name": model},
                    "sandbox_runtime": args.sandbox_runtime,
                    "task": dict(task, kind="pr-review"),
                    "outcome": out,
                }
                if quality:
                    rec["quality"] = quality
                by_month[month].append(rec)
                stats["reviewer"] += 1

    os.makedirs(args.out, exist_ok=True)
    written = 0
    for month, recs in sorted(by_month.items()):
        recs.sort(key=lambda r: r["id"])
        path = os.path.join(args.out, f"{month}.json")
        with open(path, "w") as f:
            json.dump(recs, f, indent=None, separators=(",", ":"), sort_keys=True)
            f.write("\n")
        written += len(recs)
    print(f"{args.hive_id}: hash={hive['hash']} prs={len(groups)} bundles_bad={bad} author={stats['author']} reviewer={stats['reviewer']} skipped_old={stats['skipped_old']} written={written} months={len(by_month)}", file=sys.stderr)
    return 0


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--evidence", required=True, help="evidence root (contains <owner>/<repo>/<n>/<sha>.json)")
    p.add_argument("--hive-id", required=True)
    p.add_argument("--hive-version", default="unknown")
    p.add_argument("--cluster", default=None)
    p.add_argument("--public-repos", help="file of owner/name repos allowed to be named")
    p.add_argument("--out", required=True, help="output dir; one <YYYY-MM>.json per month")
    p.add_argument("--since", help="skip PRs whose latest bundle is older than YYYY-MM-DD")
    p.add_argument("--sandbox-runtime", default="none")
    p.add_argument("--exporter", default="backfill-from-cluster")
    return convert(p.parse_args())


if __name__ == "__main__":
    sys.exit(main())
