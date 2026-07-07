"""Engine host ports — the §8.6 contract the runtime faces (the Sidecar seam).

The engine runs the SAME code locally and in the cloud; everything host-specific is
injected behind a port. This module is the in-code mirror of 执行引擎架构设计 §8.6 —
a single catalog of the seams a fully-offline Sidecar (06-规划/远期规划 §一.1 完全离线)
would swap for local implementations (SQLite / in-memory / in-proc). The Sidecar itself
has landed (hybrid: local engine, cloud persistence/billing — see 双模式工作区 §十); these
ports go local only when offline drives it.

Landed as Protocols here:

- **EventSink** — render-stream out (re-exported from ``runtime.events``; already a
  clean seam: the engine emits, the SSE layer consumes).
- **ClientRequestBridge** — the unified suspend-resume bridge for the interaction
  kinds (approval / ask_user / client_tool), implemented by
  ``runtime.interaction.InteractionRegistry``. The engine-side faces depend on this
  port, not the concrete registry.
- **Journal** — the engine's single durable persistence exit (§8.3 Turn Journal,
  唯一事实源): each turn's ordered execution facts, from which the assistant
  message's replay payload is projected on read. Postgres impl =
  ``db.repositories.TurnJournalRepository``; the ``runs``↔facts transform lives in
  ``runtime/journal.py``.

The remaining §8.6 ports stay as their concrete implementations until 完全离线
(06-规划/远期规划 §一.1) needs them swappable — Protocol-izing them now, with
no second implementation to satisfy, would be premature abstraction:

- InferenceGateway → ``llm`` provider (``llm/factory.build_provider`` → OpenAICompatibleProvider)
- ConversationStore → ``conversation/service.py`` (message persistence)
- BillingSink → ``runtime/costing.py`` + cost-event repo
- ArtifactStore → workspace snapshot store (``workspace/…``)
- PauseSignal → ``runtime`` pause flag
- DelegationTransport → ``runtime/runs`` executor (in-proc subtree)
- SnapshotStore → absorbed by Journal (目标模型, not yet carried)
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Protocol, runtime_checkable

from agentcore.runtime.events import EventSink

if TYPE_CHECKING:
    import asyncio
    from collections.abc import Callable, Sequence

    from agentcore.runtime.interaction import InteractionKind, InteractionRequest

__all__ = ["ClientRequestBridge", "EventSink", "Journal"]


@runtime_checkable
class ClientRequestBridge(Protocol):
    """Unified suspend-resume bridge (§8.6) — see ``runtime.interaction``.

    The engine-side faces (ApprovalGate / AskUserTool / WorkspaceChannel) and the
    resolve endpoint depend on this port rather than the concrete registry, so a
    Sidecar can supply an in-proc bridge without touching them.
    """

    def create(
        self,
        request_id: str,
        conversation_id: str,
        *,
        kind: InteractionKind,
        payload: dict[str, Any] | None = None,
    ) -> asyncio.Future[Any]: ...

    def resolve(self, request_id: str, result: Any, *, conversation_id: str) -> bool: ...

    async def suspend(
        self,
        request_id: str,
        conversation_id: str,
        *,
        kind: InteractionKind,
        payload: dict[str, Any] | None = None,
        timeout: float,
        on_suspended: Callable[[], None] | None = None,
    ) -> Any: ...

    def get(self, request_id: str) -> InteractionRequest | None: ...

    def discard(self, request_id: str) -> None: ...

    def list_pending(self, conversation_id: str | None = None) -> list[InteractionRequest]: ...


@runtime_checkable
class Journal(Protocol):
    """The engine's single durable persistence exit (§8.6 / §8.3 唯一事实源).

    The engine records each turn's ordered execution facts (``{kind, payload, ts}``)
    keyed by ``turn_id`` (== the assistant message id); everything replayable — the
    message's ``runs`` payload — is a projection of these facts (see
    ``runtime/journal.py``). ``record`` replaces a turn's facts wholesale (idempotent
    for a resume reusing the id); ``load_map`` batch-loads for the read-time
    projection. Postgres impl = ``db.repositories.TurnJournalRepository``; a future
    Sidecar swaps a local (SQLite / in-proc) one without touching the engine.
    """

    async def record(
        self,
        *,
        turn_id: str,
        conversation_id: str,
        trace_id: str | None,
        entries: Sequence[dict[str, Any]],
    ) -> None: ...

    async def load(self, turn_id: str) -> list[dict[str, Any]]: ...

    async def load_map(self, turn_ids: Sequence[str]) -> dict[str, list[dict[str, Any]]]: ...
