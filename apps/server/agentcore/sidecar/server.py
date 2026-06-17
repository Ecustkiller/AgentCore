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
  the shared ``InteractionRegistry`` (§18.6 ClientRequestBridge).
- ``cancel``      — cancel an in-flight turn.
- ``shutdown``    — ask the process loop to stop.

Message + cost persistence land via cloud write-back: this process holds no DB,
so the desktop relays the final result (messages + priced ``cost_runs``) to
``POST .../local-turns`` (see ``_trim_result``). Deferred to later slices: the
Journal and offline LLM. See ``sidecar.__init__``.
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Annotated, Any

from pydantic import Field, TypeAdapter, ValidationError

from agentcore.api.schemas import (
    ResolveInteractionRequest,
    interaction_result_from_body,
)
from agentcore.core.logging import get_logger
from agentcore.llm.byok import LLMCredentials
from agentcore.runtime.events import EventSink
from agentcore.runtime.interaction import default_interaction_registry
from agentcore.runtime.pipeline import run_chat_pipeline
from agentcore.sidecar import protocol
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
        # turn_id → running task, so ``cancel`` can reach an in-flight turn.
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
        self._initialized = True
        logger.info(
            "sidecar.initialized",
            user_id=self._user_id,
            root_label=self._root.name,
            inference="cloud-proxy" if self._creds else "platform-fallback",
            approvals=self._approvals_enabled,
        )
        await self._reply(
            request_id,
            {
                "ok": True,
                "protocolVersion": protocol.PROTOCOL_VERSION,
                "capabilities": {"turns": True, "interactions": True, "cancel": True},
            },
        )

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

    async def _on_cancel(self, request_id: Any, params: dict[str, Any]) -> None:
        turn_id = str(params.get("turnId") or "")
        task = self._turns.get(turn_id)
        if task is not None and not task.done():
            task.cancel()
            await self._reply(request_id, {"cancelled": True})
        else:
            await self._reply(request_id, {"cancelled": False})

    # --- turn execution -------------------------------------------------------

    async def _run_turn(self, request_id: Any, turn_id: str, params: dict[str, Any]) -> None:
        """Run one turn on the local engine; stream events; reply when done."""
        assert self._root is not None  # guarded by _on_start_turn
        conversation_id = str(params.get("conversationId") or turn_id)
        user_message = str(params.get("userMessage") or "")
        history = params.get("history") or []

        sink = EventSink()
        backend = ServerWorkspace(
            root=self._root,
            sandbox=SubprocessSandbox(),
            root_label=self._root.name or "workspace",
            # The sidecar runs ON the user's machine and this root IS their real disk
            # → "local", so the engine gates a delegated worker's machine-touching
            # tools (file_write / code_execute) behind the user's consent, just like
            # cloud local mode. Without this the gate stays off (workers un-gated) even
            # with approvals enabled, since the default backend reports "server".
            location="local",
        )
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
                llm_credentials=self._creds,
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


def _trim_result(turn_id: str, result: dict[str, Any]) -> dict[str, Any]:
    """Project ``run_chat_pipeline``'s result into the JSON-safe startTurn response.

    The live events already carried the streaming detail; the response needs the
    final answer + totals for the bubble, plus the artifacts the desktop relays to
    the cloud for persistence (双模式工作区 §一.1 回写): the assistant ``citations``,
    the replay ``runs`` payload (team graph / 思考·工具 timeline), and the priced
    ``costRuns`` ledger (计费回写, recorded idempotently by run_id). ``finish_reason``
    is a ``FinishReason`` enum, coerced to its string value here.
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
        # sidecar turn lands in durable history + the cost ledger exactly like a cloud
        # turn (the renderer relays them verbatim; it never introspects the ledger).
        "citations": result.get("citations") or [],
        "runs": result.get("runs"),
        "costRuns": result.get("cost_runs") or [],
        "error": result.get("error"),
    }
