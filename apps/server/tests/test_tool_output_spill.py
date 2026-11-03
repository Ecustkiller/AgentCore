"""Oversized tool output: the trimmed view gets a path back to the full text.

``ToolResult`` can only trim — it has no workspace. These tests pin the split: the
cap keeps the untouched string alive on the result, the pipeline seam spills it
into ``AgentCore/spill/``, and every failure mode leaves today's trimmed view
exactly as it was.
"""

from __future__ import annotations

from dataclasses import dataclass

import pytest

from agentcore.core.text import DEFAULT_ELISION_MARKER
from agentcore.tools.protocol import ToolResult
from agentcore.tools.spill import (
    MAX_SPILL_CHARS,
    MAX_SPILL_FILES,
    spill_capped_output,
)
from agentcore.workspace._paths import is_internal_zone_relpath
from agentcore.workspace.stage_dirs import SPILL_REL


@dataclass
class _Entry:
    path: str
    is_dir: bool = False
    size_bytes: int | None = None
    mtime_ms: int | None = 0


class _FakeBackend:
    """Records the calls a spill makes; ``fail_write`` proves fail-open."""

    def __init__(self, *, fail_write: bool = False, existing: int = 0) -> None:
        self.writes: list[tuple[str, str]] = []
        self.deleted: list[str] = []
        self.fail_write = fail_write
        self.existing = existing

    async def write(self, path: str, content: str) -> int:
        if self.fail_write:
            raise OSError("disk full")
        self.writes.append((path, content))
        return len(content)

    async def list(self, directory: str, pattern: str, *, cap: int | None = None):  # noqa: ANN001
        entries = [
            _Entry(path=f"{SPILL_REL}/20260101T0000{i:03d}-run-abcd.txt", mtime_ms=i)
            for i in range(self.existing)
        ]
        return type(
            "Listing", (), {"entries": entries, "truncated": False, "__iter__": lambda s: iter(entries)}
        )()

    async def delete(self, path: str, *, permanent: bool = False) -> None:
        self.deleted.append(path)


@dataclass
class _Ctx:
    backend: object


def _capped(output: str, *, success: bool = True) -> ToolResult:
    return ToolResult(tool_call_id="call-1", success=success, output=output)


def _long(extra: str = "") -> str:
    """An output that trips the 4000-char cap with a distinct, dropped middle."""
    return "HEAD" + ("x" * 3000) + f"MIDDLE{extra}" + ("y" * 3000) + "TAIL"


def test_cap_keeps_the_untouched_text_but_never_for_a_fitting_output():
    capped = _capped(_long())
    assert capped.spill_source is not None
    assert len(capped.spill_source) > len(capped.output)
    assert len(capped.output) <= ToolResult._MAX_OUTPUT_LEN

    short = _capped("small enough")
    assert short.spill_source is None


def test_spill_zone_is_an_internal_zone():
    """Hidden from listings and the file tree — readable only by exact path."""
    assert is_internal_zone_relpath(f"{SPILL_REL}/20260101T0000001-run-abcd.txt")
    assert is_internal_zone_relpath(SPILL_REL)


@pytest.mark.asyncio
async def test_spill_writes_the_full_text_and_names_the_file():
    backend = _FakeBackend()
    result = _capped(_long("NEEDLE"))
    full = result.spill_source

    await spill_capped_output(result, _Ctx(backend), tool_name="run")

    assert len(backend.writes) == 1
    path, content = backend.writes[0]
    assert path.startswith(f"{SPILL_REL}/")
    assert path.endswith(".txt")
    assert content == full
    assert "NEEDLE" in content
    # The model keeps its trimmed view plus one line saying where the rest is.
    assert path in result.output
    assert "offset/limit" in result.output
    assert "MIDDLE" not in result.output
    assert result.metadata["output_spill_path"] == path
    # The in-body marker must stop calling the missing middle 「非磁盘内容」 — it is
    # on disk now, and a trimmed view that lies about where the rest lives is worse
    # than one with no path at all.
    assert "非磁盘内容" not in result.output
    assert "全文已落盘" in result.output
    # The copy does not outlive the call.
    assert result.spill_source is None


@pytest.mark.asyncio
async def test_read_results_are_never_spilled():
    """A read result *is* a file — spilling it would point the model at a copy."""
    backend = _FakeBackend()
    result = _capped(_long())

    await spill_capped_output(result, _Ctx(backend), tool_name="read")

    assert backend.writes == []
    assert result.metadata == {}
    assert result.spill_source is None


@pytest.mark.asyncio
async def test_failed_calls_keep_their_traceback_inline():
    backend = _FakeBackend()
    result = _capped(_long(), success=False)

    await spill_capped_output(result, _Ctx(backend), tool_name="run")

    assert backend.writes == []
    assert "offset/limit" not in result.output


@pytest.mark.asyncio
async def test_over_cap_payload_keeps_todays_trimmed_view():
    backend = _FakeBackend()
    result = _capped("z" * (MAX_SPILL_CHARS + 10))
    before = result.output

    await spill_capped_output(result, _Ctx(backend), tool_name="run")

    assert backend.writes == []
    assert result.output == before


@pytest.mark.asyncio
async def test_write_failure_fails_open():
    backend = _FakeBackend(fail_write=True)
    result = _capped(_long())
    before = result.output

    await spill_capped_output(result, _Ctx(backend), tool_name="run")

    assert result.output == before
    assert result.metadata == {}
    assert result.spill_source is None
    # Marker swap is gated on the write: a failed spill keeps today's wording verbatim.
    assert DEFAULT_ELISION_MARKER in result.output


@pytest.mark.asyncio
async def test_no_workspace_is_a_no_op():
    result = _capped(_long())
    before = result.output

    await spill_capped_output(result, None, tool_name="run")

    assert result.output == before


@pytest.mark.asyncio
async def test_zone_is_pruned_oldest_first():
    backend = _FakeBackend(existing=MAX_SPILL_FILES + 3)
    result = _capped(_long())

    await spill_capped_output(result, _Ctx(backend), tool_name="run")

    assert len(backend.writes) == 1
    assert len(backend.deleted) == 3
    # mtime_ms 0..2 are the oldest of the pre-existing files.
    assert backend.deleted[0].endswith("000000-run-abcd.txt")
