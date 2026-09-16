"""Opaque workspace identity for csv 灌数 upsert (not a folder_id ownership column)."""

from __future__ import annotations


def table_workspace_key(*, folder_id: str | None, conversation_id: str) -> str:
    """Same cloud folder → same key; 裸聊 → per-conversation key."""
    fid = (folder_id or "").strip()
    if fid:
        return f"folder:{fid}"
    return f"conv:{conversation_id.strip()}"
