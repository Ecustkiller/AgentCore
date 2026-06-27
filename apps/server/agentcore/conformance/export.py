"""Export the conformance vectors + their oracle-projected golden to the shared package.

Run from the server app: ``python -m agentcore.conformance.export``. Writes one
``<name>.json`` per vector into ``packages/protocol-conformance/fixtures/`` as
``{name, description, events, projected}`` — the single source the frontend folds are
asserted against (``pnpm conformance``). Re-run after changing a vector or the oracle
(then the frontends turn red until aligned, per protocol-conformance.mdc).

Timestamps are assigned deterministically (the projection ignores them) so the committed
golden does not churn between runs.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from agentcore.conformance.projection import project_turn
from agentcore.conformance.vectors import VECTORS
from agentcore.runtime.events import SSEEvent

# apps/server/agentcore/conformance/export.py → repo root is parents[4].
_FIXTURES_DIR = (
    Path(__file__).resolve().parents[4] / "packages" / "protocol-conformance" / "fixtures"
)


def _serialize_event(event: SSEEvent, index: int) -> dict[str, Any]:
    """One SSEEvent → the wire dict the fold consumes, with a stable timestamp."""
    return {
        "type": event.type.value,
        "payload": event.payload,
        "timestamp": f"2026-01-01T00:00:00.{index:03d}Z",
    }


def build_fixtures() -> list[dict[str, Any]]:
    """Project every vector into a committable fixture (vector + golden)."""
    fixtures: list[dict[str, Any]] = []
    for name, (description, builder) in VECTORS.items():
        events = [_serialize_event(ev, i) for i, ev in enumerate(builder())]
        fixtures.append(
            {
                "name": name,
                "description": description,
                "events": events,
                "projected": project_turn(events),
            }
        )
    return fixtures


def main() -> None:
    fixtures = build_fixtures()
    _FIXTURES_DIR.mkdir(parents=True, exist_ok=True)
    # Drop stale fixtures so a removed/renamed vector never leaves an orphan golden.
    for stale in _FIXTURES_DIR.glob("*.json"):
        stale.unlink()
    for fx in fixtures:
        path = _FIXTURES_DIR / f"{fx['name']}.json"
        path.write_text(
            json.dumps(fx, ensure_ascii=False, indent=2, default=str) + "\n",
            encoding="utf-8",
        )
    print(f"conformance: wrote {len(fixtures)} fixtures → {_FIXTURES_DIR}")


if __name__ == "__main__":
    main()
