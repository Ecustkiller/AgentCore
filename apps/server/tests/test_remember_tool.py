"""CEO remember tool — named user-rule markdown under AgentCore/规则/.

DB-free here: schema contract + mutate helpers. End-to-end write is in
``tests/integration/test_documents.py``.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from agentcore.memory.rules_injection import (
    UserRuleMutationResult,
    mutate_user_rule,
    normalize_rule_filename,
)
from agentcore.tools.builtin.remember import (
    RememberTool,
    _is_incomplete_rule_content,
    build_remember_tool,
)
from agentcore.tools.protocol import ToolContext


def _ctx() -> ToolContext:
    return ToolContext.create(
        execution_id="e",
        run_id="r",
        agent_id="ceo",
        backend=SimpleNamespace(location="local"),  # type: ignore[arg-type]
        user_id="u1",
        conversation_id="c1",
    )


def test_remember_schema_is_static():
    tool = RememberTool(folder_id=None)
    assert tool.schema.name == "remember"
    assert "一篇" in tool.schema.description
    assert "file_write" in tool.schema.description
    assert "离线巩固" not in tool.schema.description
    assert "没下指令就不记" not in tool.schema.description
    assert "update_folder_profile" not in tool.schema.description
    assert tool.schema.parameters["required"] == []
    assert tool.schema.parameters["properties"]["scope"]["enum"] == ["global", "folder"]
    assert tool.schema.parameters["properties"]["action"]["enum"] == [
        "write",
        "read",
        "delete",
        "list",
    ]
    assert "name" in tool.schema.parameters["properties"]
    assert "replaces" not in tool.schema.parameters["properties"]


def test_build_remember_tool_defaults():
    tool = build_remember_tool(folder_id="fold-1")
    assert isinstance(tool, RememberTool)
    assert tool.folder_id == "fold-1"


def test_normalize_rule_filename():
    assert normalize_rule_filename("回复语言") == "回复语言.md"
    assert normalize_rule_filename("回复语言.md") == "回复语言.md"
    assert normalize_rule_filename("  回复语言.md  ") == "回复语言.md"
    assert normalize_rule_filename("") is None
    assert normalize_rule_filename("../x.md") is None
    assert normalize_rule_filename("dir/x.md") is None
    assert normalize_rule_filename("偏好.md") is None
    assert normalize_rule_filename("画像.md") is None
    assert normalize_rule_filename("导航.md") is None
    assert normalize_rule_filename("x" * 80) is None


class _FakeDoc:
    def __init__(
        self,
        name: str,
        content: str,
        apply_mode: str = "always",
        description: str = "",
    ) -> None:
        self.id = f"id-{name}"
        self.name = name
        self.content = content
        self.apply_mode = apply_mode
        self.description = description
        self.kind = "document"


class _FakeRepo:
    def __init__(self) -> None:
        self.docs: dict[str, _FakeDoc] = {}
        self.upserted = False

    async def list_user_rule_docs(self, user_id, folder_id):  # noqa: ARG002
        return list(self.docs.values())

    async def get_user_rule_doc(self, user_id, folder_id, name):  # noqa: ARG002
        return self.docs.get(name)

    async def upsert_user_rule_doc(
        self,
        user_id,
        folder_id,
        name,
        content,
        *,
        apply="always",
        description=None,
    ):  # noqa: ARG002
        from agentcore.documents.frontmatter import set_entry_frontmatter

        body = set_entry_frontmatter(content, apply=apply, description=description)
        doc = _FakeDoc(name, body, apply, description or "")
        self.docs[name] = doc
        self.upserted = True
        return doc

    async def delete_user_rule_doc(self, user_id, folder_id, name):  # noqa: ARG002
        return self.docs.pop(name, None) is not None


@pytest.mark.anyio
async def test_mutate_write_read_delete_list(monkeypatch: pytest.MonkeyPatch):
    from agentcore.memory.always_quota import AlwaysQuotaDecision, AlwaysUsage

    async def _allow(*args, **kwargs):  # noqa: ARG001
        return AlwaysQuotaDecision(
            allowed=True,
            usage=AlwaysUsage(used_chars=0, max_chars=1000),
            message="",
        )

    monkeypatch.setattr("agentcore.memory.always_quota.check_always_write", _allow)
    monkeypatch.setattr(
        "agentcore.memory.rules_injection.maybe_schedule_description_fill",
        lambda **kwargs: None,
    )
    repo = _FakeRepo()
    written = await mutate_user_rule(
        repo,  # type: ignore[arg-type]
        "u1",
        folder_id=None,
        action="write",
        name="回复语言.md",
        content="用中文回复。",
        description="回复语言",
    )
    assert written.ok and written.changed
    assert written.name == "回复语言.md"
    assert "已写入" in written.message
    assert "用中文回复" in (repo.docs["回复语言.md"].content)

    again = await mutate_user_rule(
        repo,  # type: ignore[arg-type]
        "u1",
        folder_id=None,
        action="write",
        name="回复语言.md",
        content="用中文回复。",
        description="回复语言",
    )
    assert again.ok and again.changed is False
    assert "没有变化" in again.message

    listed = await mutate_user_rule(
        repo,  # type: ignore[arg-type]
        "u1",
        folder_id=None,
        action="list",
    )
    assert listed.ok and listed.changed is False
    assert listed.catalog[0][0] == "回复语言.md"
    assert "回复语言.md" in listed.message

    read = await mutate_user_rule(
        repo,  # type: ignore[arg-type]
        "u1",
        folder_id=None,
        action="read",
        name="回复语言",
    )
    assert read.ok and "用中文回复" in read.body

    missing = await mutate_user_rule(
        repo,  # type: ignore[arg-type]
        "u1",
        folder_id=None,
        action="delete",
        name="不存在.md",
    )
    assert missing.ok is False

    deleted = await mutate_user_rule(
        repo,  # type: ignore[arg-type]
        "u1",
        folder_id=None,
        action="delete",
        name="回复语言.md",
    )
    assert deleted.ok and deleted.changed
    assert "已删除" in deleted.message
    assert "回复语言.md" not in repo.docs


@pytest.mark.anyio
async def test_mutate_rejects_missing_and_reserved_names():
    repo = _FakeRepo()
    missing = await mutate_user_rule(
        repo,  # type: ignore[arg-type]
        "u1",
        folder_id=None,
        action="write",
        content="用中文",
    )
    assert missing.ok is False
    assert "缺少 name" in missing.message

    reserved = await mutate_user_rule(
        repo,  # type: ignore[arg-type]
        "u1",
        folder_id=None,
        action="write",
        name="画像.md",
        content="不该写到记忆叶",
    )
    assert reserved.ok is False
    assert "name 不可用" in reserved.message
    assert repo.upserted is False


# --- content integrity gate (write) -------------------------------------------


def test_incomplete_rule_content_trailing_ellipsis():
    assert _is_incomplete_rule_content("以后都用中文...")
    assert _is_incomplete_rule_content("以后都用中文…")
    assert _is_incomplete_rule_content("以后都用中文……")
    assert not _is_incomplete_rule_content("以后都用中文回复")
    assert not _is_incomplete_rule_content("")


def test_incomplete_rule_content_mid_omission_marker():
    assert _is_incomplete_rule_content("以后都用中文（略）回复")
    assert _is_incomplete_rule_content("see ... omitted details")
    assert _is_incomplete_rule_content("中间省略，已保留首尾")


@pytest.mark.anyio
async def test_remember_rejects_trailing_ellipsis():
    tool = RememberTool(folder_id=None)
    for suffix in ("...", "…", "……"):
        result = await tool.execute(
            {"name": "回复语言.md", "content": f"用中文{suffix}"},
            _ctx(),
        )
        assert result.success is False
        assert "完整一篇" in (result.output or "")
        assert "省略号" in (result.output or "")


@pytest.mark.anyio
async def test_remember_rejects_mid_omission_marker():
    tool = RememberTool(folder_id=None)
    result = await tool.execute(
        {"name": "回复语言.md", "content": "用中文（略）别用表格"},
        _ctx(),
    )
    assert result.success is False
    assert "完整一篇" in (result.output or "")


@pytest.mark.anyio
async def test_remember_write_requires_name():
    tool = RememberTool(folder_id=None)
    result = await tool.execute({"content": "以后都用中文回复"}, _ctx())
    assert result.success is False
    assert "缺少 name" in (result.output or "")


@pytest.mark.anyio
async def test_remember_empty_content_with_name():
    tool = RememberTool(folder_id=None)
    result = await tool.execute({"name": "回复语言.md", "content": "   "}, _ctx())
    assert result.success is False
    assert result.error == "缺少 content。"


@pytest.mark.anyio
async def test_remember_complete_content_still_writes(monkeypatch: pytest.MonkeyPatch):
    captured: dict[str, object] = {}

    async def _fake_mutate(_repo, _uid, **kwargs):
        captured.update(kwargs)
        return UserRuleMutationResult(
            action="write",
            changed=True,
            message="已写入规则「回复语言.md」（常驻）。",
            name="回复语言.md",
            apply="always",
            content=str(kwargs.get("content") or ""),
        )

    monkeypatch.setattr(
        "agentcore.tools.builtin.remember.mutate_user_rule", _fake_mutate
    )
    monkeypatch.setattr(
        "agentcore.tools.builtin.remember.async_session_factory",
        lambda: _FakeSession(),
    )

    tool = RememberTool(folder_id=None)
    result = await tool.execute(
        {"name": "回复语言.md", "content": "以后都用中文回复"},
        _ctx(),
    )
    assert result.success is True
    assert captured["content"] == "以后都用中文回复"
    assert captured["name"] == "回复语言.md"
    assert captured["action"] == "write"
    assert "已写入" in (result.output or "")


@pytest.mark.anyio
async def test_remember_delete_trailing_ellipsis_not_gated(
    monkeypatch: pytest.MonkeyPatch,
):
    called = {"ok": False}

    async def _fake_mutate(_repo, _uid, **kwargs):
        called["ok"] = True
        assert kwargs["action"] == "delete"
        assert kwargs["name"] == "回复语言.md"
        return UserRuleMutationResult(
            action="delete",
            changed=True,
            message="已删除规则「回复语言.md」。",
            name="回复语言.md",
        )

    monkeypatch.setattr(
        "agentcore.tools.builtin.remember.mutate_user_rule", _fake_mutate
    )
    monkeypatch.setattr(
        "agentcore.tools.builtin.remember.async_session_factory",
        lambda: _FakeSession(),
    )

    tool = RememberTool(folder_id=None)
    result = await tool.execute(
        {"action": "delete", "name": "回复语言.md", "content": "用中文..."},
        _ctx(),
    )
    assert result.success is True
    assert called["ok"] is True


@pytest.mark.anyio
async def test_remember_list_unaffected_by_ellipsis_gate(monkeypatch: pytest.MonkeyPatch):
    async def _fake_mutate(_repo, _uid, **kwargs):
        assert kwargs["action"] == "list"
        return UserRuleMutationResult(
            action="list",
            changed=False,
            message="当前用户规则：\n- 回复语言.md  常驻",
            catalog=(("回复语言.md", "always", ""),),
        )

    monkeypatch.setattr(
        "agentcore.tools.builtin.remember.mutate_user_rule", _fake_mutate
    )
    monkeypatch.setattr(
        "agentcore.tools.builtin.remember.async_session_factory",
        lambda: _FakeSession(),
    )

    tool = RememberTool(folder_id=None)
    result = await tool.execute({"action": "list"}, _ctx())
    assert result.success is True
    assert "回复语言.md" in (result.output or "")


@pytest.mark.anyio
async def test_mutate_user_rule_ai_growth_denied(monkeypatch: pytest.MonkeyPatch):
    from agentcore.memory.always_quota import (
        AlwaysQuotaDecision,
        AlwaysQuotaExceededError,
        AlwaysUsage,
    )

    async def _deny(*args, **kwargs):  # noqa: ARG001
        return AlwaysQuotaDecision(
            allowed=False,
            usage=AlwaysUsage(used_chars=100, max_chars=50),
            message="常驻条目配额已满",
        )

    async def _no_notify(*args, **kwargs):  # noqa: ARG001
        return None

    monkeypatch.setattr("agentcore.memory.always_quota.check_always_write", _deny)
    monkeypatch.setattr(
        "agentcore.memory.always_quota.notify_always_quota_exceeded", _no_notify
    )
    repo = _FakeRepo()
    with pytest.raises(AlwaysQuotaExceededError) as ei:
        await mutate_user_rule(
            repo,  # type: ignore[arg-type]
            "u1",
            folder_id=None,
            action="write",
            name="回复语言.md",
            content="以后都用中文回复",
        )
    assert "配额" in ei.value.message
    assert ei.value.file == "回复语言.md"
    assert repo.upserted is False


@pytest.mark.anyio
async def test_remember_quota_denied_message(monkeypatch: pytest.MonkeyPatch):
    from agentcore.memory.always_quota import AlwaysQuotaExceededError, AlwaysUsage

    async def _boom(*args, **kwargs):  # noqa: ARG001
        raise AlwaysQuotaExceededError(
            AlwaysUsage(used_chars=100, max_chars=50),
            "常驻条目配额已满",
            file="回复语言.md",
        )

    monkeypatch.setattr("agentcore.tools.builtin.remember.mutate_user_rule", _boom)
    monkeypatch.setattr(
        "agentcore.tools.builtin.remember.async_session_factory",
        lambda: _FakeSession(),
    )
    monkeypatch.setattr(
        "agentcore.account.credentials.get_account_credentials",
        lambda: None,
    )
    tool = RememberTool(folder_id=None)
    result = await tool.execute(
        {"name": "回复语言.md", "content": "以后都用中文回复"},
        _ctx(),
    )
    assert result.success is False
    assert "配额" in (result.output or "")
    assert "请稍后再试" not in (result.output or "")


class _FakeSession:
    """Minimal async context manager standing in for async_session_factory()."""

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return None
