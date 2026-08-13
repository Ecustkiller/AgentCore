"""Unit tests for line-level memory rejection (纠错通道·行级「这条不对」).

The markdown half runs against ``FileMemoryStore`` + a fake note row; the one-transaction
body+record write is the repo's own contract and is covered by the documents suite.
"""

from types import SimpleNamespace

import pytest

from agentcore.db.models.documents import MAX_DISPUTED_LINES, DisputedLine
from agentcore.memory.dispute_line import (
    DisputeLineConflict,
    DisputeLineError,
    DisputeLineOk,
    dispute_memory_line,
    resolve_memory_file,
    restore_memory_line,
)
from agentcore.memory.store import (
    CORE_MEMORY_FILE,
    PREFERENCES_MEMORY_FILE,
    FileMemoryStore,
    memory_version,
)

_UID = "u1"
_FOLDER = "11111111-1111-1111-1111-111111111111"


class _FakeRepo:
    """Stands in for ``DocumentRepository``: body write + record stay in lockstep."""

    def __init__(self, store: FileMemoryStore) -> None:
        self._store = store
        self.lines: dict[tuple[str | None, str], list[DisputedLine]] = {}

    async def get_memory_note(self, user_id: str, name: str, folder_id: str | None):
        body = await self._store.load(user_id, name, scope=folder_id)
        key = (folder_id, name)
        if not body and key not in self.lines:
            return None
        return SimpleNamespace(disputed_lines=self.lines.get(key, []))

    async def dispute_memory_line(
        self,
        user_id: str,
        name: str,
        folder_id: str | None,
        *,
        new_content: str,
        line: DisputedLine,
    ):
        await self._store.save(user_id, name, new_content, scope=folder_id)
        key = (folder_id, name)
        rows = self.lines.setdefault(key, [])
        rows.append(line)
        del rows[:-MAX_DISPUTED_LINES]
        return SimpleNamespace(disputed_lines=rows)

    async def restore_memory_line(
        self,
        user_id: str,
        name: str,
        folder_id: str | None,
        *,
        new_content: str,
        line_id: str,
    ):
        key = (folder_id, name)
        rows = self.lines.get(key, [])
        kept = [row for row in rows if row["id"] != line_id]
        if len(kept) == len(rows):
            return None
        await self._store.save(user_id, name, new_content, scope=folder_id)
        self.lines[key] = kept
        return SimpleNamespace(disputed_lines=kept)


def test_resolve_preferences_and_topic():
    assert resolve_memory_file(kind="preferences", topic_slug=None) == (
        PREFERENCES_MEMORY_FILE
    )
    assert resolve_memory_file(kind="profile", topic_slug=None) == CORE_MEMORY_FILE
    topic = resolve_memory_file(kind="topic", topic_slug="deploy")
    assert isinstance(topic, str) and topic.endswith("deploy.md")


def test_resolve_topic_without_slug_is_rejected():
    err = resolve_memory_file(kind="topic", topic_slug="  ")
    assert isinstance(err, DisputeLineError)


@pytest.mark.asyncio
async def test_dispute_removes_only_that_line(tmp_path):
    store = FileMemoryStore(tmp_path)
    await store.save(
        _UID,
        CORE_MEMORY_FILE,
        "## 关于用户的事实\n- 用户在腾讯工作\n- 用户住在深圳\n",
    )
    repo = _FakeRepo(store)

    result = await dispute_memory_line(
        store,
        repo,
        user_id=_UID,
        content="用户在腾讯工作",
        section="关于用户的事实",
    )

    assert isinstance(result, DisputeLineOk)
    body = await store.load(_UID, CORE_MEMORY_FILE)
    # The rejected line is GONE from the body — that is what stops it being injected.
    assert "用户在腾讯工作" not in body
    # Its neighbours survive: rejecting a sentence must not silence the whole entry.
    assert "用户住在深圳" in body
    (record,) = repo.lines[(None, CORE_MEMORY_FILE)]
    assert record["section"] == "关于用户的事实"
    assert record["text"] == "用户在腾讯工作"
    assert record["disputed_at"]
    # The id the caller gets back IS the record's — an undo has an exact handle.
    assert record["id"] == result.line_id


@pytest.mark.asyncio
async def test_dispute_missing_line_leaves_no_record(tmp_path):
    """A no-match must fail loudly: a record with no matching body text is unrestorable."""
    store = FileMemoryStore(tmp_path)
    await store.save(_UID, CORE_MEMORY_FILE, "## 关于用户的事实\n- 用户住在深圳\n")
    repo = _FakeRepo(store)

    result = await dispute_memory_line(
        store,
        repo,
        user_id=_UID,
        content="用户在腾讯工作",
        section="关于用户的事实",
    )

    assert isinstance(result, DisputeLineError)
    assert repo.lines == {}
    assert "用户住在深圳" in await store.load(_UID, CORE_MEMORY_FILE)


@pytest.mark.asyncio
async def test_dispute_empty_content_is_rejected(tmp_path):
    store = FileMemoryStore(tmp_path)
    repo = _FakeRepo(store)
    result = await dispute_memory_line(
        store, repo, user_id=_UID, content="   ", section="关于用户的事实"
    )
    assert isinstance(result, DisputeLineError)


@pytest.mark.asyncio
async def test_dispute_stale_baseline_conflicts_without_writing(tmp_path):
    store = FileMemoryStore(tmp_path)
    await store.save(_UID, CORE_MEMORY_FILE, "## 关于用户的事实\n- 用户住在深圳\n")
    repo = _FakeRepo(store)

    result = await dispute_memory_line(
        store,
        repo,
        user_id=_UID,
        content="用户住在深圳",
        section="关于用户的事实",
        baseline="stale-version",
    )

    assert isinstance(result, DisputeLineConflict)
    assert repo.lines == {}
    assert "用户住在深圳" in await store.load(_UID, CORE_MEMORY_FILE)


@pytest.mark.asyncio
async def test_dispute_matching_baseline_succeeds(tmp_path):
    store = FileMemoryStore(tmp_path)
    await store.save(_UID, CORE_MEMORY_FILE, "## 关于用户的事实\n- 用户住在深圳\n")
    repo = _FakeRepo(store)
    current = memory_version(await store.load(_UID, CORE_MEMORY_FILE))

    result = await dispute_memory_line(
        store,
        repo,
        user_id=_UID,
        content="用户住在深圳",
        section="关于用户的事实",
        baseline=current,
    )

    assert isinstance(result, DisputeLineOk)


@pytest.mark.asyncio
async def test_dispute_then_restore_round_trips(tmp_path):
    store = FileMemoryStore(tmp_path)
    await store.save(_UID, CORE_MEMORY_FILE, "## 关于用户的事实\n- 用户在腾讯工作\n")
    repo = _FakeRepo(store)
    disputed = await dispute_memory_line(
        store,
        repo,
        user_id=_UID,
        content="用户在腾讯工作",
        section="关于用户的事实",
    )
    assert isinstance(disputed, DisputeLineOk)

    result = await restore_memory_line(
        store, repo, user_id=_UID, file=CORE_MEMORY_FILE, line_id=disputed.line_id
    )

    assert isinstance(result, DisputeLineOk)
    body = await store.load(_UID, CORE_MEMORY_FILE)
    assert "用户在腾讯工作" in body
    assert "## 关于用户的事实" in body
    assert repo.lines[(None, CORE_MEMORY_FILE)] == []


@pytest.mark.asyncio
async def test_restore_after_earlier_undo_puts_back_the_line_that_was_named(tmp_path):
    """Reject three, undo the first, then undo the second — by id, so it is the SECOND.

    Under index addressing this is where the channel broke: dropping a record shifts every
    later one down, so「撤销」on the second line silently put back the third while the toast
    still said「已放回这条记忆」. One click with no confirm dialog is only defensible while
    the undo is exact.
    """
    store = FileMemoryStore(tmp_path)
    await store.save(
        _UID,
        CORE_MEMORY_FILE,
        "## 关于用户的事实\n- 用户在腾讯工作\n- 用户住在深圳\n- 用户喜欢喝咖啡\n",
    )
    repo = _FakeRepo(store)
    ids: list[str] = []
    for content in ("用户在腾讯工作", "用户住在深圳", "用户喜欢喝咖啡"):
        result = await dispute_memory_line(
            store,
            repo,
            user_id=_UID,
            content=content,
            section="关于用户的事实",
        )
        assert isinstance(result, DisputeLineOk)
        ids.append(result.line_id)
    assert len(set(ids)) == 3

    first = await restore_memory_line(
        store, repo, user_id=_UID, file=CORE_MEMORY_FILE, line_id=ids[0]
    )
    second = await restore_memory_line(
        store, repo, user_id=_UID, file=CORE_MEMORY_FILE, line_id=ids[1]
    )

    assert isinstance(first, DisputeLineOk)
    assert isinstance(second, DisputeLineOk)
    body = await store.load(_UID, CORE_MEMORY_FILE)
    assert "用户在腾讯工作" in body
    assert "用户住在深圳" in body
    # The one nobody undid stays rejected — and stays restorable under its own id.
    assert "用户喜欢喝咖啡" not in body
    assert [row["text"] for row in repo.lines[(None, CORE_MEMORY_FILE)]] == [
        "用户喜欢喝咖啡"
    ]


@pytest.mark.asyncio
async def test_restore_unknown_id_restores_nothing(tmp_path):
    """A stale handle must fail loudly rather than put back whatever is on file."""
    store = FileMemoryStore(tmp_path)
    await store.save(_UID, CORE_MEMORY_FILE, "## 关于用户的事实\n- 用户住在深圳\n")
    repo = _FakeRepo(store)
    disputed = await dispute_memory_line(
        store, repo, user_id=_UID, content="用户住在深圳", section="关于用户的事实"
    )
    assert isinstance(disputed, DisputeLineOk)

    result = await restore_memory_line(
        store, repo, user_id=_UID, file=CORE_MEMORY_FILE, line_id="not-a-record"
    )

    assert isinstance(result, DisputeLineError)
    assert "用户住在深圳" not in await store.load(_UID, CORE_MEMORY_FILE)
    assert len(repo.lines[(None, CORE_MEMORY_FILE)]) == 1


@pytest.mark.asyncio
async def test_dispute_in_project_layer_leaves_global_alone(tmp_path):
    store = FileMemoryStore(tmp_path)
    await store.save(_UID, CORE_MEMORY_FILE, "## 技术栈与工具\n- 全局用 React\n")
    await store.save(
        _UID, CORE_MEMORY_FILE, "## 技术栈与工具\n- 本项目用 Vite\n", scope=_FOLDER
    )
    repo = _FakeRepo(store)

    result = await dispute_memory_line(
        store,
        repo,
        user_id=_UID,
        content="本项目用 Vite",
        section="技术栈与工具",
        scope=_FOLDER,
    )

    assert isinstance(result, DisputeLineOk)
    assert "本项目用 Vite" not in await store.load(_UID, CORE_MEMORY_FILE, scope=_FOLDER)
    assert "全局用 React" in await store.load(_UID, CORE_MEMORY_FILE)
