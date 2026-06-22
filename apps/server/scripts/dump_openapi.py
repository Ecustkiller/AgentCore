"""Dump the FastAPI OpenAPI spec to ``apps/server/openapi.json``.

This committed spec is the single source of truth for REST TS types
(``packages/contract-rest-types``). Regenerate via ``pnpm gen:types`` at repo root.
"""

from __future__ import annotations

import json
from pathlib import Path

from agentcore.main import app


def main() -> None:
    spec = app.openapi()
    out = Path(__file__).resolve().parents[1] / "openapi.json"
    out.write_text(
        json.dumps(spec, indent=2, ensure_ascii=False, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(f"wrote {out} ({len(spec.get('paths', {}))} paths)")


if __name__ == "__main__":
    main()
