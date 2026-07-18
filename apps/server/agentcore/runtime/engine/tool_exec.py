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
from agentcore.runtime.citations import (
    annotate_ledger_ids,
    annotate_tool_citations,
    merge_citations,
    normalize_citation_url,
)
from agentcore.runtime.evidence_ledger import EvidenceLedgerCore
from agentcore.runtime.events import (
    EventSink,
    tool_use_end,
    tool_use_progress,
    tool_use_start,
)
from agentcore.runtime.facts import ToolCallFact, record_turn_fact
from agentcore.runtime.loop_controller import ToolAttempt, fingerprint_tool_call
from agentcore.runtime.ledger_channel import emit_ledger_delta
from agentcore.tools.protocol import ToolContext, ToolResult
from agentcore.tools.registry import ToolRegistry

from .constants import MAX_PARALLEL_TOOLS
from .timeout import resolve_tool_timeout

logger = get_logger(__name__)

# Marker in tool_use_start.arguments when JSON parse failed — must not look like a
# successfully parsed empty object ``{}`` (journal / UI 假象).
_ARGS_PARSE_FAILED_MARKER: dict[str, Any] = {"__args_parse_failed__": True}


def _format_args_parse_error(tool_name: str, raw: str, exc: json.JSONDecodeError) -> str:
    """Model-facing Chinese error for illegal tool-call arguments JSON."""
    pos = exc.pos if isinstance(exc.pos, int) else 0
    # Window around the failure so the model can spot unescaped quotes without a full dump.
    left = max(0, pos - 24)
    right = min(len(raw), pos + 24)
    snippet = raw[left:right].replace("\n", "\\n").replace("\r", "\\r")
    if left > 0:
        snippet = "…" + snippet
    if right < len(raw):
        snippet = snippet + "…"
    detail = (exc.msg or "JSON decode error").strip()
    return (
        f"工具 '{tool_name}' 的参数不是合法 JSON（{detail}；失败位置 {pos}，附近片段："
        f"{snippet}）。请修复转义（尤其是字符串内的引号）后，原样重发全部参数；"
        "禁止改写、缩短或删减内容。"
    )


async def execute_tools(
    tool_calls: list[ToolCall],
    registry: ToolRegistry,
    context: ToolContext,
    sink: EventSink,
    *,
    approval_gate: ApprovalGate | None = None,
    citation_sink: list[dict[str, Any]] | None = None,
    annotate_citations: bool = True,
    turn_evidence_ledger: EvidenceLedgerCore | None = None,
    ledger_registrant: str = "",
    run_id: str = "",
    role: str = "",
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
    tools are merged into it (arrival order, deduped, capped) — **池语义不变**。
    When ``turn_evidence_ledger`` is set, the same hits are also registered into the
    turn-shared ledger (except ``blocked``); tool messages get ``#rN=url`` stable-id
    annotation for both CEO and workers (引用即出处 P1). Without a ledger,
    ``annotate_citations`` keeps the legacy ``[n]=url`` CEO path.

    Display/trace split for ``role == "captain"``: SSE tool events omit ``run_id``
    so the UI renders them as turn-level inline steps (same as captain
    ``content_delta``); ``ToolCallFact`` and circuit-breaker audit still keep
    ``run_id`` for §8.3 fold / audit. Workers keep ``run_id`` on SSE too.
    """
    # Captain self-tools: inline timeline (no run_id on wire); facts/audit keep run_id.
    event_run_id = "" if role == "captain" else run_id

    async def _run_one(
        tc: ToolCall,
    ) -> tuple[LLMMessage, ToolResult | None, ToolAttempt, list[dict[str, Any]]]:
        name = tc.function.name
        raw_args = tc.function.arguments or ""
        fingerprint = fingerprint_tool_call(name, raw_args)
        try:
            args = json.loads(raw_args) if raw_args else {}
        except json.JSONDecodeError as exc:
            error_msg = _format_args_parse_error(name, raw_args, exc)
            # Honest wire pair: marker args (not ``{}``) + error end — never run the tool.
            sink.emit(
                tool_use_start(
                    tc.id, name, dict(_ARGS_PARSE_FAILED_MARKER), run_id=event_run_id
                )
            )
            sink.emit(
                tool_use_end(
                    tc.id, name, success=False, output=error_msg, run_id=event_run_id
                )
            )
            logger.info(
                "tool.args_parse_failed",
                tool=name,
                tool_call_id=tc.id,
                pos=exc.pos,
                msg=exc.msg,
                args_preview=raw_args[:200],
            )
            logger.info(
                "tool.execute_end",
                tool=name,
                status="args_parse_failed",
                duration_ms=0,
            )
            return (
                LLMMessage(role="tool", content=error_msg, tool_call_id=tc.id),
                None,
                ToolAttempt(fingerprint, name, success=False, parse_failure=True),
                [],
            )

        sink.emit(tool_use_start(tc.id, name, args, run_id=event_run_id))
        logger.debug("tool.execute_start", tool=name)

        tool = registry.get_optional(name)
        if tool is None:
            error_msg = f"Tool '{name}' not found"
            sink.emit(
                tool_use_end(tc.id, name, success=False, output=error_msg, run_id=event_run_id)
            )
            logger.info("tool.execute_end", tool=name, status="not_found", duration_ms=0)
            return (
                LLMMessage(role="tool", content=error_msg, tool_call_id=tc.id),
                None,
                ToolAttempt(fingerprint, name, success=False),
                [],
            )

        # P3 safety circuit breaker — last-line heuristic (not a security boundary).
        # full_trust / kickoff / turn grants never override FORCE_APPROVAL or DENY.
        from agentcore.runtime.safety_breaker import BreakerVerdict, evaluate_tool_call

        breaker = evaluate_tool_call(name, args)
        if breaker is not None and breaker.verdict is BreakerVerdict.DENY:
            from agentcore.runtime.audit.hooks import on_circuit_breaker

            on_circuit_breaker(
                tool_name=name,
                tool_call_id=tc.id,
                rule_id=breaker.rule_id,
                verdict=breaker.verdict.value,
                reason=breaker.reason,
                run_id=run_id or None,
            )
            denial = (
                f"工具 '{name}' 被安全熔断拒绝：{breaker.reason}"
                "请改用其他方案，不要原样重试该路径。"
            )
            sink.emit(
                tool_use_end(tc.id, name, success=False, output=denial, run_id=event_run_id)
            )
            logger.info(
                "tool.execute_end",
                tool=name,
                status="circuit_breaker_deny",
                rule_id=breaker.rule_id,
                duration_ms=0,
            )
            return (
                LLMMessage(role="tool", content=denial, tool_call_id=tc.id),
                None,
                ToolAttempt(fingerprint, name, success=False, policy_failure=True),
                [],
            )

        force_breaker = (
            breaker is not None and breaker.verdict is BreakerVerdict.FORCE_APPROVAL
        )
        if force_breaker:
            from agentcore.runtime.audit.hooks import on_circuit_breaker

            on_circuit_breaker(
                tool_name=name,
                tool_call_id=tc.id,
                rule_id=breaker.rule_id,
                verdict=breaker.verdict.value,
                reason=breaker.reason,
                run_id=run_id or None,
            )
            # Surface a preview-only hint on the approval card (arguments are already
            # truncated for SSE; tools execute the original ``args`` unchanged).
            args_for_gate = {
                **args,
                "circuit_breaker_hint": breaker.reason,
            }
        else:
            args_for_gate = args

        needs_approval = force_breaker or (
            approval_gate is not None
            and tool_call_requires_approval(name, tool.schema.approval, args)
        )
        if needs_approval:
            from agentcore.runtime.sandbox_approval import execution_tool_auto_passes

            if approval_gate is None:
                # Forced destructive shape but no human gate available — fail closed.
                denial = (
                    f"工具 '{name}' 触发安全熔断且当前路径无法人工确认，已拒绝执行。"
                    f"{breaker.reason if breaker else ''}"
                    "请改用其他方案。"
                )
                sink.emit(
                    tool_use_end(
                        tc.id, name, success=False, output=denial, run_id=event_run_id
                    )
                )
                logger.info(
                    "tool.execute_end",
                    tool=name,
                    status="circuit_breaker_no_gate",
                    duration_ms=0,
                )
                return (
                    LLMMessage(role="tool", content=denial, tool_call_id=tc.id),
                    None,
                    ToolAttempt(fingerprint, name, success=False, policy_failure=True),
                    [],
                )

            auto_pass = (not force_breaker) and execution_tool_auto_passes(
                context.backend, name, autonomy_policy=approval_gate.autonomy_policy
            )
            if auto_pass:
                logger.info("approval.sandbox_auto_pass", tool=name)
            else:
                decision = await approval_gate.authorize(
                    tool_name=name,
                    tool_call_id=tc.id,
                    arguments=args_for_gate,
                    execution_id=context.execution_id,
                    force=force_breaker,
                )
                if decision is ApprovalDecision.DENY:
                    # Denial is a governance signal (user refuse / timeout), not an execution
                    # failure — mark policy_failure so the run-scoped circuit breaker ignores it.
                    denial = (
                        f"工具 '{name}' 未获用户授权，该操作未执行。"
                        "请改用其他方案或询问如何继续，不要再调用此工具。"
                    )
                    sink.emit(
                        tool_use_end(
                            tc.id, name, success=False, output=denial, run_id=event_run_id
                        )
                    )
                    logger.info("tool.execute_end", tool=name, status="denied", duration_ms=0)
                    return (
                        LLMMessage(role="tool", content=denial, tool_call_id=tc.id),
                        None,
                        ToolAttempt(fingerprint, name, success=False, policy_failure=True),
                        [],
                    )

        # 检索预算 (提案 A1): reserve a per-run slot immediately before execute so
        # approval / breaker denials never consume budget. Orthogonal to
        # LoopController.investigation_calls / team_gate.
        from agentcore.runtime.runs.retrieval_budget import (
            RETRIEVAL_TOOL_NAMES,
            budget_exhausted_output,
            charges_retrieval_budget,
        )

        budget_state = context.retrieval_budget
        budget_reserved = False
        if name in RETRIEVAL_TOOL_NAMES and budget_state is not None:
            if not await budget_state.try_reserve():
                exhausted = budget_exhausted_output()
                sink.emit(
                    tool_use_end(
                        tc.id, name, success=False, output=exhausted, run_id=event_run_id
                    )
                )
                logger.info(
                    "tool.execute_end",
                    tool=name,
                    status="retrieval_budget_exhausted",
                    duration_ms=0,
                    retrieval_budget_limit=budget_state.limit,
                    retrieval_budget_used=budget_state.used,
                )
                return (
                    LLMMessage(role="tool", content=exhausted, tool_call_id=tc.id),
                    None,
                    ToolAttempt(fingerprint, name, success=False),
                    [],
                )
            budget_reserved = True

        # 工具执行阶段进度 (联网搜索前端展示优化): inject a per-call phase callback so a
        # long-running tool (web_search) can report a coarse EXECUTION phase mid-flight. The
        # executor owns event shape (引擎纯化) — the tool passes only a phase token; we close
        # over this call's id/name/event_run_id and emit the transport-only ``tool_use_progress``.
        def _emit_phase(phase: str) -> None:
            sink.emit(tool_use_progress(tc.id, name, phase, run_id=event_run_id))

        def _emit_progress(phase: str, data: dict[str, Any] | None = None) -> None:
            sink.emit(tool_use_progress(tc.id, name, phase, run_id=event_run_id, extra=data))

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
            if budget_reserved and budget_state is not None:
                await budget_state.refund()
            duration_ms = int((time.monotonic() - started) * 1000)
            timeout_msg = (
                f"工具 '{name}' 执行超过 {timeout:.0f}s 仍未完成，已中止。"
                "请改用更快的方式、缩小处理范围，或换一种方案，不要原样重试。"
            )
            sink.emit(
                tool_use_end(
                    tc.id, name, success=False, output=timeout_msg, run_id=event_run_id
                )
            )
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
            if budget_reserved and budget_state is not None:
                await budget_state.refund()
            duration_ms = int((time.monotonic() - started) * 1000)
            error_msg = (
                f"工具 '{name}' 执行时发生内部错误：{e}。"
                "请调整方案或换一种方式，不要原样重试。"
            )
            sink.emit(
                tool_use_end(tc.id, name, success=False, output=error_msg, run_id=event_run_id)
            )
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

        # 缓存命中 / A3 拒绝等不计预算：reserved slot refunded when not charged.
        if budget_reserved and budget_state is not None and not charges_retrieval_budget(result):
            await budget_state.refund()

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
                    run_id=event_run_id,
                )
            )
        # 检索观测：web_search 把 query / hosts 放进 metadata，转发到 execute_end
        # 以便从统一工具结束事件还原「搜了什么 / 命中哪些域」。
        end_fields: dict[str, Any] = {
            "tool": name,
            "status": "ok" if result.success else "error",
            "duration_ms": int((time.monotonic() - started) * 1000),
        }
        meta = result.metadata or {}
        if isinstance(meta.get("query"), str) and meta["query"]:
            end_fields["query"] = meta["query"]
        if isinstance(meta.get("hosts"), list):
            end_fields["hosts"] = meta["hosts"]
        if isinstance(meta.get("blocked_hosts"), list) and meta["blocked_hosts"]:
            end_fields["blocked_hosts"] = meta["blocked_hosts"]
        logger.info("tool.execute_end", **end_fields)

        citations = result.citations if (result.success and result.citations) else []
        message = LLMMessage(role="tool", content=output, tool_call_id=tc.id)
        policy_failure = bool(result.metadata.get("policy_failure"))
        return (
            message,
            (result if result.is_terminal else None),
            ToolAttempt(
                fingerprint,
                name,
                success=result.success,
                policy_failure=policy_failure,
                meta=dict(result.metadata) if result.metadata else {},
            ),
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

    # Merge web sources into mid-turn sink (deterministic call order) for pause /
    # legacy ``[n]``；台账登记 ``#rN`` 并 annotate。P2：用户可见卡由 settle 按
    # ``cited_ids`` 投影，不在此发射 ``citations_event``。
    if citation_sink is not None or turn_evidence_ledger is not None:
        for message, _terminal, _attempt, message_citations in quads:
            if not message_citations:
                continue
            if citation_sink is not None:
                numbers = merge_citations(citation_sink, message_citations)
            else:
                numbers = {}
            if turn_evidence_ledger is not None and ledger_registrant:
                id_map = await _register_message_citations(
                    turn_evidence_ledger,
                    message_citations,
                    registrant=ledger_registrant,
                )
                message.content = annotate_ledger_ids(
                    message.content or "", message_citations, id_map
                )
            elif annotate_citations:
                message.content = annotate_tool_citations(
                    message.content or "", message_citations, numbers
                )
        # Live 台账增量：本轮登记后 drain → 独立通道（不占 citations_event）。
        if turn_evidence_ledger is not None:
            emit_ledger_delta(sink, turn_evidence_ledger)

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


async def _register_message_citations(
    ledger: EvidenceLedgerCore,
    citations: list[dict[str, Any]],
    *,
    registrant: str,
) -> dict[str, str]:
    """向回合共享台账登记本条工具结果的来源；返回 ``{归一化url: #rN}``。"""
    id_map: dict[str, str] = {}
    for c in citations:
        eid = await ledger.register_citation(c, registrant=registrant)
        if eid is None:
            continue
        key = normalize_citation_url(str(c.get("url") or ""))
        if key:
            id_map[key] = eid
    return id_map
