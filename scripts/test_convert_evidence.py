import importlib.util
import json
import os
import tempfile
import types
import unittest

_spec = importlib.util.spec_from_file_location(
    "convert_evidence", os.path.join(os.path.dirname(__file__), "convert-evidence.py"))
ce = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ce)


def bundle(**kw):
    b = {
        "repo": "acme/widgets",
        "number": 7,
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-02T00:00:00Z",
        "head_sha": "aaa",
        "author": {"kind": "agent", "agent": "ci-fixer", "model": "claude-sonnet-5-5", "backend": "claude",
                   "login": "secret-login"},
        "ci": {"status": "success"},
        "merge": {"opened_at": "2026-01-01T00:00:00Z", "at": "2026-01-01T01:00:00Z", "method": "squash"},
        "verdicts": [],
    }
    b.update(kw)
    return b


class HelpersTest(unittest.TestCase):
    def test_hive_hash_stable_and_domain_separated(self):
        self.assertEqual(ce.hive_hash("x"), ce.hive_hash("x"))
        self.assertEqual(len(ce.hive_hash("x")), 16)
        self.assertNotEqual(ce.hive_hash("x"), ce.hive_hash("y"))

    def test_parse_time(self):
        self.assertIsNone(ce.parse_time(""))
        self.assertIsNone(ce.parse_time(None))
        self.assertIsNone(ce.parse_time(ce.ZERO_TIME))
        self.assertIsNone(ce.parse_time("not a time"))
        self.assertEqual(ce.iso(ce.parse_time("2026-01-02T03:04:05Z")), "2026-01-02T03:04:05Z")
        self.assertIsNone(ce.iso(None))

    def test_provider_of(self):
        self.assertEqual(ce.provider_of("openai-codex/gpt-6"), "openai-codex")
        self.assertEqual(ce.provider_of("claude-opus-4-6"), "anthropic")
        self.assertEqual(ce.provider_of("GPT-5"), "openai")
        self.assertEqual(ce.provider_of("mystery"), "unknown")
        self.assertEqual(ce.provider_of(None), "unknown")

    def test_harness_and_kind(self):
        self.assertEqual(ce.harness_of("Claude"), "claude")
        self.assertEqual(ce.harness_of("nope"), "other")
        self.assertEqual(ce.harness_of(None), "other")
        self.assertEqual(ce.kind_of("docs-agent"), "docs")
        self.assertEqual(ce.kind_of("renovate-bot"), "dependency-update")
        self.assertEqual(ce.kind_of("zzz"), "unknown")
        self.assertEqual(ce.kind_of(None), "unknown")

    def test_worst_verdict(self):
        vs = [{"verdict": "approve"}, {"verdict": "changes_requested"}, {"verdict": "comment"}]
        self.assertEqual(ce.worst_verdict(vs), "changes_requested")
        self.assertEqual(ce.worst_verdict([{"verdict": "bogus"}]), "none")
        self.assertEqual(ce.worst_verdict([]), "none")

    def test_cost_refs(self):
        latest = {"issue_closures": [{"issue": 3}, {"issue": 4, "repo": "o/other"}, {"issue": "x"}]}
        author, reviewer = ce.cost_refs("acme/widgets", 7, latest)
        self.assertIn(("widgets#7", "issue"), author)
        self.assertIn(("widgets#3", "issue"), author)
        self.assertIn(("o/other#4", "issue"), author)
        self.assertEqual(reviewer[0], ("acme/widgets#7", "pr"))
        self.assertTrue(all(k == "pr" for _, k in reviewer))


class LoadBundlesTest(unittest.TestCase):
    def test_groups_and_counts_bad(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "acme", "widgets", "7")
            os.makedirs(p)
            for name, content in (("a.json", json.dumps(bundle())), ("b.json", json.dumps(bundle(head_sha="bbb"))),
                                  ("c.json", "{not json"), ("d.json", json.dumps({"repo": "acme/widgets"}))):
                with open(os.path.join(p, name), "w") as f:
                    f.write(content)
            groups, bad = ce.load_bundles(d)
            self.assertEqual(bad, 2)
            self.assertEqual(len(groups[("acme/widgets", 7)]), 2)


HIVE = {"hash": "h", "version": "1", "exporter": "t", "cluster": None}


class PrRecordBaseTest(unittest.TestCase):
    def base(self, bundles, public=()):
        return ce.pr_record_base("acme/widgets", 7, bundles, HIVE, set(public), "now")

    def test_merged_outcome_and_retries(self):
        _, out, quality, task, source, month = self.base(
            [bundle(), bundle(head_sha="bbb", updated_at="2026-01-03T00:00:00Z", ci={"status": "failure"})])
        self.assertTrue(out["pr_merged"])
        self.assertEqual(out["merge_method"], "squash")
        self.assertEqual(out["retries"], 1)
        self.assertEqual(out["wall_clock_s"], 3600)
        self.assertEqual(out["ci_status_at_merge"], "failure")
        self.assertIs(out["ci_green_first_try"], True)
        self.assertEqual(month, "2026-01")
        self.assertFalse(quality["reverted_within_14d"])

    def test_closed_unmerged(self):
        b = bundle(merge=None, outcome={"state": "closed", "closed_at": "2026-01-01T02:00:00Z"})
        _, out, quality, _, _, _ = self.base([b])
        self.assertFalse(out["pr_merged"])
        self.assertTrue(out["pr_closed_unmerged"])
        self.assertNotIn("merge_method", out)
        self.assertEqual(out["wall_clock_s"], 7200)
        self.assertEqual(quality, {})

    def test_privacy_repo_only_when_public(self):
        _, _, _, task, source, _ = self.base([bundle()])
        self.assertNotIn("repo", task)
        self.assertNotIn("org", source)
        self.assertEqual(task["repo_visibility"], "private")
        _, _, _, task, source, _ = self.base([bundle()], public=["acme/widgets"])
        self.assertEqual(task["repo"], "acme/widgets")
        self.assertEqual(source["org"], "acme")
        self.assertTrue(task["repo_consent"])

    def test_confidence_clamped_and_models_sorted(self):
        vs = [{"verdict": "approve", "confidence": 1.7, "model": "b"},
              {"verdict": "comment", "confidence": 2.0, "model": "a"}]
        _, out, _, _, _, _ = self.base([bundle(verdicts=vs)])
        self.assertEqual(out["review_confidence"], 1.0)
        self.assertEqual(out["reviewer_models"], ["a", "b"])
        self.assertEqual(out["review_verdict"], "comment")

    def test_acmm_level_range(self):
        _, _, q, t, _, _ = self.base([bundle(policy={"acmm_level": 4})])
        self.assertEqual(q["acmm_level"], 4)
        self.assertEqual(t["acmm_level"], 4)
        _, _, q, t, _, _ = self.base([bundle(policy={"acmm_level": 9})])
        self.assertNotIn("acmm_level", q)
        self.assertNotIn("acmm_level", t)


class ConvertTest(unittest.TestCase):
    def run_convert(self, bundles, **over):
        with tempfile.TemporaryDirectory() as d:
            ev, out = os.path.join(d, "ev"), os.path.join(d, "out")
            for i, b in enumerate(bundles):
                p = os.path.join(ev, *b["repo"].split("/"), str(b["number"]))
                os.makedirs(p, exist_ok=True)
                with open(os.path.join(p, f"{i}.json"), "w") as f:
                    json.dump(b, f)
            args = types.SimpleNamespace(evidence=ev, hive_id="hive-1", hive_version=None, cluster=None,
                                         public_repos=None, out=out, since=None, sandbox_runtime="none",
                                         exporter="t", launch_cost=None)
            for k, v in over.items():
                setattr(args, k, v)
            rc = ce.convert(args)
            recs = []
            for name in sorted(os.listdir(out)) if os.path.isdir(out) else []:
                with open(os.path.join(out, name)) as f:
                    recs += json.load(f)
            return rc, recs

    def test_author_and_reviewer_records_without_leaks(self):
        vs = [{"verdict": "approve", "model": "gpt-6", "backend": "codex", "confidence": 0.9}]
        rc, recs = self.run_convert([bundle(verdicts=vs)])
        self.assertEqual(rc, 0)
        self.assertEqual({r["agent"]["role"] for r in recs}, {"author", "reviewer"})
        self.assertEqual(len({r["id"] for r in recs}), 2)
        blob = json.dumps(recs)
        self.assertNotIn("secret-login", blob)
        self.assertNotIn("widgets", blob)
        self.assertEqual(recs[0]["source"]["hive_version"], "unknown")
        self.assertEqual(recs[0]["cost"]["basis"], "unknown")

    def test_human_author_without_verdicts_yields_nothing(self):
        rc, recs = self.run_convert([bundle(author={"kind": "human", "login": "x"})])
        self.assertEqual(rc, 0)
        self.assertEqual(recs, [])

    def test_since_skips_old(self):
        _, recs = self.run_convert([bundle()], since="2026-02-01")
        self.assertEqual(recs, [])

    def test_ids_deterministic_across_runs(self):
        _, a = self.run_convert([bundle()])
        _, b = self.run_convert([bundle()])
        self.assertEqual([r["id"] for r in a], [r["id"] for r in b])


if __name__ == "__main__":
    unittest.main()
