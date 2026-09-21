"""in-history extra system is a catalog/rules delta, not a full re-compose."""

from agentcore.runtime.resolve.prompt.in_history import in_history_system_delta

_BASE = "全员基座宪法。"
_CAT_V1 = "<按需目录>\n- a：旧\n</按需目录>"
_CAT_V2 = "<按需目录>\n- a：旧\n- b：新\n</按需目录>"
_RULES_V1 = "<设定>\n### 规则/一\n短约束\n</设定>"
_RULES_V2 = "<设定>\n### 规则/一\n短约束改了\n</设定>"


def test_catalog_only_omits_frozen_base():
    extra = in_history_system_delta(
        f"{_BASE}\n\n{_CAT_V1}",
        f"{_BASE}\n\n{_CAT_V2}",
    )
    assert _CAT_V2 in extra
    assert _BASE not in extra
    assert _CAT_V1 not in extra


def test_rules_only_omits_frozen_base():
    extra = in_history_system_delta(
        f"{_BASE}\n\n{_RULES_V1}\n\n{_CAT_V1}",
        f"{_BASE}\n\n{_RULES_V2}\n\n{_CAT_V1}",
    )
    assert _RULES_V2 in extra
    assert _CAT_V1 not in extra
    assert _BASE not in extra


def test_catalog_and_rules_both_in_delta():
    extra = in_history_system_delta(
        f"{_BASE}\n\n{_RULES_V1}\n\n{_CAT_V1}",
        f"{_BASE}\n\n{_RULES_V2}\n\n{_CAT_V2}",
    )
    assert extra.index("<设定>") < extra.index("<按需目录>")
    assert _RULES_V2 in extra
    assert _CAT_V2 in extra
    assert _BASE not in extra


def test_dropped_catalog_emits_empty_tag():
    extra = in_history_system_delta(f"{_BASE}\n\n{_CAT_V1}", _BASE)
    assert "<按需目录>" in extra
    assert "</按需目录>" in extra
    assert "：旧" not in extra
    assert _BASE not in extra


def test_base_drift_falls_back_to_full_current():
    current = f"新基座。\n\n{_CAT_V1}"
    extra = in_history_system_delta(f"{_BASE}\n\n{_CAT_V1}", current)
    assert extra == current


def test_identical_compose_is_empty():
    text = f"{_BASE}\n\n{_CAT_V1}"
    assert in_history_system_delta(text, text) == ""


def test_unstructured_drift_still_dumps_full_current():
    assert in_history_system_delta("SYS v1", "SYS v2") == "SYS v2"
