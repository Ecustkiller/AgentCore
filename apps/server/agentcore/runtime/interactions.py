"""Unified interaction primitive: server suspends, waits for a client decision.

Minimal in-memory form of the §18.2 Interaction primitive. A running execution
(inside the SSE request's asyncio task) can suspend on a future; the client's
decision arrives via a separate HTTP request that resolves it.

Process-local and single-worker only — sufficient for the MVP single-machine
deployment. A durable cross-process version (Redis BLPOP) is deferred.
"""

import asyncio
from dataclasses import dataclass

from agentcore.core.logging import get_logger

logger = get_logger(__name__)


@dataclass
class AgentOverride:
    """A user's per-agent override chosen at the team-preview gate (提案 B).

    Each field is the user's authoritative intent for that agent; ``None`` means
    "leave as the orchestrator planned". ``thinking`` / ``reasoning_effort`` are
    still clamped upgrade-only against the tier baseline when the run resolves
    them (see ``llm.config.apply_overrides``), so a user, like the orchestrator,
    raises capability and downgrades by choosing the ``fast`` tier.
    """

    model_preference: str | None = None
    thinking: bool | None = None
    reasoning_effort: str | None = None


@dataclass
class InteractionResponse:
    """A client's reply to a suspended interaction."""

    action: str  # approve | adjust | stop | start | cancel
    feedback: str | None = None
    # Plan-review only: agent_id -> per-agent override chosen by the user before
    # execution starts. None for checkpoint resolutions.
    overrides: dict[str, AgentOverride] | None = None


class InteractionRegistry:
    """Tracks pending interactions awaiting a client response."""

    def __init__(self) -> None:
        self._pending: dict[str, asyncio.Future[InteractionResponse]] = {}

    def create(self, interaction_id: str) -> asyncio.Future[InteractionResponse]:
        """Register a pending interaction and return its awaitable future."""
        loop = asyncio.get_running_loop()
        future: asyncio.Future[InteractionResponse] = loop.create_future()
        self._pending[interaction_id] = future
        return future

    def resolve(self, interaction_id: str, response: InteractionResponse) -> bool:
        """Resolve a pending interaction. Returns False if unknown/already done."""
        future = self._pending.get(interaction_id)
        if future is None or future.done():
            return False
        future.set_result(response)
        return True

    def discard(self, interaction_id: str) -> None:
        self._pending.pop(interaction_id, None)

    async def wait(
        self,
        future: asyncio.Future[InteractionResponse],
        interaction_id: str,
        *,
        timeout: float | None = None,
    ) -> InteractionResponse | None:
        """Await a client response, returning None on timeout."""
        try:
            if timeout is not None:
                return await asyncio.wait_for(future, timeout)
            return await future
        except TimeoutError:
            logger.warning("interaction_timeout", interaction_id=interaction_id)
            return None
        finally:
            self.discard(interaction_id)


interaction_registry = InteractionRegistry()
