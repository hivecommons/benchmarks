import unittest

from modelid import resolve, resolve_record_model


class ResolveTest(unittest.TestCase):
    CASES = [
        ("claude-sonnet-5-5", "anthropic", ("claude-sonnet-5.5", "anthropic", "")),
        ("claude-sonnet-5.5", "anthropic", ("claude-sonnet-5.5", "anthropic", "")),
        ("openai-codex/gpt-6.1-sol", "openai-codex", ("gpt-6.1-sol", "openai", "")),
        ("gpt-6.1-sol", "openai", ("gpt-6.1-sol", "openai", "")),
        ("auto", "unknown", ("auto", "auto", "")),
        ("default", "", ("auto", "auto", "")),
        ("claude-opus-4-6", "", ("claude-opus-4.6", "anthropic", "")),
        ("claude-opus-4.6", "", ("claude-opus-4.6", "anthropic", "")),
        ("gemini-3.8-flash-low", "google", ("gemini-3.8-flash", "google", "low")),
        ("anthropic/claude-sonnet-5:max", "anthropic", ("claude-sonnet-5", "anthropic", "max")),
        ("openai-codex/gpt-5.6-sol:high", "openai-codex", ("gpt-5.6-sol", "openai", "high")),
        ("aws/claude-haiku-4-5", "aws", ("claude-haiku-4.5", "anthropic", "")),
        ("github-copilot/gemini-3.8-flash", "github-copilot", ("gemini-3.8-flash", "google", "")),
        ("rits/zai-org/glm-5-3", "rits", ("glm-5.3", "z-ai", "")),
        ("lemonade/ornith-1.5-35b-a3b-gguf-q6_k", "lemonade", ("ornith-1.5-35b-a3b-gguf-q6-k", "lemonade", "")),
        ("pi-claude-code-provider/sonnet", "pi-claude-code-provider", ("claude-sonnet", "anthropic", "")),
        ("GPT-5.6 Terra", "openai", ("gpt-5.6-terra", "openai", "")),
        ("claude-sonnet-4-5-20250929", "", ("claude-sonnet-4.5", "anthropic", "")),
        ("codex-sol-5.6-high", "unknown", ("codex-sol-5.6", "openai", "high")),
        ("kimi-k3", "moonshot", ("kimi-k3", "moonshot", "")),
        ("unknown", "unknown", ("unknown", "unknown", "")),
        ("", "", ("unknown", "unknown", "")),
    ]

    def test_resolve(self):
        for raw, provider, want in self.CASES:
            with self.subTest(raw=raw):
                self.assertEqual(resolve(raw, provider), want)

    def test_record_prefers_exporter_canonical(self):
        md = {"provider": "anthropic", "name": "weird-id", "canonical": "claude-sonnet-5.5", "effort": "high"}
        self.assertEqual(resolve_record_model(md), ("claude-sonnet-5.5", "anthropic", "high"))
        self.assertEqual(resolve_record_model({"provider": "openai-codex", "name": "openai-codex/gpt-6.1-sol"}), ("gpt-6.1-sol", "openai", ""))


if __name__ == "__main__":
    unittest.main()
