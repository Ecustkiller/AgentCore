"""回合归位台账读写：结构化路径改写。

成品归位工具已下线，本模块不再写新行。``apply_turn_promotions`` 在 promotions 空时
no-op。测试仍可往台账塞行，验证后续批次对账不会把旧路径线索复活。

台账本体 :class:`~agentcore.tools.protocol.TurnPromotionLedger` 挂在 ToolContext 上
（共享可变对象）：``execute_tools`` 的 ``asyncio.gather`` 会复制 context，ContextVar
传不过去；那边的类注释记着这条坑。
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import TYPE_CHECKING, Any

from agentcore.workspace.write_claims import normalize_ownership_path

if TYPE_CHECKING:
    from agentcore.tools.protocol import TurnPromotionLedger

__all__ = [
    "adopt_journaled_reconciliation",
    "apply_turn_promotions",
    "note_delivery_reconciliation",
    "promotion_key",
    "turn_promotions",
]


def note_delivery_reconciliation(
    ledger: TurnPromotionLedger | None, payload: dict[str, Any] | None
) -> None:
    """Snapshot the delivery reconciliation just emitted.

    同 ``execution_id`` 保最新，与客户端 fold 同口径：后一批次覆盖档位 / gaps；
    ``artifacts`` 在下次 ``build_delivery_status`` 时与本快照并集（同 path 后写）。
    """
    if ledger is None or not isinstance(payload, dict) or not payload.get("execution_id"):
        return
    ledger.reconciliation = dict(payload)


def adopt_journaled_reconciliation(
    ledger: TurnPromotionLedger | None, payload: dict[str, Any] | None
) -> None:
    """接手一条**别处落盘**的对账（journal 回灌 / 可用性短问重发）作本回合真源。

    与 :func:`note_delivery_reconciliation` 同写 ``reconciliation``；不再从卡上
    接手历史搬家行（成品归位已下线）。
    """
    if ledger is None or not isinstance(payload, dict) or not payload.get("execution_id"):
        return
    ledger.reconciliation = dict(payload)


def turn_promotions(ledger: TurnPromotionLedger | None) -> list[dict[str, str]]:
    """台账里的已归位行（重发与后续批次的对账共用）。

    这些行只留在台账里做路径改写，不上 live 交付卡。live 路径不再写入；空表时
    :func:`apply_turn_promotions` 原样返回。
    """
    if ledger is None:
        return []
    return [dict(row) for row in ledger.promotions]


def promotion_key(path: Any) -> str:
    """Canonical key for matching a workspace path against the promotion table.

    同一份文件在台账里未必只有一种拼法：落盘 ``path`` 来自 sanitize 后的写入，
    ``derived_from`` 来自导出工具自报的源参数（``./a/b`` / ``a//b`` 都可能）。
    归一后再比，拼法差异就不会让改写漏掉一行、在 wire 上留下悬空引用。
    """
    text = str(path or "").strip()
    return normalize_ownership_path(text) if text else ""


def _rewrite(path: Any, table: dict[str, str]) -> Any:
    """Map one ledger path through the promotion table (unmoved paths pass through)."""
    if not isinstance(path, str):
        return path
    return table.get(promotion_key(path), path)


def _rewrite_rows(rows: Sequence[Any], table: dict[str, str]) -> list[Any]:
    """Rewrite acceptance rows (``path`` / ``derived_from``) — 导出件与源都不留悬空。

    ``derived_from`` 是导出件指回源的血缘（``md_export``：docx ← 源 md），消费方据此把
    源折成中间稿。源被归位后它若还指旧位置，导出件就认不出自己的源：中间稿折叠断链、
    ``报告.md`` 与 ``报告.docx`` 并列出现。故与 ``path`` 同表改写。
    """
    out: list[Any] = []
    for row in rows:
        if not isinstance(row, dict):
            out.append(row)
            continue
        updated = dict(row)
        updated["path"] = _rewrite(updated.get("path"), table)
        if updated.get("derived_from"):
            updated["derived_from"] = _rewrite(updated["derived_from"], table)
        out.append(updated)
    return out


def _rewrite_gaps(gaps: Sequence[Any], table: dict[str, str]) -> list[Any]:
    """Gap rows carry structured ``paths`` (soft hits) — keep them on real files."""
    out: list[Any] = []
    for row in gaps:
        if not isinstance(row, dict) or not row.get("paths"):
            out.append(row)
            continue
        updated = dict(row)
        updated["paths"] = [_rewrite(p, table) for p in row["paths"]]
        out.append(updated)
    return out


def apply_turn_promotions(
    payload: dict[str, Any], ledger: TurnPromotionLedger | None
) -> dict[str, Any]:
    """Rewrite promoted paths on a freshly built reconciliation.

    A later batch in the same turn rebuilds ``delivery_status`` from worker state,
    which still names the pre-move path — remap it so the newest card cannot
    resurrect a file that has already been promoted away. No promotions ⇒ payload
    returned untouched.

    改写覆盖载荷上**所有结构化路径字段**：``delivered_files``、``artifacts[].path``、
    ``artifacts[].derived_from``（导出件血缘）、``gaps[].paths``。wire 上不留悬空引用是
    硬要求——消费方不止桌面（移动端 / admin 回放不一定自己兜）。自由文本（``summary`` /
    ``artifacts[].detail`` / ``actions[].prompt``）里顺带提到的路径不扫、不正则替换。
    """
    if ledger is None or not ledger.promotions:
        return payload
    table = {
        promotion_key(row["from"]): row["to"]
        for row in ledger.promotions
        if promotion_key(row["from"])
    }
    updated = dict(payload)
    updated["delivered_files"] = [_rewrite(p, table) for p in payload.get("delivered_files") or []]
    updated["artifacts"] = _rewrite_rows(payload.get("artifacts") or [], table)
    updated["gaps"] = _rewrite_gaps(payload.get("gaps") or [], table)
    return updated
