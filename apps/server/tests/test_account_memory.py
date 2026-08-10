"""Account narrow-ticket rules/memory cloud path (定案 R3b)."""

from __future__ import annotations

from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any

import httpx
import pytest

from agentcore.account.credentials import (
    AccountCloudError,
    AccountCredentials,
    account_credentials_scope,
    cloud_list_user_rules,
    cloud_memory_load,
    cloud_memory_save,
    cloud_remember_rule,
)
from agentcore.memory.document_store import DocumentMemoryStore
from agentcore.memory.rules_injection import assemble_turn_rules
from agentcore.tools.builtin.remember import RememberTool
from agentcore.tools.protocol import ToolContext

pytestmark = pytest.mark.anyio


class _FakeTransport(httpx.AsyncBaseTransport):
    def __init__(self, handler) -> None:
        self._handler = handler

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        return await self._handler(request)


@pytest.fixture
def account_creds() -> AccountCredentials:
    return AccountCredentials(
        api_key="account-jwt",
        base_url="https://cloud.example/v1/account",
    )


def _ctx() -> ToolContext:
    return ToolContext(
        execution_id="e",
        run_id="r",
        agent_id="ceo",
        backend=SimpleNamespace(location="local"),  # type: ignore[arg-type]
        user_id="u1",
        conversation_id="host-1",
    )


class _EmptyMemoryStore:
    """Minimal MemoryStore stub (no AI memory) for assemble_turn_rules tests."""

    async def list(self, user_id: str, scope: str | None = None) -> list[Any]:
        return []

    async def load(self, user_id: str, path: str, scope: str | None = None) -> str:
        return ""

    async def save(
        self, user_id: str, path: str, markdown: str, scope: str | None = None
    ) -> None:
        raise AssertionError("empty store must not save")

    async def delete(self, user_id: str, path: str, scope: str | None = None) -> None:
        raise AssertionError("empty store must not delete")

    async def project_scopes(self, user_id: str) -> list[str]:
        return []


# --- cloud HTTP client --------------------------------------------------------


async def test_cloud_list_user_rules_ok(monkeypatch: pytest.MonkeyPatch, account_creds):
    async def _handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "POST"
        assert str(request.url).endswith("/rules/list")
        assert request.headers["Authorization"] == "Bearer account-jwt"
        return httpx.Response(
            200,
            json={
                "global_rules": [{"name": "用户规则.md", "content": "- 用中文"}],
                "project_rules": [],
            },
        )

    monkeypatch.setattr(
        "agentcore.account.credentials.outbound_async_client",
        lambda **kwargs: httpx.AsyncClient(transport=_FakeTransport(_handler), **kwargs),
    )
    data = await cloud_list_user_rules(account_creds, folder_id=None)
    assert data["global_rules"][0]["content"] == "- 用中文"


async def test_cloud_remember_ok(monkeypatch: pytest.MonkeyPatch, account_creds):
    async def _handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url).endswith("/rules/remember")
        body = httpx.Request("POST", str(request.url), content=request.content)
        del body
        import json

        payload = json.loads(request.content.decode())
        assert payload["content"] == "以后都用中文"
        assert payload["folder_id"] is None
        assert payload["action"] == "add"
        return httpx.Response(
            200,
            json={
                "changed": True,
                "action": "add",
                "message": "已追加规则：以后都用中文",
                "rules_markdown": None,
            },
        )

    monkeypatch.setattr(
        "agentcore.account.credentials.outbound_async_client",
        lambda **kwargs: httpx.AsyncClient(transport=_FakeTransport(_handler), **kwargs),
    )
    result = await cloud_remember_rule(
        account_creds, content="以后都用中文", folder_id=None
    )
    assert result["changed"] is True
    assert result["action"] == "add"
    assert "已追加" in result["message"]


async def test_cloud_remember_replace_payload(monkeypatch: pytest.MonkeyPatch, account_creds):
    async def _handler(request: httpx.Request) -> httpx.Response:
        import json

        payload = json.loads(request.content.decode())
        assert payload["action"] == "replace"
        assert payload["content"] == "用中文"
        assert payload["replaces"] == "用英文"
        return httpx.Response(
            200,
            json={
                "changed": True,
                "action": "replace",
                "message": "已替换规则：去掉「用英文」，写入「用中文」",
            },
        )

    monkeypatch.setattr(
        "agentcore.account.credentials.outbound_async_client",
        lambda **kwargs: httpx.AsyncClient(transport=_FakeTransport(_handler), **kwargs),
    )
    result = await cloud_remember_rule(
        account_creds,
        content="用中文",
        folder_id=None,
        action="replace",
        replaces="用英文",
    )
    assert result["changed"] is True
    assert result["action"] == "replace"



async def test_cloud_memory_save_raises_on_5xx(
    monkeypatch: pytest.MonkeyPatch, account_creds
):
    async def _handler(request: httpx.Request) -> httpx.Response:
        del request
        return httpx.Response(503, json={"detail": "down"})

    monkeypatch.setattr(
        "agentcore.account.credentials.outbound_async_client",
        lambda **kwargs: httpx.AsyncClient(transport=_FakeTransport(_handler), **kwargs),
    )
    with pytest.raises(AccountCloudError) as ei:
        await cloud_memory_save(
            account_creds, path="画像.md", content="## x", scope=None
        )
    assert ei.value.code == "account_cloud_server"


async def test_cloud_memory_load_ok(monkeypatch: pytest.MonkeyPatch, account_creds):
    async def _handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url).endswith("/memory/load")
        return httpx.Response(200, json={"content": "## 画像\n- rust"})

    monkeypatch.setattr(
        "agentcore.account.credentials.outbound_async_client",
        lambda **kwargs: httpx.AsyncClient(transport=_FakeTransport(_handler), **kwargs),
    )
    body = await cloud_memory_load(account_creds, path="画像.md", scope="folder-1")
    assert "rust" in body


# --- assemble / remember / store with ContextVar ------------------------------


async def test_assemble_turn_rules_uses_cloud_when_ticketed(
    monkeypatch: pytest.MonkeyPatch, account_creds
):
    called: dict[str, Any] = {}

    async def _fake_list(creds, *, folder_id):
        called["folder_id"] = folder_id
        assert creds is account_creds
        return {
            "global_rules": [{"name": "用户规则.md", "content": "- 永远用中文"}],
            "project_rules": [],
        }

    monkeypatch.setattr(
        "agentcore.account.credentials.cloud_list_user_rules", _fake_list
    )
    # Must not open a local DB session when ticketed.
    monkeypatch.setattr(
        "agentcore.db.base.async_session_factory",
        lambda: (_ for _ in ()).throw(AssertionError("must not open local DB")),
    )

    with account_credentials_scope(account_creds):
        user_md, mem_md = await assemble_turn_rules(
            _EmptyMemoryStore(),  # type: ignore[arg-type]
            "u1",
            folder_id=None,
            enabled=True,
            max_docs=20,
            max_chars=20000,
        )
    assert "永远用中文" in user_md
    assert mem_md == ""
    assert called["folder_id"] is None


async def test_assemble_turn_rules_cloud_failure_soft_empty(
    monkeypatch: pytest.MonkeyPatch, account_creds
):
    async def _boom(*_a, **_k):
        raise AccountCloudError("down", code="account_cloud_unreachable")

    monkeypatch.setattr("agentcore.account.credentials.cloud_list_user_rules", _boom)

    with account_credentials_scope(account_creds):
        user_md, mem_md = await assemble_turn_rules(
            _EmptyMemoryStore(),  # type: ignore[arg-type]
            "u1",
            folder_id=None,
            enabled=True,
            max_docs=20,
            max_chars=20000,
        )
    assert user_md == ""
    assert mem_md == ""


async def test_remember_tool_cloud_success(
    monkeypatch: pytest.MonkeyPatch, account_creds
):
    async def _fake_remember(creds, *, content, folder_id, action="add", replaces=None):
        assert content == "以后都用中文"
        assert folder_id is None
        assert action == "add"
        assert replaces is None
        assert creds is account_creds
        return {
            "changed": True,
            "action": "add",
            "message": "已追加规则：以后都用中文",
            "rules_markdown": None,
        }

    monkeypatch.setattr(
        "agentcore.account.credentials.cloud_remember_rule", _fake_remember
    )
    monkeypatch.setattr(
        "agentcore.tools.builtin.remember.async_session_factory",
        lambda: (_ for _ in ()).throw(AssertionError("must not open local DB")),
    )

    tool = RememberTool(folder_id=None)
    with account_credentials_scope(account_creds):
        result = await tool.execute({"content": "以后都用中文"}, _ctx())
    assert result.success is True
    assert "已追加" in (result.output or "")


async def test_remember_tool_cloud_forget(
    monkeypatch: pytest.MonkeyPatch, account_creds
):
    async def _fake_remember(creds, *, content, folder_id, action="add", replaces=None):
        assert action == "forget"
        assert content == "用英文"
        return {
            "changed": True,
            "action": "forget",
            "message": "已删除规则：用英文",
            "rules_markdown": None,
        }

    monkeypatch.setattr(
        "agentcore.account.credentials.cloud_remember_rule", _fake_remember
    )
    tool = RememberTool(folder_id=None)
    with account_credentials_scope(account_creds):
        result = await tool.execute(
            {"action": "forget", "content": "用英文"}, _ctx()
        )
    assert result.success is True
    assert "已删除" in (result.output or "")
    assert result.display["action"] == "forget"


async def test_remember_tool_cloud_failure_explicit(
    monkeypatch: pytest.MonkeyPatch, account_creds
):
    async def _boom(*_a, **_k):
        raise AccountCloudError("unreachable", code="account_cloud_unreachable")

    monkeypatch.setattr("agentcore.account.credentials.cloud_remember_rule", _boom)

    tool = RememberTool(folder_id=None)
    with account_credentials_scope(account_creds):
        result = await tool.execute({"content": "x"}, _ctx())
    assert result.success is False
    assert "记住失败" in (result.output or "")


async def test_document_store_cloud_load_and_soft_fail(
    monkeypatch: pytest.MonkeyPatch, account_creds
):
    async def _load(creds, *, path, scope):
        assert path == "画像.md"
        return "## 画像\n- ok"

    monkeypatch.setattr("agentcore.account.credentials.cloud_memory_load", _load)
    store = DocumentMemoryStore()
    with account_credentials_scope(account_creds):
        body = await store.load("u1", "画像.md")
    assert "ok" in body

    async def _boom(*_a, **_k):
        raise AccountCloudError("down")

    monkeypatch.setattr("agentcore.account.credentials.cloud_memory_load", _boom)
    with account_credentials_scope(account_creds):
        body2 = await store.load("u1", "画像.md")
    assert body2 == ""


async def test_document_store_cloud_save_raises(
    monkeypatch: pytest.MonkeyPatch, account_creds
):
    async def _boom(*_a, **_k):
        raise AccountCloudError("write failed", code="account_cloud_server")

    monkeypatch.setattr("agentcore.account.credentials.cloud_memory_save", _boom)
    store = DocumentMemoryStore()
    with account_credentials_scope(account_creds), pytest.raises(AccountCloudError):
        await store.save("u1", "画像.md", "## x")


async def test_document_store_bound_session_skips_cloud(
    monkeypatch: pytest.MonkeyPatch, account_creds
):
    """Request DI path (session bound) must stay on DB even if ContextVar is set."""
    cloud_called = False

    async def _cloud_load(*_a, **_k):
        nonlocal cloud_called
        cloud_called = True
        return "cloud"

    monkeypatch.setattr("agentcore.account.credentials.cloud_memory_load", _cloud_load)

    class _FakeRepo:
        async def get_memory_note(self, *_a, **_k):
            return SimpleNamespace(content="from-db")

    store = DocumentMemoryStore(session=SimpleNamespace())  # type: ignore[arg-type]

    @asynccontextmanager
    async def _repo():
        yield _FakeRepo()

    store._repo = _repo  # type: ignore[method-assign]
    with account_credentials_scope(account_creds):
        body = await store.load("u1", "画像.md")
    assert body == "from-db"
    assert cloud_called is False


# --- on_demand rules via account narrow ticket (禁静默空转) --------------------


def test_on_demand_user_rules_from_cloud_maps_catalog():
    from agentcore.memory.rules_injection import on_demand_user_rules_from_cloud

    rules = on_demand_user_rules_from_cloud(
        {
            "global_rules": [{"name": "用户规则.md", "content": "- always"}],
            "global_on_demand_rules": [
                {"name": "合规附录.md", "content": "- 对外须用中文\n"},
            ],
            "project_on_demand_rules": [
                {"name": "出差报销.md", "content": "- 先走审批\n"},
            ],
        },
        folder_id="F1",
    )
    assert [r.name for r in rules] == ["出差报销", "合规附录"]
    assert any(r.name == "合规附录" and r.summary for r in rules)


def test_on_demand_from_cloud_empty_when_keys_absent():
    """Older clouds without on_demand fields must not invent catalog entries."""
    from agentcore.memory.rules_injection import on_demand_user_rules_from_cloud

    assert on_demand_user_rules_from_cloud(
        {"global_rules": [{"name": "用户规则.md", "content": "- x"}]},
        folder_id=None,
    ) == []


def test_lookup_on_demand_body_project_then_global():
    from agentcore.memory.rules_injection import lookup_on_demand_rule_body_from_cloud

    payload = {
        "global_on_demand_rules": [
            {"name": "合规附录.md", "content": "- global body\n"},
        ],
        "project_on_demand_rules": [
            {"name": "合规附录.md", "content": "- project body\n"},
        ],
    }
    assert (
        lookup_on_demand_rule_body_from_cloud(
            payload, folder_id="F1", name="合规附录"
        )
        == "- project body\n"
    )
    assert (
        lookup_on_demand_rule_body_from_cloud(
            payload, folder_id=None, name="合规附录"
        )
        == "- global body\n"
    )


async def test_load_on_demand_uses_cloud_when_ticketed(
    monkeypatch: pytest.MonkeyPatch, account_creds
):
    """Regression: account path must NOT silently return [] when on_demand exists."""
    from agentcore.memory.rules_injection import load_on_demand_user_rules

    async def _fake_list(creds, *, folder_id):
        assert creds is account_creds
        assert folder_id == "F1"
        return {
            "global_rules": [{"name": "用户规则.md", "content": "- always"}],
            "project_rules": [],
            "global_on_demand_rules": [
                {"name": "合规附录.md", "content": "- 对外须用中文\n"},
            ],
            "project_on_demand_rules": [],
        }

    monkeypatch.setattr(
        "agentcore.account.credentials.cloud_list_user_rules", _fake_list
    )
    monkeypatch.setattr(
        "agentcore.db.base.async_session_factory",
        lambda: (_ for _ in ()).throw(AssertionError("must not open local DB")),
    )

    with account_credentials_scope(account_creds):
        rules = await load_on_demand_user_rules("u1", folder_id="F1")
    assert len(rules) == 1
    assert rules[0].name == "合规附录"


async def test_load_on_demand_ticketed_empty_catalog_is_honest(
    monkeypatch: pytest.MonkeyPatch, account_creds
):
    from agentcore.memory.rules_injection import load_on_demand_user_rules

    async def _fake_list(creds, *, folder_id):
        return {
            "global_rules": [{"name": "用户规则.md", "content": "- always"}],
            "global_on_demand_rules": [],
            "project_on_demand_rules": [],
        }

    monkeypatch.setattr(
        "agentcore.account.credentials.cloud_list_user_rules", _fake_list
    )
    with account_credentials_scope(account_creds):
        assert await load_on_demand_user_rules("u1", folder_id=None) == []


async def test_consult_rule_cloud_hit(
    monkeypatch: pytest.MonkeyPatch, account_creds
):
    from agentcore.tools.builtin.consult_rule import ConsultRuleTool

    body = "- 对外沟通须用中文\n"

    async def _fake_list(creds, *, folder_id):
        assert folder_id == "F1"
        return {
            "global_on_demand_rules": [{"name": "合规附录.md", "content": body}],
            "project_on_demand_rules": [],
        }

    monkeypatch.setattr(
        "agentcore.account.credentials.cloud_list_user_rules", _fake_list
    )
    monkeypatch.setattr(
        "agentcore.db.base.async_session_factory",
        lambda: (_ for _ in ()).throw(AssertionError("must not open local DB")),
    )

    tool = ConsultRuleTool(folder_id="F1")
    with account_credentials_scope(account_creds):
        result = await tool.execute({"name": "合规附录"}, _ctx())
    assert result.success
    assert result.output == body
    assert result.display == {"rule": "合规附录"}


async def test_assemble_without_ticket_uses_db_path(
    monkeypatch: pytest.MonkeyPatch,
):
    """No account ContextVar → assemble still opens a session (may soft-fail empty)."""
    opened = {"n": 0}

    class _SessCtx:
        async def __aenter__(self):
            opened["n"] += 1
            raise RuntimeError("no local pg")

        async def __aexit__(self, *_a):
            return False

    monkeypatch.setattr(
        "agentcore.db.base.async_session_factory",
        lambda: _SessCtx(),
    )
    user_md, _ = await assemble_turn_rules(
        _EmptyMemoryStore(),  # type: ignore[arg-type]
        "u1",
        folder_id=None,
        enabled=True,
        max_docs=20,
        max_chars=20000,
    )
    assert opened["n"] == 1
    assert user_md == ""
