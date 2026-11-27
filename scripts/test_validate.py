import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SCHEMA = os.path.join(ROOT, "schema", "result.schema.json")
SAMPLE = os.path.join(ROOT, "data", "sample", "hivecommons-2026-11-synthetic.json")


def run(records):
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "records.json")
        with open(path, "w") as f:
            json.dump(records, f)
        return subprocess.run(
            [sys.executable, os.path.join(HERE, "validate.py"), SCHEMA, path],
            capture_output=True,
            text=True,
        )


class ValidateTest(unittest.TestCase):
    def sample(self):
        with open(SAMPLE) as f:
            return json.load(f)

    def test_sample_records_pass(self):
        recs = self.sample()
        r = run(recs)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn(f"validated {len(recs)} records, 0 errors", r.stdout)

    def test_single_object_is_wrapped(self):
        r = run(self.sample()[0])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("validated 1 records, 0 errors", r.stdout)

    def test_missing_required_field_fails(self):
        rec = self.sample()[0]
        del rec["outcome"]
        r = run([rec])
        self.assertEqual(r.returncode, 1)
        self.assertIn(f"{rec['id']}: <root>:", r.stderr)
        self.assertIn("outcome", r.stderr)
        self.assertIn("1 errors", r.stdout)

    def test_error_reports_nested_path(self):
        rec = self.sample()[0]
        rec["schema_version"] = "not-a-version"
        r = run([rec])
        self.assertEqual(r.returncode, 1)
        self.assertIn("schema_version", r.stderr)

    def test_org_requires_explicit_repo_consent(self):
        for version in ("1", "2"):
            for consent in (False, None, True):
                with self.subTest(version=version, consent=consent):
                    rec = self.sample()[0]
                    rec["schema_version"] = version
                    rec["source"]["org"] = "example-org"
                    if consent is None:
                        rec["task"].pop("repo_consent", None)
                    else:
                        rec["task"]["repo_consent"] = consent
                    result = run([rec])
                    self.assertEqual(result.returncode, 0 if consent is True else 1, result.stderr)

    def test_anonymous_record_without_org_passes(self):
        rec = self.sample()[0]
        rec["task"].pop("repo_consent", None)
        result = run([rec])
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
