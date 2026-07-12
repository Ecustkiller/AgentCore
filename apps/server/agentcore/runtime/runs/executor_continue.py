"""Split from executor.py — see executor.py module docstring."""

from __future__ import annotations

import time
from dataclasses import asdict, replace

from agentcore.core.log_context import log_context
from agentcore.core.logging import get_logger
from agentcore.llm.pricing import calculate_cost
from agentcore.llm.profiles import TurnProfiles as ProfileSet
from agentcore.llm.profiles import default_turn_profiles as default_profile_set
from agentcore.llm.provider.protocol import LLMProvider, TokenUsage
from agentcore.runtime.approvals import ApprovalGate
from agentcore.runtime.events import (
    EventSink,
    run_completed,
    run_context,
    run_failed,
    run_started,
)
from agentcore.runtime.facts import MessageFinalFact, record_turn_fact
from agentcore.runtime.runs.contract import check_contract
from agentcore.runtime.runs.executor_context import _context_block_payloads
from agentcore.runtime.runs.executor_shared import (
    _continuation_message,
    _priced_failure,
    _react_and_capture,
)
from agentcore.runtime.runs.serialize import debrief_from_transcript, files_touched_from_transcript
from agentcore.runtime.runs.session import RunSession
from agentcore.runtime.runs.types import ContextBlock, RunPhase, RunState
from agentcore.tools.protocol import ToolContext
from agentcore.tools.registry import ToolRegistry

logger = get_logger(__name__)


async def continue_run(
    *,
    session: RunSession,
    feedback: str,
    continuation_run_id: str,
    llm: LLMProvider,
    tools: ToolRegistry,
    sink: EventSink,
    base_tool_context: ToolContext,
    execution_id: str,
    profile_set: ProfileSet | None = None,
    approval_gate: ApprovalGate | None = None,
    round_no: int = 0,
    context_blocks: list[ContextBlock] | None = None,
    parent_run_id: str | None = None,
) -> RunState:
    """续写 a saved worker session under the continuation's log scope.

    ``continues_run_id`` on the wire is always the session root (``session.run_id``);
    ``parent_run_id`` is the true delegation parent (captain / moderator), not the
    continued run. ``round_no`` (辩论逐轮, 0 = ordinary 续干) rides ``run_started``
    so every fold reads 第几轮 from the wire.

    ``context_blocks`` surface on ``run_context`` (用户看到的 == 结构化展示)；LLM 侧
    吃的是 ``feedback`` 经统一续干模板追加进 transcript 的内容。
    """
    with log_context(
        run_id=continuation_run_id,
        agent_id=continuation_run_id,
        depth=session.spec.depth,
        cost_role="member",
        persona=(session.spec.role or "").strip() or None,
        parent_run_id=(
            parent_run_id
            if parent_run_id is not None
            else (session.spec.parent_run_id or None)
        ),
    ):
        return await _continue_run_scoped(
            session=session,
            feedback=feedback,
            continuation_run_id=continuation_run_id,
            llm=llm,
            tools=tools,
            sink=sink,
            base_tool_context=base_tool_context,
            execution_id=execution_id,
            profile_set=profile_set,
            approval_gate=approval_gate,
            round_no=round_no,
            context_blocks=context_blocks,
            parent_run_id=parent_run_id,
        )


async def _continue_run_scoped(
    *,
    session: RunSession,
    feedback: str,
    continuation_run_id: str,
    llm: LLMProvider,
    tools: ToolRegistry,
    sink: EventSink,
    base_tool_context: ToolContext,
    execution_id: str,
    profile_set: ProfileSet | None = None,
    approval_gate: ApprovalGate | None = None,
    round_no: int = 0,
    context_blocks: list[ContextBlock] | None = None,
    parent_run_id: str | None = None,
) -> RunState:
    """续写 a saved worker session: same author, extended transcript, new run id."""
    profiles = profile_set or default_profile_set()
    spec = session.spec
    agent_id = continuation_run_id
    wire_parent = (
        parent_run_id if parent_run_id is not None else session.spec.parent_run_id
    )
    # 星型：continues_run_id 恒指现场根（RunSession 键）。
    sink.emit(
        run_started(
            continuation_run_id,
            agent_id,
            parent_run_id=wire_parent,
            kind=spec.kind,
            continues_run_id=session.run_id,
            stance=spec.stance or None,
            group=spec.group or None,
            round_no=round_no,
        )
    )
    if context_blocks:
        sink.emit(
            run_context(continuation_run_id, agent_id, _context_block_payloads(context_blocks))
        )
    start = time.monotonic()
    inflight: list[TokenUsage] = []
    priced_model: str | None = None
    try:
        pref = (
            spec.model_preference.value
            if hasattr(spec.model_preference, "value")
            else str(spec.model_preference)
        )
        profile = profiles.agent(spec.model_preference)
        priced_model = spec.model or profiles.model_for(f"agent.{pref}")
        tool_ctx = replace(
            base_tool_context,
            run_id=continuation_run_id,
            agent_id=agent_id,
            execution_id=execution_id,
        )
        messages = list(session.transcript)
        messages.append(_continuation_message(feedback))
        citations: list[dict] = []
        content, reasoning, round_usage, round_rounds = await _react_and_capture(
            messages,
            llm=llm,
            tools=tools,
            sink=sink,
            tool_ctx=tool_ctx,
            profile=profile,
            turn_model=priced_model,
            allowed_tools=spec.tools,
            run_id=continuation_run_id,
            agent_id=agent_id,
            citation_sink=citations,
            approval_gate=approval_gate,
            usage_sink=inflight,
        )
        duration_ms = int((time.monotonic() - start) * 1000)
        usage = round_usage.as_dict()
        cost = asdict(calculate_cost(priced_model, round_usage))
        touched_for_gate = files_touched_from_transcript(messages)
        verdict = check_contract(
            content,
            spec.deliverable,
            files_written=len(touched_for_gate),
            debrief=debrief_from_transcript(messages),
            workspace_paths=touched_for_gate,
        )
        record_turn_fact(
            MessageFinalFact(
                run_id=continuation_run_id, content=content, reasoning=reasoning
            ).to_fact()
        )
        debrief = debrief_from_transcript(messages)
        touched = files_touched_from_transcript(messages)
        sink.emit(
            run_completed(
                continuation_run_id,
                agent_id,
                output_summary=(debrief or {}).get("summary", ""),
                duration_ms=duration_ms,
                role="member",
                model=priced_model,
                usage=usage,
                cost=cost,
                debrief=debrief,
                output_files=touched or None,
            )
        )
        return RunState(
            phase=RunPhase.COMPLETED,
            content=content,
            reasoning=reasoning,
            warnings=[] if verdict.ok else list(verdict.failures),
            citations=citations,
            model=priced_model,
            duration_ms=duration_ms,
            rounds=round_rounds,
            files_touched=touched,
            debrief=debrief,
            usage=usage,
            cost=cost,
            transcript=messages,
        )
    except Exception as e:  # noqa: BLE001 — surface any continuation failure to UI/state
        duration_ms = int((time.monotonic() - start) * 1000)
        partial = inflight[0] if inflight else TokenUsage()
        logger.error(
            "run.continuation_failed", run_id=continuation_run_id, error=str(e), exc_info=True
        )
        sink.emit(run_failed(continuation_run_id, agent_id, str(e)))
        return _priced_failure(
            str(e),
            model=priced_model,
            usage=partial,
            rounds=0,
            duration_ms=duration_ms,
        )
