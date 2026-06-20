"""Model quality mode (质量档, llm/modes.py D2) request/response schemas."""

from pydantic import BaseModel, Field


class ModelModeSummary(BaseModel):
    """A user-defined custom 质量档."""

    id: str
    name: str
    # Team-role → model id (e.g. {"ceo": "deepseek-v4-pro"}). Roles absent inherit
    # the base profile's model.
    assignments: dict[str, str]

    model_config = {"from_attributes": True}


class CreateModelModeRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    assignments: dict[str, str] = Field(default_factory=dict)


class UpdateModelModeRequest(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=100)
    assignments: dict[str, str] | None = None


class ModelModePreset(BaseModel):
    """A built-in, read-only 质量档 (economy / quality)."""

    key: str
    assignments: dict[str, str]


class ModelModesResponse(BaseModel):
    """Everything the picker needs: built-in presets + the user's custom modes + the
    user's resolved default ref."""

    presets: list[ModelModePreset]
    custom: list[ModelModeSummary]
    default_mode: str


class ModelRoleOption(BaseModel):
    """A team role the user may configure in a custom mode (catalog)."""

    role: str
    configurable: bool
    # When not configurable (经济worker), the model it is locked to (display only).
    locked_model: str | None = None


class ModelModeCatalog(BaseModel):
    """The operator-bounded option space for building a custom mode: which team roles
    exist (and whether each is user-configurable) and which models may be picked."""

    roles: list[ModelRoleOption]
    models: list[str]


class SetDefaultModeRequest(BaseModel):
    """Set (or clear with null) the user's default 质量档."""

    mode: str | None = None
