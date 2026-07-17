"""辩手两阶段发言管线：ReAct 检索 → 证据笔记；干净上下文成稿 → 发言全文。

根因：旧契约把「ReAct 最后一条无工具 stop」当正式发言，模型在收工语境混入过程句与
案情复述。本管线把检索交付物改为笔记，成稿在无工具、无检索往返的干净上下文中完成。

→ 见设计: docs/03-AI核心/辩论编排设计.md §4-2.5
"""

from __future__ import annotations

from collections.abc import Callable, Collection

from agentcore.core.logging import get_logger
from agentcore.llm.profiles import ProfileParams, build_request
from agentcore.llm.provider.protocol import LLMMessage, LLMProvider, TokenUsage
from agentcore.runtime.approvals import ApprovalGate
from agentcore.runtime.debate.evidence_guard import (
    format_closing_evidence_steer,
    format_source_grounding_steer,
    novel_verified_tags,
    ungrounded_verified_tags,
)
from agentcore.runtime.engine import react_loop
from agentcore.runtime.engine.stream import stream_llm_round
from agentcore.runtime.events import (
    EventSink,
    FinishReason,
    run_output_delta,
    run_output_reset,
    run_reasoning_delta,
    run_tool_progress,
)
from agentcore.tools.protocol import ToolContext
from agentcore.tools.registry import ToolRegistry

logger = get_logger(__name__)

_EMPTY_NOTES_PLACEHOLDER = "（本阶段无补充检索笔记；请仅依据发言任务与已知材料成稿。）"


def research_continuation_message(feedback: str) -> LLMMessage:
    """续轮检索阶段追加的 user 消息（交付物 = 证据笔记，非发言）。"""
    return LLMMessage(
        role="user",
        content=(
            f"## 检索与笔记指令\n{feedback}\n\n"
            "本阶段只交付【证据笔记】（不是正式发言）。"
            "需要时用工具取证；完成后直接输出笔记正文。"
        ),
    )


def build_draft_user(
    draft_brief: str, evidence_notes: str, *, guard_steer: str = ""
) -> str:
    """成稿调用的 user 正文：任务 + 证据笔记（可选结辩标签闸回炉提示）。"""
    notes = (evidence_notes or "").strip() or _EMPTY_NOTES_PLACEHOLDER
    brief = (draft_brief or "").strip()
    text = (
        f"## 发言任务\n{brief}\n\n"
        f"## 证据笔记\n{notes}\n\n"
        "请根据发言任务与证据笔记，直接输出【正式发言】全文（自由 markdown）。"
        "证据笔记只作素材，勿整段粘贴笔记标题或复述案件简介；禁止过程叙述与收工汇报。"
    )
    steer = (guard_steer or "").strip()
    if steer:
        text = f"{text}\n\n{steer}"
    return text


async def research_then_draft(
    messages: list[LLMMessage],
    *,
    llm: LLMProvider,
    tools: ToolRegistry,
    sink: EventSink,
    tool_ctx: ToolContext,
    profile: ProfileParams,
    turn_model: str,
    allowed_tools: list[str] | None,
    run_id: str,
    agent_id: str,
    citation_sink: list[dict],
    approval_gate: ApprovalGate | None,
    draft_system: str,
    draft_brief: str,
    allow_research: bool = True,
    usage_sink: list[TokenUsage] | None = None,
    on_round_begin: Callable[[], list[LLMMessage]] | None = None,
    streamed_content: list[str] | None = None,
    gate_escalation_sink: list[dict] | None = None,
    token_budget: int = 0,
    finish_override_sink: list[FinishReason] | None = None,
    evidence_tag_whitelist: Collection[str] | None = None,
    check_source_grounding: bool = False,
) -> tuple[str, str, TokenUsage, int]:
    """两阶段：可选 ReAct 检索产笔记（不进 run 卡片正文）→ 干净成稿（流式进卡片）。

    ``messages`` 就地延展：检索工具往返保留；成稿发言以 assistant 消息追加（供续轮记忆）。
    笔记正文不追加为产品消息——只经 journal 的 llm_call fact 可见。

    成稿后过【已核实】标签闸（二选一装配，违规 ``run_output_reset`` 后回炉一次；再违规
    放行并记警告）：``evidence_tag_whitelist`` 非 None = 结辩白名单闸（新标签即违规）；
    ``check_source_grounding`` = 出处软校验闸（opening / 续辩 / 质询作答：出处须与本方
    检索语料——user/tool 消息 + 成稿 brief + 当轮笔记——宽松对应，拦凭空来源不拦写法差异）。
    """
    total_usage = TokenUsage()
    total_reasoning_parts: list[str] = []
    total_rounds = 0
    notes = ""

    # 无可用取证工具 → 退化为单次成稿（结辩 allow_research=False / 空 allow-list /
    # 注册表未挂 web_search 等）。``allowed_tools is None`` = 不限制，以注册表是否非空为准。
    if not allow_research or allowed_tools is not None and len(allowed_tools) == 0:
        tools_available = False
    elif allowed_tools is None:
        tools_available = any(True for _ in tools.list_all())
    else:
        tools_available = any(tools.get_optional(n) is not None for n in allowed_tools)

    if tools_available:
        # 检索阶段：工具进度 / 思考可直播；正文不进 run_output_delta（避免笔记冒充发言）。
        notes, research_reasoning, research_usage, research_rounds = await react_loop(
            messages=messages,
            llm=llm,
            tools=tools,
            sink=sink,
            tool_context=tool_ctx,
            profile=profile,
            turn_model=turn_model,
            allowed_tool_names=allowed_tools,
            on_content=lambda _delta: None,
            on_reasoning=lambda d: sink.emit(run_reasoning_delta(run_id, agent_id, d)),
            on_tool_progress=lambda tool, chars: sink.emit(
                run_tool_progress(run_id, agent_id, tool, chars)
            ),
            on_reset=None,
            raise_on_error=True,
            citation_sink=citation_sink,
            annotate_citations=False,
            approval_gate=approval_gate,
            usage_sink=usage_sink,
            on_round_begin=on_round_begin,
            run_id=run_id,
            role="worker",
            deliverable_only=True,
            gate_escalation_sink=gate_escalation_sink,
            token_budget=token_budget,
            finish_override_sink=finish_override_sink,
        )
        total_usage = total_usage + research_usage
        total_rounds += research_rounds
        if research_reasoning:
            total_reasoning_parts.append(research_reasoning)
        logger.info(
            "debate.speech.research_done",
            run_id=run_id,
            notes_chars=len((notes or "").strip()),
            rounds=research_rounds,
        )

    def _on_draft_content(delta: str) -> None:
        sink.emit(run_output_delta(run_id, agent_id, delta))
        if streamed_content is not None:
            streamed_content.append(delta)

    speech, draft_reasoning, draft_usage = await _stream_draft(
        llm=llm,
        profile=profile,
        turn_model=turn_model,
        draft_system=draft_system,
        draft_brief=draft_brief,
        evidence_notes=notes,
        on_content=_on_draft_content,
        on_reasoning=lambda d: sink.emit(run_reasoning_delta(run_id, agent_id, d)),
    )
    total_usage = total_usage + draft_usage
    total_rounds += 1
    if draft_reasoning:
        total_reasoning_parts.append(draft_reasoning)

    # ── 成稿【已核实】标签闸（结辩白名单 / 出处软校验，装配互斥、共用一次回炉预算） ──
    grounding_corpus = ""
    if check_source_grounding:
        # 检索语料：transcript 里的 user（任务 brief 含底料 / 历轮材料）与 tool（历轮 + 当轮
        # 工具取证原文）消息 + 本次成稿 brief + 当轮证据笔记。刻意不含 assistant 消息——
        # 凭空来源不能靠自己此前的发言自我洗白。
        parts = [m.content for m in messages if m.role in ("user", "tool") and m.content]
        parts.append(draft_brief)
        parts.append(notes)
        grounding_corpus = "\n".join(parts)

    def _guard_issues(text: str) -> tuple[str, list[str], str]:
        """(闸名, 违规标签, 回炉 steer)；无违规 → ("", [], "")。"""
        if evidence_tag_whitelist is not None:
            novel = novel_verified_tags(text, frozenset(evidence_tag_whitelist))
            if novel:
                return "closing_whitelist", novel, format_closing_evidence_steer(novel)
        if check_source_grounding:
            ungrounded = ungrounded_verified_tags(text, grounding_corpus)
            if ungrounded:
                return (
                    "source_grounding",
                    ungrounded,
                    format_source_grounding_steer(ungrounded),
                )
        return "", [], ""

    if evidence_tag_whitelist is not None or check_source_grounding:
        guard, bad_tags, steer = _guard_issues(speech)
        if guard:
            logger.info(
                "debate.speech.evidence_guard_rework",
                run_id=run_id,
                guard=guard,
                tags=bad_tags,
            )
            sink.emit(run_output_reset(run_id, agent_id, "finish_guard"))
            if streamed_content is not None:
                streamed_content.clear()
            speech, retry_reasoning, retry_usage = await _stream_draft(
                llm=llm,
                profile=profile,
                turn_model=turn_model,
                draft_system=draft_system,
                draft_brief=draft_brief,
                evidence_notes=notes,
                guard_steer=steer,
                on_content=_on_draft_content,
                on_reasoning=lambda d: sink.emit(
                    run_reasoning_delta(run_id, agent_id, d)
                ),
            )
            total_usage = total_usage + retry_usage
            total_rounds += 1
            if retry_reasoning:
                total_reasoning_parts.append(retry_reasoning)
            still_guard, still_tags, _ = _guard_issues(speech)
            if still_guard:
                logger.warning(
                    "debate.speech.evidence_guard_pass_through",
                    run_id=run_id,
                    guard=still_guard,
                    tags=still_tags,
                )

    if usage_sink is not None:
        usage_sink.clear()
        usage_sink.append(total_usage)

    messages.append(LLMMessage(role="assistant", content=speech))
    return speech, "".join(total_reasoning_parts), total_usage, total_rounds


async def _stream_draft(
    *,
    llm: LLMProvider,
    profile: ProfileParams,
    turn_model: str,
    draft_system: str,
    draft_brief: str,
    evidence_notes: str,
    on_content: Callable[[str], None],
    on_reasoning: Callable[[str], None],
    guard_steer: str = "",
) -> tuple[str, str, TokenUsage]:
    """无工具、干净上下文的成稿流式调用。"""
    draft_messages = [
        LLMMessage(role="system", content=draft_system),
        LLMMessage(
            role="user",
            content=build_draft_user(
                draft_brief, evidence_notes, guard_steer=guard_steer
            ),
        ),
    ]
    request = build_request(
        profile,
        draft_messages,
        tools=None,
        tool_choice="none",
        model=turn_model,
    )
    # stream_llm_round 类型标注 OpenAICompatibleProvider；运行时协议兼容。
    streamed = await stream_llm_round(
        llm,  # type: ignore[arg-type]
        request,
        on_content,
        on_reasoning,
        on_tool_progress=None,
        on_reset=None,
    )
    usage = streamed.usage or TokenUsage()
    return (streamed.content or "").strip(), streamed.reasoning or "", usage
