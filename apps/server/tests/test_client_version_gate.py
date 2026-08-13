"""Unit tests for the desktop / native-mobile minimum-version hard gates."""

import httpx
import pytest
from fastapi import FastAPI
from httpx import ASGITransport

from agentcore.config import settings
from agentcore.middleware.client_version import (
    ClientMinVersionMiddleware,
    compare_semver,
    floor_for_surface,
    is_client_version_outdated,
)

# --- pure helpers ---


def test_compare_semver_orders_major_minor_patch():
    assert compare_semver("0.6.24", "0.6.25") < 0
    assert compare_semver("0.6.25", "0.6.25") == 0
    assert compare_semver("0.7.0", "0.6.25") > 0
    assert compare_semver("0.6.25-beta", "0.6.25") == 0


def test_is_outdated_respects_floor_and_fail_open_inputs():
    assert is_client_version_outdated("0.6.24", "0.6.25") is True
    assert is_client_version_outdated("0.6.25", "0.6.25") is False
    assert is_client_version_outdated("dev", "0.6.25") is False
    assert is_client_version_outdated("", "0.6.25") is False
    assert is_client_version_outdated("0.6.24", "") is False


def test_is_outdated_raises_on_unparseable():
    with pytest.raises(ValueError):
        is_client_version_outdated("not-a-version", "0.6.25")


def test_floor_for_surface_only_gates_desktop_and_native_mobile(monkeypatch):
    monkeypatch.setattr(settings, "desktop_min_version", "0.6.25")
    monkeypatch.setattr(settings, "mobile_min_version", "0.5.0")
    assert floor_for_surface("desktop") == ("0.6.25", "桌面端")
    assert floor_for_surface("mobile") == ("0.5.0", "手机端")
    # ``web`` absorbs mobile-web; ``unknown`` covers admin / missing header.
    assert floor_for_surface("web") is None
    assert floor_for_surface("unknown") is None


# --- middleware ---


def _app() -> FastAPI:
    app = FastAPI()
    app.add_middleware(ClientMinVersionMiddleware)

    @app.get("/v1/ping")
    async def _ping():
        return {"ok": True}

    @app.post("/v1/auth/login")
    async def _login():
        return {"ok": True}

    @app.get("/updates/policy")
    async def _policy():
        return {"enabled": True, "min_desktop_version": "0.6.25"}

    @app.get("/livez")
    async def _livez():
        return {"status": "alive"}

    @app.options("/v1/ping")
    async def _options_ping():
        return {"ok": True}

    return app


def _headers(*, platform: str | None = "desktop", version: str | None = "0.6.24") -> dict:
    h: dict[str, str] = {}
    if platform is not None:
        h["X-Client-Platform"] = platform
    if version is not None:
        h["X-Client-Version"] = version
    return h


@pytest.fixture
def min_version(monkeypatch):
    """Desktop floor only — mobile stays unset (the production default)."""
    monkeypatch.setattr(settings, "desktop_min_version", "0.6.25")
    monkeypatch.setattr(settings, "mobile_min_version", "")


@pytest.fixture
def mobile_min_version(monkeypatch):
    """Native mobile floor only — desktop stays unset, proving the floors are independent."""
    monkeypatch.setattr(settings, "desktop_min_version", "")
    monkeypatch.setattr(settings, "mobile_min_version", "0.5.0")


async def test_below_min_returns_426(min_version):
    transport = ASGITransport(app=_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        r = await c.get("/v1/ping", headers=_headers(version="0.6.24"))
    assert r.status_code == 426
    body = r.json()["error"]
    assert body["code"] == "CLIENT_TOO_OLD"
    assert "0.6.25" in body["message"]
    assert body["details"]["min_version"] == "0.6.25"


async def test_at_or_above_min_passes(min_version):
    transport = ASGITransport(app=_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        assert (await c.get("/v1/ping", headers=_headers(version="0.6.25"))).status_code == 200
        assert (await c.get("/v1/ping", headers=_headers(version="0.6.26"))).status_code == 200
        # Auth path is also gated, but current version must pass.
        assert (
            await c.post("/v1/auth/login", headers=_headers(version="0.6.25"))
        ).status_code == 200


async def test_non_gated_platforms_pass(min_version):
    transport = ASGITransport(app=_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        for platform in ("web", "mobile-web", "admin", "android"):
            r = await c.get("/v1/ping", headers=_headers(platform=platform, version="0.6.24"))
            assert r.status_code == 200, platform
        # Missing platform header → not gated.
        r = await c.get("/v1/ping", headers=_headers(platform=None, version="0.6.24"))
        assert r.status_code == 200


async def test_missing_or_dev_version_fail_open(min_version):
    transport = ASGITransport(app=_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        assert (await c.get("/v1/ping", headers=_headers(version=None))).status_code == 200
        assert (await c.get("/v1/ping", headers=_headers(version="dev"))).status_code == 200
        # Unparseable → fail-open.
        assert (await c.get("/v1/ping", headers=_headers(version="???"))).status_code == 200


async def test_empty_desktop_min_version_disables_gate(monkeypatch):
    monkeypatch.setattr(settings, "desktop_min_version", "")
    monkeypatch.setattr(settings, "mobile_min_version", "")
    transport = ASGITransport(app=_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        r = await c.get("/v1/ping", headers=_headers(version="0.0.1"))
    assert r.status_code == 200


async def test_updates_policy_and_probes_exempt(min_version):
    transport = ASGITransport(app=_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        h = _headers(version="0.6.24")
        assert (await c.get("/updates/policy", headers=h)).status_code == 200
        assert (await c.get("/livez", headers=h)).status_code == 200
        # OPTIONS always exempt.
        assert (await c.options("/v1/ping", headers=h)).status_code == 200


# --- native mobile floor ---


async def test_outdated_android_returns_426(mobile_min_version):
    transport = ASGITransport(app=_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        r = await c.get("/v1/ping", headers=_headers(platform="android", version="0.4.9"))
    assert r.status_code == 426
    body = r.json()["error"]
    assert body["code"] == "CLIENT_TOO_OLD"
    assert "手机端" in body["message"]
    assert "0.5.0" in body["message"]
    assert body["details"]["min_version"] == "0.5.0"


async def test_native_mobile_aliases_gated_case_insensitively(mobile_min_version):
    transport = ASGITransport(app=_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        for platform in ("android", "ios", "mobile", "ANDROID", "iOS"):
            r = await c.get("/v1/ping", headers=_headers(platform=platform, version="0.4.9"))
            assert r.status_code == 426, platform


async def test_mobile_web_never_gated(mobile_min_version):
    """Browser surface: a reload is already the newest bundle, so no floor applies."""
    transport = ASGITransport(app=_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        for version in ("0.0.1", "0.4.9", "dev"):
            r = await c.get("/v1/ping", headers=_headers(platform="mobile-web", version=version))
            assert r.status_code == 200, version


async def test_current_android_passes(mobile_min_version):
    transport = ASGITransport(app=_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        for version in ("0.5.0", "0.5.1", "1.0.0"):
            r = await c.get("/v1/ping", headers=_headers(platform="android", version=version))
            assert r.status_code == 200, version


async def test_mobile_floor_does_not_gate_desktop(mobile_min_version):
    """Floors are independent: a mobile-only floor must leave desktop untouched."""
    transport = ASGITransport(app=_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        r = await c.get("/v1/ping", headers=_headers(platform="desktop", version="0.0.1"))
    assert r.status_code == 200


async def test_android_fail_open_inputs(mobile_min_version):
    transport = ASGITransport(app=_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        for version in (None, "dev", "???"):
            r = await c.get("/v1/ping", headers=_headers(platform="android", version=version))
            assert r.status_code == 200, version


async def test_empty_mobile_min_version_disables_gate(monkeypatch):
    monkeypatch.setattr(settings, "desktop_min_version", "")
    monkeypatch.setattr(settings, "mobile_min_version", "")
    transport = ASGITransport(app=_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        r = await c.get("/v1/ping", headers=_headers(platform="android", version="0.0.1"))
    assert r.status_code == 200


async def test_updates_policy_and_probes_exempt_for_android(mobile_min_version):
    """Blocked android must still reach the probes (and any future policy poll)."""
    transport = ASGITransport(app=_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        h = _headers(platform="android", version="0.4.9")
        assert (await c.get("/updates/policy", headers=h)).status_code == 200
        assert (await c.get("/livez", headers=h)).status_code == 200
        assert (await c.options("/v1/ping", headers=h)).status_code == 200


async def test_both_floors_active_together(monkeypatch):
    monkeypatch.setattr(settings, "desktop_min_version", "0.6.25")
    monkeypatch.setattr(settings, "mobile_min_version", "0.5.0")
    transport = ASGITransport(app=_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        # Each platform is judged against its own floor, not the other's.
        assert (
            await c.get("/v1/ping", headers=_headers(platform="desktop", version="0.6.24"))
        ).status_code == 426
        assert (
            await c.get("/v1/ping", headers=_headers(platform="android", version="0.6.24"))
        ).status_code == 200
        assert (
            await c.get("/v1/ping", headers=_headers(platform="android", version="0.4.9"))
        ).status_code == 426
        assert (
            await c.get("/v1/ping", headers=_headers(platform="mobile-web", version="0.4.9"))
        ).status_code == 200
