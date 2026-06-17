"""SidecarServer — dispatch JSON-RPC methods onto the reused runtime engine.

The server is transport-agnostic: it is constructed with one ``write_line`` sink
(``__main__`` wires it to stdout; tests pass a recorder) and fed inbound lines via
:meth:`handle_line`. It owns the per-session config from ``initialize`` and the
in-flight turn tasks, and translates the engine's ``EventSink`` into ``turn/event``
notifications.

Methods (Slice 1):

- ``initialize``  — bind the session: user id, the local workspace root, and the
  cloud-proxy inference credentials (so the engine's ``build_provider`` reaches
  DeepSeek through the cloud, never holding the platform key locally).
- ``startTurn``   — run one turn through ``run_chat_pipeline`` against the local
  directory; stream its events as notifications; the JSON-RPC *response* to this
  request is deferred until the turn finishes and carries the final result.
- ``respond``     — settle a suspended interaction (approval / ask_user / …) via
  the shared ``InteractionRegistry`` (§18.6 ClientRequestBridge). This is the LIVE
  resolve: it reaches a turn still paused in THIS process.
- ``resume``      — continue a turn that paused at a plan_review / ask_user
  checkpoint and was DURABLY persisted, then lost its process (app restart). Claims
  the local frame and rebuilds the turn via ``resume_chat_pipeline``.
- ``listPaused``  — a conversation's pending durable pauses, for reopen hydration.
- ``cancel``      — cancel an in-flight turn.
- ``shutdown``    — ask the process loop to stop.

Durable pause/resume (双模式工作区 / 远期规划 §一.1): plan_review / ask_user pauses are
persisted to a **local** flat-file store (:class:`LocalPausedTurnStore`, rooted at the
desktop-provided ``dataDir``) — the §18.6 paused-turn port's local impl — so a pause
survives this subprocess dying. ``resume`` / ``listPaused`` back the desktop's resume
cards. approval / client_tool pauses stay in-memory (live ``respond`` only), matching
the cloud (设计 §4.7). Without a ``dataDir`` the store is absent and pauses degrade to
process-lifetime only (the prior behaviour).

Message persistence lands via cloud write-back: this process holds no DB, so the
desktop relays the final result (messages + citations + replay ``runs``) to
``POST .../local-turns`` (see ``_trim_result``). Spend is metered authoritatively at
the cloud inference proxy (Slice 4a), not relayed from here. Deferred to later slices:
the execution-level Journal (offline replay) and offline LLM. See ``sidecar.__init__``.
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import Awaitable, Callable
from dataclasses import replace
from pathlib import Path
from typing import Annotated, Any

from pydantic import Field, TypeAdapter, ValidationError

from agentcore.api.schemas import (
    ResolveInteractionRequest,
    interaction_result_from_body,
)
from agentcore.core.logging import get_logger
from agentcore.llm.byok import INFERENCE_CONVERSATION_HEADER, LLMCredentials
from agentcore.runtime.checkpoints import CheckpointDecision
from agentcore.runtime.events import EventSink
from agentcore.runtime.interaction import default_interaction_registry
from agentcore.runtime.pipeline import resume_chat_pipeline, run_chat_pipeline
from agentcore.runtime.suspension import TurnSuspension
from agentcore.sidecar import protocol
from agentcore.sidecar.paused_store import LocalPausedTurnStore
from agentcore.tools.sandbox.subprocess import SubprocessSandbox
from agentcore.workspace.server import ServerWorkspace

logger = get_logger(__name__)

# Validates an inbound ``respond`` payload into the same discriminated body the cloud
# resolve route accepts, so the kind-specific result is built identically (and an
# approval becomes a real ApprovalDecision enum, not a bare string the gate's identity
# checks would miss).
_RESOLVE_ADAPTER: TypeAdapter[ResolveInteractionRequest] = TypeAdapter(
    Annotated[ResolveInteractionRequest, Field(discriminator="kind")]
)


class SidecarServer:
    """Routes inbound JSON-RPC lines to the engine and streams events back out."""

    def __init__(self, write_line: Callable[[str], Awaitable[None]]) -> None:
        self._write_line = write_line
        # Set by ``initialize``; until then every turn-bearing method is refused.
        self._initialized = False
        self._user_id = ""
        self._root: Path | None = None
        self._creds: LLMCredentials | None = None
        self._approvals_enabled = True
        # The local durable-pause store (§18.6 paused-turn port, local impl), set from
        # ``initialize``'s ``dataDir``. ``None`` ⇒ no data dir ⇒ pauses stay in-memory.
        self._paused_store: LocalPausedTurnStore | None = None
        # turn_id → running task, so ``cancel`` can reach an in-flight turn. A resume
        # registers under its message_id, so a cancel during resume reaches it too.
        self._turns: dict[str, asyncio.Task[None]] = {}
        # Fire-and-forget sends spawned during cancellation; kept referenced so
        # they are not garbage-collected before they flush.
        self._pending_sends: set[asyncio.Task[None]] = set()
        # Flipped by ``shutdown`` so the process loop can exit cleanly.
        self.shutdown_requested = asyncio.Event()

    # --- transport-facing entry point -----------------------------------------

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
                    protocol.make_error(
                        request_id, protocol.INVALID_REQUEST, "missing method"
                    )
                )
            return

        try:
            await self._dispatch(request_id, method, params)
        except Exception as e:  # a dispatch bug must not kill the read loop
            logger.error("sidecar.dispatch_failed", method=method, error=str(e), exc_info=True)
            if request_id is not None:
                await self._send(
                    protocol.make_error(request_id, protocol.INTERNAL_ERROR, str(e))
                )

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
        elif method == "shutdown":
            self.shutdown_requested.set()
            await self._reply(request_id, {"ok": True})
        else:
            await self._send(
                protocol.make_error(
                    request_id, protocol.METHOD_NOT_FOUND, f"unknown method: {method}"
                )
            )

    # --- methods --------------------------------------------------------------

    async def _on_initialize(self, request_id: Any, params: dict[str, Any]) -> None:
        root_raw = str(params.get("workspaceRoot") or "").strip()
        root = Path(root_raw)
        if not root_raw or not root.is_dir():
            await self._send(
                protocol.make_error(
                    request_id,
                    protocol.INVALID_PARAMS,
                    f"workspaceRoot is not an existing directory: {root_raw!r}",
                )
            )
            return

        self._user_id = str(params.get("userId") or "local")
        self._root = root.resolve()
        self._creds = self._parse_inference(params.get("inference"))
        self._approvals_enabled = bool(params.get("approvalsEnabled", True))
        self._paused_store = self._build_paused_store(params.get("dataDir"))
        self._initialized = True
        logger.info(
            "sidecar.initialized",
            user_id=self._user_id,
            root_label=self._root.name,
            inference="cloud-proxy" if self._creds else "platform-fallback",
            approvals=self._approvals_enabled,
            durable_pause=self._paused_store is not None,
        )
        await self._reply(
            request_id,
            {
                "ok": True,
                "protocolVersion": protocol.PROTOCOL_VERSION,
                "capabilities": {
                    "turns": True,
                    "interactions": True,
                    "cancel": True,
                    # durable plan_review / ask_user resume across a process restart,
                    # gated on a usable local data dir.
                    "durablePause": self._paused_store is not None,
                },
            },
        )

    @staticmethod
    def _build_paused_store(raw: Any) -> LocalPausedTurnStore | None:
        """Build the local durable-pause store from ``initialize``'s ``dataDir``.

        ``dataDir`` is the desktop's per-app data dir (e.g. ``<userData>/sidecar``);
        frames land under ``<dataDir>/paused``. Absent / blank ⇒ ``None`` ⇒ pauses
        stay in-memory (process-lifetime), the pre-durable behaviour.
        """
        data_dir = str(raw or "").strip()
        if not data_dir:
            return None
        return LocalPausedTurnStore(Path(data_dir) / "paused")

    @staticmethod
    def _parse_inference(raw: Any) -> LLMCredentials | None:
        """Build the per-turn cloud-proxy credentials from ``initialize`` params.

        ``inference = {baseUrl, apiKey}`` points the engine's ``build_provider`` at
        the cloud inference proxy (so the platform key never lands on the user's
        machine). ``None`` / missing falls back to the sidecar's own server config
        (a dev convenience — never the production posture).
        """
        if not isinstance(raw, dict):
            return None
        base_url = str(raw.get("baseUrl") or "").strip()
        api_key = str(raw.get("apiKey") or "").strip()
        if not base_url or not api_key:
            return None
        return LLMCredentials(api_key=api_key, base_url=base_url)

    def _refresh_creds(self, params: dict[str, Any]) -> None:
        """Refresh session creds from a per-turn ``inference`` block when present.

        A sidecar is long-lived (one per root, until app quit) but the cloud-proxy
        token rotates (12h TTL), so the desktop re-sends the current ``inference`` on
        every startTurn / resume — this keeps a day-long session from 401-ing once the
        initialize-time token expires. Absent ⇒ keep the initialize-time creds (e.g.
        the dev platform-fallback).
        """
        if "inference" in params:
            self._creds = self._parse_inference(params.get("inference"))

    async def _on_start_turn(self, request_id: Any, params: dict[str, Any]) -> None:
        if not self._initialized or self._root is None:
            await self._send(
                protocol.make_error(
                    request_id, protocol.NOT_INITIALIZED, "initialize must be called first"
                )
            )
            return
        turn_id = str(params.get("turnId") or "").strip()
        if not turn_id:
            await self._send(
                protocol.make_error(request_id, protocol.INVALID_PARAMS, "turnId is required")
            )
            return
        if turn_id in self._turns:
            await self._send(
                protocol.make_error(
                    request_id, protocol.INVALID_PARAMS, f"turn already running: {turn_id}"
                )
            )
            return

        # Adopt this turn's cloud-proxy token before it runs (refreshes a rotated TTL).
        self._refresh_creds(params)

        # The response to startTurn is DEFERRED until the turn completes (it carries
        # the final result); the live events flow as ``turn/event`` notifications in
        # the meantime. Spawning a task lets ``respond`` / ``cancel`` be serviced by
        # the read loop while the turn runs.
        task = asyncio.create_task(self._run_turn(request_id, turn_id, params))
        self._turns[turn_id] = task

    async def _on_respond(self, request_id: Any, params: dict[str, Any]) -> None:
        interaction_id = str(params.get("requestId") or "")
        conversation_id = str(params.get("conversationId") or "")
        try:
            body = _RESOLVE_ADAPTER.validate_python(params.get("result"))
        except ValidationError as e:
            await self._send(
                protocol.make_error(
                    request_id, protocol.INVALID_PARAMS, f"invalid respond result: {e}"
                )
            )
            return

        # Mirror the cloud resolve route's guards (routes/conversations.py): refuse a
        # stale / cross-conversation / kind-mismatched settle, and build the kind's
        # typed result via the SHARED projection — so an approval resolves with an
        # ApprovalDecision enum (the gate compares it by identity), an ask_user /
        # plan_review with a CheckpointResponse, etc., exactly as in cloud mode.
        registry = default_interaction_registry()
        pending = registry.get(interaction_id)
        if (
            pending is None
            or pending.conversation_id != conversation_id
            or pending.kind != body.kind
        ):
            await self._reply(request_id, {"resolved": False})
            return
        resolved = registry.resolve(
            interaction_id,
            interaction_result_from_body(body),
            conversation_id=conversation_id,
        )
        await self._reply(request_id, {"resolved": bool(resolved)})

    async def _on_resume(self, request_id: Any, params: dict[str, Any]) -> None:
        """Continue a durably-paused turn on a fresh process (结构化挂起 2b resume).

        Mirrors the cloud ``POST .../resume`` route: claim the local frame (atomic,
        so a turn never resumes twice) then drive the rest of the turn on a fresh
        sink, replying with the same final-result shape as ``startTurn``. The
        message_id doubles as the event-routing turn id (one durable pause per turn).
        """
        if not self._initialized or self._root is None:
            await self._send(
                protocol.make_error(
                    request_id, protocol.NOT_INITIALIZED, "initialize must be called first"
                )
            )
            return
        message_id = str(params.get("messageId") or "").strip()
        conversation_id = str(params.get("conversationId") or "").strip()
        if not message_id or not conversation_id:
            await self._send(
                protocol.make_error(
                    request_id,
                    protocol.INVALID_PARAMS,
                    "messageId and conversationId are required",
                )
            )
            return
        if message_id in self._turns:
            await self._send(
                protocol.make_error(
                    request_id, protocol.INVALID_PARAMS, f"turn already running: {message_id}"
                )
            )
            return
        if self._paused_store is None:
            await self._send(
                protocol.make_error(
                    request_id, protocol.INVALID_PARAMS, "durable pause is not enabled"
                )
            )
            return
        suspension = await self._paused_store.claim(
            message_id, conversation_id=conversation_id
        )
        if suspension is None:
            await self._send(
                protocol.make_error(
                    request_id, protocol.PAUSED_TURN_NOT_FOUND, "挂起的回合不存在或已处理"
                )
            )
            return

        decision = _parse_decision(params.get("decision"))
        note = str(params.get("note") or "")
        selected = [str(s) for s in (params.get("selected") or [])]
        # Adopt this turn's cloud-proxy token before it runs (refreshes a rotated TTL).
        self._refresh_creds(params)
        task = asyncio.create_task(
            self._run_resume(request_id, suspension, decision, note, selected)
        )
        self._turns[message_id] = task

    async def _on_list_paused(self, request_id: Any, params: dict[str, Any]) -> None:
        """A conversation's pending durable pauses, as resume-card summaries.

        Read-only (does not claim); ``resume`` claims. Mirrors the cloud
        ``GET .../paused`` shape so the desktop renders the same resume cards.
        """
        conversation_id = str(params.get("conversationId") or "").strip()
        if self._paused_store is None or not conversation_id:
            await self._reply(request_id, {"data": []})
            return
        summaries = await self._paused_store.list_summaries(conversation_id)
        await self._reply(request_id, {"data": summaries})

    async def _on_cancel(self, request_id: Any, params: dict[str, Any]) -> None:
        turn_id = str(params.get("turnId") or "")
        task = self._turns.get(turn_id)
        if task is not None and not task.done():
            task.cancel()
            await self._reply(request_id, {"cancelled": True})
        else:
            await self._reply(request_id, {"cancelled": False})

    # --- turn execution -------------------------------------------------------

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

    def _creds_for(self, conversation_id: str) -> LLMCredentials | None:
        """Session creds + this turn's conversation header for the cloud inference
        proxy (Slice 4a), so spend attributes to the right conversation.

        Per-turn (one sidecar serves many conversations), so the session creds get a
        fresh per-turn copy. None creds (dev platform-fallback, no proxy) stay None.
        """
        if self._creds is None:
            return None
        return replace(
            self._creds,
            extra_headers={
                **(self._creds.extra_headers or {}),
                INFERENCE_CONVERSATION_HEADER: conversation_id,
            },
        )

    async def _run_turn(self, request_id: Any, turn_id: str, params: dict[str, Any]) -> None:
        """Run one turn on the local engine; stream events; reply when done."""
        assert self._root is not None  # guarded by _on_start_turn
        conversation_id = str(params.get("conversationId") or turn_id)
        user_message = str(params.get("userMessage") or "")
        history = params.get("history") or []

        turn_creds = self._creds_for(conversation_id)

        sink = EventSink()
        backend = self._make_backend()
        saver, deleter = self._suspension_hooks()
        pump = asyncio.create_task(self._pump(turn_id, sink))
        try:
            result = await run_chat_pipeline(
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
            )
            await pump  # pipeline closed the sink → all events flushed
            await self._send(protocol.make_result(request_id, _trim_result(turn_id, result)))
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
    ) -> None:
        """Rebuild + finish a durably-paused turn; stream events; reply when done.

        The frame was already claimed (atomic) by ``_on_resume``; this just runs
        ``resume_chat_pipeline`` (which re-wires the CEO toolset, replays the pre-pause
        journal, settles the decision, and continues to the reply) and relays the final
        result for cloud write-back — the SAME result shape as a fresh turn. The
        message_id is the event-routing turn id.
        """
        assert self._root is not None  # guarded by _on_resume
        turn_id = suspension.message_id
        sink = EventSink()
        backend = self._make_backend()
        saver, deleter = self._suspension_hooks()
        pump = asyncio.create_task(self._pump(turn_id, sink))
        try:
            result = await resume_chat_pipeline(
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
                llm_credentials=self._creds_for(suspension.conversation_id),
                suspension_saver=saver,
                suspension_deleter=deleter,
            )
            await pump  # pipeline closed the sink → all events flushed
            await self._send(protocol.make_result(request_id, _trim_result(turn_id, result)))
        except asyncio.CancelledError:
            with contextlib.suppress(Exception):
                await pump
            self._send_soon(
                protocol.make_error(request_id, protocol.TURN_CANCELLED, "turn cancelled")
            )
            raise
        except Exception as e:
            with contextlib.suppress(Exception):
                await pump
            logger.error("sidecar.resume_failed", turn_id=turn_id, error=str(e), exc_info=True)
            await self._send(protocol.make_error(request_id, protocol.INTERNAL_ERROR, str(e)))
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

    # --- outbound -------------------------------------------------------------

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


def _parse_decision(raw: Any) -> CheckpointDecision:
    """Coerce the desktop's decision string into a :class:`CheckpointDecision`.

    The client only ever sends continue / adjust / stop (timeout is engine-set); an
    unknown / missing value defaults to ``CONTINUE`` (proceed) — the safe resume that
    runs the gated downstream as-is rather than dropping work.
    """
    try:
        return CheckpointDecision(str(raw or "").strip())
    except ValueError:
        return CheckpointDecision.CONTINUE


def _trim_result(turn_id: str, result: dict[str, Any]) -> dict[str, Any]:
    """Project ``run_chat_pipeline``'s result into the JSON-safe startTurn response.

    The live events already carried the streaming detail; the response needs the
    final answer + totals for the bubble, plus the artifacts the desktop relays to
    the cloud for persistence (双模式工作区 §一.1 回写): the assistant ``citations`` and
    the replay ``runs`` payload (team graph / 思考·工具 timeline). Spend is NOT relayed —
    it's metered authoritatively at the cloud inference proxy (Slice 4a), not from the
    client. ``finish_reason`` is a ``FinishReason`` enum, coerced to its string value here.
    """
    finish = result.get("finish_reason")
    finish_str = finish.value if hasattr(finish, "value") else (str(finish) if finish else "error")
    return {
        "turnId": turn_id,
        "messageId": result.get("message_id"),
        "content": result.get("content", "") or "",
        "reasoningContent": result.get("reasoning_content"),
        "finishReason": finish_str,
        "rounds": int(result.get("rounds", 0) or 0),
        "usage": {
            "inputTokens": int(result.get("input_tokens", 0) or 0),
            "outputTokens": int(result.get("output_tokens", 0) or 0),
            "reasoningTokens": int(result.get("reasoning_tokens", 0) or 0),
        },
        # Persistence artifacts the desktop forwards to ``POST .../local-turns`` so a
        # sidecar turn lands in durable history exactly like a cloud turn (the renderer
        # relays them verbatim). Spend is metered at the cloud inference proxy (Slice 4a),
        # not relayed from here.
        "citations": result.get("citations") or [],
        "runs": result.get("runs"),
        "error": result.get("error"),
    }
