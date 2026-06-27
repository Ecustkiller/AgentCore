"""Split from executor.py — see executor.py module docstring."""

from __future__ import annotations

import time
from dataclasses import asdict, replace

from agentcore.core.log_context import log_context
from agentcore.core.logging import get_logger
from agentcore.llm.config import apply_overrides
from agentcore.llm.modes import ProfileSet, default_profile_set
from agentcore.llm.pricing import calculate_cost
from agentcore.llm.protocol import LLMProvider, TokenUsage
from agentcore.runtime.approvals import ApprovalGate
from agentcore.runtime.events import EventSink, run_completed, run_failed, run_started
from agentcore.runtime.facts import MessageFinalFact, record_turn_fact
from agentcore.runtime.runs.contract import check_contract
from agentcore.runtime.runs.executor_shared import (
    _priced_failure,
    _react_and_capture,
    _revision_message,
)
from agentcore.runtime.runs.serialize import debrief_from_content, files_touched_from_transcript
from agentcore.runtime.runs.session import RunSession
from agentcore.runtime.runs.types import RunPhase, RunState
from agentcore.runtime.workspace import summarize
from agentcore.tools.protocol import ToolContext
from agentcore.tools.registry import ToolRegistry

logger = get_logger(__name__)


async def continue_run(
    *,
    session: RunSession,
    feedback: str,
    revision_run_id: str,
    llm: LLMProvider,
    tools: ToolRegistry,
    sink: EventSink,
    base_tool_context: ToolContext,
    execution_id: str,
    profile_set: ProfileSet | None = None,
    approval_gate: ApprovalGate | None = None,
) -> RunState:
    """续写 a saved worker session under the revision's log scope: binds
    run_id/agent_id/depth so all of the 热修's logs (tool.execute_end, run.*, llm.*)
    split by worker like any delegated run. Delegates to :func:`_continue_run_scoped`
    (see it for the full behavior); the scope auto-clears and is task-local."""
    with log_context(
        run_id=revision_run_id,
        agent_id=revision_run_id,
        depth=session.spec.depth,
    ):
        return await _continue_run_scoped(
            session=session,
            feedback=feedback,
            revision_run_id=revision_run_id,
            llm=llm,
            tools=tools,
            sink=sink,
            base_tool_context=base_tool_context,
            execution_id=execution_id,
            profile_set=profile_set,
            approval_gate=approval_gate,
        )


async def _continue_run_scoped(
    *,
    session: RunSession,
    feedback: str,
    revision_run_id: str,
    llm: LLMProvider,
    tools: ToolRegistry,
    sink: EventSink,
    base_tool_context: ToolContext,
    execution_id: str,
    profile_set: ProfileSet | None = None,
    approval_gate: ApprovalGate | None = None,
) -> RunState:
    """续写 a saved worker session: recall the SAME author to revise its own draft.

    Appends the CEO's revision instruction to the worker's preserved transcript and
    re-runs the ReAct loop under the original spec's profile / allowed tools — the
    乙 热修 path (faster, cheaper, keeps the original train of thought) vs. re-
    delegating a cold new worker (甲). Emits ``run_*`` events under
    ``revision_run_id`` parented to the original run (the graph's「修订」child node,
    P-2 版本链), prices the continuation once onto the returned RunState, and
    carries the EXTENDED transcript so the next revision continues from here. The
    contract gate is re-checked as warnings (a revision is content-quality, not a
    hard gate)."""
    profiles = profile_set or default_profile_set()
    spec = session.spec
    agent_id = revision_run_id
    # Version number for the graph's「修订 vN」child node (P4 版本链): the original is
    # v1, so the first revision (recall_count 0 here, pre-increment) is v2.
    revision = session.recall_count + 2
    sink.emit(
        run_started(
            revision_run_id,
            agent_id,
            parent_run_id=session.run_id,
            kind=spec.kind,
            revision=revision,
        )
    )
    start = time.monotonic()
    # Mirror the continuation's spend so a hard failure still bills it (B-deep 失败
    # 计费); priced_model stays None until the profile resolves (an early setup failure
    # carries no usage to price).
    inflight: list[TokenUsage] = []
    priced_model: str | None = None
    try:
        profile = apply_overrides(
            profiles.agent(spec.model_preference),
            thinking=spec.thinking,
            reasoning_effort=spec.reasoning_effort,
        )
        # 真·多模型辩手：续写沿用首轮 spec 的显式 model 覆写（session.spec 已带），故同一辩手
        # 跨轮恒走同一厂商模型。空 = 按 tier 解析（普通续写，行为不变）。见 _execute_node 同款。
        if spec.model:
            profile = replace(profile, model=spec.model)
        priced_model = profile.model
        tool_ctx = replace(
            base_tool_context,
            run_id=revision_run_id,
            agent_id=agent_id,
            execution_id=execution_id,
        )
        # Continue on a COPY so a failed continuation leaves the stored session
        # intact (the caller only commits the extended transcript on success).
        messages = list(session.transcript)
        messages.append(_revision_message(feedback))
        citations: list[dict] = []
        content, reasoning, round_usage, round_rounds = await _react_and_capture(
            messages,
            llm=llm,
            tools=tools,
            sink=sink,
            tool_ctx=tool_ctx,
            profile=profile,
            allowed_tools=spec.tools,
            run_id=revision_run_id,
            agent_id=agent_id,
            citation_sink=citations,
            approval_gate=approval_gate,
            usage_sink=inflight,
        )
        duration_ms = int((time.monotonic() - start) * 1000)
        usage = round_usage.as_dict()
        cost = asdict(calculate_cost(profile.model, round_usage))
        # files_written counts the whole continued transcript (original draft + this
        # revision), so a requires_files contract isn't spuriously flagged when the
        # recall edits prose around files the first pass already wrote.
        verdict = check_contract(
            content,
            spec.policy.contract,
            files_written=len(files_touched_from_transcript(messages)),
        )
        # 执行级事件溯源 (§18.3): the revised FULL product (content + 思考) under the
        # revision run id, so the version chain's latest output AND thinking are
        # reconstructable from the journal — the reload synthesizes this run node's
        # run_output_delta / run_reasoning_delta from here once the live deltas stop
        # being journaled (deltas 退场).
        record_turn_fact(
            MessageFinalFact(run_id=revision_run_id, content=content, reasoning=reasoning).to_fact()
        )
        sink.emit(
            run_completed(
                revision_run_id,
                agent_id,
                output_summary=summarize(content),
                duration_ms=duration_ms,
                role="member",
                model=profile.model,
                usage=usage,
                cost=cost,
            )
        )
        return RunState(
            phase=RunPhase.COMPLETED,
            content=content,
            reasoning=reasoning,
            warnings=[] if verdict.ok else list(verdict.failures),
            citations=citations,
            model=profile.model,
            duration_ms=duration_ms,
            rounds=round_rounds,
            files_touched=files_touched_from_transcript(messages),
            debrief=debrief_from_content(content),
            usage=usage,
            cost=cost,
            transcript=messages,
        )
    except Exception as e:  # noqa: BLE001 — surface any revision failure to UI/state
        duration_ms = int((time.monotonic() - start) * 1000)
        partial = inflight[0] if inflight else TokenUsage()
        logger.error("run.revise_failed", run_id=revision_run_id, error=str(e), exc_info=True)
        sink.emit(run_failed(revision_run_id, agent_id, str(e)))
        return _priced_failure(
            str(e),
            model=priced_model,
            usage=partial,
            rounds=0,
            duration_ms=duration_ms,
        )
