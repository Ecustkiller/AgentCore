"""Tests for the deterministic memory ops applier (MarkdownMemoryApplier)."""

from agentcore.memory.user_memory import (
    MarkdownMemoryApplier,
    MemoryAction,
    MemoryOp,
)

SAMPLE = """\
# 用户记忆
> 本文件由 AI 自动维护，你可随时编辑或删除任何条目。

## 沟通偏好
- 用简体中文回复
- 先给结论，再给细节

## 技术栈与工具
- 后端 Python + FastAPI
"""


def apply(markdown: str, *ops: MemoryOp) -> str:
    return MarkdownMemoryApplier().apply(markdown, list(ops))


def test_add_appends_bullet_under_section():
    out = apply(
        SAMPLE,
        MemoryOp(MemoryAction.ADD, "技术栈与工具", content="偏好 pnpm 管理 Node 依赖"),
    )
    assert "- 偏好 pnpm 管理 Node 依赖" in out
    # appended after the existing bullet in that section
    assert out.index("后端 Python") < out.index("偏好 pnpm")


def test_add_is_deduped_case_and_space_insensitive():
    out = apply(
        SAMPLE,
        MemoryOp(MemoryAction.ADD, "技术栈与工具", content="后端   python + fastapi"),
    )
    assert out.count("FastAPI") == 1  # original kept, normalized duplicate not added


def test_remove_deletes_matching_bullet():
    out = apply(SAMPLE, MemoryOp(MemoryAction.REMOVE, "沟通偏好", match="先给结论"))
    assert "先给结论" not in out
    assert "用简体中文回复" in out  # sibling untouched


def test_update_replaces_matching_bullet():
    out = apply(
        SAMPLE,
        MemoryOp(MemoryAction.UPDATE, "沟通偏好", match="用简体中文回复", content="用英文回复"),
    )
    assert "用英文回复" in out
    assert "用简体中文回复" not in out


def test_update_upserts_when_no_match():
    out = apply(
        SAMPLE,
        MemoryOp(MemoryAction.UPDATE, "工作习惯", match="不存在的条目", content="倾向小步快跑"),
    )
    assert "## 工作习惯" in out
    assert "- 倾向小步快跑" in out


def test_add_creates_missing_section():
    out = apply(SAMPLE, MemoryOp(MemoryAction.ADD, "关于用户的事实", content="在做 AgentCore"))
    assert "## 关于用户的事实" in out
    assert "- 在做 AgentCore" in out


def test_bootstrap_from_empty_input():
    out = apply("", MemoryOp(MemoryAction.ADD, "沟通偏好", content="用简体中文回复"))
    assert out.startswith("# 用户记忆")
    assert "## 沟通偏好" in out
    assert "- 用简体中文回复" in out


def test_preamble_preserved():
    out = apply(SAMPLE, MemoryOp(MemoryAction.ADD, "沟通偏好", content="多用例子说明"))
    assert out.startswith("# 用户记忆")
    assert "本文件由 AI 自动维护" in out


def test_multiple_ops_applied_in_order():
    out = apply(
        SAMPLE,
        MemoryOp(MemoryAction.ADD, "技术栈与工具", content="用 pytest 测试"),
        MemoryOp(MemoryAction.REMOVE, "技术栈与工具", match="后端 Python + FastAPI"),
        MemoryOp(MemoryAction.UPDATE, "沟通偏好", match="先给结论", content="结论先行，再展开"),
    )
    assert "用 pytest 测试" in out
    assert "后端 Python + FastAPI" not in out
    assert "结论先行，再展开" in out


def test_remove_missing_section_is_noop():
    out = apply(SAMPLE, MemoryOp(MemoryAction.REMOVE, "不存在的小节", match="任何"))
    assert "用简体中文回复" in out  # content unchanged


def test_adding_existing_bullet_is_idempotent():
    op = MemoryOp(MemoryAction.ADD, "沟通偏好", content="用简体中文回复")
    once = apply(SAMPLE, op)
    twice = MarkdownMemoryApplier().apply(once, [op])
    assert once == twice  # adding an existing bullet changes nothing


def test_output_has_trailing_newline_and_section_spacing():
    out = apply(SAMPLE)
    assert out.endswith("\n")
    assert "\n\n## 技术栈与工具" in out  # blank line between sections


# --- containment dedup (near-duplicate ADDs collapse to the more specific one) ---


def test_add_substring_of_existing_is_dropped():
    # The new bullet is fully contained in an existing one → keep the existing
    # (more specific) wording, do not add a vaguer near-duplicate.
    out = apply(SAMPLE, MemoryOp(MemoryAction.ADD, "技术栈与工具", content="后端 Python"))
    assert out.count("- 后端") == 1
    assert "后端 Python + FastAPI" in out  # the longer original survived


def test_add_superset_replaces_existing_in_place():
    # The new bullet contains an existing one → upgrade to the more specific
    # wording, replacing in place rather than appending a duplicate.
    out = apply(
        SAMPLE,
        MemoryOp(MemoryAction.ADD, "技术栈与工具", content="后端 Python + FastAPI + SQLAlchemy"),
    )
    assert out.count("- 后端") == 1
    assert "后端 Python + FastAPI + SQLAlchemy" in out


def test_add_unrelated_bullet_is_not_merged():
    # No containment either way → the bullet is appended, nothing is merged.
    out = apply(SAMPLE, MemoryOp(MemoryAction.ADD, "技术栈与工具", content="前端 React"))
    assert "后端 Python + FastAPI" in out
    assert "- 前端 React" in out


# --- section_cap (deterministic backstop that bounds section growth) ---


def test_section_cap_trims_to_most_recent():
    applier = MarkdownMemoryApplier(section_cap=2)
    # 沟通偏好 starts with 2 bullets; adding a 3rd overflows the cap of 2.
    out = applier.apply(SAMPLE, [MemoryOp(MemoryAction.ADD, "沟通偏好", content="多用例子说明")])
    assert "多用例子说明" in out  # newest kept
    assert "先给结论，再给细节" in out  # second-newest kept
    assert "用简体中文回复" not in out  # oldest dropped from the front


def test_section_cap_only_trims_overflowing_section():
    applier = MarkdownMemoryApplier(section_cap=2)
    out = applier.apply(
        SAMPLE, [MemoryOp(MemoryAction.ADD, "关于用户的事实", content="在做 AgentCore")]
    )
    # 技术栈与工具 has a single bullet — under cap, untouched.
    assert "后端 Python + FastAPI" in out
    assert "在做 AgentCore" in out


def test_non_positive_section_cap_means_no_cap():
    applier = MarkdownMemoryApplier(section_cap=0)
    out = applier.apply(
        SAMPLE,
        [
            MemoryOp(MemoryAction.ADD, "沟通偏好", content="第三条"),
            MemoryOp(MemoryAction.ADD, "沟通偏好", content="第四条"),
        ],
    )
    # 0 is treated as "no cap" so a misconfig can never wipe a section.
    assert "用简体中文回复" in out
    assert "先给结论，再给细节" in out
    assert "第三条" in out
    assert "第四条" in out
