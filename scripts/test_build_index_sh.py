import json
import os
import shutil
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
HAVE_JQ = shutil.which("jq") is not None


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
    r.update(over)
    return r


@unittest.skipUnless(HAVE_JQ, "jq not installed")
class BuildIndexShTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name
        os.makedirs(os.path.join(self.root, "scripts"))
        os.makedirs(os.path.join(self.root, "data"))
        os.makedirs(os.path.join(self.root, "schema"))
        shutil.copy(os.path.join(HERE, "..", "schema", "pricing.json"),
                    os.path.join(self.root, "schema", "pricing.json"))
        for name in ("build-index.sh", "build-index.py", "costlib.py", "modelid.py"):
            shutil.copy(os.path.join(HERE, name), os.path.join(self.root, "scripts", name))

    def tearDown(self):
        self.tmp.cleanup()

    def put(self, name, data):
        with open(os.path.join(self.root, "data", name), "w") as f:
            json.dump(data, f)

    def run_sh(self):
        env = dict(os.environ, SKIP_VALIDATE="1")
        return subprocess.run(["bash", os.path.join(self.root, "scripts", "build-index.sh")],
                              capture_output=True, text=True, env=env)

    def index(self):
        with open(os.path.join(self.root, "data", "index.json")) as f:
            return json.load(f)

    def test_empty_data_writes_empty_index(self):
        p = self.run_sh()
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("no data files", p.stderr)
        self.assertEqual(self.index()["records"], [])

    def test_duplicate_ids_across_files_are_rejected(self):
        self.put("a.json", record("dup"))
        self.put("b.json", [record("dup")])
        p = self.run_sh()
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("duplicate record ids", p.stderr)
        self.assertIn("dup", p.stderr)

    def test_empty_cost_basis_is_folded_to_unknown(self):
        self.put("a.json", record("r1", cost={"basis": ""}))
        p = self.run_sh()
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(self.index()["cost"]["basis_n"]["unknown"], 1)


if __name__ == "__main__":
    unittest.main()
