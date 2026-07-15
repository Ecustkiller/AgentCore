"""Dev-only demo tape replay toggles (product-demo screen recording)."""

from pydantic import BaseModel, Field


class DemoTapeSettings(BaseModel):
    """Env-gated server-side tape replay — never a product surface."""

    # Master switch. Off by default; production must leave this false.
    demo_tape_replay_enabled: bool = False
    # JSON map conversation_id → {tape, speed?, max_gap_ms?} (repo-relative or absolute).
    # Empty → default ``<repo>/demos/bindings.json`` when the file exists.
    demo_tape_bindings_path: str = ""
    # Global defaults (per-binding overrides win).
    demo_tape_speed: float = Field(default=1.0, ge=0.1, le=100.0)
    # Cap is 10min: 原速回放 (speed=1) needs the gap ceiling high enough to stay "unreachable".
    demo_tape_max_gap_ms: int = Field(default=3000, ge=50, le=600_000)
