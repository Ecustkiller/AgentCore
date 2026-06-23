"""Turn persistence: roster, memory consolidation, compaction."""

from pydantic import BaseModel


class PersistenceSettings(BaseModel):
    incomplete_turn_persist_enabled: bool = True

    session_roster_persist_enabled: bool = True
    session_roster_retention_days: int = 7
    session_roster_sweep_interval_seconds: int = 6 * 3600
    session_roster_sweep_batch_limit: int = 200

    memory_consolidation_enabled: bool = True
    memory_consolidation_idle_seconds: float = 90.0
    memory_consolidation_turn_cap: int = 8
    memory_consolidation_window_messages: int = 40
    memory_consolidation_sweep_interval_seconds: int = 300
    memory_consolidation_sweep_batch_limit: int = 100
    memory_section_bullet_cap: int = 20

    compaction_enabled: bool = True
    compaction_trigger_input_tokens: int = 64_000
    compaction_recency_messages: int = 20
    compaction_min_fold_messages: int = 4
    compaction_max_fold_messages: int = 200
    compaction_context_max_messages: int = 300
    compaction_summary_char_budget: int = 4_000
