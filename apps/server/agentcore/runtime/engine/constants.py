"""Shared constants for the ReAct engine."""

from agentcore.core.types import ToolCategory

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
#     more store writes / bubble re-renders, and short calls (a tiny str_replace)
#     emit ticks they don't need;
#   • larger → cheaper but the number lurches / lags on a long task book.
# 64 puts a typical DeepSeek arg stream (~150–300 chars/s) at ~3–5 ticks/s — clearly
# alive without flooding — and ≈ one text line per tick reads as "another line
# written". Each event is a tiny {tool_name, chars} + a one-field store patch, so even
# a 50KB write (≈800 ticks over its whole duration) is comfortably cheap; tune here if
# the bubble ever feels jittery (raise) or laggy (lower).
TOOL_PROGRESS_STEP = 64

# Injected when convergence governance forces a tool-free answer (a stuck loop
# trips a hard finalize, or the round budget is exhausted mid-tool-call).
FINALIZE_INSTRUCTION = (
    "[系统提示] 请停止使用任何工具，基于目前已掌握的全部信息，立即给出你最好的最终答案。"
)

# Tool categories whose calls are NOT bounded by the engine timeout backstop (B1):
# they legitimately block for minutes on a sub-run or the user, and are bounded by
# their own lifecycle instead — delegate/revise drive sub-DAGs (each constituent
# tool call is itself bounded), ask_user waits on the user behind its own checkpoint
# timeout. A flat ceiling here would wrongly kill a legitimate long wait.
TIMEOUT_EXEMPT_CATEGORIES = frozenset(
    {ToolCategory.ORCHESTRATION, ToolCategory.INTERACTION}
)
