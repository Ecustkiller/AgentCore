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

from agentcore.conversation import promotion as promotion_mod
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
            return SimpleNamespace(
                id="f-new",
                name=name,
                local_root_id=local_root_id,
                local_subpath=local_subpath,
            )

    class _FakeConvRepo:
        def __init__(self, _session):
            pass

        async def get_folder_id(self, _conversation_id):
            return None  # not yet promoted → the idempotent re-check takes the mint path

        async def set_folder(self, conversation_id, folder_id, *, user_id):
            return None

    monkeypatch.setattr(promotion_mod, "async_session_factory", lambda: _FakeSession())
    monkeypatch.setattr(promotion_mod, "FolderRepository", _FakeFolderRepo)
    monkeypatch.setattr(promotion_mod, "ConversationRepository", _FakeConvRepo)


# --- LocalWorkspace subpath scoping -------------------------------------------


async def test_scoped_read_prefixes_subpath():
    local, registry, sink = _make(base="proj")
    _, event = await _round_trip(local.read("a.txt"), sink, registry, {"ok": True, "value": "hi"})
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
    (paths, _), event = await _round_trip(local.index_files(), sink, registry, response)
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
    result, event = await _round_trip(local.grep(GrepQuery(pattern="x")), sink, registry, response)
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
    _, read_ev = await _round_trip(local.read("a.txt"), sink, registry, {"ok": True, "value": "x"})
    assert read_ev.payload["args"]["path"] == "a.txt"  # path reaches desktop verbatim
    # An unscoped index walks from the root (base ".") and returns paths untouched.
    response = {"ok": True, "value": {"paths": ["a.txt", "sub/b.md"], "truncated": False}}
    (paths, _), idx_ev = await _round_trip(local.index_files(), sink, registry, response)
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
            local_binding=LocalBinding(root_id="root-x", root_label="My Proj", subpath="My Proj"),
        )

    ws = DeferredWorkspace(user_id="u1", promote=promote, sink=EventSink(), conversation_id="c1")
    assert ws.location == "server"  # not yet promoted
    inner = await ws._materialize()  # noqa: SLF001 - test-only trigger
    assert isinstance(inner, LocalWorkspace)
    assert ws.location == "local"  # flips so the snapshot guard skips it
    assert inner.root_label == "My Proj"
    assert inner._base == "My Proj"  # noqa: SLF001 - subpath threaded to the backend


async def test_deferred_local_promotion_requires_sink():
    async def promote() -> PromotionResult:
        return PromotionResult(folder_id="f", local_binding=LocalBinding(root_id="r", subpath="s"))

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


# --- shared promotion on the panel path (no sink) -----------------------------
# Regression guard for "本地裸聊在面板里上传/编辑文件后看不到": the panel write used to
# always mint a *cloud* folder, so a desktop 裸聊 whose panel write landed before any
# turn hid its files in the cloud. Now the panel reuses promote_bare_chat_to_folder and
# reads conv.local_container_root_id, so it promotes local — silently (no live sink).


async def test_promote_bare_chat_local_no_sink_respects_locality():
    """promote_bare_chat_to_folder with a container root but NO sink (the panel path):
    mints a *local* folder (binding carries the per-chat subpath), files the
    conversation into it, and stays silent — a REST caller refetches instead of
    receiving workspace_promoted (工作区对称化 D1a)."""

    class _FolderRepo:
        async def list_by_user(self, _user_id):
            return []

        async def create(self, *, user_id, name, local_root_id, local_subpath):
            assert local_root_id == "root-x"  # locality honored on the panel path
            return SimpleNamespace(
                id="f-panel",
                name=name,
                local_root_id=local_root_id,
                local_subpath=local_subpath,
            )

    filed: dict = {}

    class _ConvRepo:
        async def get_folder_id(self, _conversation_id):
            return None  # 裸聊: not yet promoted → mint path

        async def set_folder(self, conversation_id, folder_id, *, user_id):
            filed["folder_id"] = folder_id

    result = await service.promote_bare_chat_to_folder(
        conv_repo=_ConvRepo(),
        folder_repo=_FolderRepo(),
        user_id="u1",
        conversation_id="c1",
        title="Panel Chat",
        local_container_root_id="root-x",  # conversation's stored locality intent
    )
    assert result.folder_id == "f-panel"
    assert filed["folder_id"] == "f-panel"  # conversation filed into the new folder
    assert result.local_binding is not None  # promoted local, not cloud
    assert result.local_binding.subpath == "Panel Chat"  # per-chat subpath minted


async def test_concurrent_promote_mints_one_folder():
    """Two first writes racing on the SAME 裸聊 mint exactly one folder (工作区对称化 D1a
    §并发提升) — the bug was each unsynchronized first write (two panel ops, or a panel op
    vs. the turn's deferred write) minting its own, splitting a chat's files across two
    workspaces.

    The per-conversation promotion lock serializes them and the loser re-reads
    ``folder_id`` under the lock, reusing the winner's folder. The ``sleep(0)`` inside
    ``create`` parks the winner mid-mint so the loser is forced to contend on the lock
    (without it cooperative scheduling would let the winner finish first, hiding the race).
    """
    state: dict = {"folder_id": None, "mints": 0}

    class _FolderRepo:
        async def list_by_user(self, _user_id):
            return []

        async def create(self, *, user_id, name, local_root_id, local_subpath):
            state["mints"] += 1
            minted = f"f{state['mints']}"
            await asyncio.sleep(0)  # yield mid-mint: expose the race to the other task
            return SimpleNamespace(
                id=minted,
                name=name,
                local_root_id=local_root_id,
                local_subpath=local_subpath,
            )

        async def get_by_id(self, folder_id, *, user_id):
            # The reuse branch loads the winner's folder to mirror its cloud/local shape.
            return SimpleNamespace(
                id=folder_id, name="Race", local_root_id=None, local_subpath=None
            )

    class _ConvRepo:
        async def get_folder_id(self, _conversation_id):
            return state["folder_id"]  # reflects the winner's committed set_folder

        async def set_folder(self, conversation_id, folder_id, *, user_id):
            state["folder_id"] = folder_id

    async def _promote():
        return await service.promote_bare_chat_to_folder(
            conv_repo=_ConvRepo(),
            folder_repo=_FolderRepo(),
            user_id="u1",
            conversation_id="c-race",
            title="Race",
            local_container_root_id=None,
        )

    a, b = await asyncio.gather(_promote(), _promote())

    assert state["mints"] == 1  # only the winner minted; the loser reused under the lock
    assert a.folder_id == b.folder_id == "f1"  # both address the one folder


async def test_promote_conversation_folder_serializes_across_paths():
    """The shared primitive serializes ALL promotion paths (工作区对称化 D1a §并发提升):
    a write's subpath-mint racing a "打开本地文件夹" bind's root-mint on the same 裸聊 yields
    ONE folder (the loser reuses it), so the three call sites can never each create their
    own. The ``sleep(0)`` parks the winner mid-mint to force the other onto the lock."""
    state: dict = {"folder_id": None, "mints": 0}

    class _FolderRepo:
        async def get_by_id(self, folder_id, *, user_id):
            return SimpleNamespace(
                id=folder_id, name="X", local_root_id="root-x", local_subpath=None
            )

    class _ConvRepo:
        async def get_folder_id(self, _cid):
            return state["folder_id"]

        async def set_folder(self, _cid, folder_id, *, user_id):
            state["folder_id"] = folder_id

    folder_repo, conv_repo = _FolderRepo(), _ConvRepo()

    async def _mint(label):
        state["mints"] += 1
        await asyncio.sleep(0)  # yield mid-mint: force the racer to contend on the lock
        return SimpleNamespace(
            id=f"f-{label}", name=label, local_root_id="root-x", local_subpath=None
        )

    async def _call(label):
        return await service.promote_conversation_folder(
            conv_repo=conv_repo,
            folder_repo=folder_repo,
            user_id="u1",
            conversation_id="c-x",
            mint=lambda: _mint(label),
        )

    (fa, ra), (fb, rb) = await asyncio.gather(_call("write"), _call("bind"))

    assert state["mints"] == 1  # only one path minted; the other reused
    assert fa.id == fb.id  # both address the same single folder
    assert [ra, rb].count(True) == 1  # exactly one is the reuse (the loser)


async def test_promote_conversation_folder_broadcasts_to_firehose(monkeypatch):
    """A real mint fans workspace_promoted to the user's firehose so OTHER live surfaces
    re-group (跨端实时同步); the reuse branch does NOT re-broadcast (the winner already did,
    and the loser's re-group rides that one). This is what makes a bind / panel / turn
    promotion reach the user's second device — not just the surface that drove it."""
    published: list = []

    class _Hub:
        async def publish(self, user_ids, event):
            published.append((tuple(user_ids), event))

    monkeypatch.setattr(promotion_mod, "default_chat_hub", lambda: _Hub())

    state: dict = {"folder_id": None}

    class _FolderRepo:
        async def get_by_id(self, folder_id, *, user_id):
            return SimpleNamespace(
                id=folder_id, name="X", local_root_id="root-x", local_subpath="sub"
            )

    class _ConvRepo:
        async def get_folder_id(self, _cid):
            return state["folder_id"]

        async def set_folder(self, _cid, folder_id, *, user_id):
            state["folder_id"] = folder_id

    async def _mint():
        return SimpleNamespace(id="f-new", name="X", local_root_id="root-x", local_subpath="sub")

    folder_repo, conv_repo = _FolderRepo(), _ConvRepo()

    async def _call():
        return await service.promote_conversation_folder(
            conv_repo=conv_repo,
            folder_repo=folder_repo,
            user_id="u1",
            conversation_id="c-bcast",
            mint=_mint,
        )

    # First call: 裸聊 not yet promoted → mints → broadcasts to the user's firehose.
    _, reused = await _call()
    assert reused is False
    assert len(published) == 1
    users, event = published[0]
    assert users == ("u1",)
    assert event["type"] == "workspace_promoted"
    assert event["conversation_id"] == "c-bcast"
    assert event["folder_id"] == "f-new"
    assert event["local_root_id"] == "root-x"
    assert event["local_subpath"] == "sub"

    # Second call: now promoted (the winner's set_folder is visible) → reuse, no re-broadcast.
    _, reused2 = await _call()
    assert reused2 is True
    assert len(published) == 1  # unchanged — reuse must not re-broadcast


async def test_concurrent_local_promote_dedupes_subpath_across_conversations():
    """Two DIFFERENT 裸聊 with the SAME title promoting at once under the SAME container
    root get DISTINCT subpaths (工作区对称化 D1a §并发提升), not one merged dir. The
    container-root lock serializes the dedup+create so the second read sees the first's
    folder — a per-conversation lock alone wouldn't (different conversations don't share
    one). The ``sleep(0)`` during the dedup read exposes the race."""
    created: list = []
    folder_ids: dict = {}

    class _FolderRepo:
        async def list_by_user(self, _user_id):
            await asyncio.sleep(0)  # yield during dedup read: expose the cross-chat race
            return list(created)

        async def create(self, *, user_id, name, local_root_id, local_subpath):
            folder = SimpleNamespace(
                id=f"f{len(created)}",
                name=name,
                local_root_id=local_root_id,
                local_subpath=local_subpath,
            )
            created.append(folder)
            return folder

    class _ConvRepo:
        async def get_folder_id(self, cid):
            return folder_ids.get(cid)

        async def set_folder(self, cid, folder_id, *, user_id):
            folder_ids[cid] = folder_id

    folder_repo, conv_repo = _FolderRepo(), _ConvRepo()

    async def _promote(cid):
        return await service.promote_bare_chat_to_folder(
            conv_repo=conv_repo,
            folder_repo=folder_repo,
            user_id="u1",
            conversation_id=cid,
            title="Same Title",
            local_container_root_id="root-shared",
        )

    a, b = await asyncio.gather(_promote("cX"), _promote("cY"))

    assert len(created) == 2  # two different conversations → two folders
    # Distinct subpaths → no two chats merged onto one on-disk directory.
    assert {a.local_binding.subpath, b.local_binding.subpath} == {"Same Title", "Same Title-2"}


# --- bind endpoint: 裸聊 promote-on-bind via the shared primitive --------------
# "打开本地文件夹" is the third promotion entry (alongside the turn's first write and
# the panel write); it mints through promote_conversation_folder so it serializes +
# is idempotent with them. These drive the endpoint directly (no DB) to cover the two
# bind-specific outcomes the generic primitive test can't reach.


async def test_bind_workspace_mints_root_bound_folder_for_bare_chat():
    """bind on a 裸聊 that wins the (uncontended) mint creates a folder bound to the
    requested root and files the conversation into it — no after-the-fact rebind."""
    from agentcore.api.routes.conversations.binding import bind_workspace
    from agentcore.api.schemas import BindLocalWorkspaceRequest

    state: dict = {}

    class _FolderRepo:
        async def create(self, *, user_id, name, local_root_id):
            state["created_root"] = local_root_id
            # Root-bound mint: no subpath (it IS the root) — model the real Folder's
            # nullable local_subpath so the promotion broadcast reads it (跨端实时同步).
            return SimpleNamespace(
                id="f-bind", name=name, local_root_id=local_root_id, local_subpath=None
            )

        async def set_local_root_id(self, *a, **k):  # win path never rebinds
            raise AssertionError("mint path must not rebind")

    class _ConvRepo:
        async def get_by_id(self, conversation_id, *, user_id):
            return SimpleNamespace(id=conversation_id, folder_id=None, title="Bind Me")

        async def get_folder_id(self, _cid):
            return None  # fresh 裸聊 → mint

        async def set_folder(self, cid, folder_id, *, user_id):
            state["filed"] = folder_id

    resp = await bind_workspace(
        conversation_id="c-bind",
        body=BindLocalWorkspaceRequest(root_id="root-z"),
        user=SimpleNamespace(user_id="u1"),
        conv_repo=_ConvRepo(),
        folder_repo=_FolderRepo(),
    )
    assert resp.mode == "local" and resp.root_id == "root-z"
    assert state["created_root"] == "root-z"  # minted bound to the requested root
    assert state["filed"] == "f-bind"  # conversation filed into the new folder


async def test_bind_workspace_reuse_race_applies_requested_root():
    """bind on a 裸聊 that LOST the mint race to a concurrent (cloud) promote still
    takes effect: the primitive returns reused=True with the winner's cloud folder, and
    bind applies the requested root to it (binding.py §并发提升) so "打开本地文件夹" isn't a
    silent no-op against the raced folder. set_folder must NOT run again on reuse."""
    from agentcore.api.routes.conversations.binding import bind_workspace
    from agentcore.api.schemas import BindLocalWorkspaceRequest

    applied: dict = {}

    class _FolderRepo:
        async def get_by_id(self, folder_id, *, user_id):
            # The race winner minted a *cloud* folder (no local root).
            return SimpleNamespace(
                id=folder_id, name="Raced", local_root_id=None, local_subpath=None
            )

        async def set_local_root_id(self, folder_id, root_id, *, user_id):
            applied["folder_id"], applied["root_id"] = folder_id, root_id
            return SimpleNamespace(id=folder_id, local_root_id=root_id)

    class _ConvRepo:
        async def get_by_id(self, conversation_id, *, user_id):
            return SimpleNamespace(id=conversation_id, folder_id=None, title="Raced")

        async def get_folder_id(self, _cid):
            return "f-winner"  # a concurrent promote already filed this chat

        async def set_folder(self, *a, **k):
            raise AssertionError("reuse path must not re-file the conversation")

    resp = await bind_workspace(
        conversation_id="c-race",
        body=BindLocalWorkspaceRequest(root_id="root-z"),
        user=SimpleNamespace(user_id="u1"),
        conv_repo=_ConvRepo(),
        folder_repo=_FolderRepo(),
    )
    assert resp.mode == "local" and resp.root_id == "root-z"
    assert applied == {"folder_id": "f-winner", "root_id": "root-z"}  # rebound to winner


# --- naming / subpath helpers (pure) ------------------------------------------


def test_default_name_prefers_title_then_message_then_fallback():
    assert default_workspace_name("My Title", fallback_text="msg") == "My Title"
    assert default_workspace_name(None, fallback_text="first message") == "first message"
    assert default_workspace_name("   ", fallback_text="  ") == "未命名工作区"
    assert default_workspace_name(None) == "未命名工作区"


def test_sanitize_subpath_segment_strips_illegal_and_caps():
    assert _sanitize_subpath_segment("Hello / World") == "Hello World"
    assert _sanitize_subpath_segment("a<b>c:d|e?f*g") == "abcdefg"
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
    sub = await _unique_local_subpath(repo, user_id="u1", container_root_id="root-x", name="Demo")
    assert sub == "Demo-3"


async def test_unique_subpath_ignores_other_containers():
    repo = _FakeRepo([_FakeFolder("root-y", "Demo")])
    sub = await _unique_local_subpath(repo, user_id="u1", container_root_id="root-x", name="Demo")
    assert sub == "Demo"  # a same-named folder under a *different* root doesn't clash
