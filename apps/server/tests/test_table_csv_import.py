"""csv 灌数 parse / @ bind / attachment skip — no PostgreSQL."""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path

from agentcore.table.bind import csv_mention_paths
from agentcore.table.constants import COLUMN_IMPORT_MAX, ROW_LIMIT, TABLE_UNBOUND
from agentcore.table.csv_import import (
    decode_csv_bytes,
    is_csv_relpath,
    parse_csv_snapshot,
    remap_snapshot_columns,
    title_from_csv_path,
)
from agentcore.table.land_csv import ingest_landed_csv_products, should_ingest_csv_path
from agentcore.table.source_lookup import (
    candidate_workspace_keys,
    normalize_csv_source_path,
)
from agentcore.table.workspace_key import table_workspace_key
from agentcore.tools.file_products import FileProduct
from agentcore.tools.protocol import ToolContext, ToolResult
from agentcore.tools.sandbox.subprocess import SubprocessSandbox
from agentcore.workspace.server import ServerWorkspace


def _ctx(**fields: object) -> ToolContext:
    return ToolContext.create(
        execution_id="e",
        run_id="s",
        agent_id="a",
        backend=ServerWorkspace(root=Path("."), sandbox=SubprocessSandbox()),
        user_id="u1",
        conversation_id="c1",
        **fields,  # type: ignore[arg-type]
    )


def test_workspace_key_folder_vs_bare_chat():
    assert table_workspace_key(folder_id="f1", conversation_id="c1") == "folder:f1"
    assert table_workspace_key(folder_id="  ", conversation_id="c1") == "conv:c1"
    assert table_workspace_key(folder_id=None, conversation_id="c1") == "conv:c1"


def test_source_lookup_candidates_and_normalize():
    assert normalize_csv_source_path("attachments/a.csv") is None
    assert normalize_csv_source_path("./客户.csv") == "客户.csv"
    keys = candidate_workspace_keys(
        folder_id="f1",
        conversation_id="c1",
        conversation_auto_desk_id="f1",
        desk_conversation_ids=("c1", "c2"),
    )
    assert keys[0] == "folder:f1"
    assert "conv:c1" in keys
    assert "conv:c2" in keys


def test_is_csv_and_title():
    assert is_csv_relpath("notes/Tasks.CSV")
    assert not is_csv_relpath("notes/tasks.xlsx")
    assert title_from_csv_path("data/客户.csv") == "客户"


def test_decode_prefers_utf8_sig_then_gb18030():
    assert decode_csv_bytes("姓名\n".encode("utf-8-sig")).startswith("姓名")
    assert "姓名" in decode_csv_bytes("姓名\n".encode("gb18030"))


def test_parse_csv_unique_labels_skip_empty_and_text_columns():
    snap = parse_csv_snapshot("name,name,\nAda,1,\n\nBob,2,x\n", title="客户")
    assert snap is not None
    assert snap.title == "客户"
    assert [c["label"] for c in snap.columns] == ["name", "name (2)", "列 3"]
    assert all(c["type"] == "text" for c in snap.columns)
    assert len(snap.rows) == 2
    first = snap.rows[0]["cells"]
    assert list(first.values()) == ["Ada", "1", ""]


def test_parse_csv_caps_rows_and_cols():
    header = ",".join(f"c{i}" for i in range(COLUMN_IMPORT_MAX + 4))
    body = "\n".join(header for _ in range(3))
    snap = parse_csv_snapshot(f"{header}\n{body}")
    assert snap is not None
    assert len(snap.columns) == COLUMN_IMPORT_MAX
    assert snap.truncated_cols is True

    lines = ["a,b"] + [f"{i},x" for i in range(ROW_LIMIT + 2)]
    snap = parse_csv_snapshot("\n".join(lines))
    assert snap is not None
    assert len(snap.rows) == ROW_LIMIT
    assert snap.truncated_rows is True


def test_remap_reuses_column_ids_by_label():
    first = parse_csv_snapshot("name,age\nAda,1\n")
    assert first is not None
    second = parse_csv_snapshot("name,city\nAda,NY\n")
    assert second is not None
    mapped = remap_snapshot_columns(second, first.columns)
    name_id = next(c["id"] for c in first.columns if c["label"] == "name")
    assert mapped.columns[0]["id"] == name_id
    assert mapped.columns[1]["id"] != name_id
    assert mapped.rows[0]["cells"][name_id] == "Ada"


def test_should_ingest_skips_attachments():
    assert should_ingest_csv_path("data/a.csv")
    assert not should_ingest_csv_path("attachments/a.csv")
    assert not should_ingest_csv_path("attachments/sub/a.csv")
    assert not should_ingest_csv_path("notes/a.xlsx")


def test_csv_mention_paths_order_skips_attachments_and_non_csv():
    paths = csv_mention_paths(
        [
            {"workspace_path": "attachments/old.csv"},
            {"path": "b.csv"},
            {"parsed_workspace_path": "a.csv"},
            {"workspace_path": "b.csv"},
            {"workspace_path": "notes.md"},
            {"workspace_path": "C:/abs/x.csv"},
            {"workspace_path": "keep.csv", "resident_missing": True},
        ]
    )
    assert paths == ["b.csv", "a.csv"]


def test_table_bind_slot_survives_replace():
    ctx = _ctx(table_id=None)
    clone = replace(ctx, on_phase=lambda _phase: None)
    clone.table_id = "tbl-1"
    assert ctx.table_id == "tbl-1"


async def test_ingest_products_skips_attachments_and_binds_single_csv(monkeypatch):
    ctx = _ctx()
    seen: list[str] = []

    async def fake_ingest(_context: ToolContext, path: str):
        seen.append(path)
        from agentcore.table.land_csv import CsvIngestNote

        return CsvIngestNote(table_id="t1", note=f"ok:{path}")

    monkeypatch.setattr("agentcore.table.land_csv.ingest_landed_csv", fake_ingest)
    result = ToolResult(
        tool_call_id="c",
        success=True,
        output="wrote",
        file_products=[
            FileProduct(path="attachments/skip.csv", kind="csv"),
            FileProduct(path="notes.md", kind="md"),
            FileProduct(path="data.csv", kind="csv"),
        ],
    )
    note = await ingest_landed_csv_products(result, ctx, offer_tools=False)
    assert seen == ["data.csv"]
    assert note == "ok:data.csv"
    assert ctx.table_id == "t1"


async def test_ingest_products_does_not_bind_when_two_csvs(monkeypatch):
    ctx = _ctx()

    async def fake_ingest(_context: ToolContext, path: str):
        from agentcore.table.land_csv import CsvIngestNote

        return CsvIngestNote(table_id=path, note=path)

    monkeypatch.setattr("agentcore.table.land_csv.ingest_landed_csv", fake_ingest)
    result = ToolResult(
        tool_call_id="c",
        success=True,
        output="",
        file_products=[
            FileProduct(path="a.csv", kind="csv"),
            FileProduct(path="b.csv", kind="csv"),
        ],
    )
    note = await ingest_landed_csv_products(result, ctx)
    assert "a.csv" in note and "b.csv" in note
    assert ctx.table_id is None


def test_unbound_copy():
    assert "请 @ 已导入的 csv" in TABLE_UNBOUND
