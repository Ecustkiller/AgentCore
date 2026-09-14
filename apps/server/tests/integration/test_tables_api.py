"""REST 多维表格：人路径 apply_ops、IDOR、schema 409、行顶、undo stamps。"""

from __future__ import annotations

from uuid import uuid4

from agentcore.db.models.tables import TableRow
from tests.integration.conftest import register_and_login


async def test_create_update_get_idor_schema_cap_undo(client, new_client, session_factory):
    await register_and_login(client, "tbl_owner")
    created = await client.post("/v1/tables", json={"title": "任务"})
    assert created.status_code == 201, created.text
    table = created.json()
    tid = table["id"]
    row_id = table["rows"][0]["id"]
    col_id = table["columns"][0]["id"]
    original_cols = len(table["columns"])
    original_cell = table["rows"][0]["cells"][col_id]

    patched = await client.post(
        f"/v1/tables/{tid}/ops",
        json={
            "ops": [
                {"op": "update_cells", "row_id": row_id, "cells": {col_id: "hello"}}
            ],
            "confirm": True,
        },
    )
    assert patched.status_code == 200, patched.text
    body = patched.json()
    assert body["ok"] is True
    assert body["needs_confirmation"] is False
    got = await client.get(f"/v1/tables/{tid}")
    assert got.status_code == 200, got.text
    assert got.json()["rows"][0]["cells"][col_id] == "hello"

    undone = await client.post(
        f"/v1/tables/{tid}/ops",
        json={"ops": [{"op": "undo_batch"}], "confirm": True},
    )
    assert undone.status_code == 200, undone.text
    assert undone.json()["ok"] is True
    restored = await client.get(f"/v1/tables/{tid}")
    assert restored.json()["rows"][0]["cells"][col_id] == original_cell

    dry = await client.post(
        f"/v1/tables/{tid}/ops",
        json={
            "ops": [{"op": "add_column", "label": "备注", "type": "text"}],
            "confirm": False,
        },
    )
    assert dry.status_code == 200, dry.text
    dry_body = dry.json()
    assert dry_body["ok"] is True
    assert dry_body["needs_confirmation"] is True
    after_dry = await client.get(f"/v1/tables/{tid}")
    assert len(after_dry.json()["columns"]) == original_cols

    conflict = await client.post(
        f"/v1/tables/{tid}/ops",
        json={
            "ops": [{"op": "add_column", "label": "备注", "type": "text"}],
            "confirm": True,
            "schema_baseline": 999,
        },
    )
    assert conflict.status_code == 409, conflict.text

    async with session_factory() as session:
        session.add_all(
            [
                TableRow(
                    id=str(uuid4()),
                    table_id=tid,
                    cells={},
                    position=2000.0 + i,
                )
                for i in range(4999)
            ]
        )
        await session.commit()

    overflow = await client.post(
        f"/v1/tables/{tid}/ops",
        json={
            "ops": [{"op": "upsert_rows", "rows": [{}]}],
            "confirm": True,
        },
    )
    assert overflow.status_code == 200, overflow.text
    overflow_body = overflow.json()
    assert overflow_body["ok"] is False
    assert "一张表最多 5000 行" in (overflow_body["error"] or "")
    capped = await client.get(f"/v1/tables/{tid}")
    assert len(capped.json()["rows"]) == 5000

    async with new_client() as other:
        await register_and_login(other, "tbl_intruder")
        missing = await other.get(f"/v1/tables/{tid}")
        assert missing.status_code == 404, missing.text
        denied = await other.post(
            f"/v1/tables/{tid}/ops",
            json={
                "ops": [
                    {
                        "op": "update_cells",
                        "row_id": row_id,
                        "cells": {col_id: "x"},
                    }
                ],
                "confirm": True,
            },
        )
        assert denied.status_code == 404, denied.text

    named = await client.post(
        f"/v1/tables/{tid}/ops",
        json={
            "ops": [{"op": "save_view", "name": "按状态"}],
            "confirm": True,
        },
    )
    assert named.status_code == 200, named.text
    views = named.json()["table"]["views"]
    assert len(views) == 2
    extra = next(v for v in views if v["name"] == "按状态")
    dropped = await client.post(
        f"/v1/tables/{tid}/ops",
        json={
            "ops": [{"op": "delete_view", "view_id": extra["id"]}],
            "confirm": True,
        },
    )
    assert dropped.status_code == 200, dropped.text
    remaining = (await client.get(f"/v1/tables/{tid}")).json()["views"]
    assert len(remaining) == 1
    assert remaining[0]["id"] != extra["id"]


async def test_persist_touched_rows_do_not_clobber_siblings(client, session_factory):
    from sqlalchemy import select

    from agentcore.db.models.tables import Table
    from agentcore.db.repositories.tables import TableRepository
    from agentcore.table.ops import apply_ops

    await register_and_login(client, "tbl_lww")
    created = await client.post("/v1/tables", json={"title": "并发"})
    assert created.status_code == 201, created.text
    table = created.json()
    tid = table["id"]
    col_id = table["columns"][0]["id"]
    added = await client.post(
        f"/v1/tables/{tid}/ops",
        json={"ops": [{"op": "upsert_rows", "rows": [{}]}], "confirm": True},
    )
    assert added.status_code == 200, added.text
    rows = added.json()["table"]["rows"]
    assert len(rows) == 2
    r0, r1 = rows[0]["id"], rows[1]["id"]

    async with session_factory() as session:
        owner = (await session.execute(select(Table).where(Table.id == tid))).scalar_one()
        repo = TableRepository(session)
        state = await repo.get_state(tid, user_id=owner.user_id)
        assert state is not None
        a = apply_ops(
            state,
            [{"op": "update_cells", "row_id": r0, "cells": {col_id: "A"}}],
            confirm=True,
        )
        b = apply_ops(
            state,
            [{"op": "update_cells", "row_id": r1, "cells": {col_id: "B"}}],
            confirm=True,
        )
        assert a.state is not None and b.state is not None
        await repo.persist_state(
            a.state,
            touched_row_ids=a.touched_row_ids,
            deleted_row_ids=a.deleted_row_ids,
            commit=False,
        )
        await repo.persist_state(
            b.state,
            touched_row_ids=b.touched_row_ids,
            deleted_row_ids=b.deleted_row_ids,
            commit=True,
        )

    got = await client.get(f"/v1/tables/{tid}")
    assert got.status_code == 200, got.text
    by_id = {r["id"]: r for r in got.json()["rows"]}
    assert by_id[r0]["cells"][col_id] == "A"
    assert by_id[r1]["cells"][col_id] == "B"
