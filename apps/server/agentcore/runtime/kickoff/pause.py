"""Durable kickoff pause — emit ``team_preview_*`` and capture a suspension frame."""

from __future__ import annotations

from dataclasses import replace
from typing import Any, Protocol

from agentcore.core.logging import get_logger
from agentcore.core.types import new_id
from agentcore.runtime.checkpoints import CheckpointDecision
from agentcore.runtime.events import team_preview_required
from agentcore.runtime.kickoff.revision import kickoff_adjust_state, kickoff_turn_journal
from agentcore.runtime.kickoff.summary import KickoffSummary
from agentcore.tools.registration import execution_class_tool_names

logger = get_logger(__name__)


class KickoffHost(Protocol):
    """Minimal surface shared by ``DelegateTool`` / ``DebateTool`` for durable kickoff."""

    _sink: Any
    _message_id: str | None
    _conversation_id: str | None
    _suspension_saver: Any
    _pending_pause: bool
    _depth: int
    _captain_run_id: str | None
    _user_message: str
    _folder_id: str | None
    _memory_enabled: bool
    _conversation_history_access: bool
    _base_tool_context: Any
    _registry: Any

    def _kickoff_system_prompt(self) -> str: ...

    def _kickoff_tool_name(self) -> str: ...


def kickoff_tools(*, show_capabilities: bool) -> list[str]:
    """Execution-class tools shown on the kickoff card as「将授权的执行能力」.

    File-mutation class is session-trusted under workspace / full_trust (开工授权),
    so the card lists only code / terminal / browser execution. Empty when
    AutonomyPolicy hides the capability half (not plan-derived).
    """
    if not show_capabilities:
        return []
    return sorted(execution_class_tool_names())


def can_persist_kickoff(host: KickoffHost) -> bool:
    return bool(
        host._depth == 0
        and host._message_id
        and host._suspension_saver is not None
        and host._conversation_id
    )


async def persist_kickoff(
    host: KickoffHost,
    checkpoint_id: str,
    summary: KickoffSummary,
    required_event: Any,
    *,
    plan: Any | None = None,
) -> bool:
    """Capture + persist the durable kickoff frame. Returns True iff saved.

    Same-conversation persist is serial. Before save, prior pending ``team_preview``
    cards are orphaned (journal ∪ in-process) so gather dual-send cannot leave two
    clickable kickoff cards. Required SSE emits under the same lock.
    """
    if not can_persist_kickoff(host):
        return False
    from agentcore.runtime.kickoff.orphan import (
        orphan_conversation_team_previews,
        persist_lock_for,
        remember_live_team_preview,
    )

    conversation_id = host._conversation_id or ""
    async with persist_lock_for(conversation_id):
        try:
            await orphan_conversation_team_previews(
                conversation_id,
                sink=host._sink,
                reason="superseded",
                exclude_ids={checkpoint_id},
            )
        except Exception as exc:  # noqa: BLE001 — 清旧卡失败不阻断建新卡
            logger.warning(
                "team_preview.supersede_prior_failed",
                conversation_id=conversation_id,
                error=str(exc),
            )
        saved = await _persist_kickoff_frame(
            host, checkpoint_id, summary, required_event, plan=plan
        )
        if saved:
            remember_live_team_preview(
                conversation_id, checkpoint_id, host._message_id or ""
            )
            # Emit under the persist lock so a sibling persist cannot orphan this
            # card and then lose a late required SSE from the first caller.
            if host._sink is not None:
                host._sink.emit(required_event)
        return saved


async def _persist_kickoff_frame(
    host: KickoffHost,
    checkpoint_id: str,
    summary: KickoffSummary,
    required_event: Any,
    *,
    plan: Any | None = None,
) -> bool:
    from agentcore.runtime.runs.plan import RunPlan
    from agentcore.runtime.suspension import TeamPreviewSuspension, find_tool_call_id
    from agentcore.runtime.suspension.capture import SuspensionCapture, persist_suspension_capture

    tool_name = host._kickoff_tool_name()
    plan_obj = plan if plan is not None else RunPlan()

    def build_frame(capture: SuspensionCapture) -> TeamPreviewSuspension:
        return TeamPreviewSuspension(
            message_id=host._message_id or "",
            conversation_id=host._conversation_id or "",
            user_id=host._base_tool_context.user_id,
            captain_run_id=host._captain_run_id or "",
            checkpoint_id=checkpoint_id,
            tool_call_id=find_tool_call_id(capture.transcript, tool_name),
            base_system_prompt=host._kickoff_system_prompt(),
            user_message=host._user_message,
            folder_id=host._folder_id,
            folder_binding_injected=bool(
                getattr(host._base_tool_context, "folder_binding_injected", False)
            ),
            folder_local_root_id=getattr(
                host._base_tool_context, "folder_local_root_id", None
            ),
            folder_local_subpath=getattr(
                host._base_tool_context, "folder_local_subpath", None
            ),
            memory_enabled=host._memory_enabled,
            conversation_history_access=host._conversation_history_access,
            transcript=capture.transcript,
            history=capture.history,
            plan=plan_obj,
            completed={},
            journal_entries=capture.journal_entries,
            workers=list(summary.workers),
            tools=list(summary.tools),
            primitive=summary.primitive,
            motion=summary.motion,
            form=summary.form,
            sides=list(summary.sides),
            max_rounds=summary.max_rounds,
            thorough=summary.thorough,
            debate_arguments=dict(summary.debate_arguments),
            headline=summary.headline or "",
            revision=summary.revision if summary.revision >= 1 else 1,
            revised_from=summary.revised_from or "",
            revision_note=summary.revision_note or "",
            # 委派批次协作参数：挂起点在 setup_note_wall 之前，这三样只活在工具实例上，
            # 不落帧则耐久恢复（全新工具实例）后 wall 批降级 none、seed 便签丢失。
            # DebateTool 无这些属性 → getattr 缺省（辩论批无便签墙）。
            coordination=str(getattr(host, "_coordination", "none") or "none"),
            team_brief=getattr(host, "_team_brief", None),
            seed_notes=list(getattr(host, "_seed_notes", None) or []),
            citations=capture.citations,
            trace_id=capture.trace_id,
        )

    return await persist_suspension_capture(
        checkpoint_id=checkpoint_id,
        required_event=required_event,
        build_frame=build_frame,
        saver=host._suspension_saver,
        sink=host._sink,
        suspension_kind="team_preview",
    )


async def await_kickoff(
    host: KickoffHost,
    summary: KickoffSummary,
    *,
    plan: Any | None = None,
) -> CheckpointDecision | None:
    """Pause before fan-out / moderator start; return decision, or None when suspended.

    On durable save: sets ``host._pending_pause`` and returns ``None`` so the caller
    ends with SUSPEND. Config unavailable (no transcript): CONTINUE. Runtime saver
    failure raises (D11 — no silent continue).
    """
    registry = host._registry
    conversation_id = host._conversation_id
    if registry is None or conversation_id is None:
        return CheckpointDecision.CONTINUE
    if host._depth != 0:
        return CheckpointDecision.CONTINUE

    checkpoint_id = new_id()
    lineage = kickoff_adjust_state(kickoff_turn_journal(sink=host._sink))
    if lineage.unfulfilled:
        summary = replace(
            summary,
            revision=lineage.revision,
            revised_from=lineage.revised_from or "",
            revision_note=lineage.revision_note or "",
        )
    card = summary.card_payload()
    required = team_preview_required(
        checkpoint_id=checkpoint_id,
        conversation_id=conversation_id,
        workers=card["workers"],
        tools=card["tools"],
        primitive=card["primitive"],
        motion=card["motion"],
        form=card["form"],
        sides=card["sides"],
        max_rounds=card["max_rounds"],
        thorough=card["thorough"],
        moderator_model=str(card.get("moderator_model") or ""),
        moderator_origin=str(card.get("moderator_origin") or ""),
        moderator_provider_id=str(card.get("moderator_provider_id") or ""),
        moderator_run_id=str(card.get("moderator_run_id") or ""),
        same_model_debate=bool(card.get("same_model_debate")),
        model_candidates=list(card.get("model_candidates") or []) or None,
        headline=str(card.get("headline") or ""),
        revision=int(card.get("revision") or 1),
        revised_from=str(card.get("revised_from") or ""),
        revision_note=str(card.get("revision_note") or ""),
    )
    try:
        saved = await persist_kickoff(
            host, checkpoint_id, summary, required, plan=plan
        )
    except Exception:
        # D11：运行态落帧失败（saver 抛错）⇒ 显式终止，不许静默 CONTINUE 开工。
        logger.exception(
            "team_preview.persist_failed",
            checkpoint_id=checkpoint_id,
            primitive=summary.primitive,
        )
        raise
    if saved:
        host._pending_pause = True
        logger.info(
            "team_preview.finalized",
            checkpoint_id=checkpoint_id,
            primitive=summary.primitive,
            workers=len(summary.workers),
            tools=summary.tools,
        )
        return None

    # 配置态不可用（无 transcript 等非生产场景）⇒ CONTINUE。
    logger.warning(
        "team_preview.persist_unavailable",
        checkpoint_id=checkpoint_id,
        reason="no_durable_frame",
        primitive=summary.primitive,
    )
    return CheckpointDecision.CONTINUE
