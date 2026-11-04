"""Skill Pack HTTP 面：导入 / 导出 / owner-scope（生成 / 最后修订 2026-11-04）。

包只是 markdown 的可搬走表示，不新增工具、不装代码、不改审批轴。
走真实 PG，验证写路径与 owner 边界而不是 mock。
"""

from __future__ import annotations

import base64
import io
import uuid
import zipfile

from agentcore.documents.skillpack import build_pack, parse_pack
from tests.integration.conftest import register_and_login


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def _pack_with(member: str) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("SKILL.md", b"---\nname: s\ndescription: d\n---\n\nbody\n")
        zf.writestr(member, b"print(1)")
    return buf.getvalue()


async def test_import_then_export_roundtrips_through_a_real_document(client):
    await register_and_login(client, f"sp-{uuid.uuid4().hex[:8]}")
    data = build_pack(name="发布清单", description="上线前核对", body="先灰度再全量。")
    created = await client.post(
        "/v1/skill-catalog/skill-pack/import", json={"pack_base64": _b64(data)}
    )
    assert created.status_code == 200, created.text
    view = created.json()
    assert view["name"] == "发布清单"
    assert view["description"] == "上线前核对"
    assert "secret" not in view

    exported = await client.get(
        f"/v1/skill-catalog/skill-pack/{view['id']}/export"
    )
    assert exported.status_code == 200, exported.text
    pack = parse_pack(base64.b64decode(exported.json()["pack_base64"]))
    assert pack.name == "发布清单"
    assert pack.description == "上线前核对"
    assert pack.body == "先灰度再全量。"


async def test_import_rejects_bad_base64(client):
    await register_and_login(client, f"sp-b64-{uuid.uuid4().hex[:8]}")
    r = await client.post(
        "/v1/skill-catalog/skill-pack/import", json={"pack_base64": "!!!!"}
    )
    assert r.status_code == 400


async def test_import_rejects_a_pack_containing_code(client):
    await register_and_login(client, f"sp-code-{uuid.uuid4().hex[:8]}")
    r = await client.post(
        "/v1/skill-catalog/skill-pack/import",
        json={"pack_base64": _b64(_pack_with("hooks/install.py"))},
    )
    assert r.status_code == 400
    assert "只准包含" in r.text


async def test_apply_always_is_not_silently_downgraded(client):
    await register_and_login(client, f"sp-apply-{uuid.uuid4().hex[:8]}")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr(
            "SKILL.md", b"---\nname: s\ndescription: d\napply: always\n---\n\nbody\n"
        )
    r = await client.post(
        "/v1/skill-catalog/skill-pack/import",
        json={"pack_base64": _b64(buf.getvalue())},
    )
    assert r.status_code == 400


async def test_export_is_owner_scoped(client):
    await register_and_login(client, f"sp-owner-{uuid.uuid4().hex[:8]}")
    created = await client.post(
        "/v1/skill-catalog/skill-pack/import",
        json={
            "pack_base64": _b64(
                build_pack(name="s", description="d", body="body")
            )
        },
    )
    assert created.status_code == 200
    doc_id = created.json()["id"]

    await register_and_login(client, f"sp-other-{uuid.uuid4().hex[:8]}")
    r = await client.get(f"/v1/skill-catalog/skill-pack/{doc_id}/export")
    assert r.status_code == 404


async def test_export_refuses_non_skill_documents(client):
    await register_and_login(client, f"sp-general-{uuid.uuid4().hex[:8]}")
    doc = await client.post(
        "/v1/documents",
        json={
            "name": "普通.md",
            "role": "general",
            "kind": "document",
            "content": "普通正文",
        },
    )
    assert doc.status_code == 200, doc.text
    r = await client.get(
        f"/v1/skill-catalog/skill-pack/{doc.json()['id']}/export"
    )
    assert r.status_code == 404
