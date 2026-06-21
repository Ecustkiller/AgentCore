"""Conversation service facade — re-exports the split turn / promotion modules.

Import from here to keep route and test import paths stable:
``from agentcore.conversation.service import stream_chat``, etc.
"""

from agentcore.conversation.common import (
    fallback_title as _fallback_title,
)
from agentcore.conversation.common import (
    generate_title as _generate_title,
)
from agentcore.conversation.common import (
    log_cost_recorded as _log_cost_recorded,
)
from agentcore.conversation.common import (
    preview as _preview,
)
from agentcore.conversation.common import (
    resolve_local_binding as _resolve_local_binding,
)
from agentcore.conversation.common import (
    resolve_profile_set as _resolve_profile_set,
)
from agentcore.conversation.handoff_jobs import dispatch_handoff, run_handoff_job
from agentcore.conversation.local_turn import record_local_turn
from agentcore.conversation.promotion import (
    bare_chat_promote as _bare_chat_promote,
)
from agentcore.conversation.promotion import (
    promote_bare_chat_to_folder,
    promote_conversation_folder,
)
from agentcore.conversation.promotion import (
    sanitize_subpath_segment as _sanitize_subpath_segment,
)
from agentcore.conversation.promotion import (
    unique_local_subpath as _unique_local_subpath,
)
from agentcore.conversation.turn_backend import build_turn_backend as _build_turn_backend
from agentcore.conversation.turn_persistence import (
    has_open_durable_pause as _has_open_durable_pause,
)
from agentcore.conversation.turn_persistence import (
    persist_incomplete_turn as _persist_incomplete_turn,
)
from agentcore.conversation.turn_persistence import (
    persist_turn_result as _persist_turn_result,
)
from agentcore.conversation.turn_persistence import (
    salvage_incomplete_turn as _salvage_incomplete_turn,
)
from agentcore.conversation.turn_runner import (
    run_and_persist as _run_and_persist,
)
from agentcore.conversation.turn_runner import (
    session_callbacks as _session_callbacks,
)
from agentcore.conversation.turn_runner import (
    suspension_callbacks as _suspension_callbacks,
)
from agentcore.conversation.turns import regenerate_chat, resume_chat, stream_chat

__all__ = [
    "dispatch_handoff",
    "promote_bare_chat_to_folder",
    "promote_conversation_folder",
    "record_local_turn",
    "regenerate_chat",
    "resume_chat",
    "run_handoff_job",
    "stream_chat",
    # Test / internal aliases kept on the facade for stable import paths.
    "_bare_chat_promote",
    "_build_turn_backend",
    "_fallback_title",
    "_generate_title",
    "_has_open_durable_pause",
    "_log_cost_recorded",
    "_persist_incomplete_turn",
    "_persist_turn_result",
    "_preview",
    "_resolve_local_binding",
    "_resolve_profile_set",
    "_run_and_persist",
    "_salvage_incomplete_turn",
    "_sanitize_subpath_segment",
    "_session_callbacks",
    "_suspension_callbacks",
    "_unique_local_subpath",
]
