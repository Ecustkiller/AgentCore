"""Model quality-mode (质量档) routes — user-selectable team-language model config.

A *mode* maps team roles (CEO本体 / 主力worker / 经济worker) to concrete models on
top of the base profiles (llm/modes.py). Built-in presets (economy/quality) are
read-only; users define their own custom modes here, pick one per conversation
(conversations PATCH ``model_mode``) or as their account default.

All routes are user-scoped: a non-owner custom mode resolves to 404 (IDOR-safe).
Writes are bounded by the operator ceiling (``settings.selectable_models``): an
assignment to a forbidden model or a non-configurable role is rejected (400).
"""

import uuid

from fastapi import APIRouter, Depends

from agentcore.api.dependencies import AuthUser, get_model_mode_repo, get_user_repo
from agentcore.api.schemas import (
    CreateModelModeRequest,
    ModelModeCatalog,
    ModelModePreset,
    ModelModesResponse,
    ModelModeSummary,
    ModelRoleOption,
    SetDefaultModeRequest,
    StatusResponse,
    UpdateModelModeRequest,
)
from agentcore.config import settings
from agentcore.core.errors import NotFoundError, ValidationError
from agentcore.db.repositories import ModelModeRepository, UserRepository
from agentcore.llm.config import get_profile
from agentcore.llm.modes import (
    CONFIGURABLE_ROLES,
    ROLE_TO_PROFILE,
    ROLE_WORKER_ECONOMY,
    SYSTEM_PRESETS,
)

router = APIRouter(prefix="/model-modes", tags=["model-modes"])

# Stable display order of team roles in the catalog (CEO first, then the two tiers).
_ROLE_ORDER = ("ceo", "worker_strong", "worker_economy")


def _clean_assignments(raw: dict[str, str]) -> dict[str, str]:
    """Validate a user-submitted role→model map against the operator ceiling.

    Rejects (400) an assignment to a non-configurable role (e.g. 经济worker, locked
    to Flash) or to a model outside the ceiling, so a stored mode is always a valid,
    resolvable selection. Returns the clean map on success.
    """
    ceiling = settings.selectable_models
    errors: list[str] = []
    for role, model in raw.items():
        if role not in CONFIGURABLE_ROLES:
            errors.append(f"角色 '{role}' 不可配置")
        elif model not in ceiling:
            errors.append(f"模型 '{model}' 不在可选范围内")
    if errors:
        raise ValidationError("；".join(errors))
    return dict(raw)


async def validate_mode_ref(
    mode: str | None, *, user_id: str, repo: ModelModeRepository
) -> None:
    """Ensure a mode ref is a known preset or an owned custom mode (else 400).

    ``None`` (= inherit default) is always valid. Validated on write for clear UX;
    the turn resolver also falls back safely, so a later-deleted mode never breaks.
    Shared by the conversation routes (per-conversation override) too.
    """
    if mode is None or mode in SYSTEM_PRESETS:
        return
    # Not a preset → it can only be a custom-mode id, which is a UUID. A ref that
    # isn't even a well-formed UUID is unknown by construction, so reject it here
    # rather than letting a non-UUID string hit the UUID id column (raw DataError).
    try:
        uuid.UUID(mode)
    except ValueError as exc:
        raise ValidationError(f"未知的质量档 '{mode}'") from exc
    if await repo.get_by_id(mode, user_id=user_id) is None:
        raise ValidationError(f"未知的质量档 '{mode}'")


@router.get("", response_model=ModelModesResponse)
async def list_model_modes(
    user: AuthUser,
    repo: ModelModeRepository = Depends(get_model_mode_repo),
):
    """Built-in presets + the user's custom modes + the user's resolved default ref."""
    custom = await repo.list_by_user(user.user_id)
    return ModelModesResponse(
        presets=[
            ModelModePreset(key=key, assignments=assignments)
            for key, assignments in SYSTEM_PRESETS.items()
        ],
        custom=[ModelModeSummary.model_validate(m) for m in custom],
        default_mode=user.default_model_mode or settings.default_model_mode,
    )


@router.get("/catalog", response_model=ModelModeCatalog)
async def model_mode_catalog(user: AuthUser):
    """The option space for building a custom mode: configurable team roles + the
    operator-allowed models. 经济worker is shown read-only (locked to its base model)."""
    locked_economy = get_profile(ROLE_TO_PROFILE[ROLE_WORKER_ECONOMY]).model
    roles = [
        ModelRoleOption(
            role=role,
            configurable=role in CONFIGURABLE_ROLES,
            locked_model=None if role in CONFIGURABLE_ROLES else locked_economy,
        )
        for role in _ROLE_ORDER
    ]
    return ModelModeCatalog(roles=roles, models=sorted(settings.selectable_models))


@router.post("", response_model=ModelModeSummary, status_code=201)
async def create_model_mode(
    body: CreateModelModeRequest,
    user: AuthUser,
    repo: ModelModeRepository = Depends(get_model_mode_repo),
):
    mode = await repo.create(
        user_id=user.user_id,
        name=body.name,
        assignments=_clean_assignments(body.assignments),
    )
    return ModelModeSummary.model_validate(mode)


@router.patch("/{mode_id}", response_model=ModelModeSummary)
async def update_model_mode(
    mode_id: str,
    body: UpdateModelModeRequest,
    user: AuthUser,
    repo: ModelModeRepository = Depends(get_model_mode_repo),
):
    fields = body.model_fields_set
    kwargs: dict = {}
    if "name" in fields:
        kwargs["name"] = body.name
    if "assignments" in fields:
        kwargs["assignments"] = _clean_assignments(body.assignments or {})
    mode = await repo.update(mode_id, user_id=user.user_id, **kwargs)
    if not mode:
        raise NotFoundError("质量档不存在")
    return ModelModeSummary.model_validate(mode)


@router.delete("/{mode_id}", response_model=StatusResponse)
async def delete_model_mode(
    mode_id: str,
    user: AuthUser,
    repo: ModelModeRepository = Depends(get_model_mode_repo),
):
    deleted = await repo.soft_delete(mode_id, user_id=user.user_id)
    if not deleted:
        raise NotFoundError("质量档不存在")
    return StatusResponse()


@router.put("/default", response_model=StatusResponse)
async def set_default_model_mode(
    body: SetDefaultModeRequest,
    user: AuthUser,
    repo: ModelModeRepository = Depends(get_model_mode_repo),
    user_repo: UserRepository = Depends(get_user_repo),
):
    """Set (or clear with null) the user's account-default 质量档."""
    await validate_mode_ref(body.mode, user_id=user.user_id, repo=repo)
    await user_repo.set_default_model_mode(user.user_id, body.mode)
    return StatusResponse()
