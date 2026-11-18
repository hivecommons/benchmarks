#!/usr/bin/env python3
"""Fail when a data record publishes task.repo for a repo not in consent/repos.txt.

usage: check-repo-consent.py [--data data] [--allow consent/repos.txt]
                             [--enforce-from consent/enforce-from.txt]

Exemption path for anonymised records: a record without task.repo is never checked.
To fix a violation either add the repo to consent/repos.txt (PR by an admin of that
repo/org) or anonymise the record by removing task.repo (and task.repo_consent).

Existing data is grandfathered: while enforce-from is `none` the check only reports.
When it holds a timestamp, records with published_at >= that timestamp fail.
"""
import argparse
import collections
import json
import os
import sys

SAMPLE_LIMIT = 10


def load_allow(path):
    exact, owners = set(), set()
    with open(path) as f:
        for raw in f:
            line = raw.split("#", 1)[0].strip().lower()
            if not line:
                continue
            owner, _, name = line.partition("/")
            if not owner or not name:
                sys.exit(f"{path}: bad entry {raw.strip()!r} (want owner/name or owner/*)")
            (owners if name == "*" else exact).add(owner if name == "*" else line)
    return exact, owners


def load_enforce(path):
    try:
        val = open(path).read().strip()
    except FileNotFoundError:
        return None
    return None if val in ("", "none") else val


def records(data_dir):
    for root, _, files in os.walk(data_dir):
        for fn in sorted(files):
            if not fn.endswith(".json") or fn == "index.json":
                continue
            p = os.path.join(root, fn)
            with open(p) as f:
                d = json.load(f)
            for r in d if isinstance(d, list) else [d]:
                yield p, r


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data")
    ap.add_argument("--allow", default="consent/repos.txt")
    ap.add_argument("--enforce-from", default="consent/enforce-from.txt")
    a = ap.parse_args()
    exact, owners = load_allow(a.allow)
    since = load_enforce(a.enforce_from)

    by_owner = collections.Counter()
    failing = []
    total = checked = 0
    for path, r in records(a.data):
        total += 1
        repo = (r.get("task") or {}).get("repo")
        if not repo:
            continue
        checked += 1
        low = repo.lower()
        if low in exact or low.split("/")[0] in owners:
            continue
        by_owner[repo.split("/")[0]] += 1
        if since is not None and str(r.get("published_at", "")) >= since:
            failing.append((path, r.get("id", "?"), repo))

    unlisted = sum(by_owner.values())
    mode = "report-only" if since is None else f"enforcing for published_at >= {since}"
    print(f"records: {total}; with task.repo: {checked}; not allow-listed: {unlisted} ({mode})")
    for owner, n in by_owner.most_common():
        print(f"  {owner}: {n}")
    for path, rid, repo in failing[:SAMPLE_LIMIT]:
        print(f"::error file={path}::record {rid} publishes task.repo={repo} without consent")
    if failing:
        print(
            f"\nFAIL: {len(failing)} record(s) publish task.repo for a repo not in {a.allow}.\n"
            "Fix: (a) have an admin of the repo/org open a PR adding it to consent/repos.txt, or\n"
            "(b) anonymise the record: remove task.repo and task.repo_consent.\n"
            "See METHODOLOGY.md (Consent) and consent/README.md.",
            file=sys.stderr,
        )
        return 1
    if unlisted:
        print("::warning::grandfathered records publish task.repo without allow-list consent; see consent/README.md")
    return 0


if __name__ == "__main__":
    sys.exit(main())
