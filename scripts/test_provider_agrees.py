"""Cross-check of convert-evidence.provider_of against modelid.

provider_of fills model.provider on exported records; modelid.resolve keys the
index's vendor column. Both read modelid.VENDOR_FAMILIES, and this test pins
that: every family key must resolve to the same vendor through both, so a
family added to a second, local table (or a provider_of that stops using the
shared one) fails CI instead of silently splitting a vendor's rows.
"""
import importlib.util
import os
import unittest

from modelid import VENDOR_FAMILIES, resolve

_spec = importlib.util.spec_from_file_location(
    "convert_evidence_agree", os.path.join(os.path.dirname(__file__), "convert-evidence.py"))
ce = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ce)


class ProviderAgreesTest(unittest.TestCase):
    def test_every_family_resolves_to_same_vendor(self):
        for family, vendor in VENDOR_FAMILIES.items():
            raw = f"{family}-x"
            with self.subTest(family=family):
                self.assertEqual(resolve(raw)[1], vendor)
                self.assertEqual(ce.provider_of(raw), resolve(raw)[1],
                                 "provider_of and modelid disagree; keep one table in modelid.VENDOR_FAMILIES")

    def test_slash_prefix_is_kept_verbatim(self):
        self.assertEqual(ce.provider_of("openai-codex/gpt-6"), "openai-codex")


if __name__ == "__main__":
    unittest.main()
