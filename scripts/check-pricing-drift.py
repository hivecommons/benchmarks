#!/usr/bin/env python3
"""Compare schema/pricing.json against hive's pkg/tokens/pricing.go.

Fetches pricing.go from the `source` URL in schema/pricing.json (blob URLs are
rewritten to raw), extracts the modelPrices rows and reports model keys and
rates that differ. Warn-only by default (exit 0, GitHub ::warning:: lines);
pass --fail to exit 1 on drift. Network errors are warnings unless --fail.

Usage: check-pricing-drift.py [--fail] [--go-file PATH] [--pricing PATH]

Stdlib only.
"""
import argparse
import json
import os
import re
import sys
import urllib.request

PRICING_PATH = os.path.join(os.path.dirname(__file__), "..", "schema", "pricing.json")
FIELDS = {
    "InputPerMTok": "input_per_mtok",
    "OutputPerMTok": "output_per_mtok",
    "CacheReadPerMTok": "cache_read_per_mtok",
    "CacheWritePerMTok": "cache_write_per_mtok",
}
_BLOCK = re.compile(r"\bmodelPrices\s*=\s*map\[string\]ModelPrice\s*\{")
_ROW = re.compile(r'"([^"]+)"\s*:\s*\{([^{}]*)\}')
_FIELD = re.compile(r"(\w+)\s*:\s*([0-9][0-9_]*(?:\.[0-9_]*)?(?:[eE][+-]?\d+)?)")
_COMMENT = re.compile(r"//[^\n]*")


def parse_go_prices(src):
    """Return {model_key: {json_field: float}} from a pricing.go source string."""
    m = _BLOCK.search(src)
    if not m:
        raise ValueError("modelPrices table not found in Go source")
    body = _COMMENT.sub("", src[m.end():])
    out = {}
    for key, fields in _ROW.findall(body):
        row = {}
        for name, val in _FIELD.findall(fields):
            if name in FIELDS:
                row[FIELDS[name]] = float(val.replace("_", ""))
        out[key] = row
    return out


def compare(go_models, json_models):
    """Return a list of human-readable drift messages (empty when in sync)."""
    msgs = []
    for k in sorted(set(go_models) - set(json_models)):
        msgs.append("model %s is in pricing.go but missing from pricing.json" % k)
    for k in sorted(set(json_models) - set(go_models)):
        msgs.append("model %s is in pricing.json but not in pricing.go" % k)
    for k in sorted(set(go_models) & set(json_models)):
        for f in FIELDS.values():
            g, j = go_models[k].get(f), json_models[k].get(f)
            if g is None or j is None or abs(g - j) > 1e-9:
                msgs.append("model %s %s: pricing.go=%s pricing.json=%s" % (k, f, g, j))
    return msgs


def raw_url(url):
    m = re.match(r"https://github\.com/([^/]+/[^/]+)/blob/(.+)$", url)
    return "https://raw.githubusercontent.com/%s/%s" % m.groups() if m else url


def fetch(url):
    with urllib.request.urlopen(raw_url(url), timeout=30) as r:
        return r.read().decode("utf-8")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--fail", action="store_true", help="exit 1 on drift or fetch failure")
    ap.add_argument("--go-file", help="read pricing.go from this path instead of fetching")
    ap.add_argument("--pricing", default=PRICING_PATH)
    args = ap.parse_args(argv)

    with open(args.pricing) as f:
        table = json.load(f)
    try:
        if args.go_file:
            with open(args.go_file) as f:
                src = f.read()
        else:
            src = fetch(table["source"])
        msgs = compare(parse_go_prices(src), table["models"])
    except (OSError, ValueError) as e:
        print("::warning::pricing drift check could not run: %s" % e)
        return 1 if args.fail else 0
    if not msgs:
        print("pricing.json matches pricing.go (%d models)" % len(table["models"]))
        return 0
    for m in msgs:
        print("::warning::pricing drift: %s" % m)
    print("%d difference(s); update schema/pricing.json and as_of" % len(msgs))
    return 1 if args.fail else 0


if __name__ == "__main__":
    sys.exit(main())
