"""Unit tests for the 质量档 resolution layer (llm/modes.py).

Pure logic — no DB. Verifies that a mode ref resolves to the right effective models
per team role, that the operator ceiling clamps forbidden picks, that 经济worker is
locked, and that only the model is swapped (tuned params stay put).
"""

from agentcore.llm.config import (
    DEEPSEEK_V4_FLASH,
    DEEPSEEK_V4_PRO,
    PROFILES,
)
from agentcore.llm.modes import (
    ROLE_CEO,
    ROLE_WORKER_ECONOMY,
    ROLE_WORKER_STRONG,
    build_profile_set,
    default_profile_set,
    resolve_profile_set,
    sanitize_assignments,
)

_FULL_CEILING = frozenset({DEEPSEEK_V4_FLASH, DEEPSEEK_V4_PRO})


def _resolve(ref, custom_modes=None, ceiling=_FULL_CEILING):
    return resolve_profile_set(ref, custom_modes=custom_modes or {}, ceiling=ceiling)


def test_economy_default_is_all_flash():
    ps = _resolve("economy")
    assert ps.get("chat").model == DEEPSEEK_V4_FLASH
    assert ps.agent("strong").model == DEEPSEEK_V4_FLASH
    assert ps.agent("fast").model == DEEPSEEK_V4_FLASH


def test_quality_lifts_ceo_and_strong_only():
    ps = _resolve("quality")
    assert ps.get("chat").model == DEEPSEEK_V4_PRO  # CEO本体
    assert ps.agent("strong").model == DEEPSEEK_V4_PRO  # 主力worker
    # 经济worker stays Flash even in 高质量 (cheap tier by definition).
    assert ps.agent("fast").model == DEEPSEEK_V4_FLASH


def test_none_and_unknown_ref_fall_back_to_economy():
    for ref in (None, "", "does-not-exist"):
        ps = _resolve(ref)
        assert ps.get("chat").model == DEEPSEEK_V4_FLASH
        assert ps.agent("strong").model == DEEPSEEK_V4_FLASH


def test_custom_mode_resolves_by_id():
    custom = {"m1": {ROLE_CEO: DEEPSEEK_V4_PRO}}
    ps = _resolve("m1", custom_modes=custom)
    assert ps.get("chat").model == DEEPSEEK_V4_PRO
    assert ps.agent("strong").model == DEEPSEEK_V4_FLASH  # not lifted


def test_ceiling_clamps_forbidden_model():
    # Pro pulled from the ceiling (e.g. tightened during内测): a Pro pick degrades
    # back to the base model rather than serving a now-forbidden model.
    ps = build_profile_set({ROLE_CEO: DEEPSEEK_V4_PRO}, ceiling=frozenset({DEEPSEEK_V4_FLASH}))
    assert ps.get("chat").model == DEEPSEEK_V4_FLASH


def test_worker_economy_assignment_is_ignored():
    # 经济worker is not a configurable role → an override on it is dropped (locked).
    ps = build_profile_set({ROLE_WORKER_ECONOMY: DEEPSEEK_V4_PRO}, ceiling=_FULL_CEILING)
    assert ps.agent("fast").model == DEEPSEEK_V4_FLASH


def test_sanitize_drops_noncfg_roles_and_forbidden_models():
    cleaned = sanitize_assignments(
        {
            ROLE_CEO: DEEPSEEK_V4_PRO,  # kept
            ROLE_WORKER_ECONOMY: DEEPSEEK_V4_PRO,  # dropped (locked role)
            ROLE_WORKER_STRONG: "deepseek-v9-imaginary",  # dropped (not in ceiling)
            "bogus": DEEPSEEK_V4_FLASH,  # dropped (unknown role)
        },
        ceiling=_FULL_CEILING,
    )
    assert cleaned == {ROLE_CEO: DEEPSEEK_V4_PRO}


def test_default_profile_set_is_economy():
    ps = default_profile_set()
    assert ps.get("chat").model == DEEPSEEK_V4_FLASH
    assert ps.agent("strong").model == DEEPSEEK_V4_FLASH


def test_mode_swaps_model_but_preserves_params():
    # 高质量 only changes the model; the tuned thinking/effort/round-budget on the
    # base chat profile must survive (a mode is not allowed to retune params).
    base_chat = PROFILES["chat"]
    lifted = _resolve("quality").get("chat")
    assert lifted.model == DEEPSEEK_V4_PRO
    assert lifted.thinking == base_chat.thinking
    assert lifted.reasoning_effort == base_chat.reasoning_effort
    assert lifted.temperature == base_chat.temperature
    assert lifted.max_rounds == base_chat.max_rounds


def test_base_profiles_not_mutated_by_resolution():
    # build_profile_set copies PROFILES; resolving 高质量 must not mutate the shared
    # base dict (else the next economy turn would inherit Pro).
    _resolve("quality")
    assert PROFILES["chat"].model == DEEPSEEK_V4_FLASH
    assert PROFILES["agent.strong"].model == DEEPSEEK_V4_FLASH
