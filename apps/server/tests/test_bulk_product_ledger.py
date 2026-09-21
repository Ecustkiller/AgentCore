"""批量 / 落字节工具的自报产物 → 交付物台账（契约见 ``tools/file_products.py``）。

``write`` 那批「笔」早已自报，但一次能产多件的 ``file_batch`` 也曾漏账。
这里按事故形状端到端钉死：真跑工具 → 引擎盖章 → ``files_touched`` /
``file_acceptance``。断言的是**真正落盘的路径**（已过 sanitize，不是模型请求的
原始 path），且搬家 / 复制一律不填 ``derived_from``（填错会让源文件在用户面被
误折叠成中间稿）。
"""

from __future__ import annotations

from pathlib import Path

from agentcore.llm.provider.protocol import LLMMessage
from agentcore.runtime.runs.serialize import (
    files_touched_from_transcript,
)
from agentcore.tools.builtin.file_ops import FileBatchTool
from agentcore.tools.file_products import with_file_products_marker
from agentcore.tools.protocol import ToolContext, ToolResult
from agentcore.tools.sandbox.subprocess import SubprocessSandbox
from agentcore.workspace.server import ServerWorkspace


def _ctx(workspace: Path) -> ToolContext:
    return ToolContext.create(
        execution_id="e",
        run_id="s",
        agent_id="a",
        backend=ServerWorkspace(root=workspace, sandbox=SubprocessSandbox()),
        user_id="u",
    )


def _ledger(result: ToolResult) -> list[str]:
    """台账看到的路径：按引擎单点盖章的样子过一遍 transcript（tool_exec_call 同款）。"""
    message = LLMMessage(
        role="tool",
        content=with_file_products_marker(result.output, result.file_products),
        tool_call_id="c1",
    )
    return files_touched_from_transcript([message])


async def test_file_batch_reports_every_destination_it_landed(tmp_path: Path):
    """一次多件：move / copy 逐件自报落地路径；mkdir / delete 没有产物。"""
    (tmp_path / "src.md").write_text("alpha", encoding="utf-8")
    (tmp_path / "keep.md").write_text("beta", encoding="utf-8")
    (tmp_path / "gone.md").write_text("旧", encoding="utf-8")

    result = await FileBatchTool().execute(
        {
            "operations": [
                {"op": "mkdir", "path": "out"},
                {"op": "move", "source": "src.md", "destination": "out/moved.md"},
                {"op": "copy", "source": "keep.md", "destination": "out/copy.docx"},
                {"op": "delete", "path": "gone.md", "permanent": True},
            ]
        },
        _ctx(tmp_path),
    )

    assert result.success is True
    assert [(p.path, p.kind, p.derived_from) for p in result.file_products] == [
        ("out/moved.md", "md", None),
        ("out/copy.docx", "docx", None),
    ]
    assert _ledger(result) == ["out/moved.md", "out/copy.docx"]
    assert (tmp_path / "out" / "moved.md").is_file()
    assert (tmp_path / "out" / "copy.docx").is_file()


async def test_file_batch_reports_nested_destination_as_landed(tmp_path: Path):
    """自报的必须是真正落盘的路径：嵌套 dest 保持嵌套。"""
    notes = tmp_path / "notes"
    notes.mkdir(parents=True)
    (notes / "src.md").write_text("review", encoding="utf-8")

    nested = "notes/a/b.md"
    result = await FileBatchTool().execute(
        {
            "operations": [
                {
                    "op": "move",
                    "source": "notes/src.md",
                    "destination": nested,
                }
            ]
        },
        _ctx(tmp_path),
    )

    assert result.success is True
    assert _ledger(result) == [nested]
    assert (tmp_path / Path(nested)).is_file()


async def test_file_batch_partial_failure_reports_only_the_successes(tmp_path: Path):
    """部分成功只报真正落地的那些：源不存在的那条不得入账。"""
    (tmp_path / "src.md").write_text("alpha", encoding="utf-8")

    result = await FileBatchTool().execute(
        {
            "operations": [
                {"op": "move", "source": "src.md", "destination": "out/ok.md"},
                {"op": "copy", "source": "missing.md", "destination": "out/nope.md"},
            ]
        },
        _ctx(tmp_path),
    )

    assert result.success is False
    assert result.metadata["ok"] == 1
    assert result.metadata["fail"] == 1
    # 失败的调用不自报，但整批失败不抹掉已落地的那件（漏账才是事故）。
    assert _ledger(result) == ["out/ok.md"]


async def test_file_batch_skipped_conflict_reports_no_product(tmp_path: Path):
    """目标已存在 = 跳过，没有落任何盘，不得入账。"""
    (tmp_path / "src.md").write_text("alpha", encoding="utf-8")
    (tmp_path / "taken.md").write_text("占位", encoding="utf-8")

    result = await FileBatchTool().execute(
        {
            "operations": [
                {"op": "copy", "source": "src.md", "destination": "taken.md"}
            ]
        },
        _ctx(tmp_path),
    )

    assert result.metadata["skip"] == 1
    assert result.file_products == []
    assert _ledger(result) == []
