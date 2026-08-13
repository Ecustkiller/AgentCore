"""Offline unit tests for the FCM v1 push transport (``agentcore.push.sender``).

Nothing here reaches Google. The OAuth2 token endpoint and FCM v1 are both served
in-process by an ``httpx.MockTransport`` stub, and the「service account」is a throwaway
RSA keypair minted for the test session — so the suite proves the wire contract without
a credential, a network, or a Firebase project.

What is covered is what a 真机 bring-up leans on: the assertion Google must accept, the
bearer cache (including the skew margin and the single-flight refresh), the stale-token
pruning contract, the success line that separates「发了但没到」from「压根没发」, and
every degraded branch of ``build_push_sender`` that quietly turns push into a no-op.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from functools import lru_cache
from pathlib import Path
from typing import Any

import httpx
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from jose import jwt

from agentcore.config import settings
from agentcore.push import sender as sender_mod
from agentcore.push.sender import (
    FcmPushSender,
    NullPushSender,
    PushNotification,
    PushResult,
    build_push_sender,
    device_fingerprint,
)
from tests.conftest import LogSpy

_TOKEN_URI = "https://oauth2.test/token"
_JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer"
_FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging"
_PROJECT = "agentcore-test"
_CLIENT_EMAIL = "push@agentcore-test.iam.gserviceaccount.com"

_NOTIFICATION = PushNotification(
    title="AI 需要你的授权",
    body="需要授权：file_write",
    data={"conversation_id": "conv-1", "message_id": "turn-1"},
)


@lru_cache(maxsize=1)
def _keypair() -> tuple[str, str]:
    """A throwaway RS256 keypair (PEM private, PEM public), generated once per session.

    Signing for real — rather than stubbing ``jose`` — is what makes the assertion test
    meaningful: it verifies with the public half, so a claim set Google would reject
    cannot pass here either.
    """
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private_pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()
    public_pem = (
        key.public_key()
        .public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        .decode()
    )
    return private_pem, public_pem


class _FcmStub:
    """Google OAuth2 + FCM v1, answered entirely in-process.

    A test states only what the provider replies (``send_for`` / ``token_status``) and
    reads back what we asked it (``token_forms`` / ``messages`` / ``bearers`` /
    ``send_urls``); how httpx is driven stays an implementation detail.
    """

    def __init__(
        self,
        *,
        send_for: Callable[[str], httpx.Response] | None = None,
        token_status: int = 200,
        expires_in: int = 3600,
        access_token: str = "ya29.stub",
    ) -> None:
        self.token_forms: list[dict[str, str]] = []
        self.messages: list[dict[str, Any]] = []
        self.bearers: list[str] = []
        self.send_urls: list[str] = []
        self._send_for = send_for or _accepted
        self._token_status = token_status
        self._expires_in = expires_in
        self._access_token = access_token

    def install(self, monkeypatch: pytest.MonkeyPatch) -> _FcmStub:
        def _factory(**kwargs: Any) -> httpx.AsyncClient:
            kwargs.pop("trust_env", None)
            return httpx.AsyncClient(transport=httpx.MockTransport(self._handle), **kwargs)

        monkeypatch.setattr(sender_mod, "outbound_async_client", _factory)
        return self

    def _handle(self, request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("messages:send"):
            self.send_urls.append(str(request.url))
            self.bearers.append(request.headers.get("Authorization", ""))
            message = json.loads(request.content)["message"]
            self.messages.append(message)
            return self._send_for(message["token"])
        form = httpx.QueryParams(request.content.decode())
        self.token_forms.append(dict(form))
        if self._token_status != 200:
            return httpx.Response(self._token_status, json={"error": "invalid_grant"})
        return httpx.Response(
            200,
            json={"access_token": self._access_token, "expires_in": self._expires_in},
        )


_MESSAGE_ID = "0:1699000000000000%1a2b3c4d"


def _accepted(_token: str) -> httpx.Response:
    """FCM's happy answer: the message name whose tail is the console-visible id.

    Deliberately not derived from the device token — a stub that echoed it would defeat
    the assertion that no log line ever carries the token.
    """
    return httpx.Response(200, json={"name": f"projects/{_PROJECT}/messages/{_MESSAGE_ID}"})


def _sender(**over: str) -> FcmPushSender:
    private_pem, _ = _keypair()
    kwargs: dict[str, str] = {
        "project_id": _PROJECT,
        "client_email": _CLIENT_EMAIL,
        "private_key": private_pem,
        "token_uri": _TOKEN_URI,
    }
    kwargs.update(over)
    return FcmPushSender(**kwargs)  # type: ignore[arg-type]


def _spy(monkeypatch: pytest.MonkeyPatch) -> LogSpy:
    spy = LogSpy()
    monkeypatch.setattr(sender_mod, "logger", spy)
    return spy


def _logged(spy: LogSpy, event: str) -> list[dict]:
    return [fields for name, fields in spy.events if name == event]


def _service_account_file(tmp_path: Path, **over: object) -> str:
    private_pem, _ = _keypair()
    data: dict[str, object] = {
        "project_id": _PROJECT,
        "client_email": _CLIENT_EMAIL,
        "private_key": private_pem,
        "token_uri": _TOKEN_URI,
    }
    data.update(over)
    path = tmp_path / "service-account.json"
    path.write_text(json.dumps(data), encoding="utf-8")
    return str(path)


def _enable_push(monkeypatch: pytest.MonkeyPatch, *, path: str, project_id: str = "") -> None:
    monkeypatch.setattr(settings, "push_enabled", True)
    monkeypatch.setattr(settings, "fcm_service_account_path", path)
    monkeypatch.setattr(settings, "fcm_project_id", project_id)


@pytest.fixture(autouse=True)
def _reset_sender_cache():
    """``build_push_sender`` is ``lru_cache``d process-wide — without this, one test's
    settings would keep serving the sender every later test (and every later module) gets.
    """
    build_push_sender.cache_clear()
    yield
    build_push_sender.cache_clear()


# --- the assertion Google has to accept --------------------------------------


async def test_bearer_is_a_signed_rs256_service_account_assertion(monkeypatch):
    stub = _FcmStub().install(monkeypatch)

    result = await _sender().send(["dev-a"], _NOTIFICATION)

    assert result.accepted == 1
    (form,) = stub.token_forms
    assert form["grant_type"] == _JWT_BEARER_GRANT
    _, public_pem = _keypair()
    assert jwt.get_unverified_header(form["assertion"])["alg"] == "RS256"
    claims = jwt.decode(form["assertion"], public_pem, algorithms=["RS256"], audience=_TOKEN_URI)
    assert claims["iss"] == _CLIENT_EMAIL
    assert claims["scope"] == _FCM_SCOPE
    assert claims["aud"] == _TOKEN_URI
    assert claims["exp"] - claims["iat"] == 3600


async def test_the_minted_bearer_authorizes_every_send(monkeypatch):
    stub = _FcmStub(access_token="ya29.minted").install(monkeypatch)

    await _sender().send(["dev-a", "dev-b"], _NOTIFICATION)

    assert stub.bearers == ["Bearer ya29.minted", "Bearer ya29.minted"]


async def test_each_token_gets_its_own_v1_message(monkeypatch):
    stub = _FcmStub().install(monkeypatch)

    await _sender().send(["dev-a", "dev-b"], _NOTIFICATION)

    assert stub.send_urls == [
        f"https://fcm.googleapis.com/v1/projects/{_PROJECT}/messages:send"
    ] * 2
    assert [m["token"] for m in stub.messages] == ["dev-a", "dev-b"]
    assert stub.messages[0]["notification"] == {
        "title": _NOTIFICATION.title,
        "body": _NOTIFICATION.body,
    }
    assert stub.messages[0]["data"] == _NOTIFICATION.data


async def test_data_is_omitted_when_the_notification_carries_none(monkeypatch):
    stub = _FcmStub().install(monkeypatch)

    await _sender().send(["dev-a"], PushNotification(title="t", body="b"))

    assert "data" not in stub.messages[0]


# --- bearer cache ------------------------------------------------------------


async def test_the_bearer_is_minted_once_and_reused(monkeypatch):
    stub = _FcmStub().install(monkeypatch)
    push = _sender()

    await push.send(["dev-a"], _NOTIFICATION)
    await push.send(["dev-b"], _NOTIFICATION)

    assert len(stub.token_forms) == 1
    assert len(stub.messages) == 2


async def test_a_bearer_inside_the_skew_margin_is_reminted(monkeypatch):
    """An ``expires_in`` under the 60s margin is never reused — an in-flight send must
    not carry a token that expires while it is on the wire."""
    stub = _FcmStub(expires_in=30).install(monkeypatch)
    push = _sender()

    await push.send(["dev-a"], _NOTIFICATION)
    await push.send(["dev-a"], _NOTIFICATION)

    assert len(stub.token_forms) == 2


async def test_concurrent_sends_share_a_single_refresh(monkeypatch):
    """A burst of pushes does one token exchange, not N (the ``_token_lock`` contract)."""
    stub = _FcmStub().install(monkeypatch)
    push = _sender()

    await asyncio.gather(
        push.send(["dev-a"], _NOTIFICATION),
        push.send(["dev-b"], _NOTIFICATION),
    )

    assert len(stub.token_forms) == 1
    assert len(stub.messages) == 2


async def test_a_refused_token_exchange_sends_nothing_and_counts_the_misses(monkeypatch):
    stub = _FcmStub(token_status=400).install(monkeypatch)
    spy = _spy(monkeypatch)

    result = await _sender().send(["dev-a", "dev-b"], _NOTIFICATION)

    assert stub.messages == []
    assert result == PushResult(accepted=0, stale=(), failed=2)
    assert spy.get("push.fcm_token_failed")["status"] == 400
    assert _logged(spy, "push.fcm_token_minted") == []


async def test_an_unusable_private_key_degrades_to_no_push(monkeypatch):
    stub = _FcmStub().install(monkeypatch)
    spy = _spy(monkeypatch)

    result = await _sender(private_key="-----BEGIN PRIVATE KEY-----\nnope\n").send(
        ["dev-a"], _NOTIFICATION
    )

    assert (stub.token_forms, stub.messages) == ([], [])
    assert result == PushResult(accepted=0, stale=(), failed=1)
    assert spy.get("push.fcm_token_error")["error"]


async def test_a_successful_mint_is_visible_with_its_lifetime(monkeypatch):
    _FcmStub(expires_in=3599).install(monkeypatch)
    spy = _spy(monkeypatch)

    await _sender().send(["dev-a"], _NOTIFICATION)

    minted = spy.get("push.fcm_token_minted")
    assert minted == {"project_id": _PROJECT, "expires_in": 3599}


# --- delivery, pruning, and what the log says about both ---------------------


async def test_an_accepted_send_is_visible_with_its_fcm_message_id(monkeypatch):
    """The success line is the point of the whole exercise: without it,「发了但没到」and
    「压根没发」are the same silence in the log."""
    _FcmStub().install(monkeypatch)
    spy = _spy(monkeypatch)

    await _sender().send(["dev-a"], _NOTIFICATION)

    sent = spy.get("push.fcm_sent")
    assert sent == {"device": device_fingerprint("dev-a"), "message_id": _MESSAGE_ID}
    assert "dev-a" not in str(spy.events)  # the device token itself never enters a log


async def test_an_unparseable_success_body_still_counts_as_delivered(monkeypatch):
    _FcmStub(send_for=lambda _t: httpx.Response(200, text="not json")).install(monkeypatch)
    spy = _spy(monkeypatch)

    result = await _sender().send(["dev-a"], _NOTIFICATION)

    assert result.accepted == 1
    assert spy.get("push.fcm_sent")["message_id"] == ""


async def test_404_and_unregistered_are_pruned_while_transient_failures_are_kept(monkeypatch):
    def _send_for(token: str) -> httpx.Response:
        if token == "dev-uninstalled":
            return httpx.Response(404, json={"error": {"status": "NOT_FOUND"}})
        if token == "dev-rotated":
            return httpx.Response(400, json={"error": {"details": [{"errorCode": "UNREGISTERED"}]}})
        if token == "dev-throttled":
            return httpx.Response(429, text="quota exceeded")
        return _accepted(token)

    _FcmStub(send_for=_send_for).install(monkeypatch)
    spy = _spy(monkeypatch)

    result = await _sender().send(
        ["dev-live", "dev-uninstalled", "dev-rotated", "dev-throttled"], _NOTIFICATION
    )

    # Only the two the provider called unregistered are pruned; a 429 is transient, so
    # that device keeps its token for the next attempt.
    assert result == PushResult(accepted=1, stale=("dev-uninstalled", "dev-rotated"), failed=1)
    assert [f["device"] for f in _logged(spy, "push.fcm_token_stale")] == [
        device_fingerprint("dev-uninstalled"),
        device_fingerprint("dev-rotated"),
    ]
    assert spy.get("push.fcm_send_failed")["status"] == 429


async def test_a_dead_socket_on_one_device_never_aborts_the_fan_out(monkeypatch):
    def _send_for(token: str) -> httpx.Response:
        if token == "dev-broken":
            raise httpx.ConnectError("connection reset")
        return _accepted(token)

    _FcmStub(send_for=_send_for).install(monkeypatch)
    spy = _spy(monkeypatch)

    result = await _sender().send(["dev-broken", "dev-live"], _NOTIFICATION)

    assert result == PushResult(accepted=1, stale=(), failed=1)
    assert spy.get("push.fcm_send_error")["device"] == device_fingerprint("dev-broken")


async def test_no_tokens_costs_no_credential_exchange(monkeypatch):
    stub = _FcmStub().install(monkeypatch)

    assert await _sender().send([], _NOTIFICATION) == PushResult()
    assert stub.token_forms == []


async def test_the_null_sender_delivers_nothing_and_prunes_nothing():
    assert await NullPushSender().send(["dev-a"], _NOTIFICATION) == PushResult()


def test_the_same_device_always_gets_the_same_fingerprint():
    assert device_fingerprint("dev-a") == device_fingerprint("dev-a")
    assert device_fingerprint("dev-a") != device_fingerprint("dev-b")
    assert "dev-a" not in device_fingerprint("dev-a")


# --- build_push_sender: every way push ends up a no-op -----------------------


def test_push_off_is_a_null_sender_without_touching_credentials(monkeypatch):
    monkeypatch.setattr(settings, "push_enabled", False)
    monkeypatch.setattr(settings, "fcm_service_account_path", "/nonexistent/sa.json")

    assert isinstance(build_push_sender(), NullPushSender)


def test_enabled_without_a_credential_path_degrades_and_says_so(monkeypatch):
    spy = _spy(monkeypatch)
    _enable_push(monkeypatch, path="")

    assert isinstance(build_push_sender(), NullPushSender)
    assert spy.get("push.fcm_unconfigured") == {}


def test_a_missing_credential_file_degrades_instead_of_crashing_boot(monkeypatch, tmp_path):
    spy = _spy(monkeypatch)
    _enable_push(monkeypatch, path=str(tmp_path / "absent.json"))

    assert isinstance(build_push_sender(), NullPushSender)
    assert spy.get("push.fcm_init_failed")["error"]


def test_malformed_credential_json_degrades(monkeypatch, tmp_path):
    path = tmp_path / "broken.json"
    path.write_text("{ not json", encoding="utf-8")
    spy = _spy(monkeypatch)
    _enable_push(monkeypatch, path=str(path))

    assert isinstance(build_push_sender(), NullPushSender)
    assert spy.get("push.fcm_init_failed")["error"]


def test_credential_json_missing_a_required_field_degrades(monkeypatch, tmp_path):
    path = tmp_path / "partial.json"
    path.write_text(json.dumps({"project_id": _PROJECT, "private_key": "k"}), encoding="utf-8")
    spy = _spy(monkeypatch)
    _enable_push(monkeypatch, path=str(path))

    assert isinstance(build_push_sender(), NullPushSender)
    assert "client_email" in spy.get("push.fcm_init_failed")["error"]


def test_a_good_credential_file_builds_a_configured_fcm_sender(monkeypatch, tmp_path):
    spy = _spy(monkeypatch)
    _enable_push(monkeypatch, path=_service_account_file(tmp_path))

    assert isinstance(build_push_sender(), FcmPushSender)
    assert spy.get("push.fcm_configured") == {"project_id": _PROJECT}


async def test_settings_project_id_wins_over_the_credential_file(monkeypatch, tmp_path):
    """The project a push is addressed to is the one thing a 真机 must agree with, so the
    override has to reach the send URL — not just the log line."""
    stub = _FcmStub().install(monkeypatch)
    spy = _spy(monkeypatch)
    _enable_push(monkeypatch, path=_service_account_file(tmp_path), project_id="override-proj")

    await build_push_sender().send(["dev-a"], _NOTIFICATION)

    assert spy.get("push.fcm_configured") == {"project_id": "override-proj"}
    assert stub.send_urls == [
        "https://fcm.googleapis.com/v1/projects/override-proj/messages:send"
    ]


def test_the_sender_is_built_once_per_process(monkeypatch, tmp_path):
    _enable_push(monkeypatch, path=_service_account_file(tmp_path))

    assert build_push_sender() is build_push_sender()
