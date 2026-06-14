"""Persist user attachments into the conversation's workspace (附件驻留·决策⑤).

Upgrades an @-mention / paperclip attachment from one-shot prompt context into a
durable project-space file: the extracted text is written under ``attachments/``
in the workspace, so it survives the turn, can be re-read / edited by the team
through the file tools across later turns, rides along in workspace snapshots,
and is downloadable via the workspace file API. Directory attachments carry only
a listing (no file bodies), so nothing is written for them.

This is intentionally a thin service over ``WorkspaceBackend.write`` (it never
touches ``Path``), so the same residency works unchanged for the future
``LocalWorkspace``.
"""

from __future__ import annotations

import os

from agentcore.core.logging import get_logger
from agentcore.workspace.protocol import WorkspaceBackend, WorkspaceError

logger = get_logger(__name__)

# Subdirectory that holds resident user attachments inside every workspace.
ATTACHMENTS_DIR = "attachments"


def _safe_attachment_name(name: str) -> str:
    """Reduce a user-supplied name to a single safe filename component.

    Strips any directory parts (``/`` and ``\\``) so an attachment can only land
    directly inside ``attachments/`` — the backend's traversal guard is the hard
    boundary, this just keeps names tidy and predictable. Falls back to a generic
    name when nothing usable remains.
    """
    base = os.path.basename((name or "").replace("\\", "/").strip())
    base = base.strip().strip(".")
    return base or "attachment"


def _dedup(name: str, used: set[str]) -> str:
    """Disambiguate ``name`` against ``used`` by inserting ``" (n)"`` before ext.

    Two attachments in one turn can share a filename; without this the second
    ``write`` would clobber the first. Across turns the same name maps back to
    the same path on purpose (the latest copy wins — history lives in snapshots).
    """
    if name not in used:
        used.add(name)
        return name
    root, ext = os.path.splitext(name)
    i = 2
    candidate = f"{root} ({i}){ext}"
    while candidate in used:
        i += 1
        candidate = f"{root} ({i}){ext}"
    used.add(candidate)
    return candidate


async def persist_attachments(
    backend: WorkspaceBackend, attachments: list[dict] | None
) -> list[dict]:
    """Write file attachments into the workspace; return them enriched in order.

    Each returned dict is the input dict plus a ``workspace_path`` key for every
    file actually written (``attachments/<name>``). Directory attachments and
    empty-text files are passed through untouched (no ``workspace_path``). A
    per-file write failure is logged and skipped — a bad attachment must never
    break the turn (文档铁律); the turn proceeds with that file un-resident.
    """
    if not attachments:
        return []

    used: set[str] = set()
    enriched: list[dict] = []
    for att in attachments:
        item = dict(att)
        kind = att.get("kind") or "file"
        text = att.get("text") or ""
        if kind == "file" and text.strip():
            rel = f"{ATTACHMENTS_DIR}/{_dedup(_safe_attachment_name(att.get('name') or ''), used)}"
            try:
                await backend.write(rel, text)
                item["workspace_path"] = rel
            except WorkspaceError as e:
                logger.warning(
                    "attachment_persist_failed",
                    name=att.get("name"),
                    error=str(e),
                )
        enriched.append(item)
    return enriched


def to_stored_metadata(attachments: list[dict]) -> list[dict]:
    """Project enriched attachments to the columns persisted on the message.

    Drops the one-shot ``text`` (never stored) and keeps display metadata plus
    the durable ``workspace_path`` so the client can render and download it.
    """
    return [
        {
            "name": a.get("name"),
            "path": a.get("path"),
            "truncated": bool(a.get("truncated")),
            "kind": a.get("kind") or "file",
            "workspace_path": a.get("workspace_path"),
        }
        for a in attachments
    ]
