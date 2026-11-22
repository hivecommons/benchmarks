"""Cross-check of the two model-id normalizers.

costlib.normalize_model (port of hive tokens.normalizeModelID) keys pricing and
fleet cost medians; modelid._canonical_id (port of hive modelfamily.Resolve)
keys the index aggregation. They legitimately differ in spelling ("5-5" vs
"5.5"), so this test compares them after mapping "." to "-" on the modelid
side. Every other difference must be listed in KNOWN_DIFFERENCES: a new id
shape fixed in only one normalizer then fails here instead of silently
splitting a model's cost medians from its index row.
"""
import unittest

from costlib import normalize_model
from modelid import UNKNOWN, _canonical_id, _normalize
import test_costlib  # module imports, so discover does not run their tests twice
import test_modelid

# raw id -> (costlib key, modelid key after "." -> "-"), with the reason.
KNOWN_DIFFERENCES = {
    # costlib strips "-v1" after a claude date stamp; modelid keeps it.
    "claude-sonnet-4-5-20250929-v1": ("claude-sonnet-4-5", "claude-sonnet-4-5-v1"),
    # costlib strips date stamps only for claude-*; modelid for any family.
    "gpt-5-20250101": ("gpt-5-20250101", "gpt-5"),
    # costlib cuts everything before a known vendor marker (Bedrock-style
    # "us.anthropic." prefixes, "meta_"); modelid does not.
    "us.anthropic.claude-haiku-4-5": ("claude-haiku-4-5", "us-anthropic-claude-haiku-4-5"),
    "meta_llama3-8b": ("llama-3-8b", "meta-llama3-8b"),
    # costlib splits "llama3" into "llama-3"; modelid does not.
    "llama3-70b": ("llama-3-70b", "llama3-70b"),
    # modelid treats these as placeholders (no model); costlib keys them as-is
    # and prices them through the fallback tier.
    "auto": ("auto", ""),
    "unknown": ("unknown", ""),
}


def costlib_key(raw):
    return normalize_model(raw)


def modelid_key(raw):
    m = _normalize(raw)
    if m == UNKNOWN:
        return ""  # placeholder: same "no model" meaning as costlib's ""
    return _canonical_id(m).replace(".", "-")


def all_raw_ids():
    seen = []
    costlib_raws = [r for r, _ in test_costlib.NormalizeModelTest.CASES]
    modelid_raws = [r for r, _, _ in test_modelid.ResolveTest.CASES]
    for raw in costlib_raws + modelid_raws:
        if raw not in seen:
            seen.append(raw)
    return seen


class NormalizersAgreeTest(unittest.TestCase):
    def test_agree_except_known_differences(self):
        observed = {}
        for raw in all_raw_ids():
            got = (costlib_key(raw), modelid_key(raw))
            with self.subTest(raw=raw):
                if raw in KNOWN_DIFFERENCES:
                    self.assertEqual(got, KNOWN_DIFFERENCES[raw], "known difference changed; update KNOWN_DIFFERENCES")
                else:
                    self.assertEqual(got[0], got[1], "normalizers disagree; fix both or list it in KNOWN_DIFFERENCES")
            if got[0] != got[1]:
                observed[raw] = got
        # A difference fixed in the code must be dropped from the list too.
        self.assertEqual(observed, KNOWN_DIFFERENCES)


if __name__ == "__main__":
    unittest.main()
