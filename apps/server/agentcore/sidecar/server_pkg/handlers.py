"""Sidecar JSON-RPC method handlers."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Annotated, Any

from pydantic import Field, TypeAdapter, ValidationError

from agentcore.api.schemas.messages import ResolveInteractionRequest, interaction_result_from_body
from agentcore.core.logging import get_logger
from agentcore.llm.credentials import LLMCredentials
from agentcore.runtime.interaction import default_interaction_registry
from agentcore.sidecar import protocol
from agentcore.sidecar.paused_store import LocalPausedTurnStore
from agentcore.sidecar.server_pkg.result import parse_decision

logger = get_logger(__name__)

_RESOLVE_ADAPTER: TypeAdapter[ResolveInteractionRequest] = TypeAdapter(
    Annotated[ResolveInteractionRequest, Field(discriminator="kind")]
)


class HandlerMixin:
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
        # ApprovalDecision enum (the gate compares it by identity), a client_tool with
        # its op envelope, etc., exactly as in cloud mode. ask_user / plan_review are no
        # longer resolvable here (挂起即收口 ②, Phase 3 — they finalize and resume cold).
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
        suspension = await self._paused_store.claim(message_id, conversation_id=conversation_id)
        if suspension is None:
            await self._send(
                protocol.make_error(
                    request_id, protocol.PAUSED_TURN_NOT_FOUND, "挂起的回合不存在或已处理"
                )
            )
            return

        decision = parse_decision(params.get("decision"))
        note = str(params.get("note") or "")
        selected = [str(s) for s in (params.get("selected") or [])]
        # Per-turn trace_id (mirrors startTurn): ties this continuation's proxied LLM
        # calls to its write-back so the resumed reply is greppable as one trace.
        trace_id = str(params.get("traceId") or "")
        # Adopt this turn's cloud-proxy token before it runs (refreshes a rotated TTL).
        self._refresh_creds(params)
        task = asyncio.create_task(
            self._run_resume(request_id, suspension, decision, note, selected, trace_id)
        )
        self._turns[message_id] = task

    async def _on_list_paused(self, request_id: Any, params: dict[str, Any]) -> None:
        """A conversation's pending durable pauses, as resume-card summaries.

        Read-only (does not claim); ``resume`` claims. Mirrors the cloud recovery
        snapshot's ``paused`` summaries (``GET .../recovery``) so the desktop renders
        the same resume cards.
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

    async def _on_run_redirect(self, request_id: Any, params: dict[str, Any]) -> None:
        from agentcore.runtime.runs.redirect_queue import enqueue_redirect, peek_redirect_count

        execution_id = str(params.get("executionId") or "").strip()
        run_id = str(params.get("runId") or "").strip()
        feedback = str(params.get("feedback") or "").strip()
        conversation_id = str(params.get("conversationId") or "").strip()
        if not execution_id or not run_id or not feedback or not conversation_id:
            await self._send(
                protocol.make_error(
                    request_id, protocol.INVALID_PARAMS, "runRedirect requires executionId, runId, feedback, conversationId"
                )
            )
            return
        enqueue_redirect(
            execution_id=execution_id,
            run_id=run_id,
            feedback=feedback,
            conversation_id=conversation_id,
        )
        await self._reply(request_id, {"ok": True, "queued": peek_redirect_count(execution_id)})
