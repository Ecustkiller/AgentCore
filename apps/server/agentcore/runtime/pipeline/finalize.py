"""Pipeline finalize helpers: runs payload and durable journal entries."""

import contextlib
from dataclasses import asdict
from typing import Any, NamedTuple

from agentcore.config import settings
from agentcore.core.error_codes import ErrorCode
from agentcore.core.errors import error_fields_for
from agentcore.core.logging import get_logger
from agentcore.core.types import ToolEffect, new_id
from agentcore.llm.byok import LLMCredentials
from agentcore.llm.factory import build_provider
from agentcore.llm.modes import ProfileSet, default_profile_set
from agentcore.llm.protocol import LLMMessage, TokenUsage
from agentcore.memory import default_memory_store
from agentcore.runtime.approvals import ApprovalGate
from agentcore.runtime.checkpoints import CheckpointDecision, CheckpointResponse
from agentcore.runtime.citations import merge_citations, out_of_range_markers
from agentcore.runtime.costing import aggregate_cost, captain_run_cost_from_state
from agentcore.runtime.engine import join_segments
from agentcore.runtime.events import (
    EventSink,
    FinishReason,
    checkpoint_resolved,
    citations_event,
    content_delta,
    error_event,
    message_end,
    message_start,
    plan_review_resolved,
)
from agentcore.runtime.facts import (
    TurnFactLog,
    TurnStartedFact,
    current_fact_log,
    record_turn_fact,
)
from agentcore.runtime.interaction import default_interaction_registry
from agentcore.runtime.journal import (
    completed_from_journal,
    entries_from_runs,
    plan_from_journal,
    window_from_journal,
)
from agentcore.runtime.prompt import (
    assemble_system_prompt,
    compose_ceo_chat_prompt,
)
from agentcore.runtime.runs import (
    RunKind,
    RunPhase,
    RunSpec,
    build_captain_executor,
    build_captain_resumer,
)
from agentcore.runtime.sessions import (
    SessionLoader,
    SessionSaver,
    default_session_registry,
)
from agentcore.runtime.skills import (
    SkillRegistry,
    build_system_skill_registry,
)
from agentcore.runtime.suspension import (
    AskUserSuspension,
    PlanReviewSuspension,
    SuspensionDeleter,
    SuspensionSaver,
    TurnSuspension,
    captain_transcript,
    turn_history,
)
from agentcore.tools.builtin import (
    build_ceo_tool_registry,
    build_worker_registry,
    file_mutation_tool_names,
)
from agentcore.tools.builtin.ask_user import AskUserTool, ask_user_tool_result
from agentcore.tools.builtin.consult_skill import ConsultSkillTool
from agentcore.tools.builtin.debate import DebateTool
from agentcore.tools.builtin.delegate import DelegateTool
from agentcore.tools.builtin.revise import ReviseTool
from agentcore.tools.protocol import ToolContext
from agentcore.tools.registry import ToolRegistry
from agentcore.workspace.protocol import WorkspaceBackend

logger = get_logger(__name__)
def _build_runs_payload(sink: EventSink, finish: FinishReason) -> dict | None:
    """Assemble the assistant message's ``runs`` payload from the turn's sink.

    Carries two replay artifacts on one field: the multi-agent ``events`` journal
    (team graph) and the single-agent ``process`` timeline (inline 思考+工具面板).
    A turn is one OR the other — the journal is None unless it delegated/checkpointed,
    the process is None unless it was a tool-using single-agent turn — but the
    shared shape keeps one persistence + load path. Returns None when there is
    nothing to replay (a plain chat turn with neither)."""
    journal = sink.execution_journal()
    process = sink.process_timeline()
    # 上下文传递可视化 通道①: the CEO captain's received context is TURN-LEVEL (the chat
    # bubble, present even in a pure-chat turn). Carrying it makes a pure-chat turn's
    # payload non-None, so it persists a journal (otherwise None-gated) and replays the
    # captain context on reload — the worker-side context already rides ``events``.
    captain_context = sink.captain_context()
    if journal is None and process is None and captain_context is None:
        return None
    payload: dict[str, Any] = {
        "events": journal or [],
        "finish_reason": finish.value,
    }
    if process:
        payload["process"] = process
    if captain_context is not None:
        payload["captain_context"] = captain_context
    return payload


def _durable_journal_entries(
    fact_log: TurnFactLog, runs: dict[str, Any] | None
) -> list[dict[str, Any]] | None:
    """The §18.3 fact log composed into the turn's durable journal entries (or None).

    The fact log is the single ordered stream (execution facts interleaved with the
    forwarded display facts); the durable journal adds the display-only tail the log
    does not carry — the single-agent ``process`` timeline (a post-hoc display
    aggregate) + the closing ``turn_end`` — both read off the already-built ``runs``
    so the two stay consistent. ``runs.events`` is NOT re-appended: those display
    events already ride the fact log (ungated), and the read-side projection
    (:func:`~agentcore.runtime.journal.runs_from_entries`) re-gates them.

    Gated to ``runs`` non-None — the SAME turns that persisted a journal before — so a
    plain chat turn still writes nothing (storage + None-gate parity); resume / salvage
    / local-relay paths carry no fact log and fall back to the legacy ``runs`` flatten.
    """
    if runs is None:
        return None
    tail = entries_from_runs(
        {"process": runs.get("process"), "finish_reason": runs.get("finish_reason")}
    )
    return fact_log.entries() + tail
