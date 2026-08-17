"""Admin Go-window calibration endpoint (platform-prepaid ledger only)."""

from datetime import UTC, datetime, timedelta

from sqlalchemy import update

from agentcore.billing.opencode_go_public_prices import (
    MODEL_ID,
    PRICE_AS_OF,
    estimate_go_public_usd_nano,
)
from agentcore.config import settings
from agentcore.core.types import new_id
from agentcore.db.models import CostCall
from agentcore.db.repositories import CostEventRepository, UserRepository
from tests.integration.conftest import login_admin


async def _seed_user(session_factory, username: str) -> str:
    async with session_factory() as session:
        user = await UserRepository(session).create(
            username=username,
            display_name=username,
        )
        return user.user_id


async def _create_pool_credential(
    client,
    *,
    label: str,
    base_url: str,
    subscription_day: int = 18,
) -> str:
    created = await client.post(
        "/v1/admin/platform-credentials",
        json={
            "label": label,
            "api_key": f"sk-pool-{label}",
            "base_url": base_url,
            "subscription_day": subscription_day,
            "enabled": True,
        },
    )
    assert created.status_code == 201, created.text
    return created.json()["id"]


async def _seed_call(
    session_factory,
    *,
    user_id: str,
    total: int,
    credential_source: str,
    created_at: datetime | None = None,
    platform_credential_id: str | None = None,
    tokens: dict | None = None,
    model: str = "deepseek-v4-flash",
) -> None:
    call_id = new_id()
    billed = 0 if credential_source == "user" else total
    estimated = total if credential_source == "user" else 0
    call = {
        "call_id": call_id,
        "run_id": new_id(),
        "parent_run_id": None,
        "agent_id": new_id(),
        "role": "captain",
        "model": model,
        "tokens": tokens
        or {
            "input": 10,
            "output": 5,
            "reasoning": 0,
            "cache_hit": 0,
            "cache_miss": 10,
        },
        "cost": {
            "input": billed,
            "cached": 0,
            "output": 0,
            "total": total,
            "credential_source": credential_source,
        },
        "cost_total_nano": billed,
        "cost_estimated_nano": estimated,
        "currency": "CNY",
        "duration_ms": 50,
    }
    if platform_credential_id:
        call["platform_credential_id"] = platform_credential_id
    async with session_factory() as session:
        await CostEventRepository(session).record_calls(
            user_id=user_id,
            conversation_id=new_id(),
            message_id=new_id(),
            calls=[call],
        )
    if created_at is not None:
        async with session_factory() as session:
            await session.execute(
                update(CostCall).where(CostCall.call_id == call_id).values(created_at=created_at)
            )
            await session.commit()


async def test_go_windows_require_admin(client):
    assert (await client.get("/v1/admin/usage/go-windows")).status_code == 401


async def test_go_windows_empty_has_week_month_bounds(client, make_admin, monkeypatch):
    monkeypatch.setattr(settings, "platform_go_subscription_day", 15)
    username, password = await make_admin()
    await login_admin(client, username, password)

    r = await client.get("/v1/admin/usage/go-windows")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["cost_basis"] == "nominal_nano_cny"
    assert body["estimate_basis"] == "opencode_public_list"
    assert body["estimate_currency"] == "USD"
    assert body["estimate_price_as_of"] == PRICE_AS_OF.isoformat()
    assert body["estimate_model"] == MODEL_ID
    assert body["subscription_day"] == 15
    assert body["five_hour"]["cost_total_nano"] == 0
    assert body["five_hour"]["estimated_usd_nano"] == 0
    assert body["five_hour"]["started_at"] is None
    assert body["weekly"]["cost_total_nano"] == 0
    assert body["weekly"]["estimated_usd_nano"] == 0
    assert body["weekly"]["started_at"] is not None
    assert body["weekly"]["reset_at"] is not None
    assert body["monthly"]["started_at"] is not None
    assert body["monthly"]["reset_at"] is not None
    # Monthly bounds must land on the configured anniversary (clamped day).
    assert datetime.fromisoformat(body["monthly"]["started_at"]).day == 15
    assert datetime.fromisoformat(body["monthly"]["reset_at"]).day == 15


async def test_go_windows_excludes_byok_and_vendor(client, make_admin, session_factory):
    username, password = await make_admin()
    await login_admin(client, username, password)
    go_id = await _create_pool_credential(
        client, label="Go-only", base_url="https://opencode.ai/zen/go/v1"
    )
    alice = await _seed_user(session_factory, "gw-alice")

    await _seed_call(
        session_factory,
        user_id=alice,
        total=4000,
        credential_source="platform",
        platform_credential_id=go_id,
    )
    await _seed_call(
        session_factory, user_id=alice, total=9999, credential_source="user"
    )
    await _seed_call(
        session_factory, user_id=alice, total=8000, credential_source="vendor"
    )
    await _seed_call(
        session_factory,
        user_id=alice,
        total=50_000,
        credential_source="platform",
    )

    r = await client.get("/v1/admin/usage/go-windows")
    assert r.status_code == 200, r.text
    body = r.json()
    # Just-seeded Go row is inside the current 5h / week / month.
    # Pre-pool platform row (no credential id) must not join the window.
    assert body["five_hour"]["cost_total_nano"] == 4000
    assert body["five_hour"]["calls"] == 1
    assert body["weekly"]["cost_total_nano"] == 4000
    assert body["monthly"]["cost_total_nano"] == 4000


async def test_go_windows_five_hour_excludes_expired_window_tail(
    client, make_admin, session_factory
):
    username, password = await make_admin()
    await login_admin(client, username, password)
    go_id = await _create_pool_credential(
        client, label="Go-5h", base_url="https://opencode.ai/zen/go/v1"
    )
    alice = await _seed_user(session_factory, "gw-bob")
    now = datetime.now(UTC)
    old_start = now - timedelta(hours=6)
    old_tail = now - timedelta(hours=2)
    current = now - timedelta(minutes=20)

    await _seed_call(
        session_factory,
        user_id=alice,
        total=800,
        credential_source="platform",
        created_at=old_start,
        platform_credential_id=go_id,
    )
    await _seed_call(
        session_factory,
        user_id=alice,
        total=200,
        credential_source="platform",
        created_at=old_tail,
        platform_credential_id=go_id,
    )
    await _seed_call(
        session_factory,
        user_id=alice,
        total=50,
        credential_source="platform",
        created_at=current,
        platform_credential_id=go_id,
    )

    r = await client.get("/v1/admin/usage/go-windows")
    assert r.status_code == 200, r.text
    five = r.json()["five_hour"]
    # Sliding last-5h would be 200+50; fixed window after 06h-ago origin is 50.
    assert five["cost_total_nano"] == 50
    assert five["calls"] == 1
    assert five["reset_at"] is not None


async def test_go_windows_members_use_per_account_subscription_day(
    client, make_admin, session_factory, monkeypatch
):
    monkeypatch.setattr(settings, "platform_go_subscription_day", 1)
    username, password = await make_admin()
    await login_admin(client, username, password)
    cred_id = await _create_pool_credential(
        client,
        label="Go-B",
        base_url="https://opencode.ai/zen/go/v1",
        subscription_day=18,
    )
    alice = await _seed_user(session_factory, "gw-pool")
    await _seed_call(
        session_factory,
        user_id=alice,
        total=7000,
        credential_source="platform",
        platform_credential_id=cred_id,
    )

    r = await client.get("/v1/admin/usage/go-windows")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["subscription_day"] == 1
    assert datetime.fromisoformat(body["monthly"]["started_at"]).day == 1
    assert len(body["members"]) == 1
    member = body["members"][0]
    assert member["platform_credential_id"] == cred_id
    assert member["label"] == "Go-B"
    assert member["subscription_day"] == 18
    assert member["monthly"]["cost_total_nano"] == 7000
    assert datetime.fromisoformat(member["monthly"]["started_at"]).day == 18
    assert datetime.fromisoformat(member["monthly"]["reset_at"]).day == 18


async def test_go_windows_usd_estimate_prices_peak_and_off_peak_separately(
    client, make_admin, session_factory
):
    username, password = await make_admin()
    await login_admin(client, username, password)
    go_id = await _create_pool_credential(
        client, label="Go-usd", base_url="https://opencode.ai/zen/go/v1"
    )
    alice = await _seed_user(session_factory, "gw-usd")
    now = datetime.now(UTC)
    # Same token split; one Peak hour, one Off-Peak. Both inside the current
    # UTC week / 5h window (place them in the last 30 minutes, forcing hours
    # via created_at — if "now" is Peak the off-peak stamp may fall in an
    # earlier 5h window, so we only assert weekly which is UTC-Monday based).
    tokens = {
        "input": 1_000_000,
        "output": 0,
        "reasoning": 0,
        "cache_hit": 0,
        "cache_miss": 1_000_000,
    }
    peak_at = now.replace(hour=2, minute=0, second=0, microsecond=0)
    if peak_at > now:
        peak_at = peak_at - timedelta(days=1)
    off_at = now.replace(hour=12, minute=0, second=0, microsecond=0)
    if off_at > now:
        off_at = off_at - timedelta(days=1)
    # Keep both inside this UTC week (Monday 00:00).
    week_start = now.replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(
        days=now.weekday()
    )
    if peak_at < week_start:
        peak_at = week_start + timedelta(hours=2)
    if off_at < week_start:
        off_at = week_start + timedelta(hours=12)

    await _seed_call(
        session_factory,
        user_id=alice,
        total=1,
        credential_source="platform",
        created_at=peak_at,
        tokens=tokens,
        platform_credential_id=go_id,
    )
    await _seed_call(
        session_factory,
        user_id=alice,
        total=1,
        credential_source="platform",
        created_at=off_at,
        tokens=tokens,
        platform_credential_id=go_id,
    )

    r = await client.get("/v1/admin/usage/go-windows")
    assert r.status_code == 200, r.text
    weekly = r.json()["weekly"]
    expected = estimate_go_public_usd_nano(
        tokens, peak_at, model=MODEL_ID
    ) + estimate_go_public_usd_nano(tokens, off_at, model=MODEL_ID)
    assert weekly["calls"] == 2
    assert weekly["estimated_usd_nano"] == expected
    assert estimate_go_public_usd_nano(tokens, peak_at, model=MODEL_ID) != (
        estimate_go_public_usd_nano(tokens, off_at, model=MODEL_ID)
    )


async def test_go_windows_excludes_zen_endpoint_rows(client, make_admin, session_factory):
    """Zen pool rows (and untagged platform rows) must not enter Go windows."""
    username, password = await make_admin()
    await login_admin(client, username, password)
    zen_id = await _create_pool_credential(
        client, label="Zen-A", base_url="https://opencode.ai/zen/v1"
    )
    go_id = await _create_pool_credential(
        client, label="Go-A", base_url="https://opencode.ai/zen/go/v1"
    )
    alice = await _seed_user(session_factory, "gw-zen")
    tokens = {
        "input": 1_000_000,
        "output": 0,
        "reasoning": 0,
        "cache_hit": 0,
        "cache_miss": 1_000_000,
    }
    await _seed_call(
        session_factory,
        user_id=alice,
        total=9_000,
        credential_source="platform",
        platform_credential_id=zen_id,
        tokens=tokens,
        model="deepseek-v4-flash-free",
    )
    await _seed_call(
        session_factory,
        user_id=alice,
        total=50_000,
        credential_source="platform",
        tokens=tokens,
        model="glm-5.2",
    )
    await _seed_call(
        session_factory,
        user_id=alice,
        total=700,
        credential_source="platform",
        platform_credential_id=go_id,
        tokens=tokens,
    )

    r = await client.get("/v1/admin/usage/go-windows")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["five_hour"]["cost_total_nano"] == 700
    assert body["five_hour"]["calls"] == 1
    assert body["weekly"]["cost_total_nano"] == 700
    assert body["weekly"]["calls"] == 1
    member_ids = {m["platform_credential_id"] for m in body["members"]}
    assert go_id in member_ids
    assert zen_id not in member_ids
    go_member = next(m for m in body["members"] if m["platform_credential_id"] == go_id)
    assert go_member["weekly"]["cost_total_nano"] == 700


async def test_go_windows_does_not_price_glm_as_flash(client, make_admin, session_factory):
    """A Go-endpoint glm-5.2 row counts as traffic but must not inherit Flash USD."""
    username, password = await make_admin()
    await login_admin(client, username, password)
    go_id = await _create_pool_credential(
        client, label="Go-glm", base_url="https://opencode.ai/zen/go/v1"
    )
    alice = await _seed_user(session_factory, "gw-glm")
    tokens = {
        "input": 1_000_000,
        "output": 0,
        "reasoning": 0,
        "cache_hit": 0,
        "cache_miss": 1_000_000,
    }
    await _seed_call(
        session_factory,
        user_id=alice,
        total=3_000,
        credential_source="platform",
        platform_credential_id=go_id,
        tokens=tokens,
        model="glm-5.2",
    )

    r = await client.get("/v1/admin/usage/go-windows")
    assert r.status_code == 200, r.text
    weekly = r.json()["weekly"]
    assert weekly["calls"] == 1
    assert weekly["cost_total_nano"] == 3_000
    assert weekly["estimated_usd_nano"] == 0
    assert estimate_go_public_usd_nano(tokens, datetime.now(UTC), model=MODEL_ID) > 0
