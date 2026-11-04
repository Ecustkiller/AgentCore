"""知识树检索 HTTP 端点：owner-scope / ILIKE 转义 / 软删除（生成 / 最后修订 2026-11-04）。

只读、按需、绝不自动进 prompt。走真实 PG，验证 SQL 层的边界而不是 mock。
"""

from __future__ import annotations

import uuid

from tests.integration.conftest import register_and_login


async def _create(client, name: str, content: str) -> str:
    r = await client.post(
        "/v1/documents",
        json={
            "name": name,
            "role": "general",
            "kind": "document",
            "content": content,
        },
    )
    assert r.status_code == 200, r.text
    return r.json()["id"]


async def test_search_returns_owner_scoped_hits(client):
    await register_and_login(client, f"ks-{uuid.uuid4().hex[:8]}")
    await _create(client, "部署手册.md", "先灰度发布，再全量部署。")
    await _create(client, "无关.md", "今天天气不错")

    r = await client.get("/v1/documents/search", params={"q": "灰度发布"})
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["query"] == "灰度发布"
    assert data["terms"] == ["灰度发布"]
    assert data["total_candidates"] >= 1
    assert len(data["items"]) == 1
    hit = data["items"][0]
    assert hit["name"] == "部署手册.md"
    assert "灰度发布" in hit["snippet"]
    assert hit["match_start"] is not None
    assert hit["match_end"] is not None


async def test_and_terms_and_limit(client):
    await register_and_login(client, f"ks-and-{uuid.uuid4().hex[:8]}")
    await _create(client, "a.md", "灰度发布与回滚流程")
    # 必须真的不含「发布」——「没有发布」里仍有这两个字，AND 会正确命中。
    await _create(client, "b.md", "只有灰度，尚未上线")

    r = await client.get(
        "/v1/documents/search", params={"q": "灰度 发布", "limit": 5}
    )
    assert r.status_code == 200, r.text
    assert r.json()["terms"] == ["灰度", "发布"]
    assert [i["name"] for i in r.json()["items"]] == ["a.md"]

    limited = await client.get(
        "/v1/documents/search", params={"q": "灰度", "limit": 1}
    )
    assert len(limited.json()["items"]) == 1


async def test_literal_percent_is_not_a_like_wildcard(client):
    """`100%` 里的 % 必须按字面匹配，不能变成匹配任意字符。"""
    await register_and_login(client, f"ks-pct-{uuid.uuid4().hex[:8]}")
    await _create(client, "折扣.md", "折扣 100% 有效")
    await _create(client, "占位.md", "折扣 100XYZ 有效")

    r = await client.get("/v1/documents/search", params={"q": "100%"})
    assert r.status_code == 200, r.text
    assert [i["name"] for i in r.json()["items"]] == ["折扣.md"]


async def test_empty_query_is_rejected(client):
    await register_and_login(client, f"ks-empty-{uuid.uuid4().hex[:8]}")
    r = await client.get("/v1/documents/search", params={"q": "   "})
    assert r.status_code == 400, r.text


async def test_soft_deleted_document_disappears(client):
    await register_and_login(client, f"ks-del-{uuid.uuid4().hex[:8]}")
    doc_id = await _create(client, "临时.md", "临时灰度说明")
    r = await client.delete(f"/v1/documents/{doc_id}")
    assert r.status_code == 200, r.text
    r = await client.get("/v1/documents/search", params={"q": "临时灰度"})
    assert r.status_code == 200, r.text
    assert r.json()["items"] == []


async def test_other_user_cannot_read_hits(client):
    """owner-scope：换一个账号登录，同一关键词查不到别人的文档。"""
    await register_and_login(client, f"ks-owner-{uuid.uuid4().hex[:8]}")
    await _create(client, "私有.md", "绝密灰度口令")
    await register_and_login(client, f"ks-other-{uuid.uuid4().hex[:8]}")

    r = await client.get("/v1/documents/search", params={"q": "绝密灰度口令"})
    assert r.status_code == 200, r.text
    assert r.json()["items"] == []
