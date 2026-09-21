"""Product-landing path gate (dossier notes count as product)."""

from __future__ import annotations

from agentcore.runtime.runs.landing_product import (
    filter_product_landing_paths,
    is_product_landing_path,
    landing_tool_path_from_args,
)


def test_md_counts_as_product_without_artifacts():
    path = "notes/某修复方案.md"
    assert is_product_landing_path(path, None)
    assert is_product_landing_path(path, [])
    assert filter_product_landing_paths([path, "src/a.py"], None) == [
        path,
        "src/a.py",
    ]


def test_nested_artifact_still_product():
    art = "notes/报告.md"
    assert is_product_landing_path(art, [art])
    assert is_product_landing_path(art, ["notes/"])
    assert filter_product_landing_paths([art], [art]) == [art]


def test_missing_path_compat_counts_as_product():
    assert is_product_landing_path(None, None)
    assert is_product_landing_path("", [])


def test_landing_tool_path_from_args():
    assert (
        landing_tool_path_from_args("write", {"file_path": "a.py"}) == "a.py"
    )
    assert (
        landing_tool_path_from_args(
            "file_batch",
            {
                "operations": [
                    {"op": "move", "source": "a.py", "destination": "b.py"}
                ]
            },
        )
        == "b.py"
    )
    assert (
        landing_tool_path_from_args(
            "file_batch",
            {
                "operations": [
                    {"op": "copy", "source": "a.py", "destination": "out/b.py"}
                ]
            },
        )
        == "out/b.py"
    )
    # file_batch move/copy uses destination, not a stray path.
    assert (
        landing_tool_path_from_args(
            "file_batch",
            {
                "operations": [
                    {"op": "copy", "source": "a.py", "path": "wrong.py"}
                ]
            },
        )
        is None
    )
    assert landing_tool_path_from_args("read", {"file_path": "a.py"}) is None


def test_landing_tools_is_one_object_everywhere():
    """治理面的「笔」只有一份: 各处必须 re-export 同一个对象，不得再抄一份名单。

    从前 tip allowlist / 写参解析 / delivery-idle 各存一份 frozenset，只能靠对齐测试防
    「加了不同步」——``file_copy`` 仍旧在 ``_WRITE_PARSE_TOOLS`` 里漏了一整版。现在同一性
    即对齐：抄一份新的会让这里立刻红。
    """
    from agentcore.runtime.engine import tool_exec_args
    from agentcore.runtime.loop_controller import LANDING_TOOLS as CONTROLLER_TOOLS
    from agentcore.runtime.loop_controller import types as controller_types
    from agentcore.runtime.runs import landing_product
    from agentcore.runtime.runs.serialize import LANDING_TOOLS as SERIALIZE_TOOLS
    from agentcore.tools.file_products import LANDING_TOOLS

    for seen in (
        CONTROLLER_TOOLS,
        controller_types.LANDING_TOOLS,
        tool_exec_args.LANDING_TOOLS,
        landing_product.LANDING_TOOLS,
        SERIALIZE_TOOLS,
    ):
        assert seen is LANDING_TOOLS
    # Every pen names its target through the shared arg reader (no per-tool key table).
    for name in LANDING_TOOLS:
        if name == "file_batch":
            assert (
                landing_tool_path_from_args(
                    name,
                    {
                        "operations": [
                            {"op": "copy", "source": "src", "destination": "dst.txt"}
                        ]
                    },
                )
                == "dst.txt"
            )
        else:
            assert (
                landing_tool_path_from_args(name, {"file_path": "p.txt"}) == "p.txt"
            )


async def test_every_landing_tool_self_reports_its_product(tmp_path):
    """台账防「谁都没加」: 每支笔执行成功后必须自报它真正落的盘。

    这是白名单消失后的守门测试——旧的对齐测试只能发现「名单加了没同步」，发现不了
    「新工具压根没自报」（正是 .docx 漏账事故的形状）。这里真跑每支笔，断言
    ``ToolResult.file_products`` 就是磁盘上那个路径；不自报即红。
    """
    from agentcore.tools.builtin.file_ops import (
        FileBatchTool,
        FileWriteTool,
        StrReplaceTool,
    )
    from agentcore.tools.file_products import LANDING_TOOLS
    from agentcore.tools.protocol import ToolContext
    from agentcore.tools.sandbox.subprocess import SubprocessSandbox
    from agentcore.workspace.server import ServerWorkspace

    def _ctx() -> ToolContext:
        return ToolContext.create(
            execution_id="e",
            run_id="s",
            agent_id="a",
            backend=ServerWorkspace(root=tmp_path, sandbox=SubprocessSandbox()),
            user_id="u",
        )

    (tmp_path / "src.txt").write_text("alpha\n", encoding="utf-8")
    cases: list[tuple[str, object, dict, str, str]] = [
        ("write", FileWriteTool(), {"file_path": "报告.md", "content": "# 标题"}, "报告.md", "md"),
        (
            "edit",
            StrReplaceTool(),
            {"file_path": "src.txt", "old_string": "alpha", "new_string": "beta"},
            "src.txt",
            "txt",
        ),
        (
            "file_batch",
            FileBatchTool(),
            {
                "operations": [
                    {"op": "copy", "source": "src.txt", "destination": "out/copy.py"}
                ]
            },
            "out/copy.py",
            "code",
        ),
    ]
    assert {name for name, *_ in cases} == set(LANDING_TOOLS)

    for name, tool, args, landed, kind in cases:
        result = await tool.execute(args, _ctx())  # type: ignore[attr-defined]
        assert result.success is True, f"{name}: {result.error}"
        assert [(p.path, p.kind, p.derived_from) for p in result.file_products] == [
            (landed, kind, None)
        ], f"{name} 未自报产物"
        assert (tmp_path / landed).exists()


def test_landing_tool_path_keeps_nested():
    nested = "notes/子目录/笔记.md"
    assert landing_tool_path_from_args("write", {"file_path": nested}) == nested
