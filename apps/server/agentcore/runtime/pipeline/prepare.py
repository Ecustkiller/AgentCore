"""Fresh-turn Phase 1: memory, prompts, channels, LLM, base tool context."""

from __future__ import annotations

import json
import time
from collections.abc import Awaitable
from dataclasses import dataclass

import agentcore.runtime.pipeline as pipeline_pkg
from agentcore.board.channel import BoardChannel
from agentcore.config import settings
from agentcore.core.logging import get_logger
from agentcore.core.types import new_id
from agentcore.desktop.channel import DesktopClientChannel
from agentcore.llm.credentials import LLMCredentials
from agentcore.llm.profiles import TurnProfiles
from agentcore.memory import (
    assemble_turn_rules,
    load_memory_topics,
    load_on_demand_user_rules,
)
from agentcore.runtime.context import (
    ProjectCatalogEntry,
    build_workspace_context,
    detect_workspace_git,
    load_project_catalog,
    resolve_channel_profile,
)
from agentcore.runtime.costing import RunCost
from agentcore.runtime.events import EventSink
from agentcore.runtime.interaction import default_interaction_registry
from agentcore.runtime.resolve.prepare import (
    _build_attachment_context,
    _wire_worker_conversation_log_tools,
    merge_attachment_and_mention_context,
)
from agentcore.runtime.resolve.prompt import (
    assemble_system_prompt,
    compose_worker_base_prompt,
)
from agentcore.runtime.skills import build_system_skill_registry
from agentcore.tools.builtin import build_worker_registry
from agentcore.tools.ceo_toolset import wire_worker_consult as _wire_worker_consult_tools
from agentcore.tools.protocol import ToolContext
from agentcore.tools.registry import ToolRegistry
from agentcore.vision import resolve_vision_reader_for_conversation
from agentcore.workspace.locate import workspace_channel_for_tools
from agentcore.workspace.protocol import WorkspaceBackend

logger = get_logger(__name__)


async def _timed_phase[T](phase: str, awaitable: Awaitable[T]) -> T:
    """Await ``awaitable`` and emit one ``chat.prepare_phase`` line (phase + ms)."""
    started = time.monotonic()
    try:
        return await awaitable
    finally:
        logger.info(
            "chat.prepare_phase",
            phase=phase,
            ms=int((time.monotonic() - started) * 1000),
        )


@dataclass
class PreparedTurn:
    """Phase-1 outputs shared by assemble + execute."""

    llm: object
    system_prompt: str
    worker_base_prompt: str
    worker_tools: ToolRegistry
    skill_registry: object
    board_channel: BoardChannel | None
    base_tool_context: ToolContext
    vision_cost_sink: list[RunCost]
    attachment_context: str
    native_image_parts: list[dict]
    memory_topics: list
    on_demand_rules: list
    project_catalog: list[ProjectCatalogEntry]
    bound_execution_id: str
    execution_id_token: object


async def prepare_fresh_turn(
    *,
    conversation_id: str,
    user_id: str,
    backend: WorkspaceBackend,
    sink: EventSink,
    folder_id: str | None,
    board_id: str | None,
    attachments: list[dict] | None,
    memory_enabled: bool,
    conversation_history_access: bool = True,
    permission_axes,
    llm_credentials: LLMCredentials | None,
    x_client_platform: str | None,
    profiles: TurnProfiles | None = None,
    agent_mentions: list[dict] | None = None,
    folder_binding_injected: bool = False,
    folder_local_root_id: str | None = None,
    folder_local_subpath: str | None = None,
) -> PreparedTurn:
    """Build the stable base prompt, worker tools, channels, and tool context."""
    # Long-term memory injection is gated by the caller-supplied ``memory_enabled``
    # flag (product resolve is always True / 定案 A): when False we inject nothing
    # (an empty body drops the <rules> memory section) — retained for internal
    # False-path tests and durable suspension frames.
    # 记忆作用域 (§5.2): the always-injected core spans global 偏好.md + 画像.md and — when
    # the conversation is in a project — that project's 画像.md, concatenated global-first
    # (stable prefix) into one <rules> body. ``memory_enabled=False`` ⇒ "".
    # Look up via ``pipeline.run`` so governance tests can monkeypatch the seam
    # (``test_pipeline_governance._patch_pipeline``).
    from agentcore.runtime.pipeline import run as run_mod

    memory_store = run_mod.default_memory_store()
    # Read-side full injection (Agent记忆与知识系统 · 目标形态): every always-on entry in
    # display order; write-side quota owns「常驻满了」. AI memory rides the (patchable) store
    # seam; user rules degrade to none on failure so this can never break a turn.
    rules_markdown = await _timed_phase(
        "rules",
        assemble_turn_rules(
            memory_store,
            user_id,
            folder_id=folder_id,
            enabled=memory_enabled,
        ),
    )
    # 记忆主题 / 按需规则仍加载（巩固 / 其它调用方）；按需目录改由 MergedConsultSource 统一列出。
    memory_topics = await _timed_phase(
        "memory_topics",
        load_memory_topics(
            memory_store, user_id, folder_id=folder_id, enabled=memory_enabled
        ),
    )
    on_demand_rules = await _timed_phase(
        "on_demand_rules",
        load_on_demand_user_rules(user_id, folder_id=folder_id),
    )
    # Derived cross-project roster (跨项目找项目): Folder name + 画像.md first line,
    # recent-activity ordered with a hard count cap. Outside ``<rules>`` so it never
    # evicts always memory. Empty when the user has no projects.
    project_catalog = await _timed_phase(
        "project_catalog",
        load_project_catalog(memory_store, user_id),
    )
    # Clean, stable base (base + date + workspace facts + memory): NO attachments,
    # NO CEO hints. This is the cacheable prefix shared by the CEO and reused
    # verbatim by workers. Environment facts ride the shared base so workers also
    # know execution location (防止空云 scratch 里幻觉装软件). The (per-turn, variable)
    # attachment block is appended LAST below — after the stable CEO hint stack —
    # so a turn carrying attached files does not bust DeepSeek's prefix cache for
    # the hints (缓存友好: 易变内容置于稳定前缀之后).
    # Host / MCP backfill needs a desktop client — orthogonal to workspace location.
    channel = resolve_channel_profile(x_client_platform)
    desktop_online = channel.desktop_online
    # Sticky channel-dead (e.g. baseline already hung the desktop): abort before
    # probe / MCP / exists burn more wall clock and before assemble + LLM.
    from agentcore.workspace.channel import raise_if_backend_channel_dead

    raise_if_backend_channel_dead(backend)
    from agentcore.tools.sandbox.exec_languages import resolve_exec_languages

    exec_languages = await _timed_phase(
        "exec_languages", resolve_exec_languages(backend)
    )
    # Desktop channel early: MCP discovery (stdio on desktop) must complete before
    # workspace_context stamps mcp= — same ClientTool sink the turn will stream.
    desktop_channel = (
        DesktopClientChannel(
            sink=sink,
            conversation_id=conversation_id,
            registry=default_interaction_registry(),
            timeout_seconds=settings.board_op_timeout_seconds,
        )
        if desktop_online
        else None
    )
    from agentcore.tools.mcp import discover_mcp_tools, mcp_capability_label, register_mcp_tools

    mcp_discover = await _timed_phase(
        "mcp",
        discover_mcp_tools(desktop_channel, cache_scope=user_id, cache_only=True),
    )
    mcp_label = mcp_capability_label(mcp_discover, desktop_online=desktop_online)
    git_fact = await _timed_phase("git", detect_workspace_git(backend))
    # exists/.git (and similar) may sticky-dead after prior timeouts — stop here.
    raise_if_backend_channel_dead(backend)
    workspace_facts = build_workspace_context(
        backend,
        desktop_online=desktop_online,
        exec_languages=exec_languages,
        permission_axes=permission_axes,
        mcp_enabled=mcp_discover.tool_count > 0,
        mcp_label=mcp_label,
        git_fact=git_fact,
    )
    system_prompt = assemble_system_prompt(
        rules_markdown=rules_markdown,
        workspace_context=workspace_facts,
    )
    # Resolve vision before attachment context so resident images can eye→text.
    # Turn-level ``role=vision`` sink is shared by REFERENCE with ToolContext
    # (board_read + attachment reads; executor ``replace`` keeps the same list).
    vision_cost_sink: list[RunCost] = []
    vision_reader = await _timed_phase(
        "vision",
        resolve_vision_reader_for_conversation(
            user_id=user_id, conversation_id=conversation_id
        ),
    )
    from agentcore.llm.model_metadata import model_has_curated_vision

    main_model = profiles.model_for("chat") if profiles is not None else ""
    # Curated table only — never keyword-derived catalog tags (false vision → 400).
    main_native_vision = model_has_curated_vision(main_model)
    native_image_parts: list[dict] = []
    attachment_context = await _timed_phase(
        "attachments",
        _build_attachment_context(
            attachments,
            user_id=user_id,
            host_conversation_id=conversation_id,
            conversation_history_access=conversation_history_access,
            vision_reader=None if main_native_vision else vision_reader,
            backend=backend,
            cost_sink=None if main_native_vision else vision_cost_sink,
            main_native_vision=main_native_vision,
            native_image_parts=native_image_parts if main_native_vision else None,
        ),
    )
    attachment_context = merge_attachment_and_mention_context(
        attachment_context, agent_mentions
    )
    from agentcore.workspace.sparse_listing import collect_turn_material_paths

    material_paths = collect_turn_material_paths(attachments)
    backend.ai_list_materials = material_paths
    # Workers hold no CEO hints; their base is the shared base + optional simplified
    # ``<按需目录>`` + the same attachment block at the end.
    from agentcore.runtime.capability_packs import enabled_packs

    skill_registry = build_system_skill_registry(enabled_packs=enabled_packs())
    worker_tools = build_worker_registry(
        backend=backend,
        permission_axes=permission_axes,
        languages=exec_languages if backend.location == "local" else None,
        desktop_online=desktop_online,
    )
    register_mcp_tools(worker_tools, mcp_discover)
    await _wire_worker_consult_tools(
        worker_tools,
        skill_registry=skill_registry,
        memory_enabled=memory_enabled,
        folder_id=folder_id,
        user_id=user_id,
    )
    _wire_worker_conversation_log_tools(
        worker_tools,
        conversation_history_access=conversation_history_access,
        folder_id=folder_id,
    )
    on_demand_entries: list = []
    worker_consult = worker_tools.get_optional("consult")
    if worker_consult is not None and getattr(worker_consult, "source", None) is not None:
        on_demand_entries = list(await worker_consult.source.list_directory(user_id))
    worker_base_prompt = compose_worker_base_prompt(
        system_prompt,
        on_demand_entries=on_demand_entries,
        attachment_context=attachment_context,
    )
    # System skills back the unified consult tool + ``<按需目录>`` (CEO wires later).
    # Capability packs (e.g. legal) layer in for every user when the deployment gate is on.
    # 真·多模型辩手：回合 llm = DeepSeek 默认（``build_provider``，保留可测试打桩的 seam）
    # 外包一层 ProviderRouter。无前缀模型（CEO / 委派 / 主持人）照走默认，仅辩论辩手 side
    # 带 ``provider/model`` 前缀的调用路由到对应厂商。无厂商 key 时只是空包一层，零行为变化。
    # Cross-provider Worker 默认经 ``build_turn_router`` 注入 BYOK extras。
    # 路由器接管默认 + 厂商 client 的生命周期，由下方 finally 的 ``await llm.close()`` 释放。
    from agentcore.llm.credentials import bind_credential_pricing_context

    # Call-level pricing + optional user unit card (同路贯穿 calculate_cost).
    bind_credential_pricing_context(llm_credentials)
    llm = await _timed_phase(
        "llm",
        pipeline_pkg.build_turn_router(
            llm_credentials, user_id=user_id, profiles=profiles
        ),
    )
    # AI 协作白板 (§六 M2): a board-bound turn gets a BoardChannel so ``board_ops`` can
    # reach the user's open canvas via the desktop. Bound to this board + conversation
    # on the shared interaction bridge (same registry the resolve endpoint settles).
    # ``None`` for an ordinary chat — then the tool below is never wired either.
    board_channel = (
        BoardChannel(
            sink=sink,
            conversation_id=conversation_id,
            board_id=board_id,
            registry=default_interaction_registry(),
            timeout_seconds=settings.board_op_timeout_seconds,
        )
        if board_id
        else None
    )
    # desktop_channel created earlier (MCP discovery); reuse the same instance.
    workspace_channel = workspace_channel_for_tools(
        backend,
        sink=sink,
        conversation_id=conversation_id,
    )

    # 深度研究自治：会话旗标 + 自动开辩计数（kickoff / ceo_format 经 ToolContext 读取）。
    from agentcore.runtime.deep_research_auto import load_deep_research_auto_state

    deep_research_auto, deep_research_auto_debate_count = (
        await load_deep_research_auto_state(conversation_id)
    )

    # The workspace backend is resolved per conversation by the caller
    # (folder space vs. its own conversation space) and injected here. The
    # engine and tools never see a Path — they only touch ``context.backend``.
    base_tool_context = ToolContext.create(
        execution_id=new_id(),
        run_id=new_id(),
        agent_id="default",
        backend=backend,
        user_id=user_id,
        conversation_id=conversation_id,
        permission_axes=(
            json.dumps(permission_axes.to_dict()) if permission_axes is not None else None
        ),
        deep_research_auto=deep_research_auto,
        deep_research_auto_debate_count=deep_research_auto_debate_count,
        board_channel=board_channel,
        desktop_channel=desktop_channel,
        workspace_channel=workspace_channel,
        # Profile vision slot → reader; else platform VISION_* when billing_mode=platform.
        # Same instance already used for attachment eye→text above.
        vision_reader=vision_reader,
        cost_sink=vision_cost_sink,
        shared_workspace=folder_id is not None,
        material_paths=material_paths,
        attachment_context=attachment_context,
        folder_binding_injected=folder_binding_injected,
        folder_local_root_id=folder_local_root_id,
        folder_local_subpath=folder_local_subpath or None,
    )
    # Bare-chat landing desk: seed turn hint + bind CEO file tools (never birth folder_id).
    if folder_id is None:
        from agentcore.runtime.delegate.target_desktop import (
            _load_auto_desk_folder_id,
            bind_tool_context_to_landing_desk,
        )

        auto_desk = await _load_auto_desk_folder_id(
            user_id=user_id, conversation_id=conversation_id
        )
        if auto_desk:
            base_tool_context.auto_desk_folder_id = auto_desk
            base_tool_context.turn_target_desk.note_folder(auto_desk)
            await bind_tool_context_to_landing_desk(
                base_tool_context, folder_id=auto_desk
            )
    from agentcore.runtime.closing_posture import (
        clear_b1_closing_latches,
        clear_cloud_web_verify_gap,
        clear_cutoff_delivery_gap,
        clear_unresolved_write_ownership,
    )
    from agentcore.runtime.coordination.session import current_execution_id
    from agentcore.runtime.delegate.delivery_status import current_delivery_verdict

    bound_execution_id = base_tool_context.execution_id
    execution_id_token = current_execution_id.set(bound_execution_id)
    # Fresh turn: prior batch delivery verdict must not leak into finish_guard.
    current_delivery_verdict.set(None)
    clear_cloud_web_verify_gap()
    clear_cutoff_delivery_gap()
    clear_unresolved_write_ownership()
    clear_b1_closing_latches()

    # Pillar B: if a background execution is already live for this conversation,
    # adopt it so the CEO wait path / interjection routing share one registry key.
    from agentcore.runtime.coordination.session import adopt_active_execution

    adopted = adopt_active_execution(conversation_id, event_sink=sink)
    if adopted is not None:
        bound_execution_id = adopted.execution_id
        base_tool_context.execution_id = adopted.execution_id
        current_execution_id.set(adopted.execution_id)
        # Harvest / reattach: re-stamp write-ownership honesty from the live ledger.
        from agentcore.runtime.closing_posture import (
            apply_write_ownership_honesty_for_session,
        )

        apply_write_ownership_honesty_for_session(adopted)

    return PreparedTurn(
        llm=llm,
        system_prompt=system_prompt,
        worker_base_prompt=worker_base_prompt,
        worker_tools=worker_tools,
        skill_registry=skill_registry,
        board_channel=board_channel,
        base_tool_context=base_tool_context,
        vision_cost_sink=vision_cost_sink,
        attachment_context=attachment_context,
        native_image_parts=native_image_parts,
        memory_topics=memory_topics,
        on_demand_rules=on_demand_rules,
        project_catalog=project_catalog,
        bound_execution_id=bound_execution_id,
        execution_id_token=execution_id_token,
    )
