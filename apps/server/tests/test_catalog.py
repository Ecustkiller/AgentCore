"""Unit tests for the capability catalog (tools.catalog) and the CEO prompt composer.

These are the GUARD the catalog docstring promises: ``build_capability_catalog`` reads
the CEO-only orchestration tools' schemas off uninitialised instances (their ``schema``
is a pure static descriptor). If a future schema starts touching instance state, the
``name``/``description``/``parameters`` assertions here fail loudly instead of the
endpoint silently serving half-built metadata. Also pins the CEO/worker reach annotation
and the single-source prompt composer's 按需目录 gating.
"""

from agentcore.core.types import ToolFace
from agentcore.runtime.context.consultable import ConsultDirectoryEntry
from agentcore.runtime.resolve.prompt import assemble_system_prompt, compose_ceo_chat_prompt
from agentcore.runtime.resolve.prompt.compose import render_on_demand_directory
from agentcore.runtime.skills import build_system_skill_registry
from agentcore.tools.catalog import (
    AVAILABLE_TO_CEO,
    AVAILABLE_TO_WORKER,
    build_capability_catalog,
)

# What the CEO holds beyond the read-only built-ins (mirrors pipeline._assemble_ceo_toolset).
# ``consult`` is AUDIENCE_BOTH — asserted separately.
_CEO_ORCHESTRATION = {
    "delegate",
    "replan",
    "debate",
    "folders",
    "create_folder",
    "ask_user",
}
# Worker-only collaboration channel. Write / execute built-ins are CEO+worker.
_WORKER_ONLY_COLLAB = {
    "escalate",
    "handoff",
}
_CEO_AND_WORKER_MUTATION = {
    "file_write",
    "str_replace",
    "file_delete",
    "mkdir",
    "file_batch",
    "md_export",
    "archive",
    "download_url",
    "run",
}


def _by_name() -> dict[str, object]:
    return {e.schema.name: e for e in build_capability_catalog()}


def test_every_catalog_tool_has_usable_metadata():
    """Guards the static-schema read: no half-built schema slips into the catalog."""
    catalog = build_capability_catalog()
    assert catalog, "catalog must not be empty"
    for entry in catalog:
        schema = entry.schema
        assert schema.name and isinstance(schema.name, str)
        assert schema.description and isinstance(schema.description, str)
        assert isinstance(schema.parameters, dict)
        assert schema.parameters.get("type") == "object"
        assert isinstance(schema.face, ToolFace)
        assert isinstance(entry.resident, bool)
        assert isinstance(entry.summary, str)
        assert entry.available_to, f"{schema.name} must declare available_to"
        assert set(entry.available_to) <= {AVAILABLE_TO_CEO, AVAILABLE_TO_WORKER}
        summary = entry.summary.strip()
        assert summary, f"{schema.name} needs catalog_summary for the toolbox shelf"
        assert summary != schema.name, schema.name
        assert len(summary) <= 80, (schema.name, summary)


def test_catalog_has_no_duplicate_tools():
    names = [e.schema.name for e in build_capability_catalog()]
    assert len(names) == len(set(names))


def test_ceo_orchestration_tools_are_present_and_ceo_only():
    """The drift the old GET /tools had: delegate/replan/consult/ask_user missing."""
    entries = _by_name()
    for name in _CEO_ORCHESTRATION:
        assert name in entries, f"{name} missing from catalog"
        assert entries[name].available_to == (AVAILABLE_TO_CEO,)


def test_consult_is_shared_between_ceo_and_worker():
    entries = _by_name()
    assert "consult" in entries
    assert set(entries["consult"].available_to) == {
        AVAILABLE_TO_CEO,
        AVAILABLE_TO_WORKER,
    }


def test_read_only_builtins_are_shared_with_ceo():
    entries = _by_name()
    # Read/retrieval built-ins the coordinator looks with.
    for name in (
        "web_search",
        "web_fetch",
        "file_read",
        "file_list",
        "glob",
        "grep",
        "git",
        "docs_read",
    ):
        assert name in entries
        assert set(entries[name].available_to) == {AVAILABLE_TO_CEO, AVAILABLE_TO_WORKER}


def test_conversation_logs_are_ceo_and_worker():
    entries = _by_name()
    assert "desktop_notify" not in entries
    for name in ("search_conversations", "read_conversation"):
        assert name in entries, f"{name} missing from catalog"
        assert set(entries[name].available_to) == {
            AVAILABLE_TO_CEO,
            AVAILABLE_TO_WORKER,
        }


def test_escalate_and_handoff_are_worker_only():
    entries = _by_name()
    for name in _WORKER_ONLY_COLLAB:
        assert name in entries, f"{name} missing from catalog"
        assert entries[name].available_to == (AVAILABLE_TO_WORKER,)


def test_mutation_and_execution_are_shared_with_ceo():
    entries = _by_name()
    for name in _CEO_AND_WORKER_MUTATION:
        assert name in entries, f"{name} missing from catalog"
        assert set(entries[name].available_to) == {
            AVAILABLE_TO_CEO,
            AVAILABLE_TO_WORKER,
        }


def test_ceo_prompt_skill_directory_gates_on_required_tools():
    """compose_ceo_chat_prompt 按需目录按 requires_tools 显隐（debate 手册跟 debate 工具）。"""
    registry = build_system_skill_registry()
    base = assemble_system_prompt()

    with_debate = compose_ceo_chat_prompt(
        base,
        skill_registry=registry,
        ceo_tool_names={"delegate", "consult", "debate"},
    )
    assert "按需目录" in with_debate
    assert "编排：" in with_debate
    assert "- debate_and_review：" in with_debate
    assert "- product_help：" in with_debate

    without_debate = compose_ceo_chat_prompt(
        base,
        skill_registry=registry,
        ceo_tool_names={"delegate", "consult"},
    )
    assert "- debate_and_review：" not in without_debate
    assert "- product_help：" in without_debate


# Display face ≠ ceo_orchestration surface. Pin so Folder / board tools
# cannot slide back into the orchestration dumpster.
_CATALOG_FACE: dict[str, ToolFace] = {
    "delegate": ToolFace.ORCHESTRATION,
    "replan": ToolFace.ORCHESTRATION,
    "debate": ToolFace.ORCHESTRATION,
    "consult": ToolFace.ORCHESTRATION,
    "ask_user": ToolFace.ORCHESTRATION,
    "escalate": ToolFace.ORCHESTRATION,
    "handoff": ToolFace.ORCHESTRATION,
    "folders": ToolFace.FOLDER,
    "create_folder": ToolFace.FOLDER,
    "delete_folder": ToolFace.FOLDER,
    "table_ops": ToolFace.TABLE,
    "table_read": ToolFace.TABLE,
    "docs_read": ToolFace.DOC,
    "docs_write": ToolFace.DOC,
}


def test_capability_catalog_omits_retired_update_folder_profile():
    catalog = build_capability_catalog()
    names = {e.schema.name for e in catalog}
    assert "update_folder_profile" not in names
    assert "remember" not in names
    assert "code_search" not in names
    assert "project_shell" not in names
    assert all(e.summary != "更新文件夹画像" for e in catalog)


def test_catalog_faces_are_not_an_orchestration_dumpster():
    by_name = {e.schema.name: e.schema.face for e in build_capability_catalog()}
    for name, face in _CATALOG_FACE.items():
        assert by_name[name] is face, name
    orchestration = {n for n, f in by_name.items() if f is ToolFace.ORCHESTRATION}
    folder = {n for n, f in by_name.items() if f is ToolFace.FOLDER}
    board = {n for n, f in by_name.items() if f is ToolFace.BOARD}
    table = {n for n, f in by_name.items() if f is ToolFace.TABLE}
    doc = {n for n, f in by_name.items() if f is ToolFace.DOC}
    assert orchestration == {n for n, f in _CATALOG_FACE.items() if f is ToolFace.ORCHESTRATION}
    assert folder == {n for n, f in _CATALOG_FACE.items() if f is ToolFace.FOLDER}
    assert board == {n for n, f in _CATALOG_FACE.items() if f is ToolFace.BOARD}
    assert table == {n for n, f in _CATALOG_FACE.items() if f is ToolFace.TABLE}
    assert doc == {n for n, f in _CATALOG_FACE.items() if f is ToolFace.DOC}


def test_on_demand_directory_splits_folder_off_orchestration():
    out = render_on_demand_directory(
        [
            ConsultDirectoryEntry(
                name="create_folder",
                summary="新建云文件夹",
                section="tool",
                face=ToolFace.FOLDER.value,
            ),
            ConsultDirectoryEntry(
                name="table_ops",
                summary="改当前表格",
                section="tool",
                face=ToolFace.TABLE.value,
            ),
            ConsultDirectoryEntry(
                name="docs_read",
                summary="读创作文档",
                section="tool",
                face=ToolFace.DOC.value,
            ),
            ConsultDirectoryEntry(
                name="delegate",
                summary="派活",
                section="tool",
                face=ToolFace.ORCHESTRATION.value,
            ),
        ]
    )
    assert "文件夹：" in out
    assert "白板：" not in out
    assert "表格：" in out
    assert "文档：" in out
    assert "编排：" in out
    assert out.index("文件夹：") < out.index("- create_folder：新建云文件夹") < out.index("表格：")
    assert out.index("表格：") < out.index("- table_ops：改当前表格") < out.index("文档：")
    assert out.index("文档：") < out.index("- docs_read：读创作文档") < out.index("编排：")
    assert out.index("编排：") < out.index("- delegate：派活")
