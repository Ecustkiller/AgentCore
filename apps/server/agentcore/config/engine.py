"""ReAct engine loop: timeouts, governance, tool-clear, finish-guard."""

from pydantic import BaseModel


class EngineSettings(BaseModel):
    tool_default_timeout_seconds: float = 60.0
    tool_execution_timeout_seconds: float = 90.0

    engine_empty_response_threshold: int = 2

    engine_tool_failure_warn: int = 2
    engine_tool_failure_disable: int = 3
    engine_unproductive_threshold: int = 3
    engine_reflection_start_round: int = 3
    engine_reflection_interval: int = 3
    # Absolute investigation-round ceiling (safety net). Progress-aware spinning detection
    # normally triggers earlier; this is the hard backstop.
    engine_convergence_finalize_rounds: int = 30
    # Consecutive investigation-only rounds re-reading the same targets before finalize.
    engine_convergence_spin_rounds: int = 3
    engine_finish_guard_max_reworks: int = 2

    engine_tool_clear_keep_recent: int = 4
    engine_tool_clear_min_chars: int = 2000

    # Worker 累计 token 硬顶 (loose backstop): compaction (tool_clear) 挑大梁做上下文瘦身,
    # 这只是防"预算 2221 → 实耗 41378"式失控的安全阀,不是紧箍咒。每轮末比对累计
    # input+output tokens,到顶即收口。ceiling = clamp(Intake.token_budget × factor,
    # floor, cap); factor/cap <= 0 或 Intake 预算 <= 0 时关闭 (CEO/solo 天然无此上限)。
    engine_worker_token_budget_factor: float = 2.0
    engine_worker_token_budget_floor: int = 8_000
    engine_worker_token_budget_cap: int = 80_000

    # 流式停滞闸 (卡死根因): a per-chunk IDLE ceiling for one streamed LLM round — the
    # deadline resets on every chunk, so a healthy long generation (which keeps streaming
    # reasoning/content) is never cut, but a genuine STALL (no bytes for this many seconds)
    # fails FAST and OBSERVABLY instead of riding the provider's silent 120s×3 read-timeout
    # ladder (~6 min of a frozen turn). Sized BELOW the httpx per-read 120s so this fires
    # first (and logs ``llm.stream_stalled``), and ABOVE worst-case time-to-first-token on a
    # large prompt so a big post-debate finalization call is not false-killed. 0 disables it.
    engine_llm_stream_idle_timeout_seconds: float = 100.0

    observability_span_export_enabled: bool = True
