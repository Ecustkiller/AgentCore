"""CEO coordinator toolset assembly — ownership lives in ``tools/``.

Runtime (pipeline / resume / prepare) only consumes this; monkeypatch seams
re-export the same symbol from historical import paths.
"""

from __future__ import annotations

from typing import Any

from agentcore.config import settings
from agentcore.llm.profiles import TurnProfiles as ProfileSet
from agentcore.runtime.approvals import ApprovalGate
from agentcore.runtime.events import EventSink
from agentcore.runtime.interaction import default_interaction_registry
from agentcore.runtime.sessions import (
    SessionLoader,
    SessionSaver,
)
from agentcore.runtime.skills import (
    SkillRegistry,
)
from agentcore.runtime.suspension import (
    SuspensionDeleter,
    SuspensionSaver,
)
from agentcore.tools.builtin import (
    build_ceo_tool_registry,
)
from agentcore.tools.builtin.ask_user import AskUserTool
from agentcore.tools.builtin.consult_memory import ConsultMemoryTool
from agentcore.tools.builtin.consult_rule import ConsultRuleTool
from agentcore.tools.builtin.delegate import DelegateTool
from agentcore.tools.builtin.remember import RememberTool
from agentcore.tools.builtin.update_project_profile import UpdateProjectProfileTool
from agentcore.tools.protocol import ToolContext
from agentcore.tools.registration import register_always_ceo_tools
from agentcore.tools.registry import ToolRegistry


def _assemble_ceo_toolset(
    *,
    llm,
    sink: EventSink,
    base_system_prompt: str,
    user_message: str,
    history: list[dict],
    worker_tools: ToolRegistry,
    base_tool_context: ToolContext,
    profiles: ProfileSet,
    approval_gate: ApprovalGate | None,
    session_store,
    session_saver: SessionSaver | None,
    session_loader: SessionLoader | None,
    conversation_id: str,
    captain_run_id: str,
    checkpoint_enabled: bool,
    message_id: str,
    suspension_saver: SuspensionSaver | None,
    suspension_deleter: SuspensionDeleter | None,
    backend_location: str,
    skill_registry: SkillRegistry,
    memory_enabled: bool = True,
    conversation_history_access: bool = True,
    folder_id: str | None = None,
    has_memory_topics: bool = False,
    has_on_demand_rules: bool = False,
    permission_axes=None,
    advertise_bind_local_folder: bool = False,
    desktop_online: bool = False,
) -> tuple[DelegateTool, Any, ToolRegistry]:
    """Wire the CEO coordinator's toolset (delegate + read/retrieval +
    consult_skill + an optional consult_memory + an optional ask_user), shared by a
    fresh turn and a 2b resume.

    The CEO is a COORDINATOR: it holds only the read/retrieval built-ins plus the
    orchestration primitives, never the mutation tools (those live with workers via
    ``delegate``). ``base_system_prompt`` is the CLEAN prompt handed to delegate
    (reused verbatim by workers — no CEO-chat hints). ``skill_registry`` backs
    the CEO-only ``consult_skill`` tool (提示词瘦身 P2): the advanced-mechanism guidance
    is pulled on demand instead of riding the prompt every turn. ``message_id`` + the
    suspension closures arm durable plan_review pauses (结构化挂起 2b) on the
    top-level delegate. Returns ``(delegate_tool, debate_tool, chat_tools)`` — the
    tools whose accumulated usage/ledger/citations the caller folds into the turn totals.
    ``debate_tool`` is always constructed and registered (same always-on tier as ``delegate``).
    """
    delegate_tool = DelegateTool(
        llm=llm,
        sink=sink,
        system_prompt=base_system_prompt,
        user_message=user_message,
        history=history,
        tools=worker_tools,
        base_tool_context=base_tool_context,
        captain_run_id=captain_run_id,
        approval_gate=approval_gate,
        profile_set=profiles,
        session_store=session_store,
        session_saver=session_saver,
        session_loader=session_loader,
        conversation_id=conversation_id,
        registry=default_interaction_registry(),
        checkpoint_timeout_seconds=settings.checkpoint_timeout_seconds,
        checkpoint_enabled=checkpoint_enabled,
        message_id=message_id,
        suspension_saver=suspension_saver,
        suspension_deleter=suspension_deleter,
        folder_id=folder_id,
        memory_enabled=memory_enabled,
        conversation_history_access=conversation_history_access,
        permission_axes=permission_axes,
    )
    chat_tools = build_ceo_tool_registry(
        desktop_online=desktop_online,
        permission_axes=permission_axes,
        backend_location=backend_location,
        include_browser="browser_navigate" in worker_tools.names,
    )
    chat_tools.register(delegate_tool)
    # debate (辩论编排原语): the CEO's对抗性多视角思考 primitive, sibling to delegate —
    # ALWAYS registered (拍板: 模型须能从闲聊开辩), schema 只留短触发 (长文在
    # debate_and_review skill). 非终结且把辩手/主持人的 usage/ledger/citations 累加
    # 在实例上, 由本回合折回总账。→ docs/03-AI核心/辩论编排设计.md
    # Membership / audience live on tool ``registration`` (tools.registration);
    # construction stays here because Delegate/Debate need heavy turn deps.
    # Lazy import: debate package may be mid-edit by a parallel agent.
    from agentcore.tools.builtin.debate import DebateTool

    debate_tool = DebateTool(
        llm=llm,
        sink=sink,
        system_prompt=base_system_prompt,
        user_message=user_message,
        tools=worker_tools,
        base_tool_context=base_tool_context,
        profile_set=profiles,
        captain_run_id=captain_run_id,
        approval_gate=approval_gate,
        # ambient 掌舵：有活跃用户即武装（checkpoint_enabled）；辩论永不硬停，轮次边界非阻塞
        # drain steer 队列。自治 / handoff 不武装 → 纯裁判自判。
        conversation_id=conversation_id,
        ambient_armed=checkpoint_enabled,
        message_id=message_id,
        suspension_saver=suspension_saver,
        suspension_deleter=suspension_deleter,
        folder_id=folder_id,
        memory_enabled=memory_enabled,
        conversation_history_access=conversation_history_access,
        permission_axes=permission_axes,
        registry=default_interaction_registry(),
        # 批 D1：共享会话 roster，开赛探测幕1 透镜 session 作证人。
        session_store=session_store,
        session_loader=session_loader,
    )
    chat_tools.register(debate_tool)
    from agentcore.runtime.resolve.ceo_surface import (
        coordination_surface_active,
        register_coordination_surface,
    )

    # Injection == execution gate for the coord tools (active_coordination):
    # idle chat drops replan + the coordination suite. When a session is already
    # live at assemble time, register here so the first LLM round offers wait.
    # Mid-turn / pre-LLM: promote_coordination_surface_if_needed (tool_round +
    # ensure_coordination_surface_before_llm) when a session starts later.
    register_coordination_surface(
        chat_tools,
        delegate_tool=delegate_tool,
        sink=sink,
        include=coordination_surface_active(
            execution_id=base_tool_context.execution_id
        ),
    )
    # Zero/light-arg ALWAYS orchestration (consult_skill + projects): declaration
    # loop — same helper for fresh assemble and 2b resume (via this function).
    # Heavy ALWAYS (delegate / debate above) stay handwritten.
    register_always_ceo_tools(chat_tools, skill_registry=skill_registry)
    # Memory gate (caller-supplied ``memory_enabled``; product resolve always on /
    # 定案 A): False ⇒ no remember / consult_memory / update_project_profile
    # (always-injected 画像 already gated in pipeline/run.py).
    # consult_memory is further gated by ``has_memory_topics`` — empty catalog ⇒ no tool
    # (aligns with「目录为空不渲染」; compose_ceo_chat_prompt keys the directory on this
    # tool being present). ``remember`` / explore profile stay on whenever memory is on.
    # ``consult_rule`` is independent of the memory gate — on_demand user rules are the
    # user's own instructions; empty on_demand catalog ⇒ not wired (same empty-catalog rule).
    if memory_enabled:
        # Look up via ``resolve.prepare`` so resume/board e2e monkeypatches of
        # ``prepare.default_memory_store`` keep working (historical seam).
        from agentcore.runtime.resolve.prepare import default_memory_store

        mem_store = default_memory_store()
        if has_memory_topics:
            # ``folder_id`` ⇒ project-then-global topic resolution (Agent记忆与知识系统 §二).
            chat_tools.register(ConsultMemoryTool(store=mem_store, folder_id=folder_id))
        # Explicit remember: a user directive is recorded as a USER RULE immediately (§5.7 分流
        # — inferred preferences still go through offline consolidation).
        chat_tools.register(RememberTool(folder_id=folder_id))
        # Explore-act close-out: project ``画像.md`` mid-turn write (§1.5 product exception).
        # Only when the conversation is bound to a project — bare chat has no project layer.
        if folder_id:
            chat_tools.register(
                UpdateProjectProfileTool(
                    folder_id=folder_id,
                    store=mem_store,
                    prompt_holders=[delegate_tool, debate_tool],
                )
            )
    if has_on_demand_rules:
        chat_tools.register(ConsultRuleTool(folder_id=folder_id))
    if checkpoint_enabled:
        # 结构化挂起 2b: arm the ask_user pause with the SAME durable closures as the
        # delegate plan_review — message_id keys the frame, the turn-level constants
        # (captain_run_id / clean base prompt / user_message) let resume re-wire the
        # CEO toolset, and the saver/deleter persist before the wait + drop after a
        # live resolve. A disconnect mid-ask leaves a frame ``POST .../resume`` maps
        # the answer back onto.
        chat_tools.register(
            AskUserTool(
                sink=sink,
                conversation_id=conversation_id,
                timeout_seconds=settings.checkpoint_timeout_seconds,
                captain_run_id=captain_run_id,
                base_system_prompt=base_system_prompt,
                user_message=user_message,
                history=history,
                message_id=message_id,
                suspension_saver=suspension_saver,
                suspension_deleter=suspension_deleter,
                folder_id=folder_id,
                memory_enabled=memory_enabled,
                conversation_history_access=conversation_history_access,
                advertise_bind_local_folder=advertise_bind_local_folder,
            )
        )
    return delegate_tool, debate_tool, chat_tools
