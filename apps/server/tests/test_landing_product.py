"""Product-landing path gate (dossier notes count as product)."""

from __future__ import annotations

from agentcore.runtime.runs.landing_product import (
    filter_product_landing_paths,
    is_dossier_intermediate_path,
    is_product_landing_path,
    landing_tool_path_from_args,
)
from agentcore.workspace.stage_dirs import RESEARCH_DIR, REVIEWS_DIR


def test_dossier_intermediate_paths():
    assert is_dossier_intermediate_path(f"{REVIEWS_DIR}/修复方案.md")
    assert is_dossier_intermediate_path(f"{RESEARCH_DIR}/报告.md")
    assert is_dossier_intermediate_path(f"{RESEARCH_DIR}/")
    assert not is_dossier_intermediate_path("apps/server/foo.py")
    assert not is_dossier_intermediate_path("site/index.html")


def test_reviews_md_counts_as_product_without_artifacts():
    path = f"{REVIEWS_DIR}/某修复方案.md"
    assert is_product_landing_path(path, None)
    assert is_product_landing_path(path, [])
    assert filter_product_landing_paths([path, "src/a.py"], None) == [
        path,
        "src/a.py",
    ]


def test_research_artifact_still_product():
    art = f"{RESEARCH_DIR}/调研报告.md"
    assert is_product_landing_path(art, [art])
    assert is_product_landing_path(art, [f"{RESEARCH_DIR}/"])
    assert filter_product_landing_paths([art], [art]) == [art]


def test_missing_path_compat_counts_as_product():
    assert is_product_landing_path(None, None)
    assert is_product_landing_path("", [])


def test_landing_tool_path_from_args():
    assert (
        landing_tool_path_from_args("file_write", {"path": "a.py"}) == "a.py"
    )
    assert (
        landing_tool_path_from_args("write_section", {"path": "sec.md"})
        == "sec.md"
    )
    assert (
        landing_tool_path_from_args(
            "file_move", {"source": "a.py", "destination": "b.py"}
        )
        == "b.py"
    )
    assert (
        landing_tool_path_from_args(
            "file_copy", {"source": "a.py", "destination": "out/b.py"}
        )
        == "out/b.py"
    )
    # file_copy / file_move use destination, not source / path.
    assert (
        landing_tool_path_from_args(
            "file_copy", {"source": "a.py", "path": "wrong.py"}
        )
        is None
    )
    assert landing_tool_path_from_args("file_read", {"path": "a.py"}) is None


def test_file_product_tables_aligned_with_serialize():
    """tip allowlist / landing path / LANDING_TOOLS 须与 serialize._FILE_PRODUCT_ARG 同集。"""
    from agentcore.runtime.engine.tool_exec_args import _FILE_PRODUCT_TOOL_NAMES
    from agentcore.runtime.loop_controller import LANDING_TOOLS
    from agentcore.runtime.runs.serialize import _FILE_PRODUCT_ARG

    expected = frozenset(_FILE_PRODUCT_ARG)
    assert expected == _FILE_PRODUCT_TOOL_NAMES
    assert expected == LANDING_TOOLS
    for name, key in _FILE_PRODUCT_ARG.items():
        if key == "destination":
            assert (
                landing_tool_path_from_args(
                    name, {"source": "src", "destination": "dst.txt"}
                )
                == "dst.txt"
            )
        else:
            assert (
                landing_tool_path_from_args(name, {"path": "p.txt"}) == "p.txt"
            )


def test_landing_tool_path_sanitizes_dossier_nested():
    nested = f"{RESEARCH_DIR}/子目录/笔记.md"
    assert (
        landing_tool_path_from_args("file_write", {"path": nested})
        == f"{RESEARCH_DIR}/子目录_笔记.md"
    )
