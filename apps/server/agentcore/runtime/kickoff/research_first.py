"""调研链证据探测（辩论进宿主图判据）。

开赛前开工卡「先调研再辩」按键已退役（庭前取证内化为辩论固有阶段）。
本模块不再提供 offer / recommend 闸，也不再回灌固定开工文案。
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
