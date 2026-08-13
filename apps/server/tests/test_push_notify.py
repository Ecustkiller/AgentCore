"""Offline unit tests for the user-level push fan-out (``agentcore.push.notify``).

The device table and the transport are both stubbed here, so what is under test is the
orchestration itself: which zero a zero-delivery push actually was, that stale tokens get
pruned, that a DB failure stays inside the function — and that the count it answers is
the provider's receipt rather than「我调用过 notify_user」.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

import pytest

from agentcore.push import notify as notify_mod
from agentcore.push.notify import notify_user
from agentcore.push.sender import NullPushSender, PushNotification, PushResult
from tests.conftest import LogSpy

_NOTIFICATION = PushNotification(title="AI 需要你的回应", body="AI 已停下来等你处理。")


class _FakeSession:
    async def __aenter__(self) -> _FakeSession:
        return self

    async def __aexit__(self, *_exc: object) -> bool:
        return False


class _FakeDeviceRepo:
    """The two device-table calls ``notify_user`` makes, recorded instead of executed."""

    def __init__(self, tokens: Sequence[str], *, read_error: Exception | None = None) -> None:
        self._tokens = list(tokens)
        self._read_error = read_error
        self.read_for: list[str] = []
        self.pruned: list[list[str]] = []

    async def tokens_for_user(self, user_id: str) -> list[str]:
        self.read_for.append(user_id)
        if self._read_error is not None:
            raise self._read_error
        return list(self._tokens)

    async def delete_tokens(self, tokens: Sequence[str]) -> None:
        self.pruned.append(list(tokens))


class _RecordingSender:
    """A configured (non-null) sender that answers a canned :class:`PushResult`."""

    def __init__(self, result: PushResult) -> None:
        self._result = result
        self.calls: list[tuple[list[str], PushNotification]] = []

    async def send(
        self, tokens: Sequence[str], notification: PushNotification
    ) -> PushResult:
        self.calls.append((list(tokens), notification))
        return self._result


def _install(
    monkeypatch: pytest.MonkeyPatch,
    *,
    sender: Any,
    repo: _FakeDeviceRepo | None = None,
) -> LogSpy:
    monkeypatch.setattr(notify_mod, "build_push_sender", lambda: sender)
    if repo is None:

        def _forbidden() -> _FakeSession:
            raise AssertionError("a short-circuited push must not open a DB session")

        monkeypatch.setattr(notify_mod, "async_session_factory", _forbidden)
    else:
        monkeypatch.setattr(notify_mod, "async_session_factory", _FakeSession)
        monkeypatch.setattr(notify_mod, "PushDeviceRepository", lambda _db: repo)
    spy = LogSpy()
    monkeypatch.setattr(notify_mod, "logger", spy)
    return spy


async def test_unconfigured_push_is_a_named_skip_and_never_touches_the_db(monkeypatch):
    """Today's production default. The old silent ``return`` is exactly what made
    ``pushed=true`` believable upstream — the skip has to leave a line behind."""
    spy = _install(monkeypatch, sender=NullPushSender())

    assert await notify_user("u1", _NOTIFICATION) == 0
    assert spy.get("push.skipped") == {"user_id": "u1", "reason": "unconfigured"}


async def test_a_user_with_no_registered_device_is_a_named_skip_too(monkeypatch):
    sender = _RecordingSender(PushResult(accepted=1))
    repo = _FakeDeviceRepo([])
    spy = _install(monkeypatch, sender=sender, repo=repo)

    assert await notify_user("u1", _NOTIFICATION) == 0
    assert repo.read_for == ["u1"]
    assert sender.calls == []
    assert spy.get("push.skipped") == {"user_id": "u1", "reason": "no_devices"}


async def test_delivered_devices_are_counted_and_logged(monkeypatch):
    sender = _RecordingSender(PushResult(accepted=2))
    repo = _FakeDeviceRepo(["tok-a", "tok-b"])
    spy = _install(monkeypatch, sender=sender, repo=repo)

    assert await notify_user("u1", _NOTIFICATION) == 2
    assert sender.calls == [(["tok-a", "tok-b"], _NOTIFICATION)]
    assert repo.pruned == []
    assert spy.get("push.notified") == {
        "user_id": "u1",
        "devices": 2,
        "accepted": 2,
        "pruned": 0,
        "failed": 0,
    }


async def test_stale_tokens_are_pruned_and_the_prune_is_reported(monkeypatch):
    sender = _RecordingSender(PushResult(accepted=1, stale=("tok-dead",)))
    repo = _FakeDeviceRepo(["tok-live", "tok-dead"])
    spy = _install(monkeypatch, sender=sender, repo=repo)

    assert await notify_user("u1", _NOTIFICATION) == 1
    assert repo.pruned == [["tok-dead"]]
    assert spy.get("push.notified")["pruned"] == 1


async def test_a_configured_sender_that_delivers_nothing_answers_zero(monkeypatch):
    """The「发不出去」case: credentials in place, devices registered, nothing accepted.
    It must not be reportable as a push that happened."""
    sender = _RecordingSender(PushResult(failed=2))
    repo = _FakeDeviceRepo(["tok-a", "tok-b"])
    spy = _install(monkeypatch, sender=sender, repo=repo)

    assert await notify_user("u1", _NOTIFICATION) == 0
    assert spy.get("push.notified") == {
        "user_id": "u1",
        "devices": 2,
        "accepted": 0,
        "pruned": 0,
        "failed": 2,
    }


async def test_a_db_failure_never_reaches_the_turn_that_triggered_it(monkeypatch):
    repo = _FakeDeviceRepo([], read_error=RuntimeError("pool exhausted"))
    spy = _install(monkeypatch, sender=_RecordingSender(PushResult()), repo=repo)

    assert await notify_user("u1", _NOTIFICATION) == 0
    assert spy.get("push.notify_failed") == {"user_id": "u1", "error": "pool exhausted"}


async def test_a_failing_prune_is_swallowed_rather_than_raised(monkeypatch):
    sender = _RecordingSender(PushResult(accepted=1, stale=("tok-dead",)))
    repo = _FakeDeviceRepo(["tok-live", "tok-dead"])
    spy = _install(monkeypatch, sender=sender, repo=repo)

    async def _boom(_tokens: Sequence[str]) -> None:
        raise RuntimeError("delete failed")

    monkeypatch.setattr(repo, "delete_tokens", _boom)

    assert await notify_user("u1", _NOTIFICATION) == 0
    assert spy.get("push.notify_failed")["error"] == "delete failed"
