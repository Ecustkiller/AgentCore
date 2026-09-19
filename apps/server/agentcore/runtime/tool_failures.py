"""Run-scoped tool failure facts for honest finalize / CEO synthesis.

Aggregated on :class:`~agentcore.runtime.loop_controller.LoopController` (same
counters as the circuit breaker). This module only formats the facts — it does
not own a parallel tally, and does not mutate ``role: system``.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

_LAST_ERROR_CAP = 200


@dataclass(frozen=True)
class ToolFailureFact:
    """One tool's failure summary for a single run."""

    tool_name: str
    failure_count: int
    last_error: str
    succeeded_after: bool

    @property
    def outstanding(self) -> bool:
        """True when failures were not cancelled by a later success of the same tool."""
        return self.failure_count > 0 and not self.succeeded_after

    def to_dict(self) -> dict[str, Any]:
        return {
            "tool_name": self.tool_name,
            "failure_count": self.failure_count,
            "last_error": self.last_error,
            "succeeded_after": self.succeeded_after,
        }

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> ToolFailureFact | None:
        name = str(data.get("tool_name") or "").strip()
        if not name:
            return None
        try:
            count = int(data.get("failure_count") or 0)
        except (TypeError, ValueError):
            count = 0
        if count <= 0:
            return None
        return cls(
            tool_name=name,
            failure_count=count,
            last_error=cap_error_summary(str(data.get("last_error") or "")),
            succeeded_after=bool(data.get("succeeded_after")),
        )


def cap_error_summary(text: str, *, limit: int = _LAST_ERROR_CAP) -> str:
    """Collapse whitespace and truncate for prompt / tool-result surfaces."""
    cleaned = " ".join((text or "").split())
    if len(cleaned) <= limit:
        return cleaned
    return cleaned[: max(0, limit - 1)] + "…"


def facts_from_dicts(rows: Sequence[Mapping[str, Any]] | None) -> list[ToolFailureFact]:
    out: list[ToolFailureFact] = []
    for row in rows or ():
        if not isinstance(row, Mapping):
            continue
        fact = ToolFailureFact.from_dict(row)
        if fact is not None:
            out.append(fact)
    return out


def outstanding_facts(facts: Sequence[ToolFailureFact]) -> list[ToolFailureFact]:
    return [f for f in facts if f.outstanding]


def format_tool_failures_section(
    facts: Sequence[ToolFailureFact], *, heading: str = "### tool_failures"
) -> str:
    """Structured block for delegate / synthesis consumers. Empty when no failures."""
    if not facts:
        return ""
    lines = [
        heading,
        "引擎按 run 聚合的工具失败事实。"
        "``succeeded_after=true`` = 同工具后来已成功；"
        "``succeeded_after=false`` = 仍有未抵消失败。",
    ]
    for fact in facts:
        err = fact.last_error or "（无摘要）"
        lines.append(
            f"- `{fact.tool_name}`：failures={fact.failure_count}，"
            f"succeeded_after={'true' if fact.succeeded_after else 'false'}，"
            f"last_error={err}"
        )
    return "\n".join(lines)


def format_team_tool_failures_block(
    products: Sequence[Mapping[str, Any]],
) -> str:
    """CEO-facing multi-worker ``tool_failures`` section, or "" when none."""
    chunks: list[str] = []
    for wp in products:
        rows = wp.get("tool_failures")
        facts = facts_from_dicts(rows if isinstance(rows, list) else None)
        if not facts:
            continue
        role = str(wp.get("role") or "worker")
        run_id = str(wp.get("run_id") or "")
        head = f"#### {role}"
        if run_id:
            head += f" · run_id: `{run_id}`"
        section = format_tool_failures_section(facts, heading=head)
        if section:
            chunks.append(section)
    if not chunks:
        return ""
    return (
        "\n### tool_failures\n"
        "各队员 run 内工具失败聚合（引擎地面真相）。\n\n"
        + "\n\n".join(chunks)
    )
