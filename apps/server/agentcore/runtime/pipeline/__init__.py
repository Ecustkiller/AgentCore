"""ChatPipeline package — Prepare -> Execute -> Finalize.

Re-exports stable import paths for ``agentcore.runtime.pipeline``.
"""

from agentcore.llm.factory import build_provider, build_router_around, build_turn_router
from agentcore.runtime.pipeline.finalize import _build_runs_payload, _journal_entries_for_turn
from agentcore.runtime.pipeline.resume import resume_chat_pipeline
from agentcore.runtime.pipeline.run import run_chat_pipeline
from agentcore.runtime.resolve.prepare import (
    _build_agent_mention_context,
    _build_attachment_context,
    merge_attachment_and_mention_context,
)
from agentcore.tools.ceo_toolset import _assemble_ceo_toolset

__all__ = [
    "build_provider",
    "build_router_around",
    "build_turn_router",
    "run_chat_pipeline",
    "resume_chat_pipeline",
    "_assemble_ceo_toolset",
    "_build_attachment_context",
    "_build_agent_mention_context",
    "merge_attachment_and_mention_context",
    "_build_runs_payload",
    "_journal_entries_for_turn",
]
