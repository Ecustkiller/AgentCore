"""ReAct engine loop: timeouts, governance, tool-clear, finish-guard."""

from pydantic import BaseModel


class EngineSettings(BaseModel):
    tool_default_timeout_seconds: float = 60.0
    tool_execution_timeout_seconds: float = 90.0

    engine_fallback_enabled: bool = True
    engine_empty_response_threshold: int = 2

    engine_tool_failure_warn: int = 2
    engine_tool_failure_disable: int = 3
    engine_unproductive_threshold: int = 3
    engine_reflection_start_round: int = 3
    engine_reflection_interval: int = 3
    engine_convergence_finalize_rounds: int = 12
    engine_finish_guard_max_reworks: int = 2

    engine_tool_clear_keep_recent: int = 4
    engine_tool_clear_min_chars: int = 2000

    observability_span_export_enabled: bool = True
