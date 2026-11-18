import contextlib
import importlib.util
import io
import json
import os
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("build_index", os.path.join(HERE, "build-index.py"))
bi = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bi)

HOUR = 3600


def record(rid, **over):
    r = {
        "id": rid,
        "published_at": "2026-03-15T00:00:00Z",
        "source": {"org": "acme", "hive_id": "h1"},
        "agent": {"role": "author", "harness": "claude"},
        "model": {"provider": "anthropic", "name": "claude-sonnet-5-5"},
        "task": {"kind": "fix", "repo_consent": True},
        "outcome": {"pr_opened": True, "pr_merged": True},
    }
    for k, v in over.items():
        r[k] = v
    return r


def write(root, name, data):
    os.makedirs(os.path.dirname(os.path.join(root, name)), exist_ok=True)
    with open(os.path.join(root, name), "w") as f:
        json.dump(data, f)


def run_main(root, argv_extra=None):
    out = os.path.join(root, "out.json")
    old = bi.sys.argv
    bi.sys.argv = ["build-index.py", root, out]
    err = io.StringIO()
    try:
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(err):
            rc = bi.main()
    finally:
        bi.sys.argv = old
    idx = None
    if os.path.exists(out):
        with open(out) as f:
            idx = json.load(f)
    return rc, idx, err.getvalue()


class BucketTest(unittest.TestCase):
    def test_boundaries(self):
        ubs = bi.WALL_BUCKETS_H
        self.assertEqual(bi.bucket(0), 0)
        for i, ub in enumerate(ubs):
            with self.subTest(upper_bound_h=ub):
                self.assertEqual(bi.bucket(ub * HOUR), i)          # inclusive upper bound
                self.assertEqual(bi.bucket(ub * HOUR + 1), i + 1)  # just above spills to next
        self.assertEqual(bi.bucket(10_000 * HOUR), len(ubs))      # open-ended last bucket
        self.assertEqual(bi.bucket(-5), 0)


class LoadTest(unittest.TestCase):
    def test_load_objects_arrays_recursive_and_skips_index(self):
        with tempfile.TemporaryDirectory() as d:
            write(d, "a/one.json", record("1"))
            write(d, "a/b/many.json", [record("2"), record("3")])
            write(d, "index.json", [record("skipme")])
            write(d, "a/index.json", [record("skipme2")])
            write(d, "notes.txt", "ignored")
            ids = sorted(r["id"] for r in bi.load(d))
        self.assertEqual(ids, ["1", "2", "3"])

    def test_load_empty_dir(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(bi.load(d), [])

    def test_load_bad_json_raises(self):
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, "bad.json"), "w") as f:
                f.write("{")
            with self.assertRaises(ValueError):
                bi.load(d)


class MainTest(unittest.TestCase):
    def test_empty_root(self):
        with tempfile.TemporaryDirectory() as d:
            rc, idx, _ = run_main(d)
        self.assertEqual(rc, 0)
        self.assertEqual((idx["count"], idx["hive_count"], idx["cells"], idx["latest_published_at"]), (0, 0, [], None))

    def test_duplicate_ids_fail_without_writing(self):
        with tempfile.TemporaryDirectory() as d:
            write(d, "x.json", [record("dup"), record("dup")])
            rc, idx, err = run_main(d)
        self.assertEqual(rc, 1)
        self.assertIsNone(idx)
        self.assertIn("duplicate ids", err)

    def test_synthetic_excluded_from_real_counts(self):
        with tempfile.TemporaryDirectory() as d:
            write(d, "x.json", [
                record("r1", published_at="2026-03-01T00:00:00Z"),
                record("s1", synthetic=True, published_at="2027-01-01T00:00:00Z", source={"org": "acme", "hive_id": "synth"}),
            ])
            _, idx, _ = run_main(d)
        self.assertEqual((idx["count"], idx["synthetic_count"]), (2, 1))
        self.assertEqual(idx["latest_published_at"], "2026-03-01T00:00:00Z")  # synthetic ignored
        self.assertEqual(idx["hive_count"], 1)                                # synthetic hive not counted
        self.assertEqual(idx["attributed_count"], 1)
        # synthetic records stay separate cells (synthetic is part of the key)
        self.assertEqual(sorted(c["synthetic"] for c in idx["cells"]), [False, True])
        self.assertEqual(len(idx["hives"]), 2)
        self.assertEqual(sum(c["n"] for c in idx["cells"] if not c["synthetic"]), 1)

    def test_coverage_attributed_vs_anonymized(self):
        with tempfile.TemporaryDirectory() as d:
            recs = [record("a1"), record("a2"),
                    record("n1", task={"kind": "fix", "repo_consent": False}),
                    record("n2", task={"kind": "fix"}),
                    record("s", synthetic=True)]
            write(d, "x.json", recs)
            _, idx, _ = run_main(d)
        self.assertEqual(idx["attributed_count"], 2)
        self.assertEqual(idx["anonymized_count"], 2)
        self.assertEqual(idx["count"], 5)
        self.assertEqual(idx["attributed_count"] + idx["anonymized_count"] + idx["synthetic_count"], idx["count"])
        hive = [h for h in idx["hives"] if h["hive_id"] == "h1"][0]
        # Observed behavior: per-hive counters do NOT exclude synthetic records
        # (the synthetic record here shares hive h1), unlike the top-level
        # attributed_count. Harmless while synthetic data uses its own hive_id.
        self.assertEqual((hive["records"], hive["attributed"], hive["authored"], hive["reviews"]), (5, 3, 5, 0))

    def test_cell_counts_rates_and_wall_histogram(self):
        with tempfile.TemporaryDirectory() as d:
            recs = [
                record("1", outcome={"pr_opened": True, "pr_merged": True, "ci_green_first_try": True, "wall_clock_s": 0.3 * HOUR, "human_interventions": 2, "retries": 1},
                       quality={"reverted_within_14d": False}),
                record("2", outcome={"pr_opened": True, "pr_merged": False, "ci_green_first_try": False, "wall_clock_s": 5 * HOUR}, quality={"reverted_within_14d": True}),
                record("3", outcome={"pr_opened": False, "pr_merged": True, "wall_clock_s": 1000 * HOUR}),
            ]
            write(d, "x.json", recs)
            _, idx, _ = run_main(d)
        self.assertEqual(len(idx["cells"]), 1)
        c = idx["cells"][0]
        self.assertEqual((c["n"], c["opened"], c["merged"]), (3, 2, 2))
        self.assertEqual((c["ci_n"], c["ci_green"]), (2, 1))
        self.assertEqual((c["revert_n"], c["reverted"]), (2, 1))
        self.assertEqual((c["interventions"], c["retries"]), (2, 1))
        # wall clock only counted for merged PRs: 0.3h -> bucket 1, 1000h -> open-ended; unmerged 5h skipped
        self.assertEqual(sum(c["wall"]), 2)
        self.assertEqual(c["wall"][1], 1)
        self.assertEqual(c["wall"][-1], 1)
        self.assertEqual(c["canonical"], "claude-sonnet-5.5")
        self.assertEqual(c["vendor"], "anthropic")

    def test_month_fallback_and_acmm(self):
        with tempfile.TemporaryDirectory() as d:
            write(d, "x.json", [
                record("m", outcome={"pr_merged": True, "merged_at": "2026-02-28T10:00:00Z", "opened_at": "2026-01-30T00:00:00Z"}),
                record("o", outcome={"opened_at": "2026-01-30T00:00:00Z"}),
                record("p", outcome={}, task={"kind": "fix", "acmm_level": 3}),
                record("q", outcome={}, quality={"acmm_level": 4}),
            ])
            _, idx, _ = run_main(d)
        months = sorted(c["month"] for c in idx["cells"])
        self.assertEqual(months, ["2026-01", "2026-02", "2026-03", "2026-03"])
        self.assertEqual(sorted(c["acmm"] for c in idx["cells"] if c["month"] == "2026-03"), ["3", "4"])

    def test_cost_aggregation_and_min_n_inputs(self):
        # The site applies the display rules (rates need n>=10, cost per merged PR
        # needs >=30 merged PRs with a cost; site/app.js MIN_N / MIN_N_COST). The
        # index must therefore expose the raw counts those rules read.
        with tempfile.TemporaryDirectory() as d:
            recs = []
            for i in range(5):  # >= costlib.MEDIAN_MIN_N attributed PRs, merged, $2 each
                recs.append(record(f"c{i}", cost={"basis": "tokens_x_pricing", "usd_est": 2.0}))
            recs.append(record("unmerged", outcome={"pr_opened": True, "pr_merged": False}, cost={"basis": "tokens_x_pricing", "usd_est": 4.0}))
            recs.append(record("imputed"))                   # no cost -> fleet median 2.0
            recs.append(record("weird", cost={"basis": "bogus"}))  # unknown basis value
            write(d, "x.json", recs)
            _, idx, _ = run_main(d)
        c = idx["cells"][0]
        self.assertEqual(c["n"], 8)
        self.assertEqual(c["cost_basis_n"], {"reported": 0, "tokens_x_pricing": 6, "fleet_model_median": 2, "unknown": 0})
        self.assertEqual((c["cost_n"], c["cost_merged"]), (8, 7))
        self.assertAlmostEqual(c["cost_usd"], 5 * 2.0 + 4.0 + 2 * 2.0)
        self.assertAlmostEqual(c["cost_merged_usd"], 7 * 2.0)
        self.assertEqual(idx["cost"]["basis_n"]["fleet_model_median"], 2)
        med = idx["cost"]["medians"]
        self.assertEqual([(m["model"], m["role"], m["n"], m["how"]) for m in med], [("claude-sonnet-5-5", "author", 6, "model")])

    def test_cost_below_median_min_n_stays_unknown(self):
        with tempfile.TemporaryDirectory() as d:
            recs = [record(f"c{i}", cost={"basis": "tokens_x_pricing", "usd_est": 2.0}) for i in range(4)] + [record("x")]
            write(d, "x.json", recs)
            _, idx, _ = run_main(d)
        c = idx["cells"][0]
        self.assertEqual(c["cost_basis_n"]["unknown"], 1)
        self.assertEqual((c["cost_n"], c["cost_merged"]), (4, 4))
        self.assertEqual(idx["cost"]["medians"], [])

    def test_does_not_touch_live_data(self):
        live = os.path.join(HERE, "..", "data", "index.json")
        before = os.stat(live).st_mtime_ns if os.path.exists(live) else None
        with tempfile.TemporaryDirectory() as d:
            run_main(d)
        after = os.stat(live).st_mtime_ns if os.path.exists(live) else None
        self.assertEqual(before, after)


if __name__ == "__main__":
    unittest.main()
