#!/usr/bin/env python3
"""Validate an array of benchmark records against the result schema.

usage: validate.py schema.json records.json
"""
import json
import sys

from jsonschema import Draft202012Validator, FormatChecker


def main() -> int:
    schema_path, data_path = sys.argv[1], sys.argv[2]
    with open(schema_path) as f:
        schema = json.load(f)
    with open(data_path) as f:
        records = json.load(f)
    if isinstance(records, dict):
        records = [records]
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    bad = 0
    for rec in records:
        errors = sorted(validator.iter_errors(rec), key=lambda e: list(e.path))
        for err in errors:
            bad += 1
            loc = "/".join(str(p) for p in err.path) or "<root>"
            print(f"{rec.get('id', '?')}: {loc}: {err.message}", file=sys.stderr)
    print(f"validated {len(records)} records, {bad} errors")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
