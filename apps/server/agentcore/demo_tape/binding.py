"""Conversation → tape binding (dev-only, file-backed)."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from agentcore.config import settings
from agentcore.config.paths import PROJECT_ROOT
from agentcore.core.logging import get_logger

logger = get_logger(__name__)


@dataclass(frozen=True)
class TapeBinding:
    conversation_id: str
    tape_path: Path
    speed: float
    max_gap_ms: int


def bindings_path() -> Path:
    raw = (settings.demo_tape_bindings_path or "").strip()
    if raw:
        p = Path(raw)
        return p if p.is_absolute() else PROJECT_ROOT / p
    return PROJECT_ROOT / "demos" / "bindings.json"


def resolve_tape_path(spec: str) -> Path:
    p = Path(spec)
    if p.is_absolute():
        return p
    # Prefer repo-relative; also allow apps/server-relative for convenience.
    cand = PROJECT_ROOT / p
    if cand.exists():
        return cand
    return Path.cwd() / p


def _parse_entry(conversation_id: str, raw: Any) -> TapeBinding | None:
    if isinstance(raw, str):
        return TapeBinding(
            conversation_id=conversation_id,
            tape_path=resolve_tape_path(raw),
            speed=float(settings.demo_tape_speed),
            max_gap_ms=int(settings.demo_tape_max_gap_ms),
        )
    if not isinstance(raw, dict):
        return None
    tape = raw.get("tape") or raw.get("path")
    if not tape:
        return None
    speed = float(raw.get("speed", settings.demo_tape_speed))
    max_gap_ms = int(raw.get("max_gap_ms", settings.demo_tape_max_gap_ms))
    return TapeBinding(
        conversation_id=conversation_id,
        tape_path=resolve_tape_path(str(tape)),
        speed=speed,
        max_gap_ms=max_gap_ms,
    )


def load_bindings() -> dict[str, TapeBinding]:
    path = bindings_path()
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        logger.warning("demo_tape.bindings_read_failed", path=str(path), error=str(e))
        return {}
    if not isinstance(data, dict):
        return {}
    out: dict[str, TapeBinding] = {}
    for cid, raw in data.items():
        if cid.startswith("_"):
            continue
        binding = _parse_entry(str(cid), raw)
        if binding is not None:
            out[str(cid)] = binding
    return out


def resolve_binding(conversation_id: str) -> TapeBinding | None:
    if not settings.demo_tape_replay_enabled:
        return None
    return load_bindings().get(conversation_id)


def write_binding(
    conversation_id: str,
    *,
    tape: str,
    speed: float | None = None,
    max_gap_ms: int | None = None,
) -> Path:
    """Upsert one conversation binding into the bindings file."""
    path = bindings_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    data: dict[str, Any] = {}
    if path.exists():
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                data = loaded
        except (OSError, json.JSONDecodeError):
            data = {}
    entry: dict[str, Any] = {"tape": tape}
    if speed is not None:
        entry["speed"] = speed
    if max_gap_ms is not None:
        entry["max_gap_ms"] = max_gap_ms
    data[conversation_id] = entry
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path


def conversation_is_cloud(
    *,
    local_container_root_id: str | None,
    local_root_id: str | None,
    folder_local_root_id: str | None,
    folder_id: str | None,
) -> tuple[bool, str]:
    """Whether a conversation will take the cloud turn path on desktop.

    Mirrors desktop sidecar routing: local project folder or bare local container
    → sidecar (bypasses server tape replay); otherwise cloud.
    """
    if folder_id is not None:
        if folder_local_root_id:
            return False, "project folder is local-mode (sidecar)"
        return True, "project folder is cloud-mode"
    if local_container_root_id or local_root_id:
        return False, "bare chat has local container/root (sidecar)"
    return True, "bare cloud chat"
