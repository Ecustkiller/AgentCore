"""Tests for 工作区对称化 D1a (desktop bare chat → per-conversation local workspace).

Three layers, all without a real desktop or DB:

  * ``LocalWorkspace`` *subpath scoping* — when bound to a sub-directory under a
    shared container root, every op path is prefixed on the way to the desktop and
    stripped on the way back, so the engine/tools/user only see workspace-relative
    paths. Unscoped (``base=""``) is a pure pass-through (regression guard for the
    existing "添加本地文件夹" root-bound projects).
  * ``DeferredWorkspace`` *local promotion* — a 裸聊 promoted with a ``local_binding``
    materializes a ``LocalWorkspace`` inner (not a server one) and its ``location``
    flips to ``"local"`` so the end-of-turn server-snapshot guard correctly skips it.
  * naming / subpath helpers — title→message fallback, FS-safe segment sanitizing,
    and per-container dedupe.
"""

import asyncio
from types import SimpleNamespace

import pytest

from agentcore.conversation import service
from agentcore.conversation.service import (
    _sanitize_subpath_segment,
    _unique_local_subpath,
)
from agentcore.runtime.events import EventSink, EventType, SSEEvent
from agentcore.runtime.interaction import InteractionRegistry
from agentcore.tools.sandbox.protocol import ExecutionRequest
from agentcore.workspace.channel import WorkspaceChannel
from agentcore.workspace.deferred import DeferredWorkspace, PromotionResult
from agentcore.workspace.local import LocalWorkspace
from agentcore.workspace.locate import LocalBinding, default_workspace_name
from agentcore.workspace.protocol import GrepQuery
from agentcore.workspace.server import ServerWorkspace

pytestmark = pytest.mark.anyio

CONV = "conv-1"
ROOT_ID = "root-abc"


# --- helpers (mirror test_workspace_channel: a fake desktop drives each op) ----


def _make(base: str = "") -> tuple[LocalWorkspace, InteractionRegistry, EventSink]:
    sink = EventSink()
    registry = InteractionRegistry()
    channel = WorkspaceChannel(
        sink=sink,
        conversation_id=CONV,
        registry=registry,
        timeout_seconds=5.0,
        root_id=ROOT_ID,
    )
    return LocalWorkspace(channel, base_subpath=base), registry, sink


async def _await_request(sink: EventSink) -> SSEEvent:
    for _ in range(2000):
        if not sink._queue.empty():  # noqa: SLF001 - test-only inspection
            return sink._queue.get_nowait()
        await asyncio.sleep(0)
    raise AssertionError("no workspace_op_required event emitted")


async def _round_trip(coro, sink, registry, response: dict):
    task = asyncio.create_task(coro)
    event = await _await_request(sink)
    assert registry.resolve(event.payload["request_id"], response, conversation_id=CONV)
    return await task, event


def _drain(sink: EventSink) -> list[SSEEvent]:
    """All events queued on the sink so far (emit is synchronous)."""
    out: list[SSEEvent] = []
    while not sink._queue.empty():  # noqa: SLF001 - test-only inspection
        out.append(sink._queue.get_nowait())
    return out


def _patch_promote_db(monkeypatch) -> None:
    """Stub the DB so ``_bare_chat_promote`` runs without a session (no-DB ethos).

    The minted folder echoes the requested binding so the test can assert the
    promotion event mirrors what was filed; ``set_folder`` is a no-op.
    """

    class _FakeSession:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

    class _FakeFolderRepo:
        def __init__(self, _session):
            pass

        async def list_by_user(self, _user_id):
            return []

        async def create(self, *, user_id, name, local_root_id, local_subpath):
            return SimpleNamespace(id="f-new")

    class _FakeConvRepo:
        def __init__(self, _session):
            pass

        async def set_folder(self, conversation_id, folder_id, *, user_id):
            return None

    monkeypatch.setattr(service, "async_session_factory", lambda: _FakeSession())
    monkeypatch.setattr(service, "FolderRepository", _FakeFolderRepo)
    monkeypatch.setattr(service, "ConversationRepository", _FakeConvRepo)


# --- LocalWorkspace subpath scoping -------------------------------------------


async def test_scoped_read_prefixes_subpath():
    local, registry, sink = _make(base="proj")
    _, event = await _round_trip(
        local.read("a.txt"), sink, registry, {"ok": True, "value": "hi"}
    )
    assert event.payload["args"]["path"] == "proj/a.txt"


async def test_scoped_write_and_move_prefix_paths():
    local, registry, sink = _make(base="proj")
    _, ew = await _round_trip(
        local.write("out.txt", "data"), sink, registry, {"ok": True, "value": 4}
    )
    assert ew.payload["args"]["path"] == "proj/out.txt"
    _, em = await _round_trip(
        local.move("a.txt", "b.txt"), sink, registry, {"ok": True, "value": None}
    )
    assert em.payload["args"] == {"src": "proj/a.txt", "dst": "proj/b.txt"}


async def test_scoped_list_prefixes_dir_and_strips_results():
    local, registry, sink = _make(base="proj")
    response = {
        "ok": True,
        "value": [
            {"path": "proj/src", "is_dir": True},
            {"path": "proj/src/main.py", "is_dir": False},
        ],
    }
    entries, event = await _round_trip(local.list(".", "*"), sink, registry, response)
    # "." (workspace root) maps to the subpath base; results come back relative.
    assert event.payload["args"]["directory"] == "proj"
    assert [(e.path, e.is_dir) for e in entries] == [
        ("src", True),
        ("src/main.py", False),
    ]


async def test_scoped_index_files_sends_base_and_strips():
    local, registry, sink = _make(base="proj")
    response = {
        "ok": True,
        "value": {"paths": ["proj/a.txt", "proj/sub/b.md"], "truncated": False},
    }
    (paths, _), event = await _round_trip(
        local.index_files(), sink, registry, response
    )
    assert event.payload["args"]["base"] == "proj"  # scopes the walk to this subtree
    assert paths == ["a.txt", "sub/b.md"]


async def test_scoped_grep_prefixes_dir_and_strips_hits():
    local, registry, sink = _make(base="proj")
    response = {
        "ok": True,
        "value": {
            "hits": [{"path": "proj/a.py", "line_no": 3, "text": "x"}],
            "file_counts": [["proj/a.py", 1]],
            "total_matches": 1,
            "truncated": False,
        },
    }
    result, event = await _round_trip(
        local.grep(GrepQuery(pattern="x")), sink, registry, response
    )
    assert event.payload["args"]["directory"] == "proj"
    assert result.hits[0].path == "a.py"
    assert result.file_counts == [("a.py", 1)]


async def test_scoped_execute_sends_cwd_subpath():
    local, registry, sink = _make(base="proj")
    response = {
        "ok": True,
        "value": {
            "success": True,
            "stdout": "",
            "stderr": "",
            "exit_code": 0,
            "duration_ms": 1,
        },
    }
    _, event = await _round_trip(
        local.execute(ExecutionRequest(code="print(1)", language="python")),
        sink,
        registry,
        response,
    )
    assert event.payload["args"]["cwd"] == "proj"


async def test_unscoped_is_pure_passthrough():
    """base="" → no prefix / no strip (existing root-bound local projects unchanged)."""
    local, registry, sink = _make()
    _, read_ev = await _round_trip(
        local.read("a.txt"), sink, registry, {"ok": True, "value": "x"}
    )
    assert read_ev.payload["args"]["path"] == "a.txt"  # path reaches desktop verbatim
    # An unscoped index walks from the root (base ".") and returns paths untouched.
    response = {"ok": True, "value": {"paths": ["a.txt", "sub/b.md"], "truncated": False}}
    (paths, _), idx_ev = await _round_trip(
        local.index_files(), sink, registry, response
    )
    assert idx_ev.payload["args"]["base"] == "."
    assert paths == ["a.txt", "sub/b.md"]


# --- DeferredWorkspace: cloud vs local promotion ------------------------------


async def test_deferred_promotes_cloud_to_server_workspace(tmp_path, monkeypatch):
    from agentcore.config import settings

    monkeypatch.setattr(settings, "data_dir", str(tmp_path))

    async def promote() -> PromotionResult:
        return PromotionResult(folder_id="f-new")

    ws = DeferredWorkspace(user_id="u1", promote=promote)
    assert ws.location == "server"  # pre-promotion default
    inner = await ws._materialize()  # noqa: SLF001 - test-only trigger
    assert isinstance(inner, ServerWorkspace)
    assert ws.location == "server"
    assert ws.folder_id == "f-new"


async def test_deferred_promotes_local_to_local_workspace_with_subpath():
    async def promote() -> PromotionResult:
        return PromotionResult(
            folder_id="f-new",
            local_binding=LocalBinding(
                root_id="root-x", root_label="My Proj", subpath="My Proj"
            ),
        )

    ws = DeferredWorkspace(
        user_id="u1", promote=promote, sink=EventSink(), conversation_id="c1"
    )
    assert ws.location == "server"  # not yet promoted
    inner = await ws._materialize()  # noqa: SLF001 - test-only trigger
    assert isinstance(inner, LocalWorkspace)
    assert ws.location == "local"  # flips so the snapshot guard skips it
    assert inner.root_label == "My Proj"
    assert inner._base == "My Proj"  # noqa: SLF001 - subpath threaded to the backend


async def test_deferred_local_promotion_requires_sink():
    async def promote() -> PromotionResult:
        return PromotionResult(
            folder_id="f", local_binding=LocalBinding(root_id="r", subpath="s")
        )

    ws = DeferredWorkspace(user_id="u1", promote=promote)  # no sink
    with pytest.raises(RuntimeError, match="sink"):
        await ws._materialize()  # noqa: SLF001 - test-only trigger


# --- bare-chat promotion emits the workspace_promoted signal -------------------
# Regression guard for "AI 产出了文件但前端看不到 / 对话从未分组消失": the lazy
# promotion is server-side + mid-turn, so without this event the live client never
# learns the 裸聊 became a folder. _bare_chat_promote must emit it on the turn's sink.


async def test_bare_chat_promote_emits_local_workspace_promoted(monkeypatch):
    _patch_promote_db(monkeypatch)
    sink = EventSink()
    promote = service._bare_chat_promote(  # noqa: SLF001 - unit under test
        user_id="u1",
        conversation_id="c1",
        title="My Title",
        user_message="hello",
        local_container_root_id="root-x",
        sink=sink,
    )
    result = await promote()
    assert result.local_binding is not None  # local promotion

    promoted = [e for e in _drain(sink) if e.type == EventType.WORKSPACE_PROMOTED]
    assert len(promoted) == 1
    p = promoted[0].payload
    assert p["conversation_id"] == "c1"
    assert p["folder_id"] == "f-new"
    assert p["name"] == "My Title"
    assert p["local_root_id"] == "root-x"  # carries the container root for the client
    assert p["local_subpath"] == "My Title"  # sanitized title → per-chat subpath


async def test_bare_chat_promote_emits_cloud_workspace_promoted(monkeypatch):
    _patch_promote_db(monkeypatch)
    sink = EventSink()
    promote = service._bare_chat_promote(  # noqa: SLF001 - unit under test
        user_id="u1",
        conversation_id="c2",
        title=None,  # title still pending mid-turn → name falls back to the message
        user_message="do a thing",
        local_container_root_id=None,  # web/mobile/「云端临时对话」 → cloud promotion
        sink=sink,
    )
    result = await promote()
    assert result.local_binding is None  # cloud promotion

    p = [e for e in _drain(sink) if e.type == EventType.WORKSPACE_PROMOTED][0].payload
    assert p["folder_id"] == "f-new"
    assert p["name"] == "do a thing"
    assert p["local_root_id"] is None  # cloud → client treats it as a cloud folder
    assert p["local_subpath"] == ""


# --- naming / subpath helpers (pure) ------------------------------------------


def test_default_name_prefers_title_then_message_then_fallback():
    assert default_workspace_name("My Title", fallback_text="msg") == "My Title"
    assert default_workspace_name(None, fallback_text="first message") == "first message"
    assert default_workspace_name("   ", fallback_text="  ") == "未命名工作区"
    assert default_workspace_name(None) == "未命名工作区"


def test_sanitize_subpath_segment_strips_illegal_and_caps():
    assert _sanitize_subpath_segment("Hello / World") == "Hello World"
    assert _sanitize_subpath_segment('a<b>c:d|e?f*g') == "abcdefg"
    assert _sanitize_subpath_segment("trailing dots...") == "trailing dots"
    assert _sanitize_subpath_segment("") == "workspace"
    assert _sanitize_subpath_segment("   ") == "workspace"
    assert len(_sanitize_subpath_segment("x" * 200)) == 80


# A folder row stand-in for the dedupe query (only the two fields it reads).
class _FakeFolder:
    def __init__(self, local_root_id, local_subpath):
        self.local_root_id = local_root_id
        self.local_subpath = local_subpath


class _FakeRepo:
    def __init__(self, folders):
        self._folders = folders

    async def list_by_user(self, _user_id):
        return self._folders


async def test_unique_subpath_dedupes_within_container():
    repo = _FakeRepo(
        [
            _FakeFolder("root-x", "Demo"),
            _FakeFolder("root-x", "Demo-2"),
            _FakeFolder("root-y", "Other"),
        ]
    )
    sub = await _unique_local_subpath(
        repo, user_id="u1", container_root_id="root-x", name="Demo"
    )
    assert sub == "Demo-3"


async def test_unique_subpath_ignores_other_containers():
    repo = _FakeRepo([_FakeFolder("root-y", "Demo")])
    sub = await _unique_local_subpath(
        repo, user_id="u1", container_root_id="root-x", name="Demo"
    )
    assert sub == "Demo"  # a same-named folder under a *different* root doesn't clash
