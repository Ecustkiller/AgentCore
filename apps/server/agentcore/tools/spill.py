"""Keep an oversized tool result recoverable instead of only trimming it.

``ToolResult`` caps the model-facing ``output`` (4000 chars unless the tool raised
``output_limit``) and keeps head+tail under an honest marker
(「系统视图截断·非磁盘内容」). The marker tells the model the middle is gone and
then offers no way to get it back: a ``run`` that printed a 40k-char build log
answers the next question with silence in the middle, and the agent either re-runs
the command or guesses.

This module closes that hole at the one seam that still holds the untouched text
and a workspace to put it in. When a result was capped, the full text is written
under ``AgentCore/spill/`` — an internal zone, so it stays out of AI listings, grep
walks and the file tree, while an explicit ``read`` path still reaches it — and the
capped output gains one line naming the file.

The in-body marker is rewritten too. It reads 「非磁盘内容」 by default, which is
true of every other truncation site and becomes a lie here; the swap happens only
after the write lands, so a failed spill leaves today's text byte-for-byte intact.

Five rules, each from a way this goes wrong:

- **Fail open.** Missing workspace, refused write, oversized payload: every one
  leaves the capped output exactly as it is today. The worst acceptable outcome of
  a context-saving feature is saving nothing.
- **Only what the model cannot reconstruct.** ``read`` is skipped — its result *is*
  a file the model can re-read, so spilling it would store a copy of a copy and
  point the model at the copy.
- **Only a success.** A failed call's ``output`` is the model's only evidence of
  what broke; pointing it at a side file instead of the traceback it needs is worse
  than trimming it.
- **One owner of the copy.** ``spill_source`` is cleared before any write is
  attempted, so a retry cannot leave the original alive in memory.
- **Bounded.** One file per call, skipped above ``MAX_SPILL_CHARS``, and the zone is
  pruned to ``MAX_SPILL_FILES`` oldest-first — in local mode this directory lives in
  the user's own folder, not in a product cache.
"""

from __future__ import annotations

import re
import time
from typing import TYPE_CHECKING

from agentcore.core.logging import get_logger
from agentcore.core.text import DEFAULT_ELISION_MARKER
from agentcore.tools.protocol import ToolResult
from agentcore.workspace.stage_dirs import SPILL_REL

if TYPE_CHECKING:  # pragma: no cover - typing only
    from agentcore.tools.protocol import ToolContext

logger = get_logger(__name__)

# One result larger than this is a runaway dump, not a tool answer; the model keeps
# today's trimmed view rather than paying disk + prune cost for it.
MAX_SPILL_CHARS = 1_000_000
# Oldest-first ceiling for the zone. The files are pure redundancy (the model has
# already seen both ends), so losing the oldest costs nothing.
MAX_SPILL_FILES = 200
# ``read`` owns a real file already; see the module docstring.
_NO_SPILL_TOOLS = frozenset({"read"})

_NOTICE = (
    "\n\n[正文共 {total} 字符，此处只保留首尾；全文在 {path}，"
    "可用 read 按 offset/limit 分段读取。]"
)
# The default marker says the missing middle is 「非磁盘内容」 — true of every other
# truncation site, and false the moment this one spills. Swapped in only *after* the
# write lands, so the model never reads a claim the disk cannot back.
_SPILLED_MARKER = "\n\n[系统视图截断·全文已落盘，路径见本段末尾] ……\n\n"


def _file_relpath(tool_name: str, tool_call_id: str) -> str:
    """Workspace-relative spill path. Leading ns stamp makes lexical order age order."""
    stamp = time.time_ns()
    safe_tool = re.sub(r"[^A-Za-z0-9_.-]+", "-", tool_name or "tool")[:40].strip("-")
    tail = re.sub(r"[^A-Za-z0-9]+", "", tool_call_id or "")[:8] or "call"
    return f"{SPILL_REL}/{stamp}-{safe_tool or 'tool'}-{tail}.txt"


async def spill_capped_output(
    result: ToolResult,
    context: ToolContext | None,
    *,
    tool_name: str,
) -> None:
    """Write a capped result's full text to the session workspace, then say where.

    Mutates ``result.output`` on success and always clears ``result.spill_source``.
    Never raises: a spill is a nicety, and a tool call must not fail because the
    thing that was supposed to make its output recoverable broke.
    """
    full = result.spill_source
    if full is None:
        return
    # Single owner: the copy dies here whether or not the write succeeds.
    result.spill_source = None
    if tool_name in _NO_SPILL_TOOLS or not result.success:
        return
    if len(full) > MAX_SPILL_CHARS:
        logger.info(
            "tool.output_spill_skipped",
            tool=tool_name,
            chars=len(full),
            reason="over_cap",
        )
        return
    backend = getattr(context, "backend", None)
    write = getattr(backend, "write", None)
    if not callable(write):
        return

    relpath = _file_relpath(tool_name, result.tool_call_id)
    try:
        await write(relpath, full)
    except Exception:  # noqa: BLE001 — spill is best-effort by contract
        logger.warning(
            "tool.output_spill_failed",
            tool=tool_name,
            chars=len(full),
            exc_info=True,
        )
        return

    trimmed = (result.output or "").replace(
        DEFAULT_ELISION_MARKER, _SPILLED_MARKER
    )
    result.output = trimmed + _NOTICE.format(total=len(full), path=relpath)
    result.metadata["output_spill_path"] = relpath
    logger.info(
        "tool.output_spilled",
        tool=tool_name,
        chars=len(full),
        kept_chars=len(trimmed),
        path=relpath,
    )
    await _prune(backend)


async def _prune(backend: object) -> None:
    """Drop the oldest spill files past ``MAX_SPILL_FILES``. Best-effort."""
    list_dir = getattr(backend, "list", None)
    delete = getattr(backend, "delete", None)
    if not callable(list_dir) or not callable(delete):
        return
    try:
        listing = await list_dir(SPILL_REL, "*.txt", cap=MAX_SPILL_FILES * 2)
        entries = [entry for entry in listing if not entry.is_dir]
    except Exception:  # noqa: BLE001 — prune is best-effort by contract
        return
    if len(entries) <= MAX_SPILL_FILES:
        return
    entries.sort(key=lambda entry: (entry.mtime_ms or 0, entry.path))
    for entry in entries[: len(entries) - MAX_SPILL_FILES]:
        try:
            await delete(entry.path, permanent=True)
        except Exception:  # noqa: BLE001 — a stuck file must not fail the call
            logger.warning("tool.output_spill_prune_failed", path=entry.path, exc_info=True)
