"""Design+impl same-grant soft gate unit tests.

假阳性面（刻意不拦 / 已写清）：
- 仅 DESIGN.md / 仅代码 artifacts → 不告警
- 已拆两 task + depends_on（或设计 task 带 checkpoint_after）→ 不告警
- 轻量单文件小改（无设计路径、无阶段 A+B）→ 不告警
- task 文案仅「阶段 A」或仅「阶段 B」→ 不告警
- 已知窄误伤：非设计/实现语义的「阶段 A + 阶段 B」双标签仍会软提示（靠收窄文案，不扩扫）
"""

from __future__ import annotations

import pytest

from agentcore.runtime.delegate.design_impl_slice import (
    check_design_impl_same_grant,
    is_code_artifact_path,
    is_design_artifact_path,
    task_text_claims_design_and_impl_phases,
)
from tests.delegate.conftest import Provider, ctx, tool

# ── 路径 / 文案谓词 ───────────────────────────────────────────────────────────


def test_design_and_code_path_predicates():
    assert is_design_artifact_path("agent-editor/DESIGN.md")
    assert is_design_artifact_path("docs/architecture.md")
    assert is_design_artifact_path("方案设计.md")
    assert not is_design_artifact_path("src/main.ts")
    assert not is_design_artifact_path("README.md")

    assert is_code_artifact_path("package.json")
    assert is_code_artifact_path("src/main.ts")
    assert is_code_artifact_path("apps/desktop/electron/main.ts")
    assert is_code_artifact_path("lib/util.py")
    assert not is_code_artifact_path("DESIGN.md")
    assert not is_code_artifact_path("notes.json")


def test_phase_a_and_b_cue():
    gold = (
        "在 agent-editor/ 下新建 MVP 骨架。分两段执行："
        "【阶段 A：设计落盘】先写 DESIGN.md；"
        "【阶段 B：实现骨架】再落 package.json 与 src/。"
    )
    assert task_text_claims_design_and_impl_phases(gold)
    assert not task_text_claims_design_and_impl_phases("【阶段 A：设计落盘】只写 DESIGN.md")
    assert not task_text_claims_design_and_impl_phases("实现登录页")


# ── 纯函数闸 ──────────────────────────────────────────────────────────────────


def test_soft_warn_design_md_plus_src_same_task():
    """正例（日志同类）：同一 task artifacts 同时含 DESIGN.md + src/ → 软告警，不拒收。"""
    warn = check_design_impl_same_grant(
        [
            {
                "id": "fs",
                "role": "全栈工程师",
                "task": "新建桌面 AI 编程助手 MVP 骨架",
                "deliverable": {
                    "form": "files",
                    "artifacts": [
                        "agent-editor/DESIGN.md",
                        "agent-editor/package.json",
                        "agent-editor/src/main.ts",
                    ],
                },
            }
        ]
    )
    assert warn is not None
    assert "全栈工程师" in warn
    assert "depends_on" in warn
    assert "checkpoint_after" in warn
    assert "不拒收" in warn


def test_soft_warn_phase_a_and_b_in_task_text():
    """正例：单 task 文案同时含阶段 A + 阶段 B → 软告警。"""
    warn = check_design_impl_same_grant(
        [
            {
                "id": "fs",
                "role": "全栈工程师",
                "task": (
                    "分两段执行：【阶段 A：设计落盘】写 DESIGN.md；"
                    "【阶段 B：实现骨架】落 src/ 与 electron。"
                ),
            }
        ]
    )
    assert warn is not None
    assert "全栈工程师" in warn


def test_ok_when_split_two_tasks_with_depends_on():
    """反例：已拆设计 task + 实现 task（depends_on）→ 无告警。"""
    warn = check_design_impl_same_grant(
        [
            {
                "id": "d",
                "role": "设计师",
                "task": "写设计说明",
                "deliverable": {
                    "form": "files",
                    "artifacts": ["agent-editor/DESIGN.md"],
                },
            },
            {
                "id": "i",
                "role": "工程师",
                "task": "按设计实现骨架",
                "depends_on": ["d"],
                "deliverable": {
                    "form": "files",
                    "artifacts": [
                        "agent-editor/package.json",
                        "agent-editor/src/main.ts",
                    ],
                },
            },
        ]
    )
    assert warn is None


def test_ok_when_design_has_checkpoint_after_and_downstream():
    """反例：设计 task 虽文案含阶段 A+B，但有 checkpoint_after + 下游依赖 → 视为已拆开。"""
    warn = check_design_impl_same_grant(
        [
            {
                "id": "d",
                "role": "全栈",
                "task": "【阶段 A：设计】【阶段 B：实现】先设计后实现",
                "checkpoint_after": True,
                "deliverable": {
                    "form": "files",
                    "artifacts": ["DESIGN.md", "src/app.ts"],
                },
            },
            {
                "id": "i",
                "role": "实现续",
                "task": "继续实现",
                "depends_on": ["d"],
            },
        ]
    )
    assert warn is None


def test_ok_design_only():
    """反例：仅 DESIGN → 不告警。"""
    warn = check_design_impl_same_grant(
        [
            {
                "id": "d",
                "role": "设计师",
                "task": "写架构说明",
                "deliverable": {
                    "form": "files",
                    "artifacts": ["docs/ARCHITECTURE.md"],
                },
            }
        ]
    )
    assert warn is None


def test_ok_code_only_light_change():
    """反例：仅代码 / 轻量单文件小改 → 不告警。"""
    warn = check_design_impl_same_grant(
        [
            {
                "id": "e",
                "role": "工程师",
                "task": "修登录按钮点击无响应",
                "deliverable": {
                    "form": "files",
                    "artifacts": ["src/components/LoginButton.tsx"],
                },
            }
        ]
    )
    assert warn is None


def test_ok_phase_a_only():
    warn = check_design_impl_same_grant(
        [
            {
                "role": "设计师",
                "task": "【阶段 A：设计落盘】只写 DESIGN.md",
                "deliverable": {"form": "files", "artifacts": ["DESIGN.md"]},
            }
        ]
    )
    assert warn is None


# ── DelegateTool：软提示进 CEO 可见结果尾（不拒收）────────────────────────────


@pytest.mark.asyncio
async def test_execute_surfaces_design_impl_warn_in_output():
    """DESIGN+src 同 task → 委派成功入图，告警文案进工具结果尾。"""
    t = tool(Provider(["骨架产出"]))
    result = await t.execute(
        {
            "tasks": [
                {
                    "id": "fs",
                    "role": "全栈工程师",
                    "task": "新建 MVP 骨架",
                    "deliverable": {
                        "form": "files",
                        "artifacts": [
                            "agent-editor/DESIGN.md",
                            "agent-editor/src/main.ts",
                        ],
                    },
                }
            ],
            "coordinate": False,
        },
        ctx(),
    )
    assert result.success is True
    assert result.error in (None, "")
    assert "同时塞了设计与实现" in result.output
    assert "depends_on" in result.output
    assert "checkpoint_after" in result.output


@pytest.mark.asyncio
async def test_execute_no_design_impl_tail_when_split():
    """已拆两 task + depends_on → 成功且无设计实现混装告警。"""
    t = tool(Provider(["设计产出", "实现产出"]))
    result = await t.execute(
        {
            "tasks": [
                {
                    "id": "d",
                    "role": "设计师",
                    "task": "写 DESIGN.md",
                    "deliverable": {
                        "form": "files",
                        "artifacts": ["DESIGN.md"],
                    },
                },
                {
                    "id": "i",
                    "role": "工程师",
                    "task": "实现 src/",
                    "depends_on": ["d"],
                    "deliverable": {
                        "form": "files",
                        "artifacts": ["src/main.ts"],
                    },
                },
            ],
            "coordinate": False,
        },
        ctx(),
    )
    assert result.success is True
    assert "同时塞了设计与实现" not in result.output


@pytest.mark.asyncio
async def test_execute_no_design_impl_tail_code_only():
    """仅代码小改 → 成功且无混装尾巴。"""
    t = tool(Provider(["修好了"]))
    result = await t.execute(
        {
            "tasks": [
                {
                    "id": "e",
                    "role": "工程师",
                    "task": "修一个按钮",
                    "deliverable": {
                        "form": "files",
                        "artifacts": ["src/Button.tsx"],
                    },
                }
            ],
            "coordinate": False,
        },
        ctx(),
    )
    assert result.success is True
    assert "同时塞了设计与实现" not in result.output
