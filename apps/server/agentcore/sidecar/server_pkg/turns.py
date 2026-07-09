"""Sidecar turn execution: run, resume, event pump."""

from __future__ import annotations

import asyncio
import contextlib
from typing import Any

from agentcore.core.log_context import log_context
from agentcore.core.logging import get_logger
from agentcore.llm.resolve import resolve_turn_model
from agentcore.runtime.checkpoints import CheckpointDecision
from agentcore.runtime.events import EventSink
from agentcore.runtime.suspension import TurnSuspension
from agentcore.sidecar import protocol
from agentcore.sidecar.server_pkg.result import trim_result

logger = get_logger(__name__)


class TurnExecutionMixin:
    async def _run_turn(self, request_id: Any, turn_id: str, params: dict[str, Any]) -> None:
        """Run one turn on the local engine; stream events; reply when done."""
        assert self._root is not None  # guarded by _on_start_turn
        conversation_id = str(params.get("conversationId") or turn_id)
        user_message = str(params.get("userMessage") or "")
        history = params.get("history") or []
        # The desktop mints one trace_id per local turn and threads it here + into the
        # write-back, so this turn's proxied LLM calls and its persisted reply share it.
        trace_id = str(params.get("traceId") or "")
        # 结构化补轮·B（可逆叫停）：续辩 turn 从收场卡发起时带上一场 debate 的投影种子（普通回合为
        # None）。引擎据此让本场 debate 续上一场（焦点正交、首轮辩手读到上一场摘要）。
        raw_seed = params.get("debateSeed")
        debate_seed = raw_seed if isinstance(raw_seed, dict) else None

        turn_creds = self._creds_for(conversation_id, trace_id, turn_id)

        sink = EventSink()
        backend = self._make_backend()
        saver, deleter = self._suspension_hooks()
        pump = asyncio.create_task(self._pump(turn_id, sink))
        try:
            try:
                # Bind the turn's trace_id here (the cloud binds it in stream_chat; the engine
                # itself doesn't) so the engine's message_start carries it and the live bubble
                # joins the same trace as the proxy logs + write-back (打通气泡↔日志, live ==
                # reload). Task-local + auto-restored; copied into delegated worker tasks.
                with log_context(
                    trace_id=trace_id,
                    conversation_id=conversation_id,
                    user_id=self._user_id,
                ):
                    from agentcore.sidecar import server as sidecar_server

                    result = await sidecar_server.run_chat_pipeline(
                        conversation_id=conversation_id,
                        user_message=user_message,
                        history=list(history),
                        sink=sink,
                        user_id=self._user_id,
                        backend=backend,
                        approvals_enabled=self._approvals_enabled,
                        llm_credentials=turn_creds,
                        suspension_saver=saver,
                        suspension_deleter=deleter,
                        debate_seed=debate_seed,
                    )
            finally:
                # The pipeline no longer closes the sink (its owner does); the sidecar owns
                # this one, so close it on EVERY path — success or crash — or the pump would
                # await the None sentinel forever.
                sink.close()
            await pump  # sink closed above → all events flushed
            # Surface the model this turn actually ran on: creds present ⇒ the
            # cloud-proxy/account model; None (dev fallback) ⇒ settings.platform_model.
            await self._send(
                protocol.make_result(
                    request_id,
                    trim_result(turn_id, result, model=resolve_turn_model(turn_creds)),
                )
            )
        except asyncio.CancelledError:
            with contextlib.suppress(Exception):
                await pump
            # Reply on an independent task: this one is unwinding from cancellation.
            self._send_soon(
                protocol.make_error(request_id, protocol.TURN_CANCELLED, "turn cancelled")
            )
            raise
        except Exception as e:
            with contextlib.suppress(Exception):
                await pump
            logger.error("sidecar.turn_failed", turn_id=turn_id, error=str(e), exc_info=True)
            await self._send(protocol.make_error(request_id, protocol.INTERNAL_ERROR, str(e)))
        finally:
            self._turns.pop(turn_id, None)

    async def _run_resume(
        self,
        request_id: Any,
        suspension: TurnSuspension,
        decision: CheckpointDecision,
        note: str,
        selected: list[str],
        trace_id: str = "",
    ) -> None:
        """Rebuild + finish a durably-paused turn; stream events; reply when done.

        The frame was already claimed (atomic rename to ``.claimed``) by ``_on_resume``;
        this runs ``resume_chat_pipeline`` and, on success, :meth:`confirm_claim` drops
        the ``.claimed`` file. On failure it :meth:`rollback_claim` restores the frame so
        the desktop can retry. The message_id is the event-routing turn id.
        """
        assert self._root is not None  # guarded by _on_resume
        turn_id = suspension.message_id
        # Resolved once so the pipeline runs on it AND the reply surfaces the same model.
        resume_creds = self._creds_for(suspension.conversation_id, trace_id, turn_id)
        sink = EventSink()
        backend = self._make_backend()
        saver, deleter = self._suspension_hooks()
        pump = asyncio.create_task(self._pump(turn_id, sink))
        try:
            try:
                # Bind this continuation's trace_id (same rationale as _run_turn) so the
                # resumed reply's message_start + local logs join its proxy logs + write-back.
                with log_context(
                    trace_id=trace_id,
                    conversation_id=suspension.conversation_id,
                    user_id=self._user_id,
                ):
                    from agentcore.sidecar import server as sidecar_server

                    result = await sidecar_server.resume_chat_pipeline(
                        suspension=suspension,
                        decision=decision,
                        note=note,
                        selected=selected,
                        sink=sink,
                        backend=backend,
                        # The Sidecar has no message DB, so the prior-turn history rides in the
                        # local frame record (rehydrated onto the suspension at claim) — the resume
                        # splices it ahead of the journal-folded rounds (Phase 2 ⑤).
                        history=suspension.history,
                        llm_credentials=resume_creds,
                        suspension_saver=saver,
                        suspension_deleter=deleter,
                    )
            finally:
                # The pipeline no longer closes the sink (its owner does); the sidecar owns
                # this one, so close it on EVERY path — success or crash — or the pump would
                # await the None sentinel forever.
                sink.close()
            await pump  # sink closed above → all events flushed
            # Same model signal as a start turn (see _run_turn): the resumed reply reports
            # the model it actually ran on so the badge stays honest across a resume.
            await self._send(
                protocol.make_result(
                    request_id,
                    trim_result(turn_id, result, model=resolve_turn_model(resume_creds)),
                )
            )
        except asyncio.CancelledError:
            if self._paused_store is not None:
                await self._paused_store.rollback_claim(turn_id)
            with contextlib.suppress(Exception):
                await pump
            self._send_soon(
                protocol.make_error(request_id, protocol.TURN_CANCELLED, "turn cancelled")
            )
            raise
        except Exception as e:
            if self._paused_store is not None:
                await self._paused_store.rollback_claim(turn_id)
            with contextlib.suppress(Exception):
                await pump
            logger.error("sidecar.resume_failed", turn_id=turn_id, error=str(e), exc_info=True)
            await self._send(
                protocol.make_error(
                    request_id,
                    protocol.RESUME_RETRYABLE,
                    str(e),
                )
            )
        else:
            if self._paused_store is not None:
                await self._paused_store.confirm_claim(turn_id)
        finally:
            self._turns.pop(turn_id, None)

    async def _pump(self, turn_id: str, sink: EventSink) -> None:
        """Drain the turn's EventSink, emitting each event as a notification.

        Mirrors the SSE layer's ``_event_generator`` consumer: pull until the sink
        is closed (``None``), forwarding every event verbatim. ``StrEnum`` values in
        the payload (``EventType`` / ``FinishReason``) serialize as plain strings.
        """
        while True:
            event = await sink.get()
            if event is None:
                return
            await self._send(
                protocol.make_notification(
                    "turn/event",
                    {
                        "turnId": turn_id,
                        "event": {
                            "type": event.type.value,
                            "timestamp": event.timestamp,
                            "payload": event.payload,
                        },
                    },
                )
            )
