"""User-selectable model modes (质量档) — team-language model selection.

A *mode* maps **team roles** (what the user sees) to concrete models on top of the
base :class:`~agentcore.llm.config.ModelProfile` params. The user-facing roles
CEO本体 / 主力worker / 经济worker front the internal ``chat`` / ``agent.strong`` /
``agent.fast`` profiles; ``memory`` / ``title`` are NEVER user-configurable. A mode
only swaps a profile's **model** — the tuned thinking / effort / temperature /
round-budget always stay in code (an engineering concern, not a user knob).

Two layers compose here (see docs/03-AI核心/编排器与CEO主Agent.md §2.1):

- **Operator ceiling** (``settings.selectable_models``): the set of models a user
  may pick at all. Enforced on write (route) *and* on resolve (``_clamp_to_ceiling``)
  so a mode persisted before the ceiling tightened still resolves safely.
- **User modes**: system presets (``economy`` / ``quality``, read-only) plus the
  user's own custom modes (DB rows, resolved by the caller into ``custom_modes``).

Resolution precedence (the caller passes the first non-null it has):
``conversation.model_mode`` → ``user.default_model_mode`` →
``settings.default_model_mode`` → :data:`SYSTEM_DEFAULT_MODE` (economy). An unknown
or deleted mode ref falls back to the system default — a model-config problem must
never break a turn (mirrors ``pricing.pricing_for`` / ``config.get_profile``).

This module is intentionally **pure** (no DB / settings imports): the caller loads
the user's custom modes and the ceiling and passes them in, so the resolver stays
trivially unit-testable.
"""

from __future__ import annotations

from dataclasses import dataclass, replace

from agentcore.core.types import ModelTier
from agentcore.llm.config import (
    DEEPSEEK_V4_FLASH,
    DEEPSEEK_V4_PRO,
    PROFILES,
    ModelProfile,
    get_profile,
)

# --- Team-role vocabulary (the only place roles ↔ internal profiles are bound) ---
# Users configure these team roles; the engine speaks profiles. memory/title are
# deliberately absent — they are never exposed nor configurable.
ROLE_CEO = "ceo"
ROLE_WORKER_STRONG = "worker_strong"
ROLE_WORKER_ECONOMY = "worker_economy"

ROLE_TO_PROFILE: dict[str, str] = {
    ROLE_CEO: "chat",
    ROLE_WORKER_STRONG: "agent.strong",
    ROLE_WORKER_ECONOMY: "agent.fast",
}

# Roles the user may actually re-assign. 经济worker(agent.fast) is intentionally NOT
# here (决策: 锁 Flash) — the fast tier is "cheap by definition", so lifting it to
# Pro would defeat its purpose. The UI may still *show* it (read-only) via the
# catalog; resolution never honors an override on it.
CONFIGURABLE_ROLES: tuple[str, ...] = (ROLE_CEO, ROLE_WORKER_STRONG)

# Logical model catalog. The operator ceiling selects which of these a user can pick.
KNOWN_MODELS: tuple[str, ...] = (DEEPSEEK_V4_FLASH, DEEPSEEK_V4_PRO)

# A mode's assignments: team-role → model id. A role absent from the map keeps the
# base profile's model (i.e. inherits the economy/default model for that scenario).
Assignments = dict[str, str]

# --- System presets (read-only, code-defined) ---------------------------------
# economy = all base models (Flash everywhere) = the default. quality lifts the
# CEO本体 + 主力worker to Pro; 经济worker stays Flash (cheap tier).
# 内测 (方案 A-中+): Pro is out of the *user* ceiling (config.user_selectable_models),
# so ``quality`` is unreachable by users — a user/conversation ref to it clamps to
# Flash via ``_clamp_to_ceiling``. The preset is kept (not deleted) because eval is
# its only live consumer: the harness/judge resolve ``quality`` against the FULL
# catalog ceiling (evals/harness._EVAL_CEILING) to exercise Flash-vs-Pro and the Pro
# judge. Re-adding Pro to the user ceiling restores it for users with zero changes.
SYSTEM_DEFAULT_MODE = "economy"
SYSTEM_PRESETS: dict[str, Assignments] = {
    "economy": {},
    "quality": {
        ROLE_CEO: DEEPSEEK_V4_PRO,
        ROLE_WORKER_STRONG: DEEPSEEK_V4_PRO,
    },
}


@dataclass(frozen=True)
class ProfileSet:
    """The effective :class:`ModelProfile` per scenario, resolved once per turn.

    Explicitly injected through the pipeline (NO module-global mutation), so two
    concurrent turns can run different modes without racing. Built by
    :func:`build_profile_set` from the base ``PROFILES`` with a mode's per-role
    model overrides applied (params untouched, only ``model`` swapped).
    """

    profiles: dict[str, ModelProfile]

    def get(self, name: str) -> ModelProfile:
        """Resolve a named profile, falling back to the global base profile."""
        return self.profiles.get(name) or get_profile(name)

    def agent(self, preference: ModelTier | str) -> ModelProfile:
        """Map a delegate worker model_preference (fast/strong) to its profile."""
        pref = preference.value if isinstance(preference, ModelTier) else str(preference)
        return self.get(f"agent.{pref}")


def _clamp_to_ceiling(
    assignments: Assignments, ceiling: frozenset[str]
) -> Assignments:
    """Keep only role→model entries that are configurable AND within the ceiling.

    Defence in depth: writes are validated up front (route), but a mode persisted
    before a ceiling tightened (e.g. Pro pulled during内测) must still resolve to a
    safe set rather than serving a now-forbidden model.
    """
    return {
        role: model
        for role, model in assignments.items()
        if role in CONFIGURABLE_ROLES and model in ceiling
    }


def build_profile_set(
    assignments: Assignments, *, ceiling: frozenset[str]
) -> ProfileSet:
    """Apply a mode's (ceiling-clamped) role→model overrides onto the base profiles."""
    safe = _clamp_to_ceiling(assignments, ceiling)
    profiles = dict(PROFILES)
    for role, model in safe.items():
        key = ROLE_TO_PROFILE[role]
        profiles[key] = replace(profiles[key], model=model)
    return ProfileSet(profiles=profiles)


def resolve_assignments(
    mode_ref: str | None, *, custom_modes: dict[str, Assignments]
) -> Assignments:
    """Resolve a mode ref (preset name or custom-mode id) to its assignments.

    ``custom_modes`` is the caller-loaded ``{mode_id: assignments}`` for the user
    (the only DB-touching part stays in the caller). An empty / unknown / deleted
    ref falls back to the system default (economy) so a turn never crashes on a
    stale selection.
    """
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
) -> ProfileSet:
    """One-shot: resolve a mode ref → assignments → an effective :class:`ProfileSet`."""
    return build_profile_set(
        resolve_assignments(mode_ref, custom_modes=custom_modes), ceiling=ceiling
    )


def default_profile_set() -> ProfileSet:
    """The economy (all-base) profile set — for callers without a mode selection
    (e.g. the autonomous local→云 handoff job, which has no live user picking one)."""
    return ProfileSet(profiles=dict(PROFILES))


def sanitize_assignments(
    raw: dict[str, str], *, ceiling: frozenset[str]
) -> Assignments:
    """Validate a user-submitted assignments map for persistence (route layer).

    Keeps only configurable roles assigned to a model within the operator ceiling.
    Unknown roles / forbidden models are dropped (not an error: the mode degrades
    to base for those roles), keeping a stored mode always resolvable.
    """
    return {
        role: model
        for role, model in raw.items()
        if role in CONFIGURABLE_ROLES and model in ceiling
    }
