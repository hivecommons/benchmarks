import os
import shutil
import subprocess
import tempfile
import unittest

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "check-no-temp-artifacts.sh")


def git(cwd, *args):
    subprocess.run(
        ["git", "-c", "user.name=t", "-c", "user.email=t@example.com", *args],
        cwd=cwd, check=True, capture_output=True,
    )


class CheckNoTempArtifactsTest(unittest.TestCase):
    """Runs the guard from a copy inside a throwaway git repo, since it cd's to its parent dir."""

    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.root, True)
        os.mkdir(os.path.join(self.root, "scripts"))
        shutil.copy(SCRIPT, os.path.join(self.root, "scripts"))
        git(self.root, "init", "-q")
        git(self.root, "add", "-A")
        git(self.root, "commit", "-q", "-m", "init")

    def run_guard(self):
        return subprocess.run(
            ["bash", os.path.join(self.root, "scripts", "check-no-temp-artifacts.sh")],
            capture_output=True, text=True,
        )

    def test_clean_tree_passes(self):
        r = self.run_guard()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("no temp artifacts", r.stdout)

    def test_untracked_file_fails(self):
        open(os.path.join(self.root, "stray.txt"), "w").close()
        r = self.run_guard()
        self.assertEqual(r.returncode, 1)
        self.assertIn("stray.txt", r.stderr)

    def test_mktemp_template_name_fails_even_when_ignored(self):
        with open(os.path.join(self.root, ".gitignore"), "w") as f:
            f.write("*XXXXXX*\n")
        git(self.root, "add", ".gitignore")
        git(self.root, "commit", "-q", "-m", "ignore")
        open(os.path.join(self.root, "index.XXXXXX"), "w").close()
        r = self.run_guard()
        self.assertEqual(r.returncode, 1)
        self.assertIn("index.XXXXXX", r.stderr)


if __name__ == "__main__":
    unittest.main()
