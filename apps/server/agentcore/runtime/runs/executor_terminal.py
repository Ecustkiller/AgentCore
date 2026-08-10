"""AGENT-node salvage / cancel / terminal RunState builders.

Split from ``executor_node`` — pure move; consumed only by the node facade.
"""

from __future__ import annotations

import asyncio
from dataclasses import asdict
from typing import Any

from agentcore.core.logging import get_logger
from agentcore.llm.pricing import calculate_cost
from agentcore.llm.provider.protocol import LLMMessage, TokenUsage
from agentcore.runtime.events import (
    FinishReason,
    escalation_raised,
    run_cancelled,
    run_completed,
    run_failed,
)
from agentcore.runtime.runs.contract import (
    ContractVerdict,
    handoff_expectation_met,
    has_salvageable_half_product,
    node_has_dependents,
    strip_invalid_ledger_refs_from_debrief,
    synthesize_debrief,
    worker_expects_handoff,
)
from agentcore.runtime.runs.executor_env import AgentExecutorEnv
from agentcore.runtime.runs.executor_hooks import _stamp_retrieval_evidence_gap
from agentcore.runtime.runs.executor_identities import LeadSubteam
from agentcore.runtime.runs.executor_shared import (
    _apply_cutoff_reasons,
    _apply_finish_interrupt,
    _delivery_gaps_from_warnings,
    _hard_gap_blocks_completion,
    _is_hard_failure,
    _priced_failure,
)
from agentcore.runtime.runs.file_acceptance import (
    build_file_acceptance,
    path_rejections_from_contract_messages,
)
from agentcore.runtime.runs.landing_product import filter_product_landing_paths
from agentcore.runtime.runs.salvage import (
    cancelled_state_from_salvage,
    content_from_transcript,
    freeze_partial_transcript,
    try_salvage_session,
)
from agentcore.runtime.runs.serialize import (
    debrief_from_transcript,
    escalations_from_transcript,
    files_touched_from_transcript,
)
from agentcore.runtime.runs.types import ContextBlock, RunPhase, RunSpec, RunState

logger = get_logger(__name__)


def build_terminal_run_state(
    env: AgentExecutorEnv,
    spec: RunSpec,
    agent_id: str,
    *,
    messages: list[LLMMessage],
    content: str,
    reasoning: str,
    verdict: ContractVerdict,
    deliverable: Any,
    product_landing_artifacts: list[str] | None,
    resolutions: dict[str, dict[str, Any]],
    gate_escalations: list[dict[str, Any]],
    worker_citations: list[dict],
    priced_model: str,
    run_usage: TokenUsage,
    run_rounds: int,
    duration_ms: int,
    finish_override: list[FinishReason],
    cutoff_reasons: list[str],
    tool_failures: list[dict],
    write_pass_used: bool,
    visual_rework_used: int,
    received_blocks: list[ContextBlock],
    tool_ctx: Any,
) -> RunState:
    """Build COMPLETED / contract-FAILED / hard-gap FAILED terminal RunState + emit."""
    usage = run_usage.as_dict()
    cost = asdict(calculate_cost(priced_model, run_usage))
    # Upward escalations this worker raised (escalate tool calls), harvested
    # once from the transcript and carried on BOTH terminal states — a worker
    # that flags a blocker then fails its contract should still surface that
    # blocker to the CEO. 阻塞式求决策: fold each blocking escalate's resolution
    # (answer / timeout) in by question, so CEO synthesis knows which were already
    # settled with the user and must not be re-asked (设计 §4.5/§4.7).
    escalations = escalations_from_transcript(messages)
    for esc in escalations:
        settled = resolutions.get(esc.get("question", ""))
        if settled is not None:
            esc["status"] = settled["status"]
            esc["answer"] = settled["answer"]
    # Merge Escalation Gate scheme-layer signals (dedupe by question).
    seen_questions = {e.get("question", "") for e in escalations}
    for gate_esc in gate_escalations:
        q = gate_esc.get("question", "")
        if q and q not in seen_questions:
            escalations.append(gate_esc)
            seen_questions.add(q)
    # 完工交接简报: harvest the worker's structured brief from its ``handoff`` tool call
    # (best-effort; None when it finished without one) so downstream dep injection / CEO
    # synthesis read the author's own 结论 + 建议下一步 instead of re-deriving them from
    # prose. Carried on BOTH terminal states (a worker that failed its contract can still
    # have submitted a useful brief before failing). Nodes that expect a handoff
    # (has dependents, or leaf after substantial work) but still lack a minimum-quality
    # brief get an engine-synthesized degraded debrief so CEO / delivery_status can see
    # 「汇报不完整」. Upstream: only when salvageable half-product (body / disk /
    # qualified brief) — empty inventory must not mint an empty ``degraded_synth``.
    # Leaf substantial (tools / longer body): always stamp degraded when missing.
    debrief = debrief_from_transcript(messages)
    touched = files_touched_from_transcript(messages)
    product_touched = filter_product_landing_paths(
        touched, product_landing_artifacts
    )
    author_brief = debrief
    expects_handoff = worker_expects_handoff(
        env.plan,
        spec.run_id,
        content=content,
        messages=messages,
        files_touched=touched,
    )
    has_dependents = node_has_dependents(env.plan, spec.run_id)
    can_synth = has_salvageable_half_product(content, touched, author_brief) or (
        expects_handoff and not has_dependents
    )
    if (
        expects_handoff
        and not handoff_expectation_met(debrief, for_dependents=has_dependents)
        and can_synth
    ):
        debrief = synthesize_debrief(content, touched)
        logger.info(
            "handoff.degraded_synth",
            run_id=spec.run_id,
            had_author_brief=author_brief is not None,
        )
    # 收口剥离：handoff 简报 / 升格正文也可能带非法 #rN（与 artifacts 闸同口径）。
    citable_ids = (
        env.turn_evidence_ledger.draft_citable_ids()
        if env.turn_evidence_ledger is not None
        else None
    )
    debrief, stripped_debrief = strip_invalid_ledger_refs_from_debrief(
        debrief, citable_ids
    )
    if stripped_debrief:
        logger.warning(
            "citations.invalid_ledger_ref",
            run_id=spec.run_id,
            markers=stripped_debrief,
            surface="handoff_debrief",
            citable_count=len(citable_ids or ()),
        )
    if content and citable_ids is not None:
        from agentcore.runtime.citations import (
            invalid_ledger_ref_ids,
            strip_invalid_ledger_refs,
        )

        bad_body = invalid_ledger_ref_ids(content, citable_ids)
        if bad_body:
            content = strip_invalid_ledger_refs(content, set(bad_body))
            logger.warning(
                "citations.invalid_ledger_ref",
                run_id=spec.run_id,
                markers=bad_body,
                surface="worker_body",
                citable_count=len(citable_ids or ()),
            )
    # Soft web-quality (anti-slop): at most one rework (already spent in the loop).
    # Remaining soft-only hits demote to warnings — never hard-fail the run.
    # P1c visual critic: remaining visual_failures after max reworks → partial.
    if (verdict.soft_failures or verdict.visual_failures) and not verdict.failures:
        if verdict.soft_failures:
            logger.info(
                "contract.web_quality_soft_accept",
                run_id=spec.run_id,
                soft_failures=verdict.soft_failures,
            )
        if verdict.visual_failures:
            logger.info(
                "contract.visual_critic_partial",
                run_id=spec.run_id,
                visual_failures=verdict.visual_failures,
                rework_used=visual_rework_used,
            )
        verdict = ContractVerdict(
            ok=True,
            failures=[],
            warnings=[
                *verdict.warnings,
                *verdict.soft_failures,
                *verdict.visual_failures,
            ],
            soft_failures=[],
            visual_failures=[],
        )
    path_rej = path_rejections_from_contract_messages(
        [*verdict.failures, *verdict.soft_failures]
    )
    if not verdict.ok and _is_hard_failure(
        content, deliverable, files_touched=len(product_touched)
    ):
        reason = "；".join(verdict.failures)
        logger.info("contract.failed", run_id=spec.run_id, failures=verdict.failures)
        # 交付真相：零落盘硬失败时上浮 escalate，供 CEO 续派 / 收口（非自愈旁路）。
        if (
            deliverable is not None
            and (deliverable.form == "files" or bool(deliverable.artifacts))
            and not product_touched
        ):
            esc_q = (
                "落盘契约未满足：form=files/artifacts 且零落盘"
                + ("（写盘 pass 已用尽）" if write_pass_used else "")
                + "——请 continue_from_run_id 续派或冷补派，勿当作已完成。"
            )
            if not any(e.get("question") == esc_q for e in escalations):
                escalations.append(
                    {
                        "question": esc_q,
                        "assumption": "",
                        "blocking": False,
                        "kind": "normal",
                        "source": "contract",
                    }
                )
            env.sink.emit(
                escalation_raised(
                    spec.run_id,
                    agent_id,
                    question=esc_q,
                    assumption="",
                    blocking=False,
                    kind="normal",
                )
            )
        # A contract miss still produced a deliverable + (often) a 交接简报: surface it so
        # the run-detail shows the author's wrap-up beside the failure (the infra-failure
        # except path below has no reliable content, so it carries none).
        # 分脸：结构/格式闸 → format「格式未过」；内容/结论 → quality「未达标」。
        from agentcore.runtime.runs.contract import contract_run_failure_kind

        env.sink.emit(
            run_failed(
                spec.run_id,
                agent_id,
                reason,
                failure_kind=contract_run_failure_kind(verdict),
                debrief=debrief,
                execution_id=env.execution_id,
            )
        )
        # Contract retries already exhausted inside this executor; mark
        # non-retryable so WaveScheduler's on_failure=retry does not cold-
        # start the whole node (same tokens, same empty/short product).
        return _stamp_retrieval_evidence_gap(
            RunState(
                phase=RunPhase.FAILED,
                content=content,
                reasoning=reasoning,
                error=reason,
                error_retryable=False,
                escalations=escalations,
                debrief=debrief,
                citations=worker_citations,
                model=priced_model,
                duration_ms=duration_ms,
                rounds=run_rounds,
                files_touched=touched,
                file_acceptance=build_file_acceptance(
                    touched,
                    phase=RunPhase.FAILED,
                    error=reason,
                    path_rejections=path_rej,
                ),
                tool_failures=list(tool_failures),
                usage=usage,
                cost=cost,
                transcript=messages,
                received_context=received_blocks,
            ),
            tool_ctx,
            search_policy=spec.search_policy or "",
        )
    # Soft-accept / clean complete: still surface an interrupted LLM finish so CEO
    # synthesis sees the gap (files may be on disk but handoff missing/thin).
    warnings = [] if verdict.ok else [
        *verdict.failures,
        *verdict.soft_failures,
        *verdict.visual_failures,
    ]
    if verdict.ok and verdict.warnings:
        # Soft-accept demotion / placeholder soft notes already on the verdict.
        warnings = list(verdict.warnings)
    elif verdict.warnings:
        warnings = [*warnings, *verdict.warnings]
    warnings, debrief = _apply_finish_interrupt(
        finish_override,
        warnings=warnings,
        debrief=debrief,
        content=content,
        files_touched=touched,
        run_id=spec.run_id,
    )
    warnings = _apply_cutoff_reasons(cutoff_reasons, warnings=warnings)
    # 刀1：已落盘时 degraded_handoff 只记 warning，不抬硬缺口。
    delivery_gaps = _delivery_gaps_from_warnings(
        warnings, debrief, files_landed=bool(touched)
    )
    # 成篇质量：有下游 + 相对合同未满足且无成篇 prose 落盘 → 失败（与 handoff 同口径）。
    # 认 tool_ctx.landed_artifact_kinds（跨 replace 存活）；勿用 has_landed_files /
    # 泛 files_touched（骨架落盘会误豁免）。地板固定非空（不跟合同字数字段）。
    # 非 prose：正文空但 debrief.summary 在 → 先升格再验地板。
    # prose + 有下游：summary 不算正文，禁止升格顶地板。
    from agentcore.runtime.runs.research_quality import (
        brief_may_satisfy_body_floor,
        promote_brief_to_deliverable,
        upstream_body_floor_satisfied,
    )

    body_chars = len((content or "").strip())
    floor = 0
    form = deliverable.form if deliverable is not None else None
    if (
        body_chars == 0
        and debrief
        and brief_may_satisfy_body_floor(deliverable_form=form)
    ):
        brief_summary = str((debrief or {}).get("summary") or "").strip()
        if brief_summary:
            candidate = promote_brief_to_deliverable(
                brief_summary, (debrief or {}).get("key_points")
            )
            if upstream_body_floor_satisfied(
                body_chars=len(candidate),
                landed_artifact_kinds=tool_ctx.landed_artifact_kinds,
                min_body_chars=floor,
            ):
                content = candidate
                body_chars = len(candidate)
    # 升格后正文再剥一次（简报字段已剥；升格可能把 key_points 拼回正文）。
    if content and citable_ids is not None:
        from agentcore.runtime.citations import (
            invalid_ledger_ref_ids,
            strip_invalid_ledger_refs,
        )

        bad_promoted = invalid_ledger_ref_ids(content, citable_ids)
        if bad_promoted:
            content = strip_invalid_ledger_refs(content, set(bad_promoted))
            body_chars = len((content or "").strip())
            logger.warning(
                "citations.invalid_ledger_ref",
                run_id=spec.run_id,
                markers=bad_promoted,
                surface="promoted_brief",
                citable_count=len(citable_ids or ()),
            )
    if node_has_dependents(env.plan, spec.run_id) and not upstream_body_floor_satisfied(
        body_chars=body_chars,
        landed_artifact_kinds=tool_ctx.landed_artifact_kinds,
        min_body_chars=floor,
    ):
        floor_hint = "为空"
        summary_hint = (
            "（summary 不算正文）"
            if (
                body_chars == 0
                and debrief
                and str((debrief or {}).get("summary") or "").strip()
                and not brief_may_satisfy_body_floor(deliverable_form=form)
            )
            else ""
        )
        reason = (
            f"空交付不得进入下游：正文{floor_hint}{summary_hint}"
            "且无成篇落盘（prose；骨架/空文件不算）"
        )
        logger.info(
            "handoff.empty_body_blocked",
            run_id=spec.run_id,
            body_chars=body_chars,
            min_body_chars=floor,
            deliverable_form=form,
        )
        env.sink.emit(
            run_failed(
                spec.run_id,
                agent_id,
                reason,
                failure_kind="quality",
                debrief=debrief,
                execution_id=env.execution_id,
            )
        )
        return _stamp_retrieval_evidence_gap(
            RunState(
                phase=RunPhase.FAILED,
                content=content,
                reasoning=reasoning,
                error=reason,
                error_retryable=False,
                escalations=escalations,
                debrief=debrief,
                citations=worker_citations,
                model=priced_model,
                duration_ms=duration_ms,
                rounds=run_rounds,
                tool_failures=list(tool_failures),
                usage=usage,
                cost=cost,
                transcript=messages,
                received_context=received_blocks,
            ),
            tool_ctx,
            search_policy=spec.search_policy or "",
        )
    # 刀1 / 方案 A：strict + 真未落盘仍硬拦；已落盘 + 仅交接降级 → 放行 COMPLETED。
    hard_gap = _hard_gap_blocks_completion(
        delivery_gaps,
        debrief,
        deliverable,
        files_touched=len(touched or []),
    )
    if hard_gap:
        logger.info(
            "contract.hard_gap_blocked_completion",
            run_id=spec.run_id,
            reason=hard_gap.reason,
            failure_kind=hard_gap.failure_kind,
            gaps=delivery_gaps,
        )
        env.sink.emit(
            run_failed(
                spec.run_id,
                agent_id,
                hard_gap.reason,
                failure_kind=hard_gap.failure_kind,
                debrief=debrief,
                execution_id=env.execution_id,
            )
        )
        return _stamp_retrieval_evidence_gap(
            RunState(
                phase=RunPhase.FAILED,
                content=content,
                reasoning=reasoning,
                error=hard_gap.reason,
                error_retryable=False,
                warnings=warnings,
                delivery_gaps=delivery_gaps,
                escalations=escalations,
                debrief=debrief,
                citations=worker_citations,
                model=priced_model,
                duration_ms=duration_ms,
                rounds=run_rounds,
                files_touched=touched,
                file_acceptance=build_file_acceptance(
                    touched,
                    phase=RunPhase.FAILED,
                    error=hard_gap.reason,
                    path_rejections=path_rej,
                ),
                tool_failures=list(tool_failures),
                usage=usage,
                cost=cost,
                transcript=messages,
                received_context=received_blocks,
            ),
            tool_ctx,
            search_policy=spec.search_policy or "",
        )
    # The worker's terminal RunState is journaled at the ``execute`` choke point
    # below (run_final_fact — covers COMPLETED *and* FAILED in one place), so resume
    # re-seeds it from facts not the旁路 frame (执行级事件溯源 Phase 2 ⑥).
    env.sink.emit(
        run_completed(
            spec.run_id,
            agent_id,
            # 交接简报单一源: the summary IS the worker's authored 结论 (best-effort "" when
            # it wrote none — the full deliverable is persisted + shown either way), never a
            # truncation; the structured debrief rides alongside for the run-detail card.
            output_summary=(debrief or {}).get("summary", ""),
            duration_ms=duration_ms,
            # 阶段1 scheduled runs are all delegated workers → member row;
            # the already-priced usage/cost light up the payroll live.
            role="member",
            model=priced_model,
            usage=usage,
            cost=cost,
            debrief=debrief,
            output_files=touched or None,
            gaps=delivery_gaps or None,
            execution_id=env.execution_id,
        )
    )
    return _stamp_retrieval_evidence_gap(
        RunState(
            phase=RunPhase.COMPLETED,
            content=content,
            reasoning=reasoning,
            warnings=warnings,
            delivery_gaps=delivery_gaps,
            escalations=escalations,
            debrief=debrief,
            citations=worker_citations,
            model=priced_model,
            duration_ms=duration_ms,
            rounds=run_rounds,
            files_touched=touched,
            file_acceptance=build_file_acceptance(
                touched,
                phase=RunPhase.COMPLETED,
                path_rejections=path_rej,
            ),
            tool_failures=list(tool_failures),
            usage=usage,
            cost=cost,
            transcript=messages,
            received_context=received_blocks,
        ),
        tool_ctx,
        search_policy=spec.search_policy or "",
    )


def handle_agent_node_cancel(
    env: AgentExecutorEnv,
    spec: RunSpec,
    agent_id: str,
    e: asyncio.CancelledError,
    *,
    messages: list[LLMMessage],
    streamed_content: list[str],
) -> RunState | None:
    """Dual cancel: redirect → salvage CANCELLED; stop → emit then re-raise.

    Returns a RunState on redirect salvage; returns None when caller must ``raise``.
    """
    cancel_reason = (
        "redirect"
        if e.args and str(e.args[0]) == "redirect"
        else "stop"
    )
    env.sink.emit(
        run_cancelled(
            spec.run_id,
            agent_id,
            reason=cancel_reason,
            execution_id=env.execution_id,
        )
    )
    if cancel_reason == "redirect":
        # Fold live streamed draft into messages when the ReAct pass was cut
        # before the final assistant turn was appended (用户已看见的一半产出).
        draft = "".join(streamed_content).strip()
        salvage_msgs = list(messages)
        if draft and not any(m.role in ("assistant", "tool") for m in salvage_msgs):
            salvage_msgs.append(LLMMessage(role="assistant", content=draft))
        session = try_salvage_session(spec=spec, messages=salvage_msgs)
        logger.info(
            "run.redirect_cancelled",
            run_id=spec.run_id,
            salvage=session is not None,
            transcript_len=len(session.transcript) if session else 0,
            streamed_chars=len(draft),
        )
        return cancelled_state_from_salvage(session, error="redirected")
    return None


def handle_agent_node_exception(
    env: AgentExecutorEnv,
    spec: RunSpec,
    agent_id: str,
    e: BaseException,
    *,
    start: float,
    messages: list[LLMMessage],
    inflight: list[TokenUsage],
    run_usage: TokenUsage,
    run_rounds: int,
    priced_model: str | None,
    product_landing_artifacts: list[str] | None,
    tool_ctx: Any | None,
) -> RunState:
    """Price partial spend and return FAILED RunState for infra/call failures."""
    import time

    duration_ms = int((time.monotonic() - start) * 1000)
    usage_acc = run_usage
    # Bill the rounds that completed before the failure: finished attempts are
    # already in run_usage; an in-flight pass that raised left its spend in
    # ``inflight`` (B-deep 失败计费).
    if inflight:
        usage_acc = usage_acc + inflight[0]
    # 确定性失败区分 (BL-6): a non-retryable upstream error (prompt 超长 / 400 /
    # 鉴权 / 余额 — AgentCoreError.retryable=False) will re-fail identically, so
    # carry that verdict onto the state and let the scheduler skip its infra retry.
    # Closed httpx client (turn teardown race) is also deterministic — retrying
    # the same closed client just multiplies llm.call_failed / run.failed.
    # A plain crash / unknown exception has no ``retryable`` attr → defaults True
    # (retry as before), so only KNOWN-deterministic failures opt out.
    from agentcore.core.errors import LLMClientClosedError, is_llm_client_closed_error

    if is_llm_client_closed_error(e) and not isinstance(e, LLMClientClosedError):
        e = LLMClientClosedError(str(e))
    retryable = bool(getattr(e, "retryable", True))
    logger.error(
        "run.failed",
        run_id=spec.run_id,
        error=str(e),
        retryable=retryable,
        exc_info=True,
    )
    frozen = freeze_partial_transcript(messages) if messages else []
    product_landed = False
    if frozen:
        touched = files_touched_from_transcript(frozen)
        product_landed = (
            len(filter_product_landing_paths(touched, product_landing_artifacts)) > 0
        )
    env.sink.emit(
        run_failed(
            spec.run_id,
            agent_id,
            str(e),
            failure_kind="call",
            execution_id=env.execution_id,
            product_landed=product_landed or None,
        )
    )
    failed = _priced_failure(
        str(e),
        model=priced_model,
        usage=usage_acc,
        rounds=run_rounds,
        duration_ms=duration_ms,
        retryable=retryable,
        transcript=frozen or None,
        content=content_from_transcript(frozen) if frozen else "",
    )
    if tool_ctx is not None:
        return _stamp_retrieval_evidence_gap(
            failed, tool_ctx, search_policy=spec.search_policy or ""
        )
    return failed


async def dispose_agent_node(
    spec: RunSpec,
    lead_subteam: LeadSubteam | None,
) -> None:
    """Browser unbind + lead subteam dispose (finally path)."""
    # Browser B: release this run's session bind so a later worker omitting
    # session_id can reuse the conversation's unbound unique/active live tab
    # (complete / fail / cancel — including redirect cancel + re-raise stop).
    try:
        from agentcore.runtime.browser.registry import default_browser_session_registry

        default_browser_session_registry().unbind_run(spec.run_id)
    except Exception:  # noqa: BLE001 - teardown must not fail the worker path
        logger.warning("browser.unbind_run_failed", run_id=spec.run_id)
    # 堵漏账: if this lead opened a sub-plan at a 波边界 but its react loop ended
    # without a final replan (answered directly / hit MAX_ROUNDS / raised), the held
    # sub-team spend still sits in the child delegate's _supervised. Fold it in now —
    # BEFORE the parent drive's absorb_children merges this child's ledger — so no
    # sub-team usage is stranded unbilled. No-op when nothing is paused; best-effort,
    # and in a finally so it runs on the success, MAX_ROUNDS, and exception paths alike.
    if lead_subteam is not None:
        await lead_subteam.dispose()
