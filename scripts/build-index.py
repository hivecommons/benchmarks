#!/usr/bin/env python3
"""Aggregate data/**/*.json records into data/index.json.

The browser never sees raw records: index.json holds pre-aggregated cells at
the grain (org, hive_id, month, role, kind, harness, runtime, acmm, provider,
model, synthetic) plus per-hive totals. Wall-clock is kept as a 12-bucket
log-scale histogram so the site can report a median without raw values.
"""
import collections
import datetime as dt
import glob
import json
import os
import sys

# wall-clock buckets in hours (upper bounds); last is open-ended
WALL_BUCKETS_H = [0.25, 0.5, 1, 2, 4, 8, 24, 48, 96, 168, 336, 720]


def bucket(wall_s):
    h = wall_s / 3600
    for i, ub in enumerate(WALL_BUCKETS_H):
        if h <= ub:
            return i
    return len(WALL_BUCKETS_H)


def load(root):
    recs = []
    for path in sorted(glob.glob(os.path.join(root, "**", "*.json"), recursive=True)):
        if os.path.basename(path) == "index.json":
            continue
        with open(path) as f:
            data = json.load(f)
        recs.extend(data if isinstance(data, list) else [data])
    return recs


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else "data"
    out_path = sys.argv[2] if len(sys.argv) > 2 else os.path.join(root, "index.json")
    recs = load(root)
    ids = collections.Counter(r["id"] for r in recs)
    dupes = [i for i, n in ids.items() if n > 1]
    if dupes:
        print(f"duplicate ids: {dupes[:5]} (+{max(len(dupes)-5,0)})", file=sys.stderr)
        return 1

    cells = {}
    hives = {}
    for r in recs:
        src, ag, md, task, out, q = r.get("source", {}), r.get("agent", {}), r.get("model", {}), r.get("task", {}), r.get("outcome", {}), r.get("quality", {})
        month = (out.get("merged_at") or out.get("opened_at") or r["published_at"])[:7]
        acmm = task.get("acmm_level", q.get("acmm_level"))
        key = (src.get("org", ""), src.get("hive_id", ""), month, ag.get("role", ""), task.get("kind", ""), ag.get("harness", ""),
               r.get("sandbox_runtime", ""), "" if acmm is None else str(acmm), md.get("provider", ""), md.get("name", ""), bool(r.get("synthetic")))
        c = cells.get(key)
        if c is None:
            c = cells[key] = {"n": 0, "opened": 0, "merged": 0, "ci_n": 0, "ci_green": 0, "cost_n": 0, "cost_usd": 0.0, "cost_merged": 0,
                              "revert_n": 0, "reverted": 0, "interventions": 0, "retries": 0, "wall": [0] * (len(WALL_BUCKETS_H) + 1)}
        c["n"] += 1
        if out.get("pr_opened"):
            c["opened"] += 1
        if out.get("pr_merged"):
            c["merged"] += 1
        if out.get("ci_green_first_try") in (True, False):
            c["ci_n"] += 1
            c["ci_green"] += 1 if out["ci_green_first_try"] else 0
        cost = r.get("cost") or {}
        if isinstance(cost.get("usd"), (int, float)):
            c["cost_n"] += 1
            c["cost_usd"] += cost["usd"]
            c["cost_merged"] += 1 if out.get("pr_merged") else 0
        if q.get("reverted_within_14d") in (True, False):
            c["revert_n"] += 1
            c["reverted"] += 1 if q["reverted_within_14d"] else 0
        c["interventions"] += out.get("human_interventions", 0) or 0
        c["retries"] += out.get("retries", 0) or 0
        if isinstance(out.get("wall_clock_s"), (int, float)) and out.get("pr_merged"):
            c["wall"][bucket(out["wall_clock_s"])] += 1

        hid = src.get("hive_id", "")
        h = hives.setdefault(hid, {"hive_id": hid, "records": 0, "attributed": 0, "authored": 0, "reviews": 0, "first": month, "last": month,
                                    "hive_version": src.get("hive_version", ""), "cluster": src.get("cluster", ""), "orgs": set(), "synthetic": bool(r.get("synthetic"))})
        h["records"] += 1
        h["attributed"] += 1 if task.get("repo_consent") else 0
        h["authored"] += 1 if ag.get("role") == "author" else 0
        h["reviews"] += 1 if ag.get("role") == "reviewer" else 0
        h["first"], h["last"] = min(h["first"], month), max(h["last"], month)
        if src.get("org"):
            h["orgs"].add(src["org"])

    dims = ["org", "hive_id", "month", "role", "kind", "harness", "runtime", "acmm", "provider", "model", "synthetic"]
    cell_rows = [dict(zip(dims, k), **v) for k, v in sorted(cells.items(), key=lambda kv: [str(x) for x in kv[0]])]
    for h in hives.values():
        h["orgs"] = sorted(h["orgs"])
    real = [r for r in recs if not r.get("synthetic")]
    index = {
        "generated_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source_commit": os.environ.get("GITHUB_SHA", "local"),
        "schema_version": "1",
        "count": len(recs),
        "synthetic_count": len(recs) - len(real),
        "attributed_count": sum(1 for r in real if r.get("task", {}).get("repo_consent")),
        "anonymized_count": sum(1 for r in real if not r.get("task", {}).get("repo_consent")),
        "hive_count": sum(1 for h in hives.values() if not h["synthetic"]),
        "latest_published_at": max((r["published_at"] for r in real), default=None),
        "wall_buckets_h": WALL_BUCKETS_H,
        "hives": sorted(hives.values(), key=lambda h: -h["records"]),
        "cells": cell_rows,
    }
    with open(out_path, "w") as f:
        json.dump(index, f, separators=(",", ":"))
        f.write("\n")
    print(f"wrote {out_path}: {len(recs)} records, {len(cell_rows)} cells, {index['hive_count']} hives, {os.path.getsize(out_path)//1024} KiB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
