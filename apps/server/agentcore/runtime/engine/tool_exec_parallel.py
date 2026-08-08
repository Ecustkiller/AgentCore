"""Parallel tool execution + same-round file_read coalesce for one ReAct round."""

from __future__ import annotations

import asyncio
import contextlib
import json
import time
from dataclasses import replace
from typing import Any

from agentcore.core.logging import get_logger
from agentcore.core.types import ToolEffect
from agentcore.llm.provider.protocol import LLMMessage, ToolCall, llm_content_text
from agentcore.runtime.approvals import ApprovalGate
from agentcore.runtime.events import (
    EventSink,
    run_phase,
    tool_use_end,
    tool_use_progress,
    tool_use_start,
)
from agentcore.runtime.evidence_ledger import EvidenceLedgerCore
from agentcore.runtime.facts import ToolCallFact, record_turn_fact
from agentcore.runtime.loop_controller import (
    ERROR_CLASS_PERMANENT,
    ERROR_CLASS_PERMISSION,
    ERROR_CLASS_VALIDATION,
    ToolAttempt,
    fingerprint_tool_call,
)
from agentcore.runtime.tool_deadline import reset_tool_deadline, set_tool_deadline
from agentcore.tools.protocol import ToolContext, ToolResult
from agentcore.tools.registry import ToolRegistry

from .constants import MAX_PARALLEL_TOOLS
from .timeout import resolve_tool_timeout
from .tool_exec_args import (
    _ARGS_PARSE_FAILED_MARKER,
    _FILE_PRODUCT_TOOL_NAMES,
    _attempt_meta_with_landing_path,
    _failed_tool_message,
    _format_args_parse_error,
    _missing_tool_feedback,
    _short_tool_error_reason,
    with_tool_failed_marker,
)
from .tool_exec_citations import apply_round_citation_side_effects
from .tool_exec_gates import _check_safety_and_approval_gates
from .tool_protocol_sanitize import (
    salvage_handoff_raw_arguments,
    sanitize_raw_tool_arguments,
    sanitize_tool_args,
    sanitize_tool_name,
    unwrap_nested_delegate_arguments,
)

logger = get_logger(__name__)


def _file_read_round_coalesce_key(args: dict[str, Any]) -> str | None:
    """Same-round parallel ``file_read`` coalesce key: normalized path only.

    Offset/limit variants still share one underlying read (fan-out); only full
    reads bump ``file_read_counts``. Empty path → no coalesce.
    """
    if not isinstance(args, dict):
        return None
    path = str(args.get("path") or "").strip().replace("\\", "/")
    return path or None


def _clone_tool_result(result: ToolResult, tool_call_id: str) -> ToolResult:
    """Fan-out copy of a shared ``file_read`` result for a sibling tool_call."""
    return replace(
        result,
        tool_call_id=tool_call_id,
        citations=list(result.citations) if result.citations else None,
        metadata=dict(result.metadata) if result.metadata else {},
        display=dict(result.display) if result.display else None,
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
    allowed_tool_names: list[str] | None = None,
) -> tuple[list[LLMMessage], ToolResult | None, list[ToolAttempt]]:
    """Execute tool calls (parallel, capped).

    Returns ``(tool_messages, terminal, attempts)`` where ``terminal`` is the
    chosen terminal-effect ToolResult (a tool that already produced the turn's
    final answer — handoff / ask_user-stop — or a SUSPEND pause) or ``None``, and
    ``attempts`` carries the per-call fingerprint + success used by convergence
    governance to detect mechanical loops. When multiple terminals appear in one
    round, SUSPEND wins (durable pause must not lose to call-order luck) and a
    warning is logged; normal agent toolsets never hold both classes.

    ``allowed_tool_names`` is the run's least-privilege allow-list (``None`` = no
    restriction). Schema offering already filters to this list; this parameter
    **also enforces at execute** so a model cannot land side effects by calling a
    registered tool that was never granted (e.g. debater ``file_write``).

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

    Same-round parallel ``file_read`` calls that share a normalized path execute
    the underlying read once; sibling tool_calls receive fan-out clones (one
    count bump when the shared result is a full read).
    """
    # Captain self-tools: inline timeline (no run_id on wire); facts/audit keep run_id.
    event_run_id = "" if role == "captain" else run_id
    allowed_set = None if allowed_tool_names is None else frozenset(allowed_tool_names)
    # Same-round file_read path coalesce (leader Future → fan-out clones).
    file_read_inflight: dict[str, asyncio.Future[ToolResult]] = {}

    async def _run_one(
        tc: ToolCall,
    ) -> tuple[LLMMessage, ToolResult | None, ToolAttempt, list[dict[str, Any]]]:
        raw_name = tc.function.name or ""
        name = sanitize_tool_name(raw_name)
        # Mutate in place so transcript / debrief harvest see the cleaned name
        # (same ToolCall objects live on the assistant message).
        if name != raw_name:
            tc.function.name = name
            logger.info(
                "tool.name_protocol_sanitized",
                tool_call_id=tc.id,
                raw_name=raw_name[:120],
                cleaned_name=name[:80],
            )
        raw_args = tc.function.arguments or ""
        # Strip vendor/XML protocol residue before parse so hybrid leaks
        # (``{"tasks"><parameter…>``) become retryable JSON when salvageable.
        parse_args = sanitize_raw_tool_arguments(raw_args)
        if parse_args != raw_args:
            with contextlib.suppress(TypeError, ValueError):
                tc.function.arguments = parse_args
            raw_args = parse_args
        fingerprint = fingerprint_tool_call(name, raw_args)
        parse_exc: json.JSONDecodeError | None = None
        try:
            args = json.loads(raw_args) if raw_args else {}
        except json.JSONDecodeError as exc:
            parse_exc = exc
            salvaged = salvage_handoff_raw_arguments(raw_args, tool_name=name or raw_name)
            if salvaged is not None:
                # Guaranteed loadable object by salvage; continue as a normal parse.
                args = json.loads(salvaged)
                parse_exc = None
                logger.info(
                    "tool.args_salvaged",
                    tool=name or raw_name,
                    tool_call_id=tc.id,
                    args_preview=salvaged[:200],
                )
                with contextlib.suppress(TypeError, ValueError):
                    tc.function.arguments = salvaged
                raw_args = salvaged
                fingerprint = fingerprint_tool_call(name, raw_args)
        if parse_exc is not None:
            model_msg, user_msg = _format_args_parse_error(
                name or raw_name, raw_args, parse_exc
            )
            # Honest wire pair: marker args (not ``{}``) + error end — never run the tool.
            # UI/process line gets人话 for write tools; model transcript keeps technical tip.
            sink.emit(
                tool_use_start(
                    tc.id, name or raw_name, dict(_ARGS_PARSE_FAILED_MARKER), run_id=event_run_id
                )
            )
            sink.emit(
                tool_use_end(
                    tc.id,
                    name or raw_name,
                    success=False,
                    output=user_msg,
                    run_id=event_run_id,
                )
            )
            logger.info(
                "tool.args_parse_failed",
                tool=name or raw_name,
                tool_call_id=tc.id,
                pos=parse_exc.pos,
                msg=parse_exc.msg,
                args_preview=raw_args[:200],
            )
            logger.info(
                "tool.execute_end",
                tool=name or raw_name,
                status="args_parse_failed",
                duration_ms=0,
            )
            return (
                _failed_tool_message(tc.id, model_msg),
                None,
                ToolAttempt(
                    fingerprint,
                    name or raw_name,
                    success=False,
                    parse_failure=True,
                    error_summary=model_msg,
                    meta={"error_class": ERROR_CLASS_VALIDATION},
                ),
                [],
            )

        if isinstance(args, dict):
            if name == "delegate":
                unwrapped = unwrap_nested_delegate_arguments(args)
                if unwrapped is not None:
                    logger.info(
                        "tool.delegate_arguments_unwrapped",
                        tool_call_id=tc.id,
                        inner_keys=sorted(unwrapped.keys())[:20],
                        has_tasks=isinstance(unwrapped.get("tasks"), list)
                        and bool(unwrapped.get("tasks")),
                        has_playbook=bool(
                            (
                                isinstance(unwrapped.get("playbook"), str)
                                and str(unwrapped.get("playbook") or "").strip()
                            )
                            or (
                                isinstance(unwrapped.get("playbook_id"), str)
                                and str(unwrapped.get("playbook_id") or "").strip()
                            )
                        ),
                    )
                    args = unwrapped
                    with contextlib.suppress(TypeError, ValueError):
                        tc.function.arguments = json.dumps(args, ensure_ascii=False)
            cleaned_args = sanitize_tool_args(args)
            if cleaned_args != args:
                args = cleaned_args
                with contextlib.suppress(TypeError, ValueError):
                    tc.function.arguments = json.dumps(args, ensure_ascii=False)

        sink.emit(tool_use_start(tc.id, name, args, run_id=event_run_id))
        if event_run_id:
            sink.emit(
                run_phase(
                    event_run_id,
                    getattr(context, "agent_id", "") or event_run_id,
                    "tool",
                    tool_name=name or raw_name or None,
                )
            )

        if allowed_set is not None and name not in allowed_set:
            if name in _FILE_PRODUCT_TOOL_NAMES:
                # 白名单限制：说明限制即可；禁止劝「handoff 正文交差」冒充写盘。
                error_msg = (
                    f"工具 '{name}' 不在本 run 的允许列表中，未执行。"
                    "本回合未授权该写盘工具；请改用已提供的工具，或 escalate / "
                    "handoff 说明缺写盘权限（勿用正文冒充落盘）。"
                )
                deny_status = "allowlist_deny"
            else:
                error_msg = (
                    f"工具 '{name}' 不在本 run 的允许列表中，未执行。"
                    "请仅使用当前已提供的工具，不要调用未授权的写盘或其他副作用工具。"
                )
                deny_status = "allowlist_deny"
            sink.emit(
                tool_use_end(
                    tc.id, name or raw_name, success=False, output=error_msg, run_id=event_run_id
                )
            )
            logger.info(
                "tool.execute_end",
                tool=name or raw_name,
                status=deny_status,
                duration_ms=0,
                reason=error_msg,
            )
            return (
                _failed_tool_message(tc.id, error_msg),
                None,
                ToolAttempt(
                    fingerprint,
                    name or raw_name,
                    success=False,
                    policy_failure=True,
                    error_summary=error_msg,
                    meta=_attempt_meta_with_landing_path(
                        name or raw_name,
                        args,
                        {
                            "error_class": ERROR_CLASS_PERMISSION,
                            "permission_kind": "allowlist",
                        },
                    ),
                ),
                [],
            )

        tool = registry.get_optional(name) if name else None
        if tool is None:
            missing = name or raw_name
            error_msg, status, policy_failure = _missing_tool_feedback(
                missing, raw_name=raw_name, registry=registry
            )
            sink.emit(
                tool_use_end(
                    tc.id,
                    name or raw_name,
                    success=False,
                    output=error_msg,
                    run_id=event_run_id,
                )
            )
            logger.info(
                "tool.execute_end",
                tool=name or raw_name,
                status=status,
                duration_ms=0,
            )
            return (
                _failed_tool_message(tc.id, error_msg),
                None,
                ToolAttempt(
                    fingerprint,
                    name or raw_name,
                    success=False,
                    policy_failure=policy_failure,
                    error_summary=error_msg,
                    meta=_attempt_meta_with_landing_path(name or raw_name, args),
                ),
                [],
            )

        denied = await _check_safety_and_approval_gates(
            name=name,
            args=args,
            tool_schema=tool.schema,
            tc=tc,
            context=context,
            sink=sink,
            event_run_id=event_run_id,
            run_id=run_id,
            role=role,
            fingerprint=fingerprint,
            approval_gate=approval_gate,
        )
        if denied is not None:
            return denied.message, None, denied.attempt, []

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
                    _failed_tool_message(tc.id, exhausted),
                    None,
                    ToolAttempt(
                        fingerprint,
                        name,
                        success=False,
                        error_summary=exhausted,
                        meta=_attempt_meta_with_landing_path(
                            name,
                            args,
                            {
                                "error_class": ERROR_CLASS_PERMANENT,
                                "code": "retrieval_budget_exhausted",
                                "retire_tools": sorted(RETRIEVAL_TOOL_NAMES),
                                "retire_message": (
                                    "检索预算已尽：web_search / read_url 本回合已停用——"
                                    "请基于已有材料交付，禁止再调用检索工具。"
                                ),
                            },
                        ),
                    ),
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
        deadline_token = set_tool_deadline(timeout)
        coalesce_key = (
            _file_read_round_coalesce_key(args) if name == "file_read" else None
        )
        try:
            if coalesce_key is not None:
                existing = file_read_inflight.get(coalesce_key)
                if existing is not None:
                    shared = await existing
                    result = _clone_tool_result(shared, tc.id)
                    result.duration_ms = int((time.monotonic() - started) * 1000)
                else:
                    fut: asyncio.Future[ToolResult] = (
                        asyncio.get_running_loop().create_future()
                    )
                    file_read_inflight[coalesce_key] = fut
                    try:
                        if timeout is None:
                            result = await tool.execute(args, ctx)
                        else:
                            result = await asyncio.wait_for(
                                tool.execute(args, ctx), timeout
                            )
                        # Snapshot before this call mutates ``tool_call_id``.
                        if not fut.done():
                            fut.set_result(replace(result))
                    except Exception as exc:
                        if not fut.done():
                            fut.set_exception(exc)
                        raise
            elif timeout is None:
                result = await tool.execute(args, ctx)
            else:
                result = await asyncio.wait_for(tool.execute(args, ctx), timeout)
        except TimeoutError:
            # B1 backstop: the call blew its ceiling. wait_for has already cancelled
            # the tool coroutine (a cancel-safe tool releases its side effects in
            # turn — e.g. the sandbox kills its subprocess); surface a model-facing
            # error so the loop adapts instead of hanging, and count it as a failed
            # attempt so a tool that keeps timing out trips convergence governance.
            # Liveness (hang) ≠ capacity contract — steer forbids identical retry.
            if budget_reserved and budget_state is not None:
                await budget_state.refund()
            duration_ms = int((time.monotonic() - started) * 1000)
            ceiling = timeout if timeout is not None else 0.0
            timeout_msg = (
                f"工具 '{name}' 活性挂起：超过 {ceiling:.0f}s 仍无响应，已中止。"
                "这不是字节/行数触顶——请缩小处理范围、换路径策略或换工具；"
                "禁止原样重试同一次调用。"
            )
            sink.emit(
                tool_use_end(
                    tc.id, name, success=False, output=timeout_msg, run_id=event_run_id
                )
            )
            timeout_fields: dict[str, Any] = {
                "tool": name,
                "status": "timeout",
                "duration_ms": duration_ms,
                "timeout_layer": "outer",
                "liveness_timeout": True,
            }
            if name == "git" and isinstance(args.get("subcommand"), str):
                timeout_fields["subcommand"] = args["subcommand"]
            logger.warning("tool.execute_end", **timeout_fields)
            return (
                _failed_tool_message(tc.id, timeout_msg),
                None,
                ToolAttempt(
                    fingerprint,
                    name,
                    success=False,
                    error_summary=timeout_msg,
                    meta=_attempt_meta_with_landing_path(
                        name,
                        args,
                        {
                            "liveness_timeout": True,
                            "timeout_layer": "outer",
                            "error_class": ERROR_CLASS_PERMANENT,
                        },
                    ),
                ),
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
            # Always carry the exception type: some builtins (e.g. NotImplementedError)
            # stringify to "" and the model would see a blank reason and retry blindly.
            detail = str(e).strip()
            detail = f"{type(e).__name__}: {detail}" if detail else type(e).__name__
            error_msg = (
                f"工具 '{name}' 执行时发生内部错误：{detail}。"
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
                _failed_tool_message(tc.id, error_msg),
                None,
                ToolAttempt(
                    fingerprint,
                    name,
                    success=False,
                    error_summary=error_msg,
                    meta=_attempt_meta_with_landing_path(name, args),
                ),
                [],
            )
        finally:
            reset_tool_deadline(deadline_token)
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
            # Identical error+output (common when tools mirror the same string)
            # must not double the model-visible failure text.
            err_part = (result.error or "").strip()
            out_part = (result.output or "").strip()
            if err_part and out_part and err_part == out_part:
                output = err_part
            else:
                output = "\n".join(p for p in (err_part, out_part) if p) or "Unknown error"
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
        if not result.success:
            # Short aggregable failure reason (status=error only). Full text stays on
            # tool_use_end.output / transcript; logs need a greppable tip without adjacent
            # event archaeology.
            end_fields["reason"] = _short_tool_error_reason(output)
        meta = result.metadata or {}
        if isinstance(meta.get("query"), str) and meta["query"]:
            end_fields["query"] = meta["query"]
        if isinstance(meta.get("hosts"), list):
            end_fields["hosts"] = meta["hosts"]
        if isinstance(meta.get("blocked_hosts"), list) and meta["blocked_hosts"]:
            end_fields["blocked_hosts"] = meta["blocked_hosts"]
        if isinstance(meta.get("subcommand"), str) and meta["subcommand"]:
            end_fields["subcommand"] = meta["subcommand"]
        if isinstance(meta.get("timeout_layer"), str) and meta["timeout_layer"]:
            end_fields["timeout_layer"] = meta["timeout_layer"]
        logger.info("tool.execute_end", **end_fields)

        citations = result.citations if (result.success and result.citations) else []
        # 执行层失败打机器尾注（仅 transcript；SSE 上文仍用无 marker 的 output）。
        msg_content = output if result.success else with_tool_failed_marker(output or "")
        message = LLMMessage(role="tool", content=msg_content, tool_call_id=tc.id)
        policy_failure = bool(result.metadata.get("policy_failure"))
        # 参数契约拒绝 (tools/protocol.py): forward the tool's self-correctable-rejection
        # marker so the run-scoped circuit breaker skips it (loop_controller.record).
        contract_failure = bool(result.contract_failure)
        error_summary = ""
        if not result.success and not policy_failure:
            error_summary = output if isinstance(output, str) else ""
        result_meta = dict(result.metadata) if result.metadata else {}
        if (
            not result.success
            and result_meta.get("workspace_channel_dead")
            and getattr(context, "execution_id", None)
        ):
            # So loop_controller can stamp the coordination session (workers often
            # lack current_execution_id ContextVar).
            result_meta.setdefault("execution_id", context.execution_id)
        if not result.success and "error_class" not in result_meta:
            if result_meta.get("retire_tools") or result_meta.get("liveness_timeout"):
                result_meta["error_class"] = ERROR_CLASS_PERMANENT
            elif policy_failure:
                result_meta["error_class"] = ERROR_CLASS_PERMISSION
            elif contract_failure:
                result_meta["error_class"] = ERROR_CLASS_VALIDATION
        return (
            message,
            (result if result.is_terminal else None),
            ToolAttempt(
                fingerprint,
                name,
                success=result.success,
                policy_failure=policy_failure,
                contract_failure=contract_failure,
                error_summary=error_summary,
                meta=_attempt_meta_with_landing_path(
                    name,
                    args,
                    result_meta or None,
                    error=error_summary,
                    contract_failure=contract_failure,
                ),
            ),
            citations,
        )

    sem = asyncio.Semaphore(MAX_PARALLEL_TOOLS)

    async def _bounded(
        tc: ToolCall,
    ) -> tuple[LLMMessage, ToolResult | None, ToolAttempt, list[dict[str, Any]]]:
        async with sem:
            return await _run_one(tc)

    # Same-batch handoff after writes: ``landed_artifact_kinds`` is a shared dict, but
    # parallel gather can still let handoff observe an empty stamp if it races ahead of
    # file_write/file_append. Run non-handoff tools first (still parallel among
    # themselves), then handoff — message order stays call-list order below.
    def _is_handoff_call(tc: ToolCall) -> bool:
        return sanitize_tool_name(tc.function.name or "") == "handoff"

    has_handoff = any(_is_handoff_call(tc) for tc in tool_calls)
    has_non_handoff = any(not _is_handoff_call(tc) for tc in tool_calls)
    if has_handoff and has_non_handoff:
        by_id: dict[
            str, tuple[LLMMessage, ToolResult | None, ToolAttempt, list[dict[str, Any]]]
        ] = {}
        first = [tc for tc in tool_calls if not _is_handoff_call(tc)]
        second = [tc for tc in tool_calls if _is_handoff_call(tc)]
        for tc, quad in zip(
            first, await asyncio.gather(*[_bounded(tc) for tc in first]), strict=True
        ):
            by_id[tc.id] = quad
        for tc, quad in zip(
            second, await asyncio.gather(*[_bounded(tc) for tc in second]), strict=True
        ):
            by_id[tc.id] = quad
        quads = [by_id[tc.id] for tc in tool_calls]
    else:
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
    await apply_round_citation_side_effects(
        quads,
        sink=sink,
        citation_sink=citation_sink,
        turn_evidence_ledger=turn_evidence_ledger,
        ledger_registrant=ledger_registrant,
        annotate_citations=annotate_citations,
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
                result=llm_content_text(message.content),
                success=attempt.success,
            ).to_fact()
        )

    return messages, terminal, attempts
