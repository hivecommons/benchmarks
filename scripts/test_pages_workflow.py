import os
import unittest

WORKFLOW = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    ".github", "workflows", "pages.yml",
)


def indent(line):
    return len(line) - len(line.lstrip(" "))


def block(lines, start, header):
    """Return the lines nested under the first line at or after `start` equal to `header` (stripped)."""
    for i in range(start, len(lines)):
        line = lines[i]
        if line.strip() == header and not line.lstrip().startswith("#"):
            base = indent(line)
            body = []
            for nxt in lines[i + 1:]:
                if nxt.strip() and indent(nxt) <= base:
                    break
                body.append(nxt.split("#", 1)[0].strip())
            return i, [b for b in body if b]
    return -1, None


class PagesWorkflowTest(unittest.TestCase):
    """PR builds run PR-head code, so only the deploy job may hold pages/id-token write."""

    @classmethod
    def setUpClass(cls):
        with open(WORKFLOW, encoding="utf-8") as fh:
            cls.lines = fh.read().splitlines()

    def top_level(self, header):
        top = [l for l in self.lines if l.strip() and indent(l) == 0]
        self.assertIn(header, [l.strip() for l in top])
        return block(self.lines, 0, header)[1]

    def job(self, name):
        self.top_level("jobs:")
        idx, _ = block(self.lines, 0, "jobs:")
        idx, body = block(self.lines, idx, name + ":")
        self.assertIsNotNone(body, name)
        return body

    def assert_no_write(self, body):
        text = "\n".join(body)
        self.assertNotIn("id-token", text)
        self.assertNotIn("pages: write", text)

    def test_workflow_permissions_read_only(self):
        perms = self.top_level("permissions:")
        self.assertIn("contents: read", perms)
        self.assert_no_write(perms)

    def test_build_job_has_no_write(self):
        self.assert_no_write(self.job("build"))

    def test_deploy_job_has_pages_and_id_token(self):
        body = self.job("deploy")
        self.assertIn("id-token: write", body)
        self.assertIn("pages: write", body)

    def test_pull_request_concurrency_group_differs(self):
        conc = self.top_level("concurrency:")
        group = [l for l in conc if l.startswith("group:")]
        self.assertEqual(len(group), 1)
        self.assertIn("pull_request", group[0])
        self.assertIn("'pages'", group[0])
