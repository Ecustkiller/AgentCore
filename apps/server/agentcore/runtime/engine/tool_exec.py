"""Parallel tool execution for one ReAct round."""

import asyncio
import json
import time
from dataclasses import replace
from typing import Any

from agentcore.core.logging import get_logger
from agentcore.core.types import ToolEffect
from agentcore.llm.provider.protocol import LLMMessage, ToolCall
from agentcore.runtime.approvals import ApprovalDecision, ApprovalGate, tool_call_requires_approval
from agentcore.runtime.citations import annotate_tool_citations, merge_citations
from agentcore.runtime.events import (
    EventSink,
    tool_use_end,
    tool_use_progress,
    tool_use_start,
)
from agentcore.runtime.facts import ToolCallFact, record_turn_fact
from agentcore.runtime.loop_controller import ToolAttempt, fingerprint_tool_call
from agentcore.tools.protocol import ToolContext, ToolResult
from agentcore.tools.registry import ToolRegistry

from .constants import MAX_PARALLEL_TOOLS
from .timeout import resolve_tool_timeout

logger = get_logger(__name__)


async def execute_tools(
    tool_calls: list[ToolCall],
    registry: ToolRegistry,
    context: ToolContext,
    sink: EventSink,
    *,
    approval_gate: ApprovalGate | None = None,
    citation_sink: list[dict[str, Any]] | None = None,
    annotate_citations: bool = True,
    run_id: str = "",
) -> tuple[list[LLMMessage], ToolResult | None, list[ToolAttempt]]:
    """Execute tool calls (parallel, capped).

    Returns ``(tool_messages, terminal, attempts)`` where ``terminal`` is the
    chosen terminal-effect ToolResult (a tool that already produced the turn's
    final answer — handoff / ask_user-stop — or a SUSPEND pause) or ``None``, and
    ``attempts`` carries the per-call fingerprint + success used by convergence
    governance to detect mechanical loops. When multiple terminals appear in one
    round, SUSPEND wins (durable pause must not lose to call-order luck) and a
    warning is logged; normal agent toolsets never hold both classes.

    When ``citation_sink`` is provided, web sources surfaced by successful research
    tools are merged into it (arrival order, deduped, capped). With
    ``annotate_citations`` (CEO chat path) each source's assigned canonical number
    is also folded back into that tool message's model-facing output (A2); merge
    happens in deterministic call order, not completion order, so card numbering is
    reproducible. Workers pass ``annotate_citations=False`` — sources are collected
    but the worker text is left un-numbered (its local numbers would be re-ordered
    when merged into the turn card).
    """

    async def _run_one(
        tc: ToolCall,
    ) -> tuple[LLMMessage, ToolResult | None, ToolAttempt, list[dict[str, Any]]]:
        name = tc.function.name
        fingerprint = fingerprint_tool_call(name, tc.function.arguments or "")
        try:
            args = json.loads(tc.function.arguments) if tc.function.arguments else {}
        except json.JSONDecodeError:
            args = {}

        sink.emit(tool_use_start(tc.id, name, args, run_id=run_id))
        logger.debug("tool.execute_start", tool=name)

        tool = registry.get_optional(name)
        if tool is None:
            error_msg = f"Tool '{name}' not found"
            sink.emit(tool_use_end(tc.id, name, success=False, output=error_msg, run_id=run_id))
            logger.info("tool.execute_end", tool=name, status="not_found", duration_ms=0)
            return (
                LLMMessage(role="tool", content=error_msg, tool_call_id=tc.id),
                None,
                ToolAttempt(fingerprint, name, success=False),
                [],
            )

        if approval_gate is not None and tool_call_requires_approval(
            name, tool.schema.approval, args
        ):
            from agentcore.runtime.sandbox_approval import execution_tool_auto_passes

            if execution_tool_auto_passes(context.backend, name):
                logger.info("approval.sandbox_auto_pass", tool=name)
            else:
                decision = await approval_gate.authorize(
                    tool_name=name,
                    tool_call_id=tc.id,
                    arguments=args,
                    execution_id=context.execution_id,
                )
                if decision is ApprovalDecision.DENY:
                    # Denial is a governance signal (user refuse / timeout), not an execution
                    # failure — mark policy_failure so the run-scoped circuit breaker ignores it.
                    denial = (
                        f"工具 '{name}' 未获用户授权，该操作未执行。"
                        "请改用其他方案或询问如何继续，不要再调用此工具。"
                    )
                    sink.emit(
                        tool_use_end(tc.id, name, success=False, output=denial, run_id=run_id)
                    )
                    logger.info("tool.execute_end", tool=name, status="denied", duration_ms=0)
                    return (
                        LLMMessage(role="tool", content=denial, tool_call_id=tc.id),
                        None,
                        ToolAttempt(fingerprint, name, success=False, policy_failure=True),
                        [],
                    )

        # 工具执行阶段进度 (联网搜索前端展示优化): inject a per-call phase callback so a
        # long-running tool (web_search) can report a coarse EXECUTION phase mid-flight. The
        # executor owns event shape (引擎纯化) — the tool passes only a phase token; we close
        # over this call's id/name/run_id and emit the transport-only ``tool_use_progress``.
        def _emit_phase(phase: str) -> None:
            sink.emit(tool_use_progress(tc.id, name, phase, run_id=run_id))

        def _emit_progress(phase: str, data: dict[str, Any] | None = None) -> None:
            sink.emit(tool_use_progress(tc.id, name, phase, run_id=run_id, extra=data))

        ctx = replace(context, on_phase=_emit_phase, on_progress=_emit_progress)

        started = time.monotonic()
        timeout = resolve_tool_timeout(tool.schema, args)
        try:
            if timeout is None:
                result = await tool.execute(args, ctx)
            else:
                result = await asyncio.wait_for(tool.execute(args, ctx), timeout)
        except TimeoutError:
            # B1 backstop: the call blew its ceiling. wait_for has already cancelled
            # the tool coroutine (a cancel-safe tool releases its side effects in
            # turn — e.g. the sandbox kills its subprocess); surface a model-facing
            # error so the loop adapts instead of hanging, and count it as a failed
            # attempt so a tool that keeps timing out trips convergence governance.
            duration_ms = int((time.monotonic() - started) * 1000)
            timeout_msg = (
                f"工具 '{name}' 执行超过 {timeout:.0f}s 仍未完成，已中止。"
                "请改用更快的方式、缩小处理范围，或换一种方案，不要原样重试。"
            )
            sink.emit(tool_use_end(tc.id, name, success=False, output=timeout_msg, run_id=run_id))
            logger.warning("tool.execute_end", tool=name, status="timeout", duration_ms=duration_ms)
            return (
                LLMMessage(role="tool", content=timeout_msg, tool_call_id=tc.id),
                None,
                ToolAttempt(fingerprint, name, success=False),
                [],
            )
        except Exception as e:
            # Per-tool exception firewall (audit/05 P2-1): a crash in one parallel call
            # must not cancel its siblings via asyncio.gather. Convert to a failed tool
            # result so the loop can adapt; SUSPEND terminals are unaffected (they return
            # normally, never raise).
            duration_ms = int((time.monotonic() - started) * 1000)
            error_msg = (
                f"工具 '{name}' 执行时发生内部错误：{e}。"
                "请调整方案或换一种方式，不要原样重试。"
            )
            sink.emit(tool_use_end(tc.id, name, success=False, output=error_msg, run_id=run_id))
            logger.exception(
                "tool.execute_end",
                tool=name,
                status="crash",
                duration_ms=duration_ms,
            )
            return (
                LLMMessage(role="tool", content=error_msg, tool_call_id=tc.id),
                None,
                ToolAttempt(fingerprint, name, success=False),
                [],
            )
        result.tool_call_id = tc.id

        if result.success:
            output = result.output
        else:
            # Surface BOTH the terse error summary AND any diagnostic output
            # (stdout/stderr for code_execute) so the model can self-correct
            # instead of debugging blind: many tools put the real reason in
            # ``output``, not the short ``error`` (e.g. code_execute's error is
            # just "退出码 N" while the traceback / "command not found" lives in
            # output). Either may be empty; join the non-empty parts.
            output = (
                "\n".join(
                    p for p in ((result.error or "").strip(), (result.output or "").strip()) if p
                )
                or "Unknown error"
            )
        # 挂起即收口: a SUSPEND terminal already persisted its *_required card in the
        # pause snapshot. Emitting a durable tool_use_end here would append a fact that
        # diverges snapshot vs DB (and the call stays PENDING — no tool_call fact either).
        # Live UI already has the interaction card; skip the end event entirely.
        if result.effect is not ToolEffect.SUSPEND:
            sink.emit(
                tool_use_end(
                    tc.id,
                    name,
                    success=result.success,
                    output=output,
                    display=result.display,
                    run_id=run_id,
                )
            )
        logger.info(
            "tool.execute_end",
            tool=name,
            status="ok" if result.success else "error",
            duration_ms=int((time.monotonic() - started) * 1000),
        )

        citations = result.citations if (result.success and result.citations) else []
        message = LLMMessage(role="tool", content=output, tool_call_id=tc.id)
        policy_failure = bool(result.metadata.get("policy_failure"))
        return (
            message,
            (result if result.is_terminal else None),
            ToolAttempt(fingerprint, name, success=result.success, policy_failure=policy_failure),
            citations,
        )

    sem = asyncio.Semaphore(MAX_PARALLEL_TOOLS)

    async def _bounded(
        tc: ToolCall,
    ) -> tuple[LLMMessage, ToolResult | None, ToolAttempt, list[dict[str, Any]]]:
        async with sem:
            return await _run_one(tc)

    quads = await asyncio.gather(*[_bounded(tc) for tc in tool_calls])

    # 挂起即收口 (②): a SUSPEND terminal leaves its call PENDING — the suspended tool_call
    # gets NO result message AND NO §8.3 tool_call fact (recorded below), so the resumed
    # window ends exactly at the assistant (the fold reads the missing result as「still
    # pending」). This reproduces the shape the old blocking pause produced by never
    # returning from ``execute``. INTERACT / HANDOFF differ: they DID produce the turn's
    # answer, so they keep their tool message + fact like any completed call.
    def _suspends(t: ToolResult | None) -> bool:
        return t is not None and t.effect is ToolEffect.SUSPEND

    messages = [m for m, t, _, _ in quads if not _suspends(t)]
    # Terminal selection: prefer SUSPEND over HANDOFF/INTERACT when a round somehow
    # yields multiple terminals (defense — normal agent toolsets never hold both).
    # A durable pause must not be overridden by call-order luck with a non-SUSPEND
    # terminal in the same gather batch. Warn when more than one terminal appears.
    terminals = [t for _, t, _, _ in quads if t is not None]
    if len(terminals) > 1:
        logger.warning(
            "tool.multi_terminal",
            count=len(terminals),
            effects=[t.effect.value for t in terminals],
        )
    terminal = next((t for t in terminals if t.effect is ToolEffect.SUSPEND), None)
    if terminal is None and terminals:
        terminal = terminals[0]
    attempts = [a for _, _, a, _ in quads]

    # Merge web sources into the sink in deterministic call order (not completion
    # order) so card numbering is reproducible. With annotate_citations (CEO chat
    # path) the assigned canonical number (= source-card index) is also folded into
    # each tool message's model-facing output so the model cites a number that
    # lines up with the card (A2). Workers collect-only (annotate_citations=False):
    # their sources still reach the turn card via the executor → DelegateTool →
    # pipeline, but the worker text stays un-numbered.
    if citation_sink is not None:
        for message, _terminal, _attempt, message_citations in quads:
            if not message_citations:
                continue
            numbers = merge_citations(citation_sink, message_citations)
            if annotate_citations:
                message.content = annotate_tool_citations(
                    message.content or "", message_citations, numbers
                )

    # 执行级事件溯源 (§8.3 / Phase 2 边界①): record each completed call's FINAL
    # model-facing result as a tool_call fact — captured HERE, after the citation
    # annotation above, so it is byte-for-byte what the next round's window carried (the
    # forwarded tool_use_end fires inside _run_one with the pre-annotation text). The
    # window fold reads tool results from these facts. ``tool_calls`` is positionally
    # aligned with ``quads`` (asyncio.gather preserves order), so zip pairs each result
    # to its issuing call. A SUSPEND call is skipped (挂起即收口 ②): recording its fact
    # would inject a phantom result into the resumed window — matching the old blocking
    # pause, where ``gather`` never returned so no fact was recorded for the parked call.
    for tc, (message, terminal_q, attempt, _citations) in zip(tool_calls, quads, strict=False):
        if _suspends(terminal_q):
            continue
        record_turn_fact(
            ToolCallFact(
                run_id=run_id,
                tool_call_id=message.tool_call_id or tc.id,
                name=tc.function.name,
                arguments=tc.function.arguments or "",
                result=message.content or "",
                success=attempt.success,
            ).to_fact()
        )

    return messages, terminal, attempts
