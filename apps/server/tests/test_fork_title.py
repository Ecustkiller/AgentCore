"""Clone titles: ``报告`` → ``报告 (1)``, not a stacked「副本」."""

from agentcore.conversation.fork_title import (
    CONVERSATION_TITLE_MAX_LEN,
    FORK_UNTITLED_STEM,
    fork_stem,
    next_fork_title,
)


def test_first_fork_is_one_not_two():
    assert next_fork_title("报告", ["报告"]) == "报告 (1)"


def test_second_fork_takes_two():
    assert next_fork_title("报告", ["报告", "报告 (1)"]) == "报告 (2)"


def test_fills_a_hole():
    assert next_fork_title("报告", ["报告", "报告 (1)", "报告 (3)"]) == "报告 (2)"


def test_fork_of_numbered_title_shares_the_stem():
    assert fork_stem("报告 (1)") == "报告"
    assert next_fork_title("报告 (1)", ["报告", "报告 (1)"]) == "报告 (2)"


def test_legacy_copy_suffix_peels_to_the_stem():
    assert fork_stem("报告 副本") == "报告"
    assert fork_stem("报告 副本 副本") == "报告"
    assert fork_stem("报告 副本 2") == "报告"
    assert fork_stem("报告 副本 (1)") == "报告"
    assert fork_stem("副本") == ""
    assert next_fork_title("报告 副本", ["报告", "报告 副本"]) == "报告 (1)"


def test_year_in_parentheses_is_not_a_fork_index():
    assert fork_stem("ISO 27001 (2022)") == "ISO 27001 (2022)"
    assert next_fork_title("ISO 27001 (2022)", ["ISO 27001 (2022)"]) == (
        "ISO 27001 (2022) (1)"
    )


def test_empty_source_uses_untitled_stem():
    assert next_fork_title("", []) == f"{FORK_UNTITLED_STEM} (1)"
    assert next_fork_title("   ", [f"{FORK_UNTITLED_STEM} (1)"]) == (
        f"{FORK_UNTITLED_STEM} (2)"
    )


def test_casefold_occupies_the_same_slot():
    assert next_fork_title("Report", ["Report (1)"]) == "Report (2)"


def test_suffix_survives_a_max_len_clip():
    stem = "题" * CONVERSATION_TITLE_MAX_LEN
    out = next_fork_title(stem, [])
    assert out.endswith(" (1)")
    assert len(out) == CONVERSATION_TITLE_MAX_LEN
