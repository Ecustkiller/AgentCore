"""Eval-only quality-mode resolution (decoupled from production turn profiles)."""

from __future__ import annotations

from agentcore.llm.profiles import (
    DEEPSEEK_V4_FLASH,
    DEEPSEEK_V4_PRO,
    TurnProfiles,
)

ROLE_CEO = "ceo"
ROLE_WORKER_STRONG = "worker_strong"
ROLE_WORKER_ECONOMY = "worker_economy"

ROLE_TO_PROFILE: dict[str, str] = {
    ROLE_CEO: "chat",
    ROLE_WORKER_STRONG: "agent.strong",
    ROLE_WORKER_ECONOMY: "agent.fast",
}

CONFIGURABLE_ROLES: tuple[str, ...] = (ROLE_CEO, ROLE_WORKER_STRONG)

KNOWN_MODELS: tuple[str, ...] = (DEEPSEEK_V4_FLASH, DEEPSEEK_V4_PRO)

Assignments = dict[str, str]

SYSTEM_DEFAULT_MODE = "economy"
SYSTEM_PRESETS: dict[str, Assignments] = {
    "economy": {},
    "quality": {
        ROLE_CEO: DEEPSEEK_V4_PRO,
        ROLE_WORKER_STRONG: DEEPSEEK_V4_PRO,
    },
}


def _clamp_to_ceiling(assignments: Assignments, ceiling: frozenset[str]) -> Assignments:
    return {
        role: model
        for role, model in assignments.items()
        if role in CONFIGURABLE_ROLES and model in ceiling
    }


def build_profile_set(assignments: Assignments, *, ceiling: frozenset[str]) -> TurnProfiles:
    safe = _clamp_to_ceiling(assignments, ceiling)
    overrides = {ROLE_TO_PROFILE[role]: model for role, model in safe.items()}
    return TurnProfiles(model=DEEPSEEK_V4_FLASH, model_overrides=overrides)


def resolve_assignments(
    mode_ref: str | None, *, custom_modes: dict[str, Assignments]
) -> Assignments:
    if not mode_ref:
        return SYSTEM_PRESETS[SYSTEM_DEFAULT_MODE]
    if mode_ref in SYSTEM_PRESETS:
        return SYSTEM_PRESETS[mode_ref]
    if mode_ref in custom_modes:
        return custom_modes[mode_ref]
    return SYSTEM_PRESETS[SYSTEM_DEFAULT_MODE]


def resolve_profile_set(
    mode_ref: str | None,
    *,
    custom_modes: dict[str, Assignments],
    ceiling: frozenset[str],
) -> TurnProfiles:
    return build_profile_set(
        resolve_assignments(mode_ref, custom_modes=custom_modes), ceiling=ceiling
    )
