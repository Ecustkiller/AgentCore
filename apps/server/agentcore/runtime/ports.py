"""Engine host ports — the §18.6 contract the runtime faces (the Sidecar seam).

The engine runs the SAME code locally and in the cloud; everything host-specific is
injected behind a port. This module is the in-code mirror of 执行引擎架构设计 §18.6 —
a single catalog of the seams a future Sidecar (07-规划/远期规划 §一.1) would swap
for local implementations (SQLite / in-memory / in-proc).

Landed as Protocols here:

- **EventSink** — render-stream out (re-exported from ``runtime.events``; already a
  clean seam: the engine emits, the SSE layer consumes).
- **ClientRequestBridge** — the unified suspend-resume bridge for the interaction
  kinds (approval / ask_user / client_tool), implemented by
  ``runtime.interaction.InteractionRegistry``. The engine-side faces depend on this
  port, not the concrete registry.

The remaining §18.6 ports stay as their concrete implementations until the Sidecar
work (07-规划/远期规划 §一.1) needs them swappable — Protocol-izing them now, with
no second implementation to satisfy, would be premature abstraction:

- InferenceGateway → ``llm`` provider (``llm/factory.build_provider`` → DeepSeekProvider)
- ConversationStore → ``conversation/service.py`` (message persistence)
- BillingSink → ``runtime/costing.py`` + cost-event repo
- ArtifactStore → workspace snapshot store (``workspace/…``)
- PauseSignal → ``runtime`` pause flag
- DelegationTransport → ``runtime/runs`` executor (in-proc subtree)
- Journal / SnapshotStore → Phase 2 (目标模型, not yet carried)
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Protocol, runtime_checkable

from agentcore.runtime.events import EventSink

if TYPE_CHECKING:
    import asyncio

    from agentcore.runtime.interaction import InteractionKind, InteractionRequest

__all__ = ["ClientRequestBridge", "EventSink"]


@runtime_checkable
class ClientRequestBridge(Protocol):
    """Unified suspend-resume bridge (§18.6) — see ``runtime.interaction``.

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

    def resolve(
        self, request_id: str, result: Any, *, conversation_id: str
    ) -> bool: ...

    def get(self, request_id: str) -> InteractionRequest | None: ...

    def discard(self, request_id: str) -> None: ...

    def list_pending(
        self, conversation_id: str | None = None
    ) -> list[InteractionRequest]: ...
