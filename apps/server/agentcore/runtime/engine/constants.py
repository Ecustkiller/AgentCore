"""Shared constants for the ReAct engine."""

from agentcore.core.types import ToolFace

MAX_PARALLEL_TOOLS = 5

# Tool-call arguments stream as many tiny deltas (a delegate 任务书 / file body =
# thousands of chars). Emit a progress event only when a call's accumulated args grow
# by ≥ this many chars (plus once when the tool name is first known) — throttling the
# tick that drives the「正在生成 {工具} · N 字」line (captain bubble via tool_progress,
# worker node via run_tool_progress).
#
# Trade-off — it's a char step, so #events = args_len / STEP and the counter jumps by
# STEP each tick, *independent of stream speed*:
#   • smaller → 更跟手 (counter climbs smoothly, feels live) but more SSE events →
#     more store writes / bubble re-renders, and short calls (a tiny edit)
#     emit ticks they don't need;
#   • larger → cheaper but the number lurches / lags on a long task book.
# 64 puts a typical DeepSeek arg stream (~150–300 chars/s) at ~3–5 ticks/s — clearly
# alive without flooding — and ≈ one text line per tick reads as "another line
# written". Each event is a tiny {tool_name, chars} + a one-field store patch, so even
# a 50KB write (≈800 ticks over its whole duration) is comfortably cheap; tune here if
# the bubble ever feels jittery (raise) or laggy (lower).
TOOL_PROGRESS_STEP = 64

# Names that may still execute on a forced-finalize round. Opening ``tools[]``
# stays frozen; investigation calls are dropped after the LLM round (or
# ``tool_choice=none`` on the hard salvage).
FINALIZE_COORDINATION_TOOLS = frozenset({"delegate", "consult", "ask_user"})

# Persist tools still executable on finalize when landing is in play
# (pinned landing / artifacts / wind_down) — mirrors wind_down intent.
FINALIZE_PERSIST_TOOLS = frozenset({"write", "handoff"})

# Investigation + execution names blocked at execute on finalize (by name).
# ``write`` leaves this set when persist finalize is on.
FINALIZE_FORBIDDEN_TOOLS = frozenset(
    {
        "read",
        "grep",
        "web_search",
        "web_fetch",
        "write",
        "edit",
        "run",
    }
)

# Tool faces whose calls are NOT bounded by the engine timeout backstop (B1):
# they legitimately block for minutes on a sub-run or the user, and are bounded by
# their own lifecycle instead — delegate/revise drive sub-DAGs (each constituent
# tool call is itself bounded), ask_user waits on the user behind its own checkpoint
# timeout. A flat ceiling here would wrongly kill a legitimate long wait.
# FOLDER is a display group, not this exemption.
TIMEOUT_EXEMPT_FACES = frozenset({ToolFace.ORCHESTRATION})
