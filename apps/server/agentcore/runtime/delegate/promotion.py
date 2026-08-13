"""成品归位（``promote_product``）的回合台账读写：accepted 闸门 + 交付对账改写。

归位 = CEO 收口前把用户要的成品从 AI 工作间（``AgentCore/文档/``）**移进**用户
工作区。移动而非标记：标记在离开产品 UI 那刻即失效（ZIP 里没有标记、合回本机也
没有），代价是审计按旧路径查会与新位置断开——所以搬完必须同步改写台账，
``delivery_status.promoted`` 的 ``{from, to}`` 是旧路径唯一的回查线索。

**位置态与质量态正交**：``accepted`` / ``rejected`` 答「这份验收过没过」，归位答
「这份是不是用户要的成品」。只有 accepted 的可归位，判据取自最近一次
``delivery_status``——回合内台账优先，取不到回退本会话最近一条落盘对账
（见 :func:`hydrate_reconciliation_from_journal`）。两者都是**已算好的验收结果**：
本模块**不重算验收**、也**不放行未验收路径**，读不到对账就是读不到，由调用方诚实回报。

**零归位是合法状态**：多幕协作的中间幕本就零归位。本模块不产生任何缺口 / 降档 /
回炉信号——「收口须显式声明本轮归位了什么（可答无）」是提示词层的结构要求
（`.cursor/rules/intercept-discipline.mdc` 阶梯 1），不上硬闸。

台账本体 :class:`~agentcore.tools.protocol.TurnPromotionLedger` 挂在 ToolContext 上
（共享可变对象），因为 ``delegate``（写对账）与 ``promote_product``（读闸门）分处
``asyncio.gather`` 的两个 Task，ContextVar 传不过去；那边的类注释记着这条坑。
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import TYPE_CHECKING, Any

from agentcore.core.logging import get_logger
from agentcore.workspace.write_claims import normalize_ownership_path

if TYPE_CHECKING:
    from agentcore.tools.protocol import TurnPromotionLedger

logger = get_logger(__name__)

__all__ = [
    "adopt_journaled_reconciliation",
    "apply_turn_promotions",
    "has_delivery_reconciliation",
    "hydrate_reconciliation_from_journal",
    "note_delivery_reconciliation",
    "promotable_paths",
    "promotion_key",
    "record_promotions",
    "turn_promotions",
]


def note_delivery_reconciliation(
    ledger: TurnPromotionLedger | None, payload: dict[str, Any] | None
) -> None:
    """Snapshot the delivery reconciliation just emitted (accepted 闸门的真源).

    同 ``execution_id`` 保最新，与客户端 fold 同口径：后一批次的对账覆盖前一批次。
    """
    if ledger is None or not isinstance(payload, dict) or not payload.get("execution_id"):
        return
    ledger.reconciliation = dict(payload)


def has_delivery_reconciliation(ledger: TurnPromotionLedger | None) -> bool:
    """True when this turn already produced a delivery reconciliation to read."""
    return ledger is not None and ledger.reconciliation is not None


def adopt_journaled_reconciliation(
    ledger: TurnPromotionLedger | None, payload: dict[str, Any] | None
) -> None:
    """接手一条**别处落盘**的对账（journal 回灌 / 可用性短问重发）作本回合真源。

    与 :func:`note_delivery_reconciliation` 的差别只在 ``promoted``：那条记的是本回合
    自己刚发的卡（``promoted`` 本就出自台账），这条记的是落盘的卡——卡上已有的归位行
    必须一并接手，否则本回合再归位一次、重发时会把旧行抹掉（旧路径唯一的回查线索）。
    仅在台账尚无归位行时接手：台账一旦开始记账就以台账为准，不做行级合并 / 去重。
    """
    if ledger is None or not isinstance(payload, dict) or not payload.get("execution_id"):
        return
    ledger.reconciliation = dict(payload)
    if ledger.promotions:
        return
    ledger.promotions.extend(
        {"from": str(row["from"]), "to": str(row["to"])}
        for row in payload.get("promoted") or []
        if isinstance(row, dict) and row.get("from") and row.get("to")
    )


async def hydrate_reconciliation_from_journal(
    ledger: TurnPromotionLedger | None, *, conversation_id: str
) -> bool:
    """回合台账为空时，接手本会话最近一条 **durable** ``delivery_status`` 作对账真源。

    为何必须有这条回退：「批次收尾 → `ask_user` 问用户要不要归位 → 续跑归位」是归位最
    主流的路径，而续跑是新 ``ToolContext``（新台账）——不回退，工具在主路径上就是坏的。
    取的是**已落盘的对账结果**，不是重算验收；`maybe_reinject_recent_delivery_for_
    availability_ask` 早已复用同一份（既有口径，不另造第二套真源）。

    边界：同一 ``conversation_id`` 最近一条，**不跨对话**；仍然只有 ``accepted`` 可归位；
    **回合内台账优先**（已有对账直接返回，不查库）。载荷里已有的 ``promoted`` 行一并接手，
    这样二次归位重发时不会丢掉上一轮的 ``{from, to}``（旧路径唯一的回查线索）。

    归位后重发会让 journal 最新那条就是**已改写过**的卡：再次读到它是预期的——那些路径
    已不在工作间，归位闸自会跳过并说明「已在工作区」，既不会重搬也不留悬空引用，
    因此不需要去重或版本标记。

    Never raises：查不到 / 查失败 = 取不到清单，由调用方诚实回报。
    """
    if ledger is None:
        return False
    if ledger.reconciliation is not None:
        return True
    cid = (conversation_id or "").strip()
    if not cid:
        return False
    try:
        from agentcore.db.base import async_session_factory
        from agentcore.db.repositories import TurnJournalRepository

        async with async_session_factory() as session:
            payload = await TurnJournalRepository(session).find_latest_delivery_status(
                conversation_id=cid
            )
    except Exception:  # noqa: BLE001 — 取不到就是取不到，不得让归位路径抛错
        logger.warning("promote_product.journal_lookup_failed", conversation_id=cid, exc_info=True)
        return False
    if not isinstance(payload, dict) or not payload.get("execution_id"):
        return False
    adopt_journaled_reconciliation(ledger, payload)
    logger.info(
        "promote_product.reconciliation_from_journal",
        conversation_id=cid,
        execution_id=str(payload.get("execution_id") or ""),
        accepted=len(payload.get("delivered_files") or []),
        prior_promotions=len(ledger.promotions),
    )
    return True


def turn_promotions(ledger: TurnPromotionLedger | None) -> list[dict[str, str]]:
    """台账里的已归位行（重发与后续批次的对账共用）。

    跨回合归位时含上一轮从 journal 接手的行——这张卡的 ``promoted`` 讲的是「卡上这些
    产物搬去了哪」，不是「本回合搬了几个」，所以旧行必须留着（旧路径的回查线索）。
    """
    if ledger is None:
        return []
    return [dict(row) for row in ledger.promotions]


def promotable_paths(ledger: TurnPromotionLedger | None) -> tuple[str, ...]:
    """Accepted paths eligible for promotion (stable order, deduped).

    真源 = 最近一次对账里 ``status=accepted`` 的 ``artifacts`` 行；``delivered_files``
    按定义也只含 accepted，并入只为兼容没有 ``artifacts`` 的旧载荷（journal 回灌）。
    """
    payload = ledger.reconciliation if ledger is not None else None
    if payload is None:
        return ()
    out: list[str] = []
    seen: set[str] = set()

    def _add(raw: Any) -> None:
        path = str(raw or "").strip()
        if path and path not in seen:
            seen.add(path)
            out.append(path)

    for row in payload.get("artifacts") or []:
        if isinstance(row, dict) and row.get("status") == "accepted":
            _add(row.get("path"))
    for path in payload.get("delivered_files") or []:
        _add(path)
    return tuple(out)


def promotion_key(path: Any) -> str:
    """Canonical key for matching a workspace path against the promotion table.

    同一份文件在台账里未必只有一种拼法：落盘 ``path`` 来自 sanitize 后的写入，
    ``derived_from`` 来自导出工具自报的源参数（``./a/b`` / ``a//b`` 都可能），模型抄的
    路径更随意。归一后再比，拼法差异就不会让改写漏掉一行、在 wire 上留下悬空引用。
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

    ``derived_from`` 是导出件指回源的血缘（``md_to_docx``：docx ← 源 md），消费方据此把
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
    """Stamp ``promoted`` + rewrite promoted paths on a freshly built reconciliation.

    A later batch in the same turn rebuilds ``delivery_status`` from worker state,
    which still names the pre-move path — remap it so the newest card cannot
    resurrect a file that has already been promoted away. No promotions ⇒ payload
    returned untouched (零归位不改任何字段，wire 上也不多一个 key)。

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
    updated["promoted"] = turn_promotions(ledger)
    return updated


def record_promotions(
    ledger: TurnPromotionLedger, moves: Sequence[tuple[str, str]]
) -> dict[str, Any] | None:
    """Book the moves and rewrite the delivery ledger; return the payload to re-emit.

    Rewrites the last reconciliation's ``delivered_files`` / ``artifacts``
    (``path`` 与 ``derived_from``) / gap ``paths`` so nothing left in the turn
    names a file that no longer exists,
    and returns it for re-emission under the same ``execution_id``（fold 保最新 ⇒
    同一张卡更新为新位置）。Returns ``None`` when there is nothing to re-emit
    (no moves, or no reconciliation to rewrite); callers treat that as「无需重发」,
    never as an error.
    """
    rows = [
        {"from": src.strip(), "to": dst.strip()}
        for src, dst in moves
        if str(src or "").strip() and str(dst or "").strip()
    ]
    if not rows:
        return None
    ledger.promotions.extend(rows)
    if ledger.reconciliation is None:
        logger.info("promote_product.no_delivery_payload", promoted=len(rows))
        return None
    updated = apply_turn_promotions(ledger.reconciliation, ledger)
    ledger.reconciliation = updated
    return updated
