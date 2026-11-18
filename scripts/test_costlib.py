import json
import os
import tempfile
import unittest

import costlib
from costlib import MEDIAN_MIN_N, Pricing, fill_fleet_medians, normalize_model

# Synthetic price table so the tests do not depend on schema/pricing.json values.
PRICES = {
    "as_of": "2000-01-01",
    "models": {"claude-test-1": {"input_per_mtok": 10.0, "output_per_mtok": 20.0, "cache_read_per_mtok": 1.0, "cache_write_per_mtok": 5.0}},
    "fallback_tiers": {
        "cheap": {"input_per_mtok": 1.0, "output_per_mtok": 1.0, "cache_read_per_mtok": 0.0, "cache_write_per_mtok": 0.0},
        "mid": {"input_per_mtok": 2.0, "output_per_mtok": 2.0, "cache_read_per_mtok": 0.0, "cache_write_per_mtok": 0.0},
        "big": {"input_per_mtok": 3.0, "output_per_mtok": 3.0, "cache_read_per_mtok": 0.0, "cache_write_per_mtok": 0.0},
    },
}


def make_pricing():
    d = tempfile.mkdtemp()
    p = os.path.join(d, "pricing.json")
    with open(p, "w") as f:
        json.dump(PRICES, f)
    return Pricing(p)


class NormalizeModelTest(unittest.TestCase):
    CASES = [
        (None, ""),
        ("", ""),
        ("   ", ""),
        ("Claude-Sonnet-5-5", "claude-sonnet-5-5"),
        ("claude-sonnet-5.5", "claude-sonnet-5-5"),
        ("anthropic/claude-opus-4-6", "claude-opus-4-6"),
        ("openai-codex/gpt-6.1-sol:high", "gpt-6-1-sol"),
        ("claude-sonnet-4-5-20250929", "claude-sonnet-4-5"),
        ("claude-sonnet-4-5-20250929-v1", "claude-sonnet-4-5"),
        ("gpt-5-20250101", "gpt-5-20250101"),  # date suffix only stripped for claude-*
        ("us.anthropic.claude-haiku-4-5", "claude-haiku-4-5"),
        ("llama3-70b", "llama-3-70b"),
        ("meta_llama3-8b", "llama-3-8b"),
        ("GPT-5.6 Terra", "gpt-5-6-terra"),
        ("some__weird  name", "some-weird-name"),
        ("-edge-", "edge"),
        ("totally-unknown-model", "totally-unknown-model"),
    ]

    def test_cases(self):
        for raw, want in self.CASES:
            with self.subTest(raw=raw):
                self.assertEqual(normalize_model(raw), want)


class PricingTest(unittest.TestCase):
    def setUp(self):
        self.p = make_pricing()

    def test_exact_and_fallback_tiers(self):
        row, exact = self.p.price("claude-test-1-20250101")
        self.assertTrue(exact)
        self.assertEqual(row["input_per_mtok"], 10.0)
        for name, tier in (("gpt-5-mini", "cheap"), ("claude-haiku-9", "cheap"), ("claude-opus-9", "big"), ("foo-pro", "big"), ("mystery", "mid"), ("", "mid")):
            with self.subTest(model=name):
                row, exact = self.p.price(name)
                self.assertFalse(exact)
                self.assertEqual(row, PRICES["fallback_tiers"][tier])

    def test_usd(self):
        usd, exact = self.p.usd("claude-test-1", 1_000_000, 1_000_000, 1_000_000, 1_000_000)
        self.assertTrue(exact)
        self.assertAlmostEqual(usd, 36.0)
        self.assertEqual(self.p.usd("mystery")[0], 0.0)

    def test_as_of(self):
        self.assertEqual(self.p.as_of, "2000-01-01")


def rec(model="claude-test-1", role="author", basis=None, usd=None, toks=None, usd_key="usd_est", cost=...):
    r = {"model": {"name": model}, "agent": {"role": role}}
    if cost is not ...:
        if cost is not None:
            r["cost"] = cost
        return r
    if basis is not None:
        c = {"basis": basis}
        if usd is not None:
            c[usd_key] = usd
        if toks:
            c.update(dict(zip(("input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"), toks)))
        r["cost"] = c
    return r


class FillFleetMediansTest(unittest.TestCase):
    def setUp(self):
        self.p = make_pricing()

    def test_empty_input(self):
        self.assertEqual(fill_fleet_medians([], self.p), {})

    def test_no_data_unknown_stays_unknown(self):
        recs = [rec(), rec(basis="unknown"), rec(cost=None), rec(cost={})]
        self.assertEqual(fill_fleet_medians(recs, self.p), {})
        for r in recs:
            self.assertEqual(r["cost"], {"basis": "unknown"})

    def test_missing_model_and_agent_fields(self):
        recs = [{}, {"cost": None}, {"model": None, "agent": None}]
        fill_fleet_medians(recs, self.p)
        for r in recs:
            self.assertEqual(r["cost"], {"basis": "unknown"})

    def test_model_median_at_min_n(self):
        usds = [1.0, 2.0, 3.0, 10.0, 100.0]
        self.assertEqual(len(usds), MEDIAN_MIN_N)
        recs = [rec(basis="tokens_x_pricing", usd=u) for u in usds] + [rec(basis="unknown"), rec(model="anthropic/claude-test-1")]
        medians = fill_fleet_medians(recs, self.p)
        self.assertEqual(medians[("claude-test-1", "author")], {"usd": 3.0, "n": 5, "how": "model"})
        # attributed records are untouched, imputed ones are marked
        self.assertEqual(recs[0]["cost"]["basis"], "tokens_x_pricing")
        for r in recs[5:]:
            self.assertEqual(r["cost"], {"basis": "fleet_model_median", "usd_est": 3.0})

    def test_below_min_n_without_token_mix_is_unknown(self):
        recs = [rec(basis="tokens_x_pricing", usd=u) for u in (1.0, 2.0, 3.0, 4.0)] + [rec(basis="unknown")]
        self.assertEqual(fill_fleet_medians(recs, self.p), {})
        self.assertEqual(recs[-1]["cost"], {"basis": "unknown"})

    def test_token_mix_rung_prices_at_model_list_price(self):
        # 5 attributed records for another model carry a token mix of 1M in / 1M out.
        recs = [rec(model="other", basis="tokens_x_pricing", usd=1.0, toks=(1_000_000, 1_000_000, 0, 0)) for _ in range(5)]
        target = rec(model="claude-test-1", basis="unknown")
        recs.append(target)
        medians = fill_fleet_medians(recs, self.p)
        self.assertEqual(target["cost"], {"basis": "fleet_model_median", "usd_est": 30.0})  # 10 + 20
        self.assertEqual(medians[("claude-test-1", "author")], {"usd": 30.0, "n": 5, "how": "tokens"})

    def test_roles_are_separate(self):
        recs = [rec(role="author", basis="tokens_x_pricing", usd=5.0) for _ in range(5)]
        reviewer = rec(role="reviewer", basis="unknown")
        recs.append(reviewer)
        fill_fleet_medians(recs, self.p)
        self.assertEqual(reviewer["cost"], {"basis": "unknown"})

    def test_reported_cost_uses_usd_key_and_is_backfilled(self):
        recs = [rec(basis="reported", usd=2.0, usd_key="usd") for _ in range(5)]
        fill_fleet_medians(recs, self.p)
        for r in recs:
            self.assertEqual(r["cost"]["usd_est"], 2.0)

    def test_non_positive_or_non_numeric_usd_not_trusted(self):
        recs = [rec(basis="tokens_x_pricing", usd=0.0), rec(basis="tokens_x_pricing", usd="3"), rec(basis="tokens_x_pricing")]
        fill_fleet_medians(recs, self.p)
        for r in recs:
            self.assertEqual(r["cost"], {"basis": "unknown"})

    def test_fleet_median_records_are_not_samples(self):
        recs = [rec(basis="fleet_model_median", usd=9.0) for _ in range(5)] + [rec(basis="unknown")]
        self.assertEqual(fill_fleet_medians(recs, self.p), {})


class LaunchCostIndexTest(unittest.TestCase):
    def _index(self, store):
        d = tempfile.mkdtemp()
        p = os.path.join(d, "launch-cost.json")
        with open(p, "w") as f:
            json.dump(store, f)
        return costlib.LaunchCostIndex(p)

    def test_missing_or_bad_file(self):
        self.assertFalse(costlib.LaunchCostIndex(None).ok)
        self.assertFalse(costlib.LaunchCostIndex("/nonexistent/x.json").ok)
        d = tempfile.mkdtemp()
        p = os.path.join(d, "bad.json")
        with open(p, "w") as f:
            f.write("{not json")
        self.assertFalse(costlib.LaunchCostIndex(p).ok)

    def test_cost_for(self):
        idx = self._index({
            "snapshot": {"price_table_date": "2026-01-01", "by_launch": [{"refs": [{"ref": 1}, {"ref": 2}], "input": 10, "output": 4}]},
            "daily_rollup": [{"by_ref": [{"ref": 1, "kind": "pr", "share_usd": 1.5, "launches": 2}]}],
            "live_launches": {"a": {"share_usd": 0.5, "refs": [{"ref": 1, "kind": "pr"}]}, "b": {"share_usd": 0.0, "refs": [{"ref": 3, "kind": "issue"}]}},
        })
        self.assertTrue(idx.ok)
        c = idx.cost_for([(1, "pr")])
        self.assertEqual((c["basis"], c["usd_est"], c["launches"]), ("tokens_x_pricing", 2.0, 3))
        self.assertEqual((c["input_tokens"], c["output_tokens"], c["price_table_date"]), (5, 2, "2026-01-01"))
        self.assertEqual(idx.cost_for([(99, "pr")]), {"basis": "unknown"})
        # kicks recorded but $0 spend: left to the fleet median
        self.assertEqual(idx.cost_for([(3, "issue")]), {"basis": "unknown", "launches": 1})


if __name__ == "__main__":
    unittest.main()
