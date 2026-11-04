"""Opt-in lab 定时通知：纯策略与出站签名（生成 / 最后修订 2026-11-04）。

默认关是这个功能最重要的契约；签名与 SSRF 是它有牙齿的部分。
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

from agentcore.config import settings
from agentcore.lab_schedule import (
    DueJob,
    build_body,
    decrypt_secret,
    encrypt_secret,
    fire_job,
    lab_scheduled_jobs_loop,
    next_run_at,
    sign_request,
    validate_schedule,
    webhook_headers,
)

_NOW = datetime(2026, 11, 4, 8, 0, tzinfo=UTC)
_SECRET = "s3cr3t-value"


def _valid(**overrides):
    base = {
        "interval_seconds": 60,
        "webhook_url": "https://hooks.example.com/notify",
        "secret": _SECRET,
    }
    base.update(overrides)
    return base


class TestValidateSchedule:
    def test_valid_input_passes(self):
        assert validate_schedule(**_valid()) is None

    def test_rejects_too_frequent_and_bad_scheme_and_short_secret(self):
        assert validate_schedule(**_valid(interval_seconds=30)) is not None
        assert validate_schedule(**_valid(webhook_url="ftp://x/y")) is not None
        assert validate_schedule(**_valid(webhook_url="not-a-url")) is not None
        assert validate_schedule(**_valid(secret="short")) is not None
        assert validate_schedule(**_valid(webhook_url="")) is not None

    def test_dns_level_ssrf_is_not_claimed_here(self):
        # 纯函数只判形状；DNS 级 SSRF 在创建处 / 触发处由 classify_url 判（async）。
        assert validate_schedule(**_valid(webhook_url="http://127.0.0.1:9/x")) is None


class TestNextRun:
    def test_no_catchup_storm(self):
        assert next_run_at(_NOW, 60) == _NOW + timedelta(seconds=60)


class TestSigning:
    def test_signature_is_reproducible_and_bound_to_secret_and_body(self):
        body = build_body("j1", "每小时提醒", {"tag": "日常"}, _NOW)
        assert json.loads(body)["payload"] == {"tag": "日常"}
        ts = 1793779200
        expected = hmac.new(
            _SECRET.encode(), f"{ts}.j1.".encode() + body, hashlib.sha256
        ).hexdigest()
        assert sign_request(_SECRET, "j1", ts, body) == expected
        assert sign_request("other", "j1", ts, body) != expected
        assert sign_request(_SECRET, "j1", ts + 1, body) != expected

    def test_headers_carry_everything_a_receiver_needs(self):
        body = b'{"ok":true}'
        headers = webhook_headers(_SECRET, "j1", 1793779200, body)
        assert headers["X-Nexus-Lab-Job-Id"] == "j1"
        assert headers["X-Nexus-Lab-Timestamp"] == "1793779200"
        assert headers["X-Nexus-Lab-Signature"].startswith("sha256=")


class TestSecretAtRest:
    def test_encrypt_decrypt_roundtrip_and_no_plaintext(self):
        blob = encrypt_secret(_SECRET)
        assert _SECRET.encode() not in blob
        assert decrypt_secret(blob) == _SECRET
        assert decrypt_secret(b"garbage") is None


class _Resp:
    status_code = 200


class _Client:
    def __init__(self) -> None:
        self.calls: list[tuple[str, bytes, dict[str, str]]] = []

    async def post(self, url: str, *, content: bytes, headers: dict[str, str]):
        self.calls.append((url, content, headers))
        return _Resp()


def _job(secret_enc: bytes | None = None) -> DueJob:
    return DueJob(
        id="j1",
        name="每小时提醒",
        webhook_url="https://hooks.example.com/notify",
        secret_enc=secret_enc if secret_enc is not None else encrypt_secret(_SECRET),
        payload_json='{"tag":"日常"}',
        interval_seconds=60,
    )


class TestFireJob:
    async def test_sends_a_verifiable_signature(self, monkeypatch):
        from agentcore import lab_schedule as mod

        async def safe(url: str):
            return None

        monkeypatch.setattr(mod, "classify_url", safe)
        client = _Client()
        assert await fire_job(_job(), client=client) == "ok"
        url, body, headers = client.calls[0]
        assert url == "https://hooks.example.com/notify"
        ts = int(headers["X-Nexus-Lab-Timestamp"])
        expected = f"sha256={sign_request(_SECRET, 'j1', ts, body)}"
        assert headers["X-Nexus-Lab-Signature"] == expected

    async def test_rebinding_is_blocked_before_any_request(self, monkeypatch):
        from agentcore import lab_schedule as mod

        async def blocked(url: str):
            return SimpleNamespace(name="LOOPBACK_HOST")

        monkeypatch.setattr(mod, "classify_url", blocked)
        client = _Client()
        assert await fire_job(_job(), client=client) == "blocked"
        assert client.calls == []

    async def test_bad_ciphertext_degrades_to_failed(self, monkeypatch):
        from agentcore import lab_schedule as mod

        async def safe(url: str):
            return None

        monkeypatch.setattr(mod, "classify_url", safe)
        client = _Client()
        assert await fire_job(_job(secret_enc=b"garbage"), client=client) == "failed"
        assert client.calls == []


class TestLoopGate:
    async def test_loop_returns_immediately_when_disabled(self, monkeypatch):
        monkeypatch.setattr(settings, "lab_scheduled_jobs_enabled", False)
        # 若没守住门会进入无限 while，wait_for 会把它掐掉并让测试红。
        await asyncio.wait_for(lab_scheduled_jobs_loop(), timeout=0.5)
