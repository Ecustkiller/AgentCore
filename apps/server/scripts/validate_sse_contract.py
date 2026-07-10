"""Validate SSE wire contract alignment across Python ↔ TypeScript.

Checks (fail-closed, run as part of ``pnpm gen:types``):

1. ``runtime.events.types.EventType`` values == keys of ``SSEPayloadMap`` in
   ``packages/contract-types/src/events.generated.ts``.
2. ``eventTypes.generated.ts`` union == ``EventType``.
3. Every ``EventType`` has a payload wire model in ``payloads/__init__.py``.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

from agentcore.runtime.events.payloads import EVENT_PAYLOAD_MODELS
from agentcore.runtime.events.types import EventType

ROOT = Path(__file__).resolve().parents[3]
GENERATED_EVENTS = ROOT / "packages" / "contract-types" / "src" / "events.generated.ts"
GENERATED_TYPES = ROOT / "packages" / "contract-types" / "src" / "eventTypes.generated.ts"


def _event_type_values() -> set[str]:
    return {e.value for e in EventType}


def _parse_payload_map_keys(text: str) -> set[str]:
    """Extract keys from ``export type SSEPayloadMap = { ... }``."""
    m = re.search(
        r"export type SSEPayloadMap\s*=\s*\{([^}]+)\}",
        text,
        re.DOTALL,
    )
    if not m:
        raise RuntimeError("SSEPayloadMap block not found in events.generated.ts")
    keys: set[str] = set()
    for line in m.group(1).splitlines():
        hit = re.match(r'\s*(?:"([^"]+)"|([a-z_][a-z0-9_]*))\s*:', line)
        if hit:
            keys.add(hit.group(1) or hit.group(2))
    return keys


def _parse_generated_union(text: str) -> set[str]:
    return set(re.findall(r'"([^"]+)"', text))


def main() -> None:
    errors: list[str] = []
    py_events = _event_type_values()

    generated_events_text = GENERATED_EVENTS.read_text(encoding="utf-8")
    payload_keys = _parse_payload_map_keys(generated_events_text)

    only_py = sorted(py_events - payload_keys)
    only_ts = sorted(payload_keys - py_events)
    if only_py:
        errors.append(f"EventType missing from SSEPayloadMap: {', '.join(only_py)}")
    if only_ts:
        errors.append(f"SSEPayloadMap keys missing from EventType: {', '.join(only_ts)}")

    generated_types_text = GENERATED_TYPES.read_text(encoding="utf-8")
    gen_events = _parse_generated_union(generated_types_text)
    only_py_gen = sorted(py_events - gen_events)
    only_gen = sorted(gen_events - py_events)
    if only_py_gen:
        errors.append(f"EventType missing from eventTypes.generated.ts: {', '.join(only_py_gen)}")
    if only_gen:
        errors.append(f"eventTypes.generated.ts extras not in EventType: {', '.join(only_gen)}")

    model_missing = sorted(e for e in EventType if e not in EVENT_PAYLOAD_MODELS)
    if model_missing:
        errors.append(
            "EventType missing payload wire model: "
            + ", ".join(e.value for e in model_missing)
        )

    if errors:
        for e in errors:
            print(f"validate_sse_contract: {e}", file=sys.stderr)
        sys.exit(1)

    print(
        f"validate_sse_contract: OK ({len(py_events)} event types, "
        f"payload models + SSEPayloadMap + generated union aligned)"
    )


if __name__ == "__main__":
    main()
