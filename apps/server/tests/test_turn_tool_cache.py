"""Turn-scoped cache key and fingerprint invariants."""

import asyncio

from agentcore.tools.protocol import TurnToolCache


def test_generic_tool_cache_keys_do_not_collide_on_backslash_normalization():
    cache = TurnToolCache()
    backend = object()
    cache.put_tool_result(
        backend=backend,
        kind="grep",
        key=r"pattern:a\\b",
        value="backslash",
    )
    cache.put_tool_result(
        backend=backend,
        kind="grep",
        key="pattern:a/b",
        value="slash",
    )

    assert (
        cache.get_tool_result(
            backend=backend,
            kind="grep",
            key=r"pattern:a\\b",
        )
        == "backslash"
    )
    assert (
        cache.get_tool_result(
            backend=backend,
            kind="grep",
            key="pattern:a/b",
        )
        == "slash"
    )


def test_cached_value_with_fingerprint_misses_when_fingerprint_changes():
    cache = TurnToolCache()
    backend = object()
    cache.put(
        backend=backend,
        path="file.py",
        offset=1,
        limit=10,
        start_page=1,
        value="old",
        fingerprint=(100, 10),
    )

    assert (
        cache.get(
            backend=backend,
            path="file.py",
            offset=1,
            limit=10,
            start_page=1,
            fingerprint=(100, 10),
        )
        == "old"
    )
    assert (
        cache.get(
            backend=backend,
            path="file.py",
            offset=1,
            limit=10,
            start_page=1,
            fingerprint=(101, 10),
        )
        is None
    )


async def test_clear_drops_inflight_handles_for_new_callers():
    cache = TurnToolCache()
    backend = object()
    first, first_leader = cache.begin_inflight(
        backend=backend,
        kind="read_only",
        key="grep:TODO",
    )
    assert first_leader is True

    cache.clear()
    second, second_leader = cache.begin_inflight(
        backend=backend,
        kind="read_only",
        key="grep:TODO",
    )
    assert second_leader is True
    assert second is not first

    first.cancel()
    second.cancel()
    await asyncio.gather(first, second, return_exceptions=True)
