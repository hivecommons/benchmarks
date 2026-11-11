"""Cost estimation shared by convert-evidence.py and build-index.py.

Every figure here is an ESTIMATE. The basis ladder (schema cost.basis):

  reported            harness/gateway returned a billed figure (not produced
                      by this module; passed through when a record has it)
  tokens_x_pricing    hive's per-kick token counts × list prices
                      (schema/pricing.json, mirrored from hive
                      pkg/tokens/pricing.go), apportioned to a PR through
                      hive's launch attribution (/data/launch-cost.json:
                      kick refs → the PR number or the issues the PR closed)
  fleet_model_median  no attribution for this PR: median tokens_x_pricing
                      cost of the same (model, role) across the fleet
                      (computed at index-build time, never persisted)
  unknown             nothing available; excluded from cost aggregates

Stdlib only.
"""
import collections
import json
import os
import re
import statistics

PRICING_PATH = os.path.join(os.path.dirname(__file__), "..", "schema", "pricing.json")
MEDIAN_MIN_N = 5
_VERSION_SUFFIX = re.compile(r"-\d{8}(-v\d+)?$")
_MARKERS = ("claude-", "gpt-", "deepseek-", "llama-", "llama3-", "gemini-")


def normalize_model(model):
    """Port of hive's tokens.normalizeModelID so pricing.json keys match."""
    mid = (model or "").strip().lower()
    if not mid:
        return ""
    if "/" in mid:
        mid = mid.rsplit("/", 1)[1]
    if ":" in mid:
        mid = mid.split(":", 1)[0]
    for ch in ".", "_", " ":
        mid = mid.replace(ch, "-")
    while "--" in mid:
        mid = mid.replace("--", "-")
    mid = mid.strip("-")
    for marker in _MARKERS:
        i = mid.find(marker)
        if i > 0:
            mid = mid[i:]
            break
    if mid.startswith("llama3-"):
        mid = "llama-3-" + mid[len("llama3-"):]
    if mid.startswith("claude-"):
        mid = _VERSION_SUFFIX.sub("", mid)
    return mid.strip("-")


class Pricing:
    def __init__(self, path=PRICING_PATH):
        with open(path) as f:
            self.table = json.load(f)
        self.as_of = self.table["as_of"]

    def price(self, model):
        mid = normalize_model(model)
        row = self.table["models"].get(mid)
        if row:
            return row, True
        tiers = self.table["fallback_tiers"]
        if any(k in mid for k in ("mini", "flash", "haiku", "lite", "small", "nano")):
            return tiers["cheap"], False
        if any(k in mid for k in ("opus", "-pro", "fable", "ultra", "-max")):
            return tiers["big"], False
        return tiers["mid"], False

    def usd(self, model, input_tok=0, output_tok=0, cache_read=0, cache_write=0):
        p, exact = self.price(model)
        usd = (input_tok * p["input_per_mtok"] + output_tok * p["output_per_mtok"]
               + cache_read * p["cache_read_per_mtok"] + cache_write * p["cache_write_per_mtok"]) / 1e6
        return usd, exact


class LaunchCostIndex:
    """Per-ref spend from a spoke's /data/launch-cost.json.

    usd per ref = settled daily_rollup share + live_launches share (the
    launches the rollup has not folded yet). Tokens come from the 14-day
    snapshot.by_launch split evenly across each launch's refs; they are
    informational and may cover less history than usd.
    """

    def __init__(self, path):
        self.usd = collections.defaultdict(float)       # (ref, kind) -> usd
        self.launches = collections.Counter()           # (ref, kind) -> kicks
        self.tokens = collections.defaultdict(lambda: [0, 0, 0, 0])  # ref -> [in, out, cr, cw]
        self.price_table_date = None
        self.ok = False
        if not path or not os.path.exists(path):
            return
        try:
            with open(path) as f:
                store = json.load(f)
        except (OSError, ValueError):
            return
        snap = store.get("snapshot") or {}
        self.price_table_date = snap.get("price_table_date") or None
        for day in store.get("daily_rollup") or []:
            for r in day.get("by_ref") or []:
                key = (r.get("ref"), r.get("kind"))
                self.usd[key] += r.get("share_usd") or 0.0
                self.launches[key] += r.get("launches") or 0
        for live in (store.get("live_launches") or {}).values():
            refs = live.get("refs") or []
            for r in refs:
                key = (r.get("ref"), r.get("kind"))
                self.usd[key] += live.get("share_usd") or 0.0
                self.launches[key] += 1
        for launch in snap.get("by_launch") or []:
            refs = launch.get("refs") or []
            if not refs:
                continue
            n = len(refs)
            for r in refs:
                t = self.tokens[r.get("ref")]
                t[0] += (launch.get("input") or 0) // n
                t[1] += (launch.get("output") or 0) // n
                t[2] += (launch.get("cache_read") or 0) // n
                t[3] += (launch.get("cache_create") or 0) // n
        self.ok = True

    def cost_for(self, refs_by_kind):
        """refs_by_kind: iterable of (ref, kind). Returns a schema cost object."""
        usd = 0.0
        launches = 0
        toks = [0, 0, 0, 0]
        hit = False
        for ref, kind in refs_by_kind:
            key = (ref, kind)
            if key in self.usd or key in self.launches:
                hit = True
                usd += self.usd[key]
                launches += self.launches[key]
            if ref in self.tokens:
                for i in range(4):
                    toks[i] += self.tokens[ref][i]
        if not hit:
            return {"basis": "unknown"}
        if usd <= 0:
            # kicks were recorded but no usage landed on them (backend without a
            # usage timeline, or usage outside the ownership horizon): $0 is not
            # an estimate, so leave it to the fleet median.
            return {"basis": "unknown", "launches": launches}
        out = {"basis": "tokens_x_pricing", "usd_est": round(usd, 4), "launches": launches}
        if any(toks):
            out.update(input_tokens=toks[0], output_tokens=toks[1], cache_read_tokens=toks[2], cache_write_tokens=toks[3])
        if self.price_table_date:
            out["price_table_date"] = self.price_table_date
        return out


def fill_fleet_medians(records, pricing=None):
    """Give records whose cost basis is unknown/missing a fleet_model_median
    estimate. Mutates in place; returns {(model, role): {"usd", "n", "how"}}.

    Two rungs, both reported as basis=fleet_model_median:
      model   >= MEDIAN_MIN_N attributed PRs for the same (model, role):
              median of their usd_est.
      tokens  otherwise: fleet median token mix for the role (from attributed
              records that carry token counts) priced at the model's own list
              price, so a rarely-attributed model is not priced like another.
    """
    pricing = pricing or Pricing()
    samples = collections.defaultdict(list)
    mix = collections.defaultdict(lambda: [[], [], [], []])
    for r in records:
        c = r.get("cost") or {}
        usd = c.get("usd_est", c.get("usd"))
        if c.get("basis") in ("reported", "tokens_x_pricing") and isinstance(usd, (int, float)) and usd > 0:
            role = (r.get("agent") or {}).get("role", "")
            samples[(normalize_model((r.get("model") or {}).get("name")), role)].append(usd)
            if c.get("input_tokens") is not None:
                for i, k in enumerate(("input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens")):
                    mix[role][i].append(c.get(k) or 0)
    medians = {k: {"usd": statistics.median(v), "n": len(v), "how": "model"} for k, v in samples.items() if len(v) >= MEDIAN_MIN_N}
    role_mix = {role: [statistics.median(col) for col in cols] for role, cols in mix.items() if len(cols[0]) >= MEDIAN_MIN_N}

    def estimate(model, role):
        key = (normalize_model(model), role)
        if key in medians:
            return medians[key]
        if role in role_mix:
            usd, _ = pricing.usd(model, *role_mix[role])
            est = medians[key] = {"usd": usd, "n": len(mix[role][0]), "how": "tokens"}
            return est
        return None

    for r in records:
        c = r.get("cost") or {}
        if c.get("basis") in ("reported", "tokens_x_pricing") and isinstance(c.get("usd_est", c.get("usd")), (int, float)) and c.get("usd_est", c.get("usd")) > 0:
            if "usd_est" not in c:
                c["usd_est"] = c["usd"]
            continue
        est = estimate((r.get("model") or {}).get("name"), (r.get("agent") or {}).get("role", ""))
        if est:
            r["cost"] = {"basis": "fleet_model_median", "usd_est": round(est["usd"], 4)}
        else:
            r["cost"] = {"basis": "unknown"}
    return medians
