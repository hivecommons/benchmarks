import importlib.util
import json
import os
import tempfile
import unittest

_spec = importlib.util.spec_from_file_location(
    "check_pricing_drift", os.path.join(os.path.dirname(__file__), "check-pricing-drift.py"))
cpd = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cpd)

GO = '''package tokens

var modelPrices = map[string]ModelPrice{
	// ---- test rows ----
	// comment with "quoted": {InputPerMTok: 99}
	"claude-test-1": {InputPerMTok: 10.00, OutputPerMTok: 20.00, CacheReadPerMTok: 1.00, CacheWritePerMTok: 5.00},
	"gpt-test": {
		InputPerMTok: 2, OutputPerMTok: 8.50,
		CacheReadPerMTok: 0.5, CacheWritePerMTok: 2,
	},
}
'''


def row(i, o, r, w):
    return {"input_per_mtok": i, "output_per_mtok": o, "cache_read_per_mtok": r, "cache_write_per_mtok": w}


class ParseTest(unittest.TestCase):
    def test_parse(self):
        got = cpd.parse_go_prices(GO)
        self.assertEqual(set(got), {"claude-test-1", "gpt-test"})
        self.assertEqual(got["claude-test-1"], row(10.0, 20.0, 1.0, 5.0))
        self.assertEqual(got["gpt-test"], row(2.0, 8.5, 0.5, 2.0))

    def test_missing_table(self):
        with self.assertRaises(ValueError):
            cpd.parse_go_prices("package tokens\n")


class CompareTest(unittest.TestCase):
    def test_in_sync(self):
        go = cpd.parse_go_prices(GO)
        self.assertEqual(cpd.compare(go, dict(go)), [])

    def test_drift(self):
        go = cpd.parse_go_prices(GO)
        js = {"claude-test-1": row(10.0, 21.0, 1.0, 5.0), "old-model": row(1, 1, 1, 1)}
        msgs = "\n".join(cpd.compare(go, js))
        self.assertIn("gpt-test is in pricing.go but missing", msgs)
        self.assertIn("old-model is in pricing.json but not", msgs)
        self.assertIn("claude-test-1 output_per_mtok", msgs)


class MainTest(unittest.TestCase):
    def setUp(self):
        d = tempfile.mkdtemp()
        self.go = os.path.join(d, "pricing.go")
        with open(self.go, "w") as f:
            f.write(GO)
        self.pj = os.path.join(d, "pricing.json")

    def run_main(self, models, fail):
        with open(self.pj, "w") as f:
            json.dump({"source": "unused", "models": models}, f)
        argv = ["--go-file", self.go, "--pricing", self.pj] + (["--fail"] if fail else [])
        return cpd.main(argv)

    def test_exit_codes(self):
        go = cpd.parse_go_prices(GO)
        self.assertEqual(self.run_main(go, True), 0)
        self.assertEqual(self.run_main({}, False), 0)
        self.assertEqual(self.run_main({}, True), 1)


if __name__ == "__main__":
    unittest.main()
