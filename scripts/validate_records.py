"""Validate a JSON array of exported learner records against the pinned schemas."""

import hashlib
import json
from pathlib import Path
import sys

from jsonschema import Draft202012Validator
from referencing import Registry, Resource


def validate(records):
    vendor = Path(__file__).resolve().parents[1] / "vendor" / "thia-gestalts"
    pin = json.loads((vendor / "pin.json").read_text())
    schemas = {}
    for relative_path, expected_hash in pin["sha256"].items():
        contents = (vendor / relative_path).read_bytes()
        if hashlib.sha256(contents).hexdigest() != expected_hash:
            raise ValueError(f"Pinned schema changed: {relative_path}")
        schema = json.loads(contents)
        Draft202012Validator.check_schema(schema)
        schemas[Path(relative_path).parent.name] = schema

    registry = Registry().with_resources(
        (schema["$id"], Resource.from_contents(schema)) for schema in schemas.values()
    )
    validators = {
        kind: Draft202012Validator(schema, registry=registry)
        for kind, schema in schemas.items()
        if kind != "common"
    }
    if not isinstance(records, list):
        raise ValueError("Expected a JSON array of records")

    identities = set()
    for record in records:
        validators[record["kind"]].validate(record)
        identity = (record["kind"], record["id"])
        if identity in identities:
            raise ValueError(f"Duplicate record: {identity}")
        identities.add(identity)

    for record in records:
        if record["kind"] == "learning-event":
            for target in record["targets"]:
                identity = (target["kind"], target["id"])
                if identity not in identities:
                    raise ValueError(f"Missing target {identity} for event {record['id']}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python3 scripts/validate_records.py records.json")
    records = json.loads(Path(sys.argv[1]).read_text())
    validate(records)
    print(f"Validated {len(records)} records and resolved every event target.")
