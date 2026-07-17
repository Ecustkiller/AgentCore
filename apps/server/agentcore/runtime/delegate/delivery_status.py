"""交付状态结构化（能力闸门与交付诚实性）：delegate 批次收尾的确定性交付对账。

把收尾侧引擎已有的信号——worker ``files_touched``、契约 / 交接缺口
(:func:`~agentcore.runtime.delegate.completion.collect_worker_gaps`，含 degraded 交接与
artifacts 对账残差)、``completion_criteria`` 未满足、失败 / 未执行节点——汇成一条面向
用户的 ``delivery_status`` 事件（已交付文件 / 缺口 / 待用户操作），模板拼接、不调 LLM。

挂在 drive 的各收尾路径旁路（正常终态 / 验收未满足 / 部分失败 stash / replan(stop)），
永不抛错；纯 prose 成功批次（无落盘文件、无缺口）保持无声，不发事件。
折叠语义：同 ``execution_id`` 保最新——反映最近一批委派的对账（多批场景下 FileArtifactsCard
仍是全量文件清单，本事件承载「诚实对账」而非全量枚举）。
"""

from __future__ import annotations

from typing import Any

from agentcore.runtime.runs.plan import RunPlan
from agentcore.runtime.runs.types import RunPhase, RunState

_MAX_FILES = 24
_MAX_GAPS = 12


def _delivered_files(results: dict[str, RunState]) -> list[str]:
    """Ordered, deduped workspace paths COMPLETED workers wrote (含热修修订 run)."""
    seen: set[str] = set()
    out: list[str] = []
    for state in results.values():
        if state is None or state.phase is not RunPhase.COMPLETED:
            continue
        for path in state.files_touched or []:
            if path and path not in seen:
                seen.add(path)
                out.append(path)
    return out[:_MAX_FILES]


def _has_completed_revision(run_id: str, results: dict[str, RunState]) -> bool:
    """True when a hot-redirect revision (``{run_id}_rev*``) finished for this node."""
    prefix = f"{run_id}_rev"
    return any(
        rid.startswith(prefix) and st is not None and st.phase is RunPhase.COMPLETED
        for rid, st in results.items()
    )


def _node_gaps(plan: RunPlan, results: dict[str, RunState]) -> list[dict[str, str]]:
    """Terminal-but-undelivered plan nodes → gap rows (failed / skipped / cancelled)."""
    gaps: list[dict[str, str]] = []
    for node in plan.nodes:
        state = results.get(node.run_id)
        if state is None:
            continue
        role = node.role or node.agent_name or node.run_id
        if state.phase is RunPhase.FAILED:
            err = (state.error or "").strip()
            desc = f"未完成（失败：{err}）" if err else "未完成（失败）"
            gaps.append({"role": role, "description": desc})
        elif state.phase is RunPhase.SKIPPED:
            gaps.append({"role": role, "description": "未执行（计划收口时跳过）"})
        elif state.phase is RunPhase.CANCELLED and not _has_completed_revision(
            node.run_id, results
        ):
            gaps.append({"role": role, "description": "未完成（中途取消）"})
    return gaps


def build_delivery_status(
    plan: RunPlan,
    results: dict[str, RunState],
    *,
    execution_id: str,
    backend: Any = None,
    criteria_gaps: list[str] | None = None,
) -> dict[str, Any] | None:
    """Build a ``delivery_status`` payload, or ``None`` when there is nothing to report.

    Emission gate: at least one delivered file OR one gap — a pure-prose successful
    batch stays silent (研究 / 分析类委派不该弹交付卡). All inputs are the wrap-up
    signals the engine already computed; nothing here re-verifies the workspace.
    """
    from agentcore.runtime.delegate.completion import (
        collect_worker_gaps,
        plan_mentions_binary_artifact,
        plan_suggests_code_verification,
    )

    delivered = _delivered_files(results)

    gaps: list[dict[str, str]] = []
    # ① 契约 / 交接残差（软接受后仍未对齐的声明交付物、degraded 交接简报…）。
    for role, lines in collect_worker_gaps(plan, results):
        for line in lines:
            text = str(line).strip()
            if text:
                gaps.append({"role": role, "description": text})
    # ② 完成验收未满足（completion_criteria 缺口，批次级）。
    for gap in criteria_gaps or []:
        text = str(gap).strip()
        if text:
            gaps.append({"role": "验收", "description": text})
    # ③ 失败 / 未执行 / 取消的计划节点（热修已接手的取消节点不算缺口）。
    gaps.extend(_node_gaps(plan, results))
    gaps = gaps[:_MAX_GAPS]

    # 待用户操作：唯一确定性可推导的是「无执行环境 → 绑定本地文件夹」。判定复用
    # code_execution_enabled_for 单一真相源（与 worker registry / 委派闸同一谓词）。
    actions: list[dict[str, str]] = []
    if backend is not None and gaps:
        from agentcore.tools.builtin import code_execution_enabled_for

        needs_execution = (
            plan_suggests_code_verification(plan)
            or plan_mentions_binary_artifact(plan)
            or any("code_execute" in g["description"] for g in gaps)
        )
        if needs_execution and not code_execution_enabled_for(backend):
            actions.append(
                {
                    "kind": "bind_local_folder",
                    "description": (
                        "本回合为云端会话、未装配执行环境：绑定本地文件夹后，"
                        "团队可在你的电脑上运行脚本、生成并验证产物。"
                    ),
                }
            )

    if not delivered and not gaps:
        return None

    if not gaps:
        state = "delivered"
        summary = f"已交付 {len(delivered)} 个文件"
    elif delivered:
        state = "partial"
        summary = f"已交付 {len(delivered)} 个文件；{len(gaps)} 项缺口"
    else:
        state = "blocked"
        summary = f"未能交付：{len(gaps)} 项缺口"

    return {
        "execution_id": execution_id,
        "state": state,
        "summary": summary,
        "delivered_files": delivered,
        "gaps": gaps,
        "actions": actions,
    }


def maybe_emit_delivery_status(
    sink: Any,
    plan: RunPlan,
    results: dict[str, RunState],
    *,
    execution_id: str,
    backend: Any = None,
    criteria_gaps: list[str] | None = None,
) -> None:
    """Emit ``delivery_status`` when the reconciliation has substance. Never raises."""
    try:
        payload = build_delivery_status(
            plan,
            results,
            execution_id=execution_id,
            backend=backend,
            criteria_gaps=criteria_gaps,
        )
        if payload is None:
            return
        from agentcore.runtime.events import delivery_status

        sink.emit(delivery_status(**payload))
    except Exception:  # noqa: BLE001 — wrap-up side channel must never break the drive
        from agentcore.core.logging import get_logger

        get_logger(__name__).warning(
            "delegate.delivery_status_failed",
            execution_id=execution_id,
            exc_info=True,
        )
