"""Dump the FastAPI OpenAPI spec to ``apps/server/openapi.json``.

This committed spec is the single source of truth for the desktop's generated TS
types (``apps/desktop/src/renderer/types/api.generated.ts``): the frontend never
hand-writes REST types — it runs ``pnpm gen:api`` off this file (API 开发规范).
Keys are sorted so the artifact diffs cleanly. Run after any schema / route change,
then regenerate the TS types::

    uv run python scripts/dump_openapi.py   # then: cd ../desktop && pnpm gen:api
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
