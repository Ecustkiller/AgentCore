"""Hard-ceiling termination: token budget or max_rounds force-finalize."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from agentcore.core.logging import get_logger
from agentcore.llm.profiles import ProfileParams
from agentcore.llm.provider.openai_compatible import OpenAICompatibleProvider
from agentcore.llm.provider.protocol import LLMMessage, TokenUsage
from agentcore.runtime.events import EventSink, FinishReason, escalation_raised
from agentcore.runtime.loop_controller import LoopController
from agentcore.tools.protocol import ToolContext
from agentcore.tools.registry import ToolRegistry

from .finalize import force_finalize

logger = get_logger(__name__)


async def ceiling_finalize(
    *,
    messages: list[LLMMessage],
    llm: OpenAICompatibleProvider,
    profile: ProfileParams,
    active_model: str | None,
    base_model: str,
    tools: ToolRegistry,
    allowed_tool_names: list[str] | None,
    disabled_tools: set[str],
    emit_content: Callable[[str], None],
    emit_reasoning: Callable[[str], None],
    emit_reset: Callable[[str], None],
    final_content: str,
    final_reasoning: str,
    total_usage: TokenUsage,
    ceiling_reason: str,
    round_idx: int,
    role: str,
    run_id: str,
    token_budget: int,
    controller: LoopController,
    tool_context: ToolContext,
    sink: EventSink,
    finish_override_sink: list[FinishReason] | None,
    gate_escalation_sink: list[dict[str, Any]] | None,
    cutoff_reason_sink: list[str] | None = None,
) -> tuple[str, str, TokenUsage, int]:
    """Force-finalize after the round loop exits on a hard ceiling.

    Routes the finish by run health so an on-track worker delivers while a
    thrashing one is flagged DEGRADED + escalated (signal only — no auto replan).
    On-track ``token_budget`` still stamps ``cutoff_reason_sink`` so delivery_status
    / CEO gaps stay honest (不标 DEGRADED、不自动 replan).
    """
    # Hard-ceiling termination: the token backstop broke the loop, or max_rounds
    # exhausted. Always force-finalize (杜绝死循环); route the finish by run health so an
    # on-track worker delivers its work while a thrashing one is flagged. 据审计: the
    # signal is SURFACED, not auto-actioned — there is no「升级→CEO 自动重分解」闭环; the
    # CEO may voluntarily replan off this signal.
    rounds_done = round_idx if ceiling_reason == "token_budget" else profile.max_rounds
    thrashing = role == "worker" and controller.is_thrashing()
    logger.warning(
        "engine.ceiling_finalize",
        reason=ceiling_reason,
        thrashing=thrashing,
        rounds=rounds_done,
        tokens=total_usage.total_tokens,
        token_budget=token_budget,
        run_id=run_id,
    )
    # C·掐断透明化：正轨 token 撞顶也要结构化原因码（与打转 DEGRADED 分流正交）。
    if (
        ceiling_reason == "token_budget"
        and role == "worker"
        and cutoff_reason_sink is not None
        and "token_budget" not in cutoff_reason_sink
    ):
        cutoff_reason_sink.append("token_budget")
    if thrashing:
        if finish_override_sink is not None:
            finish_override_sink.append(FinishReason.DEGRADED)
        ceiling_question = (
            f"Worker 到达硬顶（{ceiling_reason}）时仍在打转，"
            "已强制收口并交付当前产出——可能不完整。"
        )
        # 结构化落入 RunState.escalations（经 gate_escalation_sink → 执行器 harvest 合并去重），
        # 让 CEO 的 escalation 聚合真正看得到「到顶打转」这一条、可自愿重规划——不止 UI 横幅
        # （否则「升级了却没人接」）。kind=normal：纯上浮，不触发 wave 边界自动动作，对齐
        # 「不自动重分解、CEO 自愿决策」的设计取舍。
        if gate_escalation_sink is not None:
            gate_escalation_sink.append(
                {
                    "question": ceiling_question,
                    "assumption": "",
                    "blocking": False,
                    "kind": "normal",
                    "source": "ceiling_backstop",
                    "gate_kind": "normal",
                    "evidence": (
                        f"{ceiling_reason}: tokens={total_usage.total_tokens}, "
                        f"rounds={rounds_done}"
                    ),
                    "tool_name": "",
                    "layer": "scheme",
                }
            )
        sink.emit(
            escalation_raised(
                run_id,
                tool_context.agent_id,
                question=ceiling_question,
                assumption="",
                blocking=False,
                kind="normal",
            )
        )
    final_content, final_reasoning, total_usage, rounds, _coordination = await force_finalize(
        messages=messages,
        llm=llm,
        profile=profile,
        active_model=active_model or base_model,
        tools=tools,
        allowed_tool_names=allowed_tool_names,
        disabled_tools=disabled_tools,
        emit_content=emit_content,
        emit_reasoning=emit_reasoning,
        final_content=final_content,
        final_reasoning=final_reasoning,
        total_usage=total_usage,
        rounds=rounds_done,
        reason=ceiling_reason,
        run_id=run_id,
        on_reset=emit_reset,
    )
    return final_content, final_reasoning, total_usage, rounds
