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

    # Captain (CEO) ReAct ceiling — higher than chat default (16) because coordination
    # mode (team events, synthesis, follow-up delegate for audit/revision) burns rounds.
    # Workers keep agent.fast/strong profiles; 0 = inherit chat profile unchanged.
    engine_captain_max_rounds: int = 24

    engine_tool_clear_keep_recent: int = 4
    engine_tool_clear_min_chars: int = 2000

    # Worker 累计 token 硬顶 (loose backstop): compaction (tool_clear) 挑大梁做上下文瘦身,
    # 这只是防失控的安全阀,不是紧箍咒。每轮末比对累计 input+output tokens,到顶即收口。
    # 统一可配置上限；≤0 关闭 (CEO/solo 路径不传此上限,保持 0)。
    engine_worker_token_ceiling: int = 80_000
    # 辩论辩手检索阶段累计 token 硬顶（与 worker 通用顶独立）。辩手取证常需读多篇长文，
    # 与 80k worker 顶合用会导致首轮过早 ceiling_finalize。≤0 关闭。
    engine_debate_token_ceiling: int = 120_000

    # 流式停滞闸 (卡死根因): a per-chunk IDLE ceiling for one streamed LLM round — the
    # deadline resets on every chunk, so a healthy long generation (which keeps streaming
    # reasoning/content) is never cut, but a genuine STALL (no bytes for this many seconds)
    # fails FAST and OBSERVABLY instead of riding the provider's silent 120s×3 read-timeout
    # ladder (~6 min of a frozen turn). Sized BELOW the httpx per-read 120s so this fires
    # first (and logs ``llm.stream_stalled``), and ABOVE worst-case time-to-first-token on a
    # large prompt so a big post-debate finalization call is not false-killed. 0 disables it.
    engine_llm_stream_idle_timeout_seconds: float = 100.0

    observability_span_export_enabled: bool = True
