"""Shared wiring for one turn's agent-node executor (no nested closures)."""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass

from agentcore.llm.profiles import TurnProfiles as ProfileSet
from agentcore.llm.provider.protocol import LLMProvider
from agentcore.runtime.approvals import ApprovalGate
from agentcore.runtime.events import EventSink
from agentcore.runtime.ports import ClientRequestBridge
from agentcore.runtime.runs.executor_identities import DelegateFactory
from agentcore.runtime.runs.notewall import NoteWall
from agentcore.runtime.runs.plan import RunPlan
from agentcore.tools.protocol import ToolContext
from agentcore.tools.registry import ToolRegistry
from agentcore.workspace.write_claims import WriteCoordinator


@dataclass(slots=True)
class AgentExecutorEnv:
    """Closed-over turn wiring, lifted out of ``build_agent_executor`` nested defs."""

    plan: RunPlan
    llm: LLMProvider
    tools: ToolRegistry
    sink: EventSink
    base_tool_context: ToolContext
    profiles: ProfileSet
    system_prompt: str
    user_message: str
    execution_id: str
    approval_gate: ApprovalGate | None
    delegate_factory: DelegateFactory | None
    interaction_bridge: ClientRequestBridge | None
    escalation_timeout: float | None
    escalation_armed: bool
    note_wall: NoteWall | None
    collaboration: bool
    team_brief: str | None
    write_coordinator: WriteCoordinator
    ancestors_by_id: Mapping[str, frozenset[str]]
    conversation_id: str
    preexisting_files: Callable[[], Awaitable[list[str]]]
    shared_workspace: bool = False
