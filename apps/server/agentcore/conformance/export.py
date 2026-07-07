"""Export the conformance vectors + their oracle-projected golden to the shared package.

Run from the server app: ``python -m agentcore.conformance.export``. Writes one
``<name>.json`` per vector into ``packages/protocol-conformance/fixtures/`` as
``{name, description, events, projected}`` — the single source the frontend folds are
asserted against (``pnpm conformance``). Also writes
``simulation-region-positions.json`` from ``locations.REGION_POSITIONS``. Re-run after
changing a vector or the oracle (then the frontends turn red until aligned, per
protocol-conformance.mdc).

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

_NON_VECTOR_FIXTURES = frozenset(
    {"simulation-region-positions.json", "simulation-m1-tick.json"}
)

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


def build_region_positions_fixture() -> dict[str, Any]:
    """Town region anchors — single source is locations.REGION_POSITIONS."""
    from agentcore.simulation.world.locations import REGION_POSITIONS

    return {
        "regions": {name: pos.model_dump() for name, pos in REGION_POSITIONS.items()},
    }


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, default=str) + "\n",
        encoding="utf-8",
    )


def main() -> None:
    fixtures = build_fixtures()
    region_positions = build_region_positions_fixture()
    _FIXTURES_DIR.mkdir(parents=True, exist_ok=True)
    # Drop stale vector goldens; preserve non-vector contract fixtures (region positions).
    for stale in _FIXTURES_DIR.glob("*.json"):
        if stale.name in _NON_VECTOR_FIXTURES:
            continue
        stale.unlink()
    for fx in fixtures:
        _write_json(_FIXTURES_DIR / f"{fx['name']}.json", fx)
    _write_json(_FIXTURES_DIR / "simulation-region-positions.json", region_positions)
    print(
        f"conformance: wrote {len(fixtures)} vector fixtures + region positions → {_FIXTURES_DIR}"
    )


if __name__ == "__main__":
    main()
