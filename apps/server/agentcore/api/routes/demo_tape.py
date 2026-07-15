"""Dev-only demo tape catalog + prepare / auto-start launch.

Gated by ``DEMO_TAPE_REPLAY_ENABLED``: when off, every path returns 404 so the
product surface is unchanged.

- **prepare** (primary): create bare cloud conversation + bind tape; user sends
  any message to trigger replay via the existing turn_runner divert.
- **start** (auto-start): same prepare, then kick off ``stream_chat`` with the
  tape's original user prompt as a detached turn — desktop attaches via
  ``GET …/stream``.
"""

from __future__ import annotations

import asyncio
import time
from typing import Annotated

from fastapi import APIRouter, Depends, Header
from sqlalchemy.ext.asyncio import AsyncSession

from agentcore.api.dependencies import AuthUser, get_db
from agentcore.api.routes.conversations._helpers import (
    _preflight_turn_llm,
    emit_preflight_warnings,
    release_request_db_before_sse,
)
from agentcore.api.schemas.demo_tape import (
    DemoTapeCatalogResponse,
    DemoTapePrepareRequest,
    DemoTapePrepareResponse,
    DemoTapeStartRequest,
    DemoTapeStartResponse,
    DemoTapeSummary,
)
from agentcore.conversation.service import stream_chat
from agentcore.core.logging import get_logger
from agentcore.db.repositories import CostEventRepository, MessageRepository
from agentcore.demo_tape.catalog import list_tapes
from agentcore.demo_tape.launch import prepare_demo_tape_launch, require_replay_enabled
from agentcore.runtime.events import EventSink
from agentcore.runtime.turn_runs import turn_runs

logger = get_logger(__name__)

router = APIRouter(prefix="/demo-tape", tags=["demo-tape"])


async def _wait_for_user_message(conversation_id: str, *, timeout_s: float = 10.0) -> None:
    from agentcore.db.base import async_session_factory

    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        async with async_session_factory() as session:
            msgs, _ = await MessageRepository(session).list_latest(
                conversation_id, limit=1
            )
            if msgs:
                return
        await asyncio.sleep(0.05)
    logger.warning(
        "demo_tape.launch_user_message_timeout",
        conversation_id=conversation_id,
        timeout_s=timeout_s,
    )


async def _wait_for_paused_or_settled(
    conversation_id: str,
    task: asyncio.Task[object],
    *,
    timeout_s: float = 120.0,
) -> None:
    """Block until the tape hits its first durable pause (or the turn ends).

    One-click start returns before the desktop navigates + ``loadRecovery``. If we
    return at user-message time only, a fast tape can pause *after* that recovery
    read — the UI then hydrates the passive「等待开工确认」marker with no
    ResumePrompt, and never grows a collaboration graph. Waiting here makes
    recovery authoritative on first open.
    """
    from agentcore.runtime.suspension_persistence import list_paused_turns

    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if task.done():
            return
        frames = await list_paused_turns(conversation_id)
        if frames:
            return
        await asyncio.sleep(0.05)
    logger.warning(
        "demo_tape.launch_pause_timeout",
        conversation_id=conversation_id,
        timeout_s=timeout_s,
    )


@router.get("", response_model=DemoTapeCatalogResponse)
async def get_demo_tape_catalog(_user: AuthUser) -> DemoTapeCatalogResponse:
    """List available tapes when replay is enabled; 404 when the switch is off."""
    require_replay_enabled()
    tapes = [
        DemoTapeSummary(
            id=t.id,
            title=t.title,
            user_prompt=t.user_prompt,
            duration_ms=t.duration_ms,
            event_count=t.event_count,
        )
        for t in list_tapes()
    ]
    return DemoTapeCatalogResponse(enabled=True, tapes=tapes)


@router.post("/prepare", response_model=DemoTapePrepareResponse)
async def prepare_demo_tape(
    body: DemoTapePrepareRequest,
    user: AuthUser,
    session: AsyncSession = Depends(get_db),
) -> DemoTapePrepareResponse:
    """Create cloud session + bind tape; do **not** start a turn.

    The client navigates into the empty conversation; the next user message
    triggers tape replay (turn_runner divert). ``user_prompt`` is the tape's
    suggested opening line for the operator to type or paste.
    """
    prepared = await prepare_demo_tape_launch(
        tape_id=body.tape_id,
        user=user,
        session=session,
        speed=body.speed,
        max_gap_ms=body.max_gap_ms,
    )
    logger.info(
        "demo_tape.prepare_ready",
        conversation_id=prepared.conversation_id,
        tape_id=prepared.tape.id,
    )
    return DemoTapePrepareResponse(
        conversation_id=prepared.conversation_id,
        tape_id=prepared.tape.id,
        title=prepared.title,
        user_prompt=prepared.user_prompt,
        speed=prepared.speed,
        max_gap_ms=prepared.max_gap_ms,
    )


@router.post("/start", response_model=DemoTapeStartResponse)
async def start_demo_tape(
    body: DemoTapeStartRequest,
    user: AuthUser,
    session: AsyncSession = Depends(get_db),
    x_client_platform: Annotated[str | None, Header(alias="X-Client-Platform")] = None,
) -> DemoTapeStartResponse:
    """Create cloud session, bind tape, start replay turn (attach via GET …/stream)."""
    prepared = await prepare_demo_tape_launch(
        tape_id=body.tape_id,
        user=user,
        session=session,
        speed=body.speed,
        max_gap_ms=body.max_gap_ms,
    )

    preflight = await _preflight_turn_llm(
        session=session,
        user=user,
        cost_repo=CostEventRepository(session),
        needs_tools=True,
    )
    await release_request_db_before_sse(session)

    sink = EventSink()
    emit_preflight_warnings(sink, preflight)
    task = asyncio.create_task(
        stream_chat(
            conversation_id=prepared.conversation_id,
            user_message=prepared.user_prompt,
            user_id=user.user_id,
            sink=sink,
            attachments=[],
            llm_credentials=preflight.credentials,
            llm_supports_tools=preflight.supports_tools,
            x_client_platform=x_client_platform,
        )
    )
    turn_runs.register(
        conversation_id=prepared.conversation_id,
        task=task,
        sink=sink,
    )
    await _wait_for_user_message(prepared.conversation_id)
    await _wait_for_paused_or_settled(prepared.conversation_id, task)

    logger.info(
        "demo_tape.started",
        conversation_id=prepared.conversation_id,
        tape_id=prepared.tape.id,
    )
    return DemoTapeStartResponse(
        conversation_id=prepared.conversation_id,
        tape_id=prepared.tape.id,
        title=prepared.title,
        user_prompt=prepared.user_prompt,
        speed=prepared.speed,
        max_gap_ms=prepared.max_gap_ms,
    )
