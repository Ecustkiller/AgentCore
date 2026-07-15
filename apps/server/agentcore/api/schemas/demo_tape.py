"""Request/response schemas for the dev-only demo-tape one-click API."""

from pydantic import BaseModel, Field


class DemoTapeSummary(BaseModel):
    """One available tape under ``demos/tapes/``."""

    id: str
    title: str
    user_prompt: str
    duration_ms: int | None = None
    event_count: int | None = None


class DemoTapeCatalogResponse(BaseModel):
    """List + enable flag (404 when replay is off — this body is only for enabled)."""

    enabled: bool = True
    tapes: list[DemoTapeSummary]


class DemoTapePrepareRequest(BaseModel):
    """Prepare a bound cloud session without starting the tape turn."""

    tape_id: str = Field(..., min_length=1, max_length=200)
    speed: float | None = Field(default=None, ge=0.1, le=100.0)
    max_gap_ms: int | None = Field(default=None, ge=50, le=600_000)


class DemoTapePrepareResponse(BaseModel):
    """Cloud conversation bound; user sends any message to trigger replay."""

    conversation_id: str
    tape_id: str
    title: str
    user_prompt: str
    speed: float
    max_gap_ms: int


class DemoTapeStartRequest(BaseModel):
    """Auto-start one-click replay for a tape id (filename stem)."""

    tape_id: str = Field(..., min_length=1, max_length=200)
    speed: float | None = Field(default=None, ge=0.1, le=100.0)
    max_gap_ms: int | None = Field(default=None, ge=50, le=600_000)


class DemoTapeStartResponse(BaseModel):
    """Cloud conversation already bound + turn running (attach via GET …/stream)."""

    conversation_id: str
    tape_id: str
    title: str
    user_prompt: str
    speed: float
    max_gap_ms: int
