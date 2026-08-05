"""Key-name-only previews for credential-shaped files (approval cards).

Defense-in-depth helper: extracts variable / object keys without values so
humans can decide FORCE_APPROVAL reads without pasting secrets into chat.
Heuristic dotenv + shallow JSON only — not a full config parser.
"""

from __future__ import annotations

import json
import re
from typing import Any

# dotenv / shell-ish assignment: optional ``export``, KEY, ``=``.
_DOTENV_KEY_RE = re.compile(
    r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=",
)

# Cap preview size so huge dumps never enter approval SSE args.
_MAX_PREVIEW_CHARS = 64 * 1024
_MAX_KEYS_SHOWN = 24


def extract_env_key_names(text: str) -> list[str]:
    """Return unique key names from dotenv-like or shallow JSON text (no values)."""
    if not text:
        return []
    sample = text[:_MAX_PREVIEW_CHARS]
    stripped = sample.lstrip()
    if stripped.startswith("{"):
        keys = _json_object_keys(stripped)
        if keys:
            return keys
    return _dotenv_keys(sample)


def format_keys_preview(keys: list[str]) -> str:
    """Chinese one-liner for approval-card ``circuit_breaker_hint``."""
    if not keys:
        return ""
    shown = keys[:_MAX_KEYS_SHOWN]
    suffix = (
        f" …（共 {len(keys)} 个）"
        if len(keys) > _MAX_KEYS_SHOWN
        else f"（共 {len(keys)} 个）"
    )
    return "键名预览（无值，启发式）：" + ", ".join(shown) + suffix


async def build_keys_preview_line(
    backend: Any,
    *,
    tool_name: str,
    arguments: dict[str, Any],
) -> str:
    """Best-effort keys line for Ask-class credential reads; empty on any failure."""
    path = str(arguments.get("path") or "").strip()
    if not path or tool_name not in {"file_read", "grep"}:
        return ""
    from agentcore.runtime.safety_breaker import SensitivePathClass, classify_sensitive_path

    if classify_sensitive_path(path) is not SensitivePathClass.ASK:
        return ""
    read = getattr(backend, "read", None)
    if read is None:
        return ""
    try:
        text = await read(path)
    except Exception:
        return ""
    if not isinstance(text, str):
        return ""
    return format_keys_preview(extract_env_key_names(text))


def _dotenv_keys(text: str) -> list[str]:
    seen: set[str] = set()
    ordered: list[str] = []
    for line in text.splitlines():
        raw = line.strip()
        if not raw or raw.startswith("#"):
            continue
        m = _DOTENV_KEY_RE.match(line)
        if not m:
            continue
        key = m.group(1)
        if key not in seen:
            seen.add(key)
            ordered.append(key)
    return ordered


def _json_object_keys(text: str) -> list[str]:
    try:
        data = json.loads(text)
    except (json.JSONDecodeError, UnicodeDecodeError, TypeError):
        return []
    if not isinstance(data, dict):
        return []
    return [str(k) for k in data if isinstance(k, str)]
