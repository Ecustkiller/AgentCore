"""System-initiated harvest closing turn (异步团队产出投递 · 支柱 C).

When a detached coordination drive finishes, the harvester calls
:func:`run_harvest_closing_turn` to spawn a CEO turn that adopts the live
execution, consumes queued ``ALL_COMPLETED``, and delivers a final assistant
message. Meta stamps ``origin=execution_harvest`` for attribution.

Credential routing matches ordinary turns / standing-task fires (conversation
model selection + billing preflight) — never hardcode ``llm_credentials=None``
(that silently falls through to the platform key).

When preflight refuses (quota / BYOK missing), or the local workspace channel is
already sticky-dead / dies during the closing turn, :func:`persist_harvest_fallback`
pushes any existing synthesis draft / ALL_COMPLETED terminal body to the user
as an assistant message — no second LLM call (A1 / channel-dead harvest).
"""

from __future__ import annotations

import contextlib
from typing import TYPE_CHECKING, Any, Literal

from agentcore.billing.gate import preflight_llm_credentials
from agentcore.conversation.common import (
    resolve_conversation_history_access,
    resolve_local_binding,
    resolve_memory_enabled,
    resolve_permission_axes,
    resolve_profile_set,
)
from agentcore.conversation.history import load_chat_context
from agentcore.conversation.turn_backend import build_turn_backend
from agentcore.conversation.turn_runner import run_and_persist
from agentcore.core.errors import AgentCoreError
from agentcore.core.logging import get_logger
from agentcore.db.base import async_session_factory
from agentcore.db.repositories import (
    BoardRepository,
    ConversationRepository,
    CostEventRepository,
    UserRepository,
)
from agentcore.llm.resolve import (
    platform_llm_credentials,
    resolve_conversation_model_selection,
)
from agentcore.push import PushNotification, notify_user
from agentcore.runtime.events import EventSink
from agentcore.runtime.turn_runs import turn_runs
from agentcore.workspace.limits import (
    CHANNEL_DEAD_PREPARE_ABORT,
    CHANNEL_DEAD_USER_VISIBLE,
    EXEC_ENV_DEAD_USER_VISIBLE,
    is_channel_dead_detail,
)
from agentcore.workspace.protocol import WorkspaceIOError

if TYPE_CHECKING:
    from agentcore.llm.credentials import LLMCredentials
    from agentcore.runtime.coordination.session import CoordinationSession

logger = get_logger(__name__)

HarvestKind = Literal["success", "failure", "cancelled"]

_HARVEST_USER_TEXT: dict[HarvestKind, str] = {
    "success": (
        "【系统收口】后台团队任务已全部完成。请综合队员产出，按终稿纪律交付给老板："
        "交付物在前，过程简述至多一段；勿粘贴协调事件原文。"
    ),
    "failure": (
        "【系统收口】后台团队任务已结束，但有队员失败。请综合已有产出与失败情况向老板交代："
        "交付物/缺口在前，失败原因简述至多一段；勿粘贴协调事件原文；勿假装全员成功。"
    ),
    "cancelled": (
        "【系统收口】后台团队任务已取消或中断。请基于已完成部分向老板简要收尾："
        "已交付与未完成清单在前，说明已取消；勿粘贴协调事件原文；勿宣称已全部完成。"
    ),
}

_HARVEST_PUSH: dict[HarvestKind, tuple[str, str]] = {
    "success": ("团队任务已完成", "后台团队已交付终稿，打开对话查看。"),
    "failure": ("团队任务有失败", "后台团队已结束但有失败，打开对话查看收尾。"),
    "cancelled": ("团队任务已取消", "后台团队已取消或中断，打开对话查看收尾。"),
}

_HARVEST_FALLBACK_EMPTY: dict[HarvestKind, str] = {
    "success": (
        "后台团队已完成，但系统收口未能调用模型生成新综合。"
        "请查看上方团队进展与交付状态；也可稍后在额度恢复后让我继续汇总。"
    ),
    "failure": (
        "后台团队已结束（含失败），但系统收口未能调用模型生成新综合。"
        "请查看上方团队进展与交付状态中的缺口说明。"
    ),
    "cancelled": (
        "后台团队已取消或中断，且系统收口未能调用模型生成新综合。"
        "请查看上方已完成部分与交付状态。"
    ),
}

_CHANNEL_DEAD_BODY_MARKERS = (
    "channel dead",
    "活性挂起",
    "本地工作区文件通道已挂起",
    "写盘通道不可用",
    "本地文件暂时连不上",
)


class HarvestDeferredError(Exception):
    """Conversation slot occupied — keep registry; caller must retry, not unregister."""

    def __init__(self, conversation_id: str, execution_id: str) -> None:
        self.conversation_id = conversation_id
        self.execution_id = execution_id
        super().__init__(f"harvest deferred: live turn on {conversation_id}")


def harvest_closing_kind(session: CoordinationSession) -> HarvestKind:
    """Classify harvest outcome for synthetic user text (success / failure / cancelled)."""
    from agentcore.runtime.coordination.session import CoordinationEventKind

    if session.soft_stop:
        return "cancelled"
    if any(ev.kind is CoordinationEventKind.DRIVE_CANCELLED for ev in session._pending):
        return "cancelled"
    if session.failed_run_ids:
        return "failure"
    cancelled = (session.cancel_ids & session.completed_run_ids) - session.failed_run_ids
    if cancelled:
        return "cancelled"
    return "success"


def format_harvest_user_text(session: CoordinationSession) -> str:
    return _HARVEST_USER_TEXT[harvest_closing_kind(session)]


def _all_completed_terminal_output(session: CoordinationSession) -> str:
    """Pull ``ALL_COMPLETED.output`` (format_for_ceo / partial) from pending events."""
    from agentcore.runtime.coordination.session import CoordinationEventKind

    chunks: list[str] = []
    for ev in list(getattr(session, "_pending", []) or []):
        if getattr(ev, "kind", None) is not CoordinationEventKind.ALL_COMPLETED:
            continue
        out = (getattr(ev, "payload", None) or {}).get("output")
        if isinstance(out, str) and out.strip():
            chunks.append(out.strip())
    return "\n\n".join(chunks)


def _session_synthesis_or_terminal(session: CoordinationSession) -> str:
    """Prefer CEO ``update_synthesis`` draft; else ALL_COMPLETED terminal body."""
    draft = (getattr(session, "draft", None) or "").strip()
    if draft:
        return draft
    return _all_completed_terminal_output(session)


def _session_saw_channel_dead(session: CoordinationSession, body: str) -> bool:
    if getattr(session, "workspace_channel_dead", False):
        return True
    text = (body or "").lower()
    return any(m.lower() in text for m in _CHANNEL_DEAD_BODY_MARKERS)


def _is_channel_dead_failure_text(text: str | None) -> bool:
    detail = str(text or "").strip()
    if not detail:
        return False
    if detail == CHANNEL_DEAD_PREPARE_ABORT:
        return True
    return is_channel_dead_detail(detail)


def _exc_is_channel_dead(exc: BaseException) -> bool:
    if isinstance(exc, WorkspaceIOError) and _is_channel_dead_failure_text(str(exc)):
        return True
    return _is_channel_dead_failure_text(str(exc))


def _result_is_channel_dead_abort(result: dict[str, Any] | None) -> bool:
    """True when a salvaged harvest turn failed because the workspace channel is dead."""
    if not isinstance(result, dict):
        return False
    err = result.get("error")
    if isinstance(err, dict):
        return _is_channel_dead_failure_text(
            str(err.get("message") or err.get("detail") or "")
        )
    return _is_channel_dead_failure_text(err if isinstance(err, str) else None)


def build_harvest_fallback_content(
    session: CoordinationSession,
    *,
    kind: HarvestKind,
    error_message: str = "",
) -> str:
    """Assemble a no-LLM user-visible closing from existing synthesis/terminal (A1/A2)."""
    body = _session_synthesis_or_terminal(session)
    parts: list[str] = []
    if _session_saw_channel_dead(session, body):
        parts.append(CHANNEL_DEAD_USER_VISIBLE)
    if getattr(session, "exec_env_dead", False) or (
        body and "本机暂时跑不了命令" in body
    ):
        parts.append(EXEC_ENV_DEAD_USER_VISIBLE)
    if body:
        parts.append(body)
    else:
        parts.append(_HARVEST_FALLBACK_EMPTY[kind])
    err = (error_message or "").strip()
    if err:
        parts.append(f"（系统说明：{err}）")
    return "\n\n".join(parts)


async def persist_harvest_fallback(
    *,
    db: Any,
    conversation_id: str,
    execution_id: str,
    user_id: str,
    session: CoordinationSession,
    kind: HarvestKind,
    error_message: str = "",
) -> str:
    """Persist structured fallback assistant row + best-effort push. Returns content."""
    from agentcore.db.repositories import MessageRepository

    content = build_harvest_fallback_content(
        session, kind=kind, error_message=error_message
    )
    await MessageRepository(db).create(
        conversation_id=conversation_id,
        role="assistant",
        content=content,
        metadata={
            "origin": "execution_harvest_fallback",
            "execution_id": execution_id,
            "harvest_kind": kind,
            "no_llm": True,
            "channel_dead": _session_saw_channel_dead(session, content),
        },
    )
    logger.info(
        "coordination.harvest_fallback_persisted",
        conversation_id=conversation_id,
        execution_id=execution_id,
        harvest_kind=kind,
        content_chars=len(content),
        channel_dead=_session_saw_channel_dead(session, content),
    )
    with contextlib.suppress(Exception):
        await notify_user(
            user_id,
            PushNotification(
                title="团队任务已收口（未重新调用模型）",
                body="已将已有综合/终端产出推送到对话；打开查看。",
                data={
                    "conversation_id": conversation_id,
                    "execution_id": execution_id,
                    "origin": "execution_harvest_fallback",
                    "harvest_kind": kind,
                },
            ),
        )
    return content


async def run_harvest_closing_turn(
    *,
    conversation_id: str,
    execution_id: str,
) -> None:
    """Adopt the live execution and run a system closing CEO turn.

    Raises:
        HarvestDeferredError: another turn owns the conversation slot — do **not**
            treat as success or clear the coordination registry.
    """
    from agentcore.runtime.coordination.session import (
        active_coordination,
        adopt_active_execution,
    )

    session = active_coordination(execution_id)
    if session is None:
        logger.info(
            "coordination.harvest_no_session",
            conversation_id=conversation_id,
            execution_id=execution_id,
        )
        return
    if session.turn_attached:
        logger.info(
            "coordination.harvest_skipped_reattached",
            conversation_id=conversation_id,
            execution_id=execution_id,
        )
        return

    # Another turn already owns the conversation slot — keep registry; retry later.
    existing = turn_runs.get(conversation_id)
    if existing is not None and not existing.task.done():
        logger.info(
            "coordination.harvest_deferred_live_turn",
            conversation_id=conversation_id,
            execution_id=execution_id,
        )
        raise HarvestDeferredError(conversation_id, execution_id)

    kind = harvest_closing_kind(session)
    user_text = _HARVEST_USER_TEXT[kind]

    async with async_session_factory() as db:
        conv = await ConversationRepository(db).get_by_id_unscoped(conversation_id)
        if not conv:
            logger.warning(
                "coordination.harvest_conversation_missing",
                conversation_id=conversation_id,
                execution_id=execution_id,
            )
            return
        user_id = str(conv.user_id)
        folder_id = conv.folder_id
        user = await UserRepository(db).get_by_id(user_id)
        if user is None:
            logger.warning(
                "coordination.harvest_user_missing",
                conversation_id=conversation_id,
                execution_id=execution_id,
                user_id=user_id,
            )
            return
        try:
            selection = await resolve_conversation_model_selection(db, conv, user_id)
            llm_credentials: LLMCredentials | None = await preflight_llm_credentials(
                session=db,
                user=user,
                cost_repo=CostEventRepository(db),
                byok_missing_message=(
                    "系统收口需要可用的模型凭证，请先在「设置 · 模型配置」中填入 API Key。"
                ),
                model_origin=selection.origin,
                provider_id=selection.provider_id,
            )
            if selection.origin == "platform":
                llm_credentials = platform_llm_credentials(model=selection.model)
        except AgentCoreError as e:
            logger.warning(
                "coordination.harvest_credentials_unavailable",
                conversation_id=conversation_id,
                execution_id=execution_id,
                error=e.message or str(e),
                code=getattr(e, "code", None),
            )
            # A1: push existing synthesis/terminal without another LLM call.
            with contextlib.suppress(Exception):
                await persist_harvest_fallback(
                    db=db,
                    conversation_id=conversation_id,
                    execution_id=execution_id,
                    user_id=user_id,
                    session=session,
                    kind=kind,
                    error_message=e.message or str(e),
                )
            return
        # Channel already sticky-dead from the team wave: skip prepare/LLM and
        # deliver the same no-LLM fallback (avoid STREAM_ERROR empty shell).
        if getattr(session, "workspace_channel_dead", False):
            logger.warning(
                "coordination.harvest_channel_dead_skip_llm",
                conversation_id=conversation_id,
                execution_id=execution_id,
            )
            with contextlib.suppress(Exception):
                await persist_harvest_fallback(
                    db=db,
                    conversation_id=conversation_id,
                    execution_id=execution_id,
                    user_id=user_id,
                    session=session,
                    kind=kind,
                    error_message=CHANNEL_DEAD_PREPARE_ABORT,
                )
            return
        local_binding = await resolve_local_binding(db, conv)
        profile_set = await resolve_profile_set(db, conv, user_id)
        memory_enabled = await resolve_memory_enabled(db, user_id)
        conversation_history_access = await resolve_conversation_history_access(db, user_id)
        permission_axes = await resolve_permission_axes(db, conversation_id)

        board = await BoardRepository(db).get_by_conversation_id(
            conversation_id, user_id=user_id
        )
        board_id = board.id if board else None
        from agentcore.db.repositories import MessageRepository

        await MessageRepository(db).create(
            conversation_id=conversation_id,
            role="user",
            content=user_text,
            metadata={
                "origin": "execution_harvest",
                "execution_id": execution_id,
                "harvest_kind": kind,
            },
        )
        history = await load_chat_context(db, conversation_id, max_messages=40)

    sink = EventSink()
    backend = await build_turn_backend(
        user_id=user_id,
        conversation_id=conversation_id,
        folder_id=folder_id,
        sink=sink,
        local_binding=local_binding,
    )

    async def _run() -> None:
        from agentcore.runtime.delegate.post_close_gate import (
            EXECUTION_HARVEST_ORIGIN,
            bind_user_message_origin,
            reset_user_message_origin,
        )

        # Adopt before pipeline so CEO wait binds the live execution_id.
        adopt_active_execution(conversation_id, event_sink=sink)
        origin_token = bind_user_message_origin(EXECUTION_HARVEST_ORIGIN)
        try:
            try:
                result = await run_and_persist(
                    conversation_id=conversation_id,
                    user_message=user_text,
                    user_id=user_id,
                    folder_id=folder_id,
                    sink=sink,
                    history=history[:-1] if history else [],
                    attachments=None,
                    backend=backend,
                    llm_credentials=llm_credentials,
                    profile_set=profile_set,
                    memory_enabled=memory_enabled,
                    conversation_history_access=conversation_history_access,
                    permission_axes=permission_axes,
                    board_id=board_id,
                    llm_supports_tools=None,
                    x_client_platform=None,
                )
            except Exception as e:
                if not _exc_is_channel_dead(e):
                    raise
                session.workspace_channel_dead = True
                logger.warning(
                    "coordination.harvest_channel_dead_after_turn",
                    conversation_id=conversation_id,
                    execution_id=execution_id,
                    error=str(e),
                    via="exception",
                )
                async with async_session_factory() as fb_db:
                    with contextlib.suppress(Exception):
                        await persist_harvest_fallback(
                            db=fb_db,
                            conversation_id=conversation_id,
                            execution_id=execution_id,
                            user_id=user_id,
                            session=session,
                            kind=kind,
                            error_message=str(e) or CHANNEL_DEAD_PREPARE_ABORT,
                        )
                return
            if _result_is_channel_dead_abort(result):
                session.workspace_channel_dead = True
                err_text = ""
                raw_err = result.get("error") if isinstance(result, dict) else None
                if isinstance(raw_err, dict):
                    err_text = str(raw_err.get("message") or raw_err.get("detail") or "")
                elif raw_err is not None:
                    err_text = str(raw_err)
                logger.warning(
                    "coordination.harvest_channel_dead_after_turn",
                    conversation_id=conversation_id,
                    execution_id=execution_id,
                    error=err_text or CHANNEL_DEAD_PREPARE_ABORT,
                    via="salvaged_result",
                )
                async with async_session_factory() as fb_db:
                    with contextlib.suppress(Exception):
                        await persist_harvest_fallback(
                            db=fb_db,
                            conversation_id=conversation_id,
                            execution_id=execution_id,
                            user_id=user_id,
                            session=session,
                            kind=kind,
                            error_message=err_text or CHANNEL_DEAD_PREPARE_ABORT,
                        )
                return
        finally:
            reset_user_message_origin(origin_token)
        await _notify_harvest_complete(
            user_id=user_id,
            conversation_id=conversation_id,
            execution_id=execution_id,
            kind=kind,
        )

    import asyncio

    task = asyncio.create_task(
        _run(),
        name=f"harvest-close-{execution_id[:8]}",
    )
    turn_runs.register(conversation_id=conversation_id, task=task, sink=sink)
    # Wait for the closing turn so the harvester can clear the registry afterward
    # if the turn never re-attached (edge failure).
    with contextlib.suppress(asyncio.CancelledError):
        await task
    logger.info(
        "coordination.harvest_closing_turn_done",
        conversation_id=conversation_id,
        execution_id=execution_id,
        harvest_kind=kind,
    )


async def _notify_harvest_complete(
    *,
    user_id: str,
    conversation_id: str,
    execution_id: str,
    kind: HarvestKind = "success",
) -> None:
    title, body = _HARVEST_PUSH[kind]
    with contextlib.suppress(Exception):
        await notify_user(
            user_id,
            PushNotification(
                title=title,
                body=body,
                data={
                    "conversation_id": conversation_id,
                    "execution_id": execution_id,
                    "origin": "execution_harvest",
                    "harvest_kind": kind,
                },
            ),
        )
