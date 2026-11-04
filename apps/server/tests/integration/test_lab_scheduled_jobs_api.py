"""Opt-in lab 定时通知 HTTP 面（生成 / 最后修订 2026-11-04）。

最重要的一条：默认关时整个端点面 404、不写任何行。开启后才验 CRUD、
owner-scope、SSRF 与手动触发的真实签名。
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace

import pytest

from agentcore import lab_schedule as runner
from agentcore.api.routes import lab_scheduled_jobs as routes
from agentcore.config import settings
from agentcore.lab_schedule import sign_request
from tests.integration.conftest import register_and_login

_SECRET = "s3cr3t-value"
_URL = "https://hooks.example.com/notify"


def _payload(**overrides):
    base = {
        "name": "每小时提醒",
        "interval_seconds": 60,
        "webhook_url": _URL,
        "secret": _SECRET,
        "payload": {"tag": "日常"},
    }
    base.update(overrides)
    return base


@pytest.fixture
def enabled(monkeypatch):
    """打开实验开关；把 DNS 级 SSRF 判定换成不触网的桩。"""
    monkeypatch.setattr(settings, "lab_scheduled_jobs_enabled", True)

    async def safe(url: str):
        return None

    monkeypatch.setattr(routes, "classify_url", safe)
    monkeypatch.setattr(runner, "classify_url", safe)
    return safe


async def test_default_off_is_404_for_the_whole_surface(client):
    await register_and_login(client, f"lab-off-{uuid.uuid4().hex[:8]}")
    assert (await client.get("/v1/lab/scheduled-jobs")).status_code == 404
    assert (
        await client.post("/v1/lab/scheduled-jobs", json=_payload())
    ).status_code == 404
    assert (
        await client.post("/v1/lab/scheduled-jobs/whatever/fire")
    ).status_code == 404
    assert (
        await client.delete("/v1/lab/scheduled-jobs/whatever")
    ).status_code == 404


async def test_crud_never_echoes_the_secret(client, enabled):
    await register_and_login(client, f"lab-crud-{uuid.uuid4().hex[:8]}")
    created = await client.post("/v1/lab/scheduled-jobs", json=_payload())
    assert created.status_code == 200, created.text
    job = created.json()
    assert job["name"] == "每小时提醒"
    assert job["enabled"] is True
    assert job["last_status"] is None
    assert "secret" not in job
    assert "secret_enc" not in job

    listed = await client.get("/v1/lab/scheduled-jobs")
    assert listed.status_code == 200, listed.text
    assert job["id"] in [j["id"] for j in listed.json()]

    removed = await client.delete(f"/v1/lab/scheduled-jobs/{job['id']}")
    assert removed.status_code == 200, removed.text
    after = await client.get("/v1/lab/scheduled-jobs")
    assert job["id"] not in [j["id"] for j in after.json()]


async def test_interval_below_floor_is_rejected(client, enabled):
    await register_and_login(client, f"lab-floor-{uuid.uuid4().hex[:8]}")
    r = await client.post(
        "/v1/lab/scheduled-jobs", json=_payload(interval_seconds=30)
    )
    assert r.status_code in (400, 422), r.text


async def test_ssrf_blocked_url_is_rejected(client, enabled, monkeypatch):
    await register_and_login(client, f"lab-ssrf-{uuid.uuid4().hex[:8]}")

    async def blocked(url: str):
        return SimpleNamespace(name="LOOPBACK_HOST")

    monkeypatch.setattr(routes, "classify_url", blocked)
    r = await client.post(
        "/v1/lab/scheduled-jobs",
        json=_payload(webhook_url="http://127.0.0.1:9999/notify"),
    )
    assert r.status_code == 400, r.text
    assert "SSRF" in r.text


async def test_manual_fire_sends_a_verifiable_signature(client, enabled, monkeypatch):
    from agentcore import lab_schedule as mod

    await register_and_login(client, f"lab-fire-{uuid.uuid4().hex[:8]}")
    created = await client.post("/v1/lab/scheduled-jobs", json=_payload())
    assert created.status_code == 200, created.text
    job_id = created.json()["id"]

    calls: list[tuple[str, bytes, dict[str, str]]] = []

    class _Resp:
        status_code = 200

    class _Client:
        async def post(self, url: str, *, content: bytes, headers: dict[str, str]):
            calls.append((url, content, headers))
            return _Resp()

    class _Ctx:
        async def __aenter__(self):
            return _Client()

        async def __aexit__(self, *args: object) -> bool:
            return False

    monkeypatch.setattr(mod, "outbound_async_client", lambda **kwargs: _Ctx())

    fired = await client.post(f"/v1/lab/scheduled-jobs/{job_id}/fire")
    assert fired.status_code == 200, fired.text
    assert fired.json()["status"] == "ok"
    assert len(calls) == 1

    url, body, headers = calls[0]
    assert url == _URL
    assert headers["X-Nexus-Lab-Job-Id"] == job_id
    ts = int(headers["X-Nexus-Lab-Timestamp"])
    assert headers["X-Nexus-Lab-Signature"] == (
        f"sha256={sign_request(_SECRET, job_id, ts, body)}"
    )

    listed = await client.get("/v1/lab/scheduled-jobs")
    row = next(j for j in listed.json() if j["id"] == job_id)
    assert row["last_status"] == "ok"
    assert row["last_run_at"] is not None


async def test_other_user_cannot_see_or_fire(client, enabled):
    await register_and_login(client, f"lab-owner-{uuid.uuid4().hex[:8]}")
    created = await client.post("/v1/lab/scheduled-jobs", json=_payload())
    assert created.status_code == 200, created.text
    job_id = created.json()["id"]

    await register_and_login(client, f"lab-other-{uuid.uuid4().hex[:8]}")
    listed = await client.get("/v1/lab/scheduled-jobs")
    assert listed.status_code == 200
    assert job_id not in [j["id"] for j in listed.json()]
    fired = await client.post(f"/v1/lab/scheduled-jobs/{job_id}/fire")
    assert fired.status_code == 404
