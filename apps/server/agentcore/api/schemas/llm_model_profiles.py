"""Model combination profile (模型组合) API schemas.

Distinct from scenario ``ProfileParams`` (temperature / rounds) — this is the
account/session selectable ``{main, worker?, background?, vision?}`` combination.
"""

from datetime import datetime
from typing import Literal, Self

from pydantic import BaseModel, Field, model_validator


class ModelProfileSlot(BaseModel):
    """One slot in a model combination (main / worker / background / vision)."""

    origin: Literal["byok", "platform"] = Field(
        description="Credential origin: byok (user key) or platform (operator catalog)"
    )
    provider_id: str | None = Field(
        default=None,
        description="BYOK provider id when origin=byok; must be null for platform",
    )
    model: str = Field(max_length=200)

    @model_validator(mode="after")
    def _origin_provider_consistency(self) -> Self:
        if self.origin == "platform":
            if self.provider_id:
                raise ValueError("platform 指针不能带 provider_id")
            return self
        if not (self.provider_id or "").strip():
            raise ValueError("byok 指针必须指定 provider_id")
        return self


class LlmModelProfileView(BaseModel):
    id: str
    name: str
    kind: Literal["system", "user", "implicit"]
    main: ModelProfileSlot
    worker: ModelProfileSlot | None = None
    background: ModelProfileSlot | None = None
    vision: ModelProfileSlot | None = None
    reasoning_effort: str | None = Field(
        default=None,
        description=(
            "Vendor thinking-effort token for this combination (e.g. low/high/max). "
            "Null = that model's vendor default. Official control values only."
        ),
    )
    is_default: bool = False
    created_at: datetime | None = None
    updated_at: datetime | None = None
    warnings: list[str] = Field(
        default_factory=list,
        description=(
            "Ignorable BYOK model reachability hints from the last save "
            "(empty on list/get). Save still succeeds when non-empty."
        ),
    )

class LlmModelProfileListResponse(BaseModel):
    data: list[LlmModelProfileView]
    default_model_profile_id: str | None = None


class CreateLlmModelProfileRequest(BaseModel):
    name: str = Field(max_length=200)
    main: ModelProfileSlot
    worker: ModelProfileSlot | None = None
    background: ModelProfileSlot | None = None
    vision: ModelProfileSlot | None = None
    reasoning_effort: str | None = Field(
        default=None,
        max_length=32,
        description=(
            "Vendor thinking-effort token. Null = vendor default for the main model. "
            "Must be an official control value of the main model."
        ),
    )
    set_as_default: bool = False


class UpdateLlmModelProfileRequest(BaseModel):
    """Partial update. Omitted fields unchanged; explicit null on worker/background/vision
    clears the slot (worker/background → follow_main; vision → no dedicated slot).
    Explicit null on reasoning_effort clears to the vendor default."""

    name: str | None = Field(default=None, max_length=200)
    main: ModelProfileSlot | None = None
    worker: ModelProfileSlot | None = None
    background: ModelProfileSlot | None = None
    vision: ModelProfileSlot | None = None
    reasoning_effort: str | None = Field(
        default=None,
        max_length=32,
        description=(
            "Vendor thinking-effort token. Explicit null clears to the vendor default. "
            "Must be an official control value of the (new) main model."
        ),
    )


class SetDefaultModelProfileRequest(BaseModel):
    profile_id: str = Field(description="User combination id or system preset id")
