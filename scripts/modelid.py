"""Canonical model ids — Python port of hive's pkg/modelfamily.Resolve.

Different CLIs report one model under different spellings
("claude-sonnet-5-5" from Copilot CLI, "claude-sonnet-5.5" from Claude Code,
"openai-codex/gpt-6.1-sol" from pi). resolve() folds a raw id into
(canonical, vendor, effort) so build-index.py can aggregate by model.
Records already carrying model.canonical (hive >= the exporter fix) are used
as-is; this port covers the rows published before that.
"""
import re

UNKNOWN = "unknown"
AUTO = "auto"

EFFORT_LABELS = {"low", "medium", "high", "xhigh", "max"}
# Prefixes naming the CLI or routing layer, never the vendor.
GATEWAYS = {"openai-codex", "github-copilot", "copilot", "openrouter", "aws", "bedrock", "vertex", "azure", "rits",
            "pi-claude-code-provider", "kilocode", "lab-worker", "stealth"}
VENDOR_FAMILIES = {
    "claude": "anthropic", "gpt": "openai", "o1": "openai", "o3": "openai", "o4": "openai", "codex": "openai",
    "gemini": "google", "gemma": "google", "granite": "ibm", "llama": "meta", "mistral": "mistral", "qwen": "alibaba",
    "deepseek": "deepseek", "grok": "xai", "kimi": "moonshot", "glm": "z-ai", "minimax": "minimax", "mimo": "xiaomi",
    "muse": "meta",
}
CANONICAL_OVERRIDES = {"sonnet": "claude-sonnet", "opus": "claude-opus", "haiku": "claude-haiku", "default": AUTO}
PLACEHOLDERS = {"", "auto", "<agent>", "<backend>", "<model>", "...", "…", "placeholder"}
_QUOTES = "`'\"“”‘’"


def _normalize(value):
    v = (value or "").strip().lower().strip(_QUOTES)
    if "[" in v:
        v = v[: v.index("[")].strip()
    v = v.strip(_QUOTES)
    return UNKNOWN if v in PLACEHOLDERS else v


def _canonical_id(m):
    if "/" in m:
        m = m.rsplit("/", 1)[1]
    if ":" in m:
        m = m.split(":", 1)[0]
    m = m.replace(" ", "-").replace("_", "-")
    m = re.sub(r"-{2,}", "-", m).strip("-")
    out = []
    for p in m.split("-"):
        if not p:
            continue
        if len(p) == 8 and p.isdigit() and out:
            continue  # date stamp, e.g. claude-sonnet-4-5-20250929
        if out and p.isdigit() and out[-1].rsplit(".", 1)[-1].isdigit():
            out[-1] += "." + p
            continue
        out.append(p)
    return "-".join(out)


def resolve(model, reported_provider=""):
    """Return (canonical, vendor, effort) for a raw model id."""
    raw = (model or "").strip().lower().strip(_QUOTES)
    if raw in (AUTO, "default"):
        return AUTO, AUTO, ""
    m = _normalize(raw)
    if m == UNKNOWN:
        return UNKNOWN, UNKNOWN, ""
    prefix = m.split("/", 1)[0] if "/" in m else ""
    effort = ""
    if ":" in m and m.split(":", 1)[1] in EFFORT_LABELS:
        effort = m.split(":", 1)[1]
    cid = _canonical_id(m)
    parts = cid.split("-")
    if len(parts) > 1 and parts[-1] in EFFORT_LABELS:
        effort = effort or parts[-1]
        cid = "-".join(parts[:-1])
    cid = CANONICAL_OVERRIDES.get(cid, cid)
    if not cid:
        return UNKNOWN, UNKNOWN, effort
    if cid == AUTO:
        return AUTO, AUTO, effort
    family = cid.split("-", 1)[0]
    vendor = UNKNOWN
    rp = (reported_provider or "").strip().lower()
    if family in VENDOR_FAMILIES:
        vendor = VENDOR_FAMILIES[family]
    elif prefix and prefix not in GATEWAYS:
        vendor = prefix
    elif rp and rp != UNKNOWN and rp not in GATEWAYS:
        vendor = rp
    return cid, vendor, effort


def resolve_record_model(md):
    """(canonical, vendor, effort) for a record's model object, preferring the
    exporter's own canonical fields when present."""
    canonical, vendor, effort = resolve(md.get("name"), md.get("provider"))
    if md.get("canonical"):
        canonical = md["canonical"]
        if md.get("provider") and md["provider"] not in GATEWAYS and md["provider"] != UNKNOWN:
            vendor = md["provider"]
    return canonical, vendor, md.get("effort") or effort
