"""Resolve prepare phase: CEO toolset assembly and attachment context."""

from agentcore.config import settings
from agentcore.core.logging import get_logger
from agentcore.llm.profiles import TurnProfiles as ProfileSet
from agentcore.memory import default_memory_store
from agentcore.runtime.approvals import ApprovalGate
from agentcore.runtime.debate import DebateSeed
from agentcore.runtime.events import (
    EventSink,
)
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
from agentcore.tools.builtin.consult_skill import ConsultSkillTool
from agentcore.tools.builtin.debate import DebateTool
from agentcore.tools.builtin.delegate import DelegateTool
from agentcore.tools.builtin.replan import ReplanTool
from agentcore.tools.builtin.revise import ReviseTool
from agentcore.tools.protocol import ToolContext
from agentcore.tools.registry import ToolRegistry

logger = get_logger(__name__)


def _wire_worker_memory_tools(
    worker_tools: ToolRegistry,
    *,
    memory_enabled: bool = True,
    folder_id: str | None = None,
) -> None:
    """Register ``consult_memory`` on the delegated worker toolset when memory is on.

    Same store + project scope as the CEO path (``folder_id`` ⇒ project-then-global
    resolution). Off ⇒ not wired — the privacy off-ramp's tool half, mirroring
    ``_assemble_ceo_toolset``.
    """
    if memory_enabled:
        worker_tools.register(
            ConsultMemoryTool(store=default_memory_store(), project_id=folder_id)
        )


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
    folder_id: str | None = None,
    debate_seed: DebateSeed | None = None,
) -> tuple[DelegateTool, ReviseTool, DebateTool, ToolRegistry]:
    """Wire the CEO coordinator's toolset (delegate + revise + read/retrieval +
    consult_skill + an optional consult_memory + an optional ask_user), shared by a
    fresh turn and a 2b resume.

    The CEO is a COORDINATOR: it holds only the read/retrieval built-ins plus the
    orchestration primitives, never the mutation tools (those live with workers via
    ``delegate``). ``base_system_prompt`` is the CLEAN prompt handed to delegate /
    revise (reused verbatim by workers — no CEO-chat hints). ``skill_registry`` backs
    the CEO-only ``consult_skill`` tool (提示词瘦身 P2): the advanced-mechanism guidance
    is pulled on demand instead of riding the prompt every turn. ``message_id`` + the
    suspension closures arm durable plan_review pauses (结构化挂起 2b) on the
    top-level delegate. Returns ``(delegate_tool, revise_tool, debate_tool,
    chat_tools)`` — the tools whose accumulated usage/ledger/citations the caller
    folds into the turn totals.
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
        conversation_id=conversation_id,
        registry=default_interaction_registry(),
        checkpoint_timeout_seconds=settings.checkpoint_timeout_seconds,
        checkpoint_enabled=checkpoint_enabled,
        message_id=message_id,
        suspension_saver=suspension_saver,
        suspension_deleter=suspension_deleter,
        folder_id=folder_id,
        memory_enabled=memory_enabled,
    )
    chat_tools = build_ceo_tool_registry()
    chat_tools.register(delegate_tool)
    # 受监督的波循环 (replan): delegate 的伴生工具——在波边界把晚绑定步骤定稿并续跑同一张
    # 暂停的计划。共享当回合的 DelegateTool 实例（其 ``_supervised`` 暂停态 + 累加器），故
    # 自身无用量面；与 revise 一样恒注册，仅在某次 delegate 让出「计划已让出」简报后才有效，
    # 否则返回友好错误。→ docs/03-AI核心/编排器与CEO主Agent.md §一 replan 原语
    chat_tools.register(ReplanTool(delegate=delegate_tool))
    revise_gate = approval_gate if backend_location == "local" else None
    revise_tool = ReviseTool(
        llm=llm,
        sink=sink,
        session_store=session_store,
        tools=worker_tools,
        base_tool_context=base_tool_context,
        profile_set=profiles,
        captain_run_id=captain_run_id,
        approval_gate=revise_gate,
        session_saver=session_saver,
        session_loader=session_loader,
    )
    chat_tools.register(revise_tool)
    # debate (辩论编排原语): the CEO's对抗性多视角思考 primitive, sibling to delegate. A
    # Moderator hosts an adaptive多轮 debate内部 and returns双产物 (决策简报 + 交锋叙事线);
    # like delegate它非终结且把辩手/主持人的 usage/ledger/citations累加在实例上，由本回合
    # 折回总账。→ docs/03-AI核心/辩论编排设计.md
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
        # 交互式逐轮（opt-in）的挂起桥接：同 ask_user/escalate 共用统一交互桥 + checkpoint 超时；
        # ``checkpoint_enabled`` 即「有活跃用户」闸（自治 / handoff 回合不武装 → 回落自判收敛）。
        registry=default_interaction_registry(),
        conversation_id=conversation_id,
        round_decision_timeout=settings.checkpoint_timeout_seconds,
        interactive_armed=checkpoint_enabled,
        # 结构化补轮·B：前端从收场卡发起续辩时直传的上一场种子（None=全新辩论）。
        prior_seed=debate_seed,
    )
    chat_tools.register(debate_tool)
    # consult_skill (提示词瘦身 P2): always wired (not live-user gated) so the CEO can
    # pull any advanced-mechanism guidance on demand; the always-on 能力目录 in the
    # prompt lists the skills whose required tools are actually wired this turn.
    chat_tools.register(ConsultSkillTool(registry=skill_registry))
    # consult_memory (记忆文件夹化 §六): CEO-only on-demand recall of a 记忆主题笔记. Gated by
    # the long-term-memory master switch — off ⇒ not wired, AND the prompt's 记忆主题目录 is
    # not rendered (compose_ceo_chat_prompt keys the directory on this tool being present),
    # so a user who turned memory off surfaces zero memory — the same privacy off-ramp as
    # the core-memory injection (always-injected 画像 already gated in pipeline/run.py).
    if memory_enabled:
        # ``folder_id`` lets consult_memory resolve a topic name across BOTH scopes — the
        # current project's 主题 first, then global (Agent记忆与知识系统 §二).
        chat_tools.register(ConsultMemoryTool(store=default_memory_store(), project_id=folder_id))
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
                registry=default_interaction_registry(),
                timeout_seconds=settings.checkpoint_timeout_seconds,
                captain_run_id=captain_run_id,
                base_system_prompt=base_system_prompt,
                user_message=user_message,
                message_id=message_id,
                suspension_saver=suspension_saver,
                suspension_deleter=suspension_deleter,
                folder_id=folder_id,
                memory_enabled=memory_enabled,
            )
        )
    return delegate_tool, revise_tool, debate_tool, chat_tools


def _build_attachment_context(attachments: list[dict] | None) -> str | None:
    """Render user-referenced files / dirs / conversations into a prompt block.

    Files carry pre-extracted text; directories carry a recursive file listing
    (paths only, no file bodies); conversations carry their recent messages
    (materialized client-side). All are truncated client-side. A file with a
    ``workspace_path`` was persisted into the workspace (附件驻留), so the header
    points the agent at that durable path — it can re-read or edit the file with
    the file tools instead of relying only on the inlined (possibly truncated)
    copy. Returns None when there is nothing to inject so the base prompt stays
    unchanged.
    """
    if not attachments:
        return None

    blocks: list[str] = []
    resident = False
    for att in attachments:
        text = (att.get("text") or "").strip()
        if not text:
            continue
        name = att.get("name") or "untitled"
        if att.get("kind") == "dir":
            path = att.get("path") or name
            note = " (partial listing)" if att.get("truncated") else ""
            blocks.append(
                f"--- Directory: {name} ({path}){note} ---\n"
                f"File paths (contents not included):\n{text}"
            )
        elif att.get("kind") == "conversation":
            # A referenced past conversation: its recent messages, materialized
            # client-side into `text`. Nothing is written to the workspace;
            # truncated => only the most recent slice was carried.
            note = " (recent messages only)" if att.get("truncated") else ""
            blocks.append(f"--- Conversation: {name}{note} ---\n{text}")
        else:
            # Prefer the durable in-workspace path so the model can act on the
            # real file; fall back to the original (local) path when un-resident.
            ws_path = att.get("workspace_path")
            path = ws_path or att.get("path") or name
            if ws_path:
                resident = True
            note = " (truncated)" if att.get("truncated") else ""
            blocks.append(f"--- File: {name} ({path}){note} ---\n{text}")

    if not blocks:
        return None

    body = "\n\n".join(blocks)
    resident_note = (
        " Files shown with an in-workspace path have been saved into your "
        "workspace — read or edit them with the file tools by that path rather "
        "than trusting only the (possibly truncated) text below."
        if resident
        else ""
    )
    return (
        "<attached_files>\n"
        "The user attached the following files, directories and past "
        "conversations as context for this message. Treat them as reference "
        "material the user provided; cite them by name when relevant. Directory "
        "entries list file paths only (file contents are not included); a "
        "Conversation block holds that conversation's recent messages."
        f"{resident_note}\n\n"
        f"{body}\n"
        "</attached_files>"
    )
