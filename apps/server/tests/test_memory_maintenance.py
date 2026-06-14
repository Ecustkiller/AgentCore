"""Tests for the long-term memory store + per-turn maintenance closed loop."""

from collections.abc import Sequence

from agentcore.memory.maintenance import maintain_user_memory
from agentcore.memory.store import FileMemoryStore
from agentcore.memory.user_memory import (
    MemoryAction,
    MemoryExtractInput,
    MemoryOp,
)

# --- FileMemoryStore (real disk via tmp_path) ---


async def test_store_load_missing_returns_empty(tmp_path):
    store = FileMemoryStore(tmp_path)
    assert await store.load("u1") == ""


async def test_store_save_then_load_round_trip(tmp_path):
    store = FileMemoryStore(tmp_path)
    await store.save("u1", "## 沟通偏好\n- 用中文\n")
    assert await store.load("u1") == "## 沟通偏好\n- 用中文\n"


async def test_store_is_per_user(tmp_path):
    store = FileMemoryStore(tmp_path)
    await store.save("alice", "alice memory")
    await store.save("bob", "bob memory")
    assert await store.load("alice") == "alice memory"
    assert await store.load("bob") == "bob memory"


async def test_store_neutralizes_path_separators(tmp_path):
    store = FileMemoryStore(tmp_path)
    await store.save("../../etc/passwd", "x")
    # Stays inside the base dir (no traversal); round-trips by the same key.
    assert await store.load("../../etc/passwd") == "x"
    children = [p for p in tmp_path.rglob("*") if p.is_file()]
    assert len(children) == 1
    assert children[0].parent == tmp_path


# --- maintain_user_memory (extractor + applier + store) ---


class _FakeExtractor:
    """Returns canned ops and records the inputs it saw."""

    def __init__(self, ops: list[MemoryOp]) -> None:
        self._ops = ops
        self.inputs: list[MemoryExtractInput] = []

    async def extract(self, data: MemoryExtractInput) -> list[MemoryOp]:
        self.inputs.append(data)
        return list(self._ops)


class _RaisingExtractor:
    async def extract(self, data: MemoryExtractInput) -> list[MemoryOp]:
        raise RuntimeError("llm down")


def _turn() -> Sequence[dict]:
    return [{"role": "user", "content": "我以后都用 pnpm"}]


async def test_maintain_writes_when_ops_present(tmp_path):
    store = FileMemoryStore(tmp_path)
    extractor = _FakeExtractor(
        [MemoryOp(action=MemoryAction.ADD, section="技术栈与工具", content="偏好 pnpm")]
    )
    changed = await maintain_user_memory(
        user_id="u1", messages=_turn(), extractor=extractor, store=store
    )
    assert changed is True
    saved = await store.load("u1")
    assert "## 技术栈与工具" in saved
    assert "- 偏好 pnpm" in saved


async def test_maintain_passes_current_memory_to_extractor(tmp_path):
    store = FileMemoryStore(tmp_path)
    await store.save("u1", "## 沟通偏好\n- 已有偏好\n")
    extractor = _FakeExtractor([])
    await maintain_user_memory(user_id="u1", messages=_turn(), extractor=extractor, store=store)
    assert "已有偏好" in extractor.inputs[0].current_memory


async def test_maintain_skips_write_when_no_ops(tmp_path):
    store = FileMemoryStore(tmp_path)
    await store.save("u1", "original")
    changed = await maintain_user_memory(
        user_id="u1", messages=_turn(), extractor=_FakeExtractor([]), store=store
    )
    assert changed is False
    assert await store.load("u1") == "original"


async def test_maintain_is_idempotent_for_duplicate_op(tmp_path):
    store = FileMemoryStore(tmp_path)
    op = MemoryOp(action=MemoryAction.ADD, section="技术栈与工具", content="偏好 pnpm")
    # First turn writes the bullet (and canonicalizes the file).
    assert await maintain_user_memory(
        user_id="u1", messages=_turn(), extractor=_FakeExtractor([op]), store=store
    )
    before = await store.load("u1")
    # Second turn re-extracts the same bullet: the applier dedups it, so the
    # canonical content is unchanged and the write is skipped.
    changed = await maintain_user_memory(
        user_id="u1", messages=_turn(), extractor=_FakeExtractor([op]), store=store
    )
    assert changed is False
    assert await store.load("u1") == before


async def test_maintain_empty_messages_returns_false(tmp_path):
    store = FileMemoryStore(tmp_path)
    extractor = _FakeExtractor([MemoryOp(action=MemoryAction.ADD, section="沟通偏好", content="x")])
    changed = await maintain_user_memory(
        user_id="u1", messages=[], extractor=extractor, store=store
    )
    assert changed is False
    assert extractor.inputs == []  # extractor not even called


async def test_maintain_swallows_extractor_failure(tmp_path):
    store = FileMemoryStore(tmp_path)
    await store.save("u1", "original")
    changed = await maintain_user_memory(
        user_id="u1", messages=_turn(), extractor=_RaisingExtractor(), store=store
    )
    assert changed is False
    assert await store.load("u1") == "original"
