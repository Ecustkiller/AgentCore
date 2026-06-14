"""ChatPipeline: Prepare -> Execute -> Finalize.

Orchestrates a single user message through the full lifecycle:
  1. Prepare  — build context, resolve prompt/model/tools, load history
  2. Execute  — run ReAct loop, stream events
  3. Finalize — persist assistant message, update conversation
"""

import contextlib
from pathlib import Path

from agentcore.core.logging import get_logger
from agentcore.core.types import new_id
from agentcore.llm.config import get_profile
from agentcore.llm.factory import build_provider
from agentcore.llm.protocol import LLMMessage
from agentcore.memory import default_memory_store
from agentcore.runtime.engine import react_loop
from agentcore.runtime.events import (
    EventSink,
    FinishReason,
    message_end,
    message_start,
)
from agentcore.runtime.prompt import CHAT_TEAM_CAPABILITY_HINT, assemble_system_prompt
from agentcore.tools.builtin.assemble_team import AssembleTeamTool
from agentcore.tools.builtin.code_execute import CodeExecuteTool
from agentcore.tools.builtin.file_ops import FileListTool, FileReadTool, FileWriteTool
from agentcore.tools.builtin.web.read_url import ReadUrlTool
from agentcore.tools.builtin.web.search import WebSearchTool
from agentcore.tools.protocol import ToolContext
from agentcore.tools.registry import ToolRegistry

logger = get_logger(__name__)


def _build_default_tools() -> ToolRegistry:
    """Register all built-in tools for MVP."""
    registry = ToolRegistry()
    registry.register(WebSearchTool())
    registry.register(ReadUrlTool())
    registry.register(FileReadTool())
    registry.register(FileWriteTool())
    registry.register(FileListTool())
    registry.register(CodeExecuteTool())
    return registry


def _build_attachment_context(attachments: list[dict] | None) -> str | None:
    """Render user-referenced files/directories into a system-prompt block.

    Files carry pre-extracted text; directories carry a recursive file listing
    (paths only, no file bodies). Both are truncated client-side. Returns None
    when there is nothing to inject so the base prompt stays unchanged.
    """
    if not attachments:
        return None

    blocks: list[str] = []
    for att in attachments:
        text = (att.get("text") or "").strip()
        if not text:
            continue
        name = att.get("name") or "untitled"
        path = att.get("path") or name
        if att.get("kind") == "dir":
            note = " (partial listing)" if att.get("truncated") else ""
            blocks.append(
                f"--- Directory: {name} ({path}){note} ---\n"
                f"File paths (contents not included):\n{text}"
            )
        else:
            note = " (truncated)" if att.get("truncated") else ""
            blocks.append(f"--- File: {name} ({path}){note} ---\n{text}")

    if not blocks:
        return None

    body = "\n\n".join(blocks)
    return (
        "<attached_files>\n"
        "The user attached the following files and directories as context for "
        "this message. Treat them as reference material the user provided; cite "
        "them by name when relevant. Directory entries list file paths only "
        "(file contents are not included).\n\n"
        f"{body}\n"
        "</attached_files>"
    )


async def run_chat_pipeline(
    *,
    conversation_id: str,
    user_message: str,
    history: list[dict],
    sink: EventSink,
    user_id: str,
    attachments: list[dict] | None = None,
) -> dict:
    """Run the full chat pipeline for a single user message.

    Returns a dict with final_content, usage, and metadata.
    The sink receives all SSE events during execution.
    """
    message_id = new_id()

    try:
        # --- Phase 1: Prepare ---
        memory_markdown = await default_memory_store().load(user_id)
        system_prompt = assemble_system_prompt(
            memory_markdown=memory_markdown,
            extra_context=_build_attachment_context(attachments),
        )
        worker_tools = _build_default_tools()
        llm = build_provider()

        base_tool_context = ToolContext(
            execution_id=new_id(),
            step_id=new_id(),
            agent_id="default",
            workspace_dir=Path.cwd(),
            user_id=user_id,
        )

        # --- Phase 2: Assemble the chat agent's toolset (chat-first) ---
        # The chat agent owns the conversation and replies directly. It carries
        # the built-in tools plus a single on-demand escalation tool,
        # ``assemble_team``, which spins up a multi-agent team ONLY when the model
        # judges a request truly needs one. There is no mandatory pre-turn
        # orchestrator pass anymore — that was the ~15s dead-air root cause.
        # Worker agents inside a team get ``worker_tools`` (no nested team tool),
        # so a team can never recursively assemble another team.
        # The team tool gets the CLEAN base prompt — it is reused verbatim by the
        # team's workers and synthesizer (runs.py), which must not be told about a
        # team tool they do not hold.
        team_tool = AssembleTeamTool(
            llm=llm,
            sink=sink,
            system_prompt=system_prompt,
            user_message=user_message,
            history=history,
            tools=worker_tools,
            base_tool_context=base_tool_context,
        )
        chat_tools = ToolRegistry()
        for schema in worker_tools.list_all():
            chat_tools.register(worker_tools.get(schema.name))
        chat_tools.register(team_tool)

        # The entry chat agent additionally learns it may escalate to a team.
        chat_system_prompt = f"{system_prompt}\n{CHAT_TEAM_CAPABILITY_HINT}"

        # --- Phase 3: Execute ---
        sink.emit(message_start(message_id, conversation_id=conversation_id))

        messages: list[LLMMessage] = [LLMMessage(role="system", content=chat_system_prompt)]
        for msg in history:
            messages.append(LLMMessage(role=msg["role"], content=msg["content"]))
        messages.append(LLMMessage(role="user", content=user_message))

        profile = get_profile("chat")
        (
            final_content,
            final_reasoning,
            input_tokens,
            output_tokens,
            reasoning_tokens,
            rounds,
        ) = await react_loop(
            messages=messages,
            llm=llm,
            tools=chat_tools,
            sink=sink,
            tool_context=base_tool_context,
            profile=profile,
        )
        finish = (
            FinishReason.END_TURN
            if rounds < profile.max_rounds
            else FinishReason.MAX_ROUNDS
        )

        sink.emit(
            message_end(
                finish,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                reasoning_tokens=reasoning_tokens,
                rounds=rounds,
            )
        )

        return {
            "message_id": message_id,
            "content": final_content,
            "reasoning_content": final_reasoning,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "reasoning_tokens": reasoning_tokens,
            "rounds": rounds,
            "finish_reason": finish,
        }

    except Exception as e:
        logger.error("pipeline_error", error=str(e), exc_info=True)
        from agentcore.runtime.events import error_event

        sink.emit(error_event("PIPELINE_ERROR", str(e)))
        sink.emit(message_end(FinishReason.ERROR))
        return {
            "message_id": message_id,
            "content": "",
            "error": str(e),
            "finish_reason": FinishReason.ERROR,
        }
    finally:
        sink.close()
        with contextlib.suppress(Exception):
            await llm.close()
