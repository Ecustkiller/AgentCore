"""Discover demo tape JSON files under ``demos/tapes/`` (dev-only)."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from agentcore.config.paths import PROJECT_ROOT
from agentcore.core.logging import get_logger

logger = get_logger(__name__)


@dataclass(frozen=True)
class TapeInfo:
    """One tape file ready for one-click replay."""

    id: str
    path: Path
    repo_relative: str
    title: str
    user_prompt: str
    duration_ms: int | None
    event_count: int | None


def tapes_dir() -> Path:
    return PROJECT_ROOT / "demos" / "tapes"


def _read_meta(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        logger.warning("demo_tape.catalog_read_failed", path=str(path), error=str(e))
        return {}
    if not isinstance(data, dict):
        return {}
    meta = data.get("meta")
    return meta if isinstance(meta, dict) else {}


def list_tapes() -> list[TapeInfo]:
    """List ``*.json`` tapes under ``demos/tapes/``, sorted by id."""
    root = tapes_dir()
    if not root.is_dir():
        return []
    out: list[TapeInfo] = []
    for path in sorted(root.glob("*.json")):
        if not path.is_file():
            continue
        meta = _read_meta(path)
        tape_id = path.stem
        title = str(meta.get("title") or tape_id).strip() or tape_id
        user_prompt = str(meta.get("user_prompt") or "").strip()
        duration = meta.get("duration_ms")
        event_count = meta.get("event_count")
        try:
            rel = path.resolve().relative_to(PROJECT_ROOT.resolve()).as_posix()
        except ValueError:
            rel = f"demos/tapes/{path.name}"
        out.append(
            TapeInfo(
                id=tape_id,
                path=path,
                repo_relative=rel,
                title=title,
                user_prompt=user_prompt,
                duration_ms=int(duration) if isinstance(duration, int) else None,
                event_count=int(event_count) if isinstance(event_count, int) else None,
            )
        )
    return out


def resolve_tape(tape_id: str) -> TapeInfo | None:
    """Resolve a tape by stem id (e.g. ``lv-molihua-trademark``)."""
    needle = (tape_id or "").strip()
    if not needle or "/" in needle or "\\" in needle or ".." in needle:
        return None
    for info in list_tapes():
        if info.id == needle:
            return info
    return None
