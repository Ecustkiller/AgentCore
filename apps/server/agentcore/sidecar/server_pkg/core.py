"""SidecarServer core: transport dispatch and outbound I/O."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import replace
from pathlib import Path
from typing import Any

from agentcore.conversation.store.outbox import OutboxStore
from agentcore.core.logging import get_logger
from agentcore.core.types import AutonomyPolicy
from agentcore.llm.credentials import (
    INFERENCE_CONVERSATION_HEADER,
    INFERENCE_TRACE_HEADER,
    LLMCredentials,
)
from agentcore.runtime.suspension import TurnSuspension
from agentcore.sidecar import protocol
from agentcore.sidecar.paused_store import LocalPausedTurnStore
from agentcore.sidecar.server_pkg.handlers import HandlerMixin
from agentcore.sidecar.server_pkg.turns import TurnExecutionMixin
from agentcore.tools.sandbox.subprocess import SubprocessSandbox
from agentcore.workspace.server import ServerWorkspace

logger = get_logger(__name__)


class SidecarServer(HandlerMixin, TurnExecutionMixin):
    """Routes inbound JSON-RPC lines to the engine and streams events back out."""

    def __init__(self, write_line: Callable[[str], Awaitable[None]]) -> None:
        self._write_line = write_line
        # Set by ``initialize``; until then every turn-bearing method is refused.
        self._initialized = False
        self._user_id = ""
        self._root: Path | None = None
        self._creds: LLMCredentials | None = None
        self._approvals_enabled = True
        # The user's capability-authorization posture (安全权限与治理 §三). The sidecar has
        # no users DB — the desktop sends it on initialize and refreshes it per turn/resume
        # (the policy can change mid-session; an initialize snapshot would go stale).
        self._autonomy_policy: AutonomyPolicy = AutonomyPolicy.FIRST_GRANT
        # The local durable-pause store (§8.6 paused-turn port, local impl), set from
        # ``initialize``'s ``dataDir``. ``None`` ⇒ no data dir ⇒ pauses stay in-memory.
        self._paused_store: LocalPausedTurnStore | None = None
        # Progressive outbox (as-built: 双模式工作区 §10.3): sibling of paused under dataDir.
        # ``None`` ⇒ no data dir ⇒ no local outbox (dev without durable write-back).
        self._outbox_store: OutboxStore | None = None
        # turn_id → running task, so ``cancel`` can reach an in-flight turn. A resume
        # registers under its message_id, so a cancel during resume reaches it too.
        self._turns: dict[str, asyncio.Task[None]] = {}
        # Fire-and-forget sends spawned during cancellation; kept referenced so
        # they are not garbage-collected before they flush.
        self._pending_sends: set[asyncio.Task[None]] = set()
        # Flipped by ``shutdown`` so the process loop can exit cleanly.
        self.shutdown_requested = asyncio.Event()

    async def handle_line(self, line: str) -> None:
        """Parse and dispatch one inbound line. Never raises (loop-safe)."""
        line = line.strip()
        if not line:
            return
        try:
            message = protocol.decode_line(line)
        except protocol.ProtocolError as e:
            await self._send(protocol.make_error(None, protocol.PARSE_ERROR, str(e)))
            return

        request_id = message.get("id")
        method = message.get("method")
        params = message.get("params") or {}
        if not isinstance(method, str):
            # A response/notification we did not expect, or a malformed request.
            if request_id is not None:
                await self._send(
                    protocol.make_error(request_id, protocol.INVALID_REQUEST, "missing method")
                )
            return

        try:
            await self._dispatch(request_id, method, params)
        except Exception as e:  # a dispatch bug must not kill the read loop
            logger.error("sidecar.dispatch_failed", method=method, error=str(e), exc_info=True)
            if request_id is not None:
                await self._send(protocol.make_error(request_id, protocol.INTERNAL_ERROR, str(e)))

    async def _dispatch(self, request_id: Any, method: str, params: dict[str, Any]) -> None:
        if method == "initialize":
            await self._on_initialize(request_id, params)
        elif method == "startTurn":
            await self._on_start_turn(request_id, params)
        elif method == "respond":
            await self._on_respond(request_id, params)
        elif method == "resume":
            await self._on_resume(request_id, params)
        elif method == "listPaused":
            await self._on_list_paused(request_id, params)
        elif method == "cancel":
            await self._on_cancel(request_id, params)
        elif method == "runRedirect":
            await self._on_run_redirect(request_id, params)
        elif method == "debateSteer":
            await self._on_debate_steer(request_id, params)
        elif method == "shutdown":
            self.shutdown_requested.set()
            await self._reply(request_id, {"ok": True})
        else:
            await self._send(
                protocol.make_error(
                    request_id, protocol.METHOD_NOT_FOUND, f"unknown method: {method}"
                )
            )

    def _make_backend(self) -> ServerWorkspace:
        """Build the local-disk workspace backend for a turn / resume.

        The sidecar runs ON the user's machine and this root IS their real disk →
        ``location="local"``, so the engine gates a delegated worker's machine-touching
        tools (file_write / code_execute) behind the user's consent, just like cloud
        local mode. Without this the gate stays off (workers un-gated) even with
        approvals enabled, since the default backend reports "server".
        """
        assert self._root is not None  # guarded by callers
        return ServerWorkspace(
            root=self._root,
            sandbox=SubprocessSandbox(),
            root_label=self._root.name or "workspace",
            location="local",
        )

    def _suspension_hooks(
        self,
    ) -> tuple[
        Callable[[TurnSuspension], Awaitable[None]] | None,
        Callable[[str], Awaitable[None]] | None,
    ]:
        """The (saver, deleter) closures the pipeline wires into delegate / ask_user.

        Backed by the local paused-turn store so a pause persists before its wait and
        drops after a live resolve. ``(None, None)`` when no store ⇒ in-memory pause.
        """
        store = self._paused_store
        if store is None:
            return None, None
        return store.save, store.delete

    def _creds_for(
        self, conversation_id: str, trace_id: str = "", message_id: str = ""
    ) -> LLMCredentials | None:
        """Session creds + this turn's conversation/trace/message headers for the cloud
        inference proxy (Slice 4a), so spend attributes to the right conversation,
        every proxied LLM call joins this turn's trace (the write-back reuses the same
        id → ONE trace end-to-end, 打通气泡↔日志), and in-turn proxy rows carry the
        assistant ``message_id`` for daily-request quota (distinct from off-turn background
        rows that intentionally leave message_id NULL).

        Per-turn (one sidecar serves many conversations), so the session creds get a
        fresh per-turn copy. None creds (dev platform-fallback, no proxy) stay None.
        ``trace_id`` / ``message_id`` empty (untraced caller) ⇒ the header is omitted,
        not blank.
        """
        if self._creds is None:
            return None
        from agentcore.llm.credentials import INFERENCE_MESSAGE_HEADER

        extra = {
            **(self._creds.extra_headers or {}),
            INFERENCE_CONVERSATION_HEADER: conversation_id,
        }
        if trace_id:
            extra[INFERENCE_TRACE_HEADER] = trace_id
        if message_id:
            extra[INFERENCE_MESSAGE_HEADER] = message_id
        return replace(self._creds, extra_headers=extra)

    async def _send(self, message: dict[str, Any]) -> None:
        await self._write_line(protocol.encode_line(message))

    def _send_soon(self, message: dict[str, Any]) -> None:
        """Schedule a send on an independent task (for use during cancellation)."""
        task = asyncio.create_task(self._send(message))
        self._pending_sends.add(task)
        task.add_done_callback(self._pending_sends.discard)

    async def _reply(self, request_id: Any, result: Any) -> None:
        """Send a success response, unless the message was a notification (no id)."""
        if request_id is not None:
            await self._send(protocol.make_result(request_id, result))
