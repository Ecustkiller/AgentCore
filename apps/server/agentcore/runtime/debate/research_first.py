"""调研链证据探测（辩论进宿主图判据）。

本模块只回答是否已有命题卡 / 约定文档。
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from agentcore.memory.followups import select_motion_card_from_journal


def has_research_chain_evidence(
    entries: Sequence[Mapping[str, Any]] | None,
    *,
    has_research_artifacts: bool = False,
) -> bool:
    """是否已有调研链证据（命题卡 / 约定文档）——原 offer 判据的逆命题素材。"""
    if select_motion_card_from_journal(entries) is not None:
        return True
    return bool(has_research_artifacts)
