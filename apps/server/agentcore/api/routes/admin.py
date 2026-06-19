"""Admin console routes (平台管理员后台, admin-only).

Every endpoint is gated by the ``AdminUser`` dependency — 401 unauthenticated,
403 for a logged-in non-admin. This server-side role gate (+ the per-account
guards in ``AdminService``) is the *real* authorization boundary; the admin
frontend is just a client (管理员页面设计 决策: 独立 web 控制台, 后端契约先行).

Surface: 用户管理 (P0 — list every account, patch one account's role / status /
quota), 全站用量看板 (P1 — ``GET /usage/summary``, the cross-user counterpart of
``/v1/usage/summary``) and 系统状态 (P2 — ``GET /system``, a read-only deployment
snapshot). 邀请码 lives under ``/v1/auth/invites`` (already admin-gated).
"""

from datetime import UTC, datetime, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, Query

from agentcore.admin import AdminService
from agentcore.api.account_cleanup import cleanup_account_resources
from agentcore.api.cost_view import cost_breakdown, usage_breakdown
from agentcore.api.dependencies import (
    AdminUser,
    get_admin_service,
    get_asset_storage,
    get_auth_service,
    get_conversation_repo,
    get_conversation_share_repo,
    get_cost_event_repo,
    get_message_repo,
    get_turn_journal_repo,
    get_turn_metrics_repo,
    get_user_llm_key_repo,
    get_user_repo,
)
from agentcore.api.routes.system import app_version
from agentcore.api.schemas import (
    AdminConversationLine,
    AdminConversationReplay,
    AdminObservabilitySummary,
    AdminOverview,
    AdminResetPasswordResponse,
    AdminSystemStatus,
    AdminUpdateUserRequest,
    AdminUsageSummary,
    AdminUserCostLine,
    AdminUserDetail,
    AdminUserListItem,
    AdminUserListResponse,
    AdminUserResponse,
    DailyCost,
    DailyTurns,
    QuotaStatus,
    ReplayConversation,
    ReplayMessage,
    ReplaySpan,
    RoleCostLine,
    TurnHealthWindow,
    TurnMetricLine,
    UsageWindow,
)
from agentcore.auth import AuthService
from agentcore.config import settings
from agentcore.core.errors import NotFoundError
from agentcore.db.base import database_ready
from agentcore.db.models import User
from agentcore.db.repositories import (
    ConversationRepository,
    ConversationShareRepository,
    CostEventRepository,
    MessageRepository,
    TurnJournalRepository,
    TurnMetricsRepository,
    UserLlmKeyRepository,
    UserRepository,
)
from agentcore.llm.pricing import NANO_PER_USD
from agentcore.storage.assets import AssetStorage

router = APIRouter(prefix="/admin", tags=["admin"])

# 全站看板 windows: the 7-day trend length (matches /v1/usage/summary) and the Top-N
# spenders shown in the by-user payroll (the long tail isn't actionable for ops).
_TREND_DAYS = 7
_TOP_USERS = 20
# 用户详情下钻 caps: the most recent conversations + turns shown for one account
# (a bounded glance — deeper history is the per-conversation 复盘's concern).
_USER_CONVERSATIONS = 15
_USER_RECENT_TURNS = 20
# 概览首页「近期错误」feed length — a short glance on the dashboard (the full feed
# lives on the 观测 page).
_OVERVIEW_ERRORS = 5
# 观测看板「近期错误」feed length — the recent failures worth a glance (the long tail
# is for the drill-down, not the dashboard).
_ERROR_FEED = 20
# 会话复盘 message cap: one conversation's thread is bounded for the timeline payload
# (a conversation rarely exceeds this; deeper history is a paginated concern later).
_REPLAY_MAX_MESSAGES = 500
# 复盘 span preview cap: a tool call's args/result are truncated to a triage-sized
# snippet (the full text lives in turn_journal / the client replay, not this ops view).
_SPAN_PREVIEW = 200


def _preview(text: str | None) -> str | None:
    """Truncate a tool arg/result to a triage-sized snippet (``None`` stays ``None``)."""
    if not text:
        return None
    text = text.strip()
    return text if len(text) <= _SPAN_PREVIEW else text[:_SPAN_PREVIEW] + "…"


def _project_spans(entries: list[dict]) -> list[ReplaySpan]:
    """Project a turn's journal entries to the compact tool/LLM span list (会话复盘).

    Reads only the execution facts that triage a turn — ``llm_call`` (round /
    finish_reason / tokens) and ``tool_call`` (name / ok? / arg·result preview) — in
    emission (``seq``) order, skipping the heavy/display kinds (system prompt, team
    graph, full results). The full fidelity stays in turn_journal for client replay;
    this is the operator's at-a-glance "what did the turn actually do".
    """
    spans: list[ReplaySpan] = []
    for entry in entries:
        kind = entry.get("kind")
        payload = entry.get("payload") or {}
        if kind == "llm_call":
            usage = payload.get("usage") or {}
            spans.append(
                ReplaySpan(
                    kind="llm",
                    run_id=payload.get("run_id"),
                    round_idx=payload.get("round_idx"),
                    finish_reason=payload.get("finish_reason"),
                    input_tokens=int(usage.get("input", 0) or 0),
                    output_tokens=int(usage.get("output", 0) or 0),
                )
            )
        elif kind == "tool_call":
            spans.append(
                ReplaySpan(
                    kind="tool",
                    run_id=payload.get("run_id"),
                    name=payload.get("name"),
                    success=bool(payload.get("success", True)),
                    args_preview=_preview(payload.get("arguments")),
                    result_preview=_preview(payload.get("result")),
                )
            )
    return spans


def _health_window(agg: dict) -> TurnHealthWindow:
    """Map a turn_metrics health rollup → the wire schema, deriving the rates.

    The repository returns raw counts (turns / errors / delegated); the rates
    (errors-per-turn, delegated-per-turn) are computed here so the schema carries
    ready-to-render fractions and a zero-turn window is a clean 0.0 (no /0).
    """
    turns = agg["turns"]
    return TurnHealthWindow(
        turns=turns,
        errors=agg["errors"],
        error_rate=(agg["errors"] / turns) if turns else 0.0,
        avg_duration_ms=agg["avg_duration_ms"],
        p95_duration_ms=agg["p95_duration_ms"],
        avg_rounds=agg["avg_rounds"],
        delegated_turns=agg["delegated"],
        delegated_rate=(agg["delegated"] / turns) if turns else 0.0,
        input_tokens=agg["input_tokens"],
        output_tokens=agg["output_tokens"],
    )


def _admin_user_response(user: User) -> AdminUserResponse:
    return AdminUserResponse(
        id=user.user_id,
        username=user.username,
        display_name=user.display_name,
        email=user.email,
        role=user.role,
        status=user.status,
        is_unlimited=user.is_unlimited,
        quota_daily_tokens=user.quota_daily_tokens,
        quota_monthly_cost_usd=user.quota_monthly_cost_usd,
        quota_daily_requests=user.quota_daily_requests,
        default_model_mode=user.default_model_mode,
        created_at=user.created_at,
        deleted_at=user.deleted_at,
    )


def _admin_user_list_item(user: User, cost_total: int) -> AdminUserListItem:
    """A roster row = the account record + its all-time cumulative spend (nano-USD)."""
    return AdminUserListItem(
        **_admin_user_response(user).model_dump(), cost_total=cost_total
    )


@router.get("/overview", response_model=AdminOverview)
async def overview(
    admin: AdminUser,
    users: UserRepository = Depends(get_user_repo),
    cost_repo: CostEventRepository = Depends(get_cost_event_repo),
    metrics_repo: TurnMetricsRepository = Depends(get_turn_metrics_repo),
) -> AdminOverview:
    """控制台概览 (landing dashboard): today's platform pulse (active users + turn
    health + cost), account tallies, the 7-day cost / turn trends, deployment
    health, and a short recent-errors feed.

    A curated one-call home view that *reuses the same aggregates* as the 用量 /
    观测 / 系统 surfaces (so the headline numbers never drift from the drill-down
    pages) plus one extra metric — distinct active users today. Each error row
    carries its ``conversation_id`` to drill into 会话复盘.
    """
    now = datetime.now(UTC)
    day_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    week_start = day_start - timedelta(days=_TREND_DAYS - 1)

    today_health = await metrics_repo.aggregate_health_for_window(since=day_start)
    active_users_today = await metrics_repo.count_distinct_users_for_window(
        since=day_start
    )
    today_cost = await cost_repo.aggregate_for_window(since=day_start)

    # 近 7 日成本趋势 (zero-filled, oldest-first ending today).
    daily_cost = await cost_repo.aggregate_daily_for_window(since=week_start)
    recent_daily_cost = []
    for i in range(_TREND_DAYS):
        iso = (week_start + timedelta(days=i)).date().isoformat()
        recent_daily_cost.append(DailyCost(date=iso, cost_total=daily_cost.get(iso, 0)))

    # 近 7 日回合趋势 (zero-filled, oldest-first ending today).
    daily_turns = await metrics_repo.aggregate_daily_for_window(since=week_start)
    recent_daily_turns = []
    for i in range(_TREND_DAYS):
        iso = (week_start + timedelta(days=i)).date().isoformat()
        point = daily_turns.get(iso) or {}
        recent_daily_turns.append(
            DailyTurns(
                date=iso,
                turns=int(point.get("turns", 0)),
                errors=int(point.get("errors", 0)),
            )
        )

    counts = await users.count_overview()
    db_ok = await database_ready()
    errors = await metrics_repo.list_recent_errors(limit=_OVERVIEW_ERRORS)

    return AdminOverview(
        active_users_today=active_users_today,
        today=_health_window(today_health),
        cost_today=cost_breakdown(today_cost["cost"]),
        users_total=counts["total"],
        users_active=counts["active"],
        admins=counts["admins"],
        recent_daily_cost=recent_daily_cost,
        recent_daily_turns=recent_daily_turns,
        database_ok=db_ok,
        recent_errors=[TurnMetricLine.model_validate(r) for r in errors],
        cny_per_usd=settings.cny_per_usd,
        billing_mode=settings.billing_mode,
    )


@router.get("/users", response_model=AdminUserListResponse)
async def list_users(
    admin: AdminUser,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    q: str | None = Query(None, max_length=100),
    role: Literal["user", "admin"] | None = Query(None),
    status: Literal["active", "disabled"] | None = Query(None),
    sort: Literal["created_at", "cost"] = Query("created_at"),
    order: Literal["asc", "desc"] = Query("desc"),
    include_deleted: bool = Query(False),
    service: AdminService = Depends(get_admin_service),
) -> AdminUserListResponse:
    """The full account roster, paginated, each row carrying its all-time spend.

    Filters (AND): ``q`` substring-matches username/display_name, ``role``/``status``
    pin those dimensions. ``sort`` ∈ {``created_at``, ``cost``} (累计成本) with ``order``
    ∈ {``asc``, ``desc``}. ``include_deleted`` surfaces 注销 (soft-deleted, anonymized)
    accounts — hidden by default as tombstones, shown on demand for audit. Admin-only
    directory — enumeration is intended here. ``cny_per_usd`` folds each row's nano-USD
    ``cost_total`` into ¥.
    """
    rows, total = await service.list_users(
        page=page,
        page_size=page_size,
        query=q,
        role=role,
        status=status,
        sort=sort,
        order=order,
        include_deleted=include_deleted,
    )
    return AdminUserListResponse(
        data=[_admin_user_list_item(u, cost_total) for u, cost_total in rows],
        total=total,
        page=page,
        page_size=page_size,
        cny_per_usd=settings.cny_per_usd,
    )


@router.patch("/users/{user_id}", response_model=AdminUserResponse)
async def update_user(
    user_id: str,
    body: AdminUpdateUserRequest,
    admin: AdminUser,
    service: AdminService = Depends(get_admin_service),
) -> AdminUserResponse:
    """Partially update an account's role / status / quota.

    Only fields *present* in the body are applied (tri-state — see
    ``AdminUpdateUserRequest``): a quota field sent as ``null`` clears the override,
    a value sets it; absent fields are left untouched. Returns the fresh record.
    """
    fields = body.model_fields_set
    # Resolve the quota patch from the set-fields so the route owns the API-shape
    # concern and the repo gets only the dimensions the operator actually changed.
    quota: dict[str, object] = {}
    if "is_unlimited" in fields and body.is_unlimited is not None:
        quota["is_unlimited"] = body.is_unlimited
    if "quota_daily_tokens" in fields:
        quota["daily_tokens"] = body.quota_daily_tokens
    if "quota_monthly_cost_usd" in fields:
        quota["monthly_cost_usd"] = body.quota_monthly_cost_usd
    if "quota_daily_requests" in fields:
        quota["daily_requests"] = body.quota_daily_requests

    updated = await service.update_user(
        actor=admin,
        user_id=user_id,
        role=body.role if "role" in fields else None,
        status=body.status if "status" in fields else None,
        quota=quota or None,
    )
    return _admin_user_response(updated)


@router.post(
    "/users/{user_id}/reset-password", response_model=AdminResetPasswordResponse
)
async def reset_user_password(
    user_id: str,
    admin: AdminUser,
    auth_service: AuthService = Depends(get_auth_service),
) -> AdminResetPasswordResponse:
    """Reset an account's password to a fresh one-off (重置密码), returned once for the
    admin to hand over. Revokes the user's sessions (forces re-login on every device)
    and clears any lockout. 404 for an unknown account. The credential mechanics live
    in ``AuthService`` (password/session domain); this route is the admin-gated entry.
    """
    temp_password = await auth_service.admin_reset_password(user_id=user_id)
    return AdminResetPasswordResponse(temporary_password=temp_password)


@router.delete("/users/{user_id}", response_model=AdminUserResponse)
async def delete_user(
    user_id: str,
    admin: AdminUser,
    auth_service: AuthService = Depends(get_auth_service),
    conversations: ConversationRepository = Depends(get_conversation_repo),
    shares: ConversationShareRepository = Depends(get_conversation_share_repo),
    llm_keys: UserLlmKeyRepository = Depends(get_user_llm_key_repo),
    assets: AssetStorage = Depends(get_asset_storage),
) -> AdminUserResponse:
    """注销 (soft-delete + anonymize) an account, admin-initiated (用户管理 强操作).

    The stronger sibling of 停用 (a reversible status flip): this anonymizes the
    account (username → ``deleted_<id>``, email/avatar cleared), disables it (live
    tokens die on the next request), revokes its sessions, and cascades cross-domain
    cleanup (conversations soft-deleted for the retention sweeper, public shares
    revoked, BYOK key dropped, avatar object removed) — the same destructive path as
    self-service 注销, minus the password. Refuses self-deletion (no self-lockout →
    ≥1 active admin always remains); 404 for an unknown account. The append-only cost
    ledger is intentionally retained. Returns the tombstone record (carries
    ``deleted_at``) so the client can flag the row 「已注销」or drop it from the roster.
    """
    updated, avatar_key = await auth_service.admin_delete_account(
        actor_id=admin.user_id, user_id=user_id
    )
    await cleanup_account_resources(
        user_id,
        avatar_key=avatar_key,
        conversations=conversations,
        shares=shares,
        llm_keys=llm_keys,
        assets=assets,
    )
    return _admin_user_response(updated)


@router.get("/users/{user_id}/detail", response_model=AdminUserDetail)
async def user_detail(
    user_id: str,
    admin: AdminUser,
    users: UserRepository = Depends(get_user_repo),
    cost_repo: CostEventRepository = Depends(get_cost_event_repo),
    conversations: ConversationRepository = Depends(get_conversation_repo),
    messages_repo: MessageRepository = Depends(get_message_repo),
    metrics_repo: TurnMetricsRepository = Depends(get_turn_metrics_repo),
) -> AdminUserDetail:
    """用户详情下钻 (用户管理 P0): one account's record + its own usage (today / month
    / 7-day trend / by-role) + recent conversations + recent turn activity.

    The per-user counterpart of the platform 用量看板 — same windows / 口径 but scoped
    to one account (``cost_events.user_id``) — composed with the account's recent
    conversation roster (message counts batched, no N+1) and its recent turns (each
    carries ``conversation_id`` to drill into 会话复盘). Admin cross-user; 404 for an
    unknown id. Reuses the per-user cost aggregates already serving ``/v1/usage/summary``.
    """
    user = await users.get_by_id(user_id)
    if user is None:
        raise NotFoundError("用户不存在")

    now = datetime.now(UTC)
    day_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    month_start = day_start.replace(day=1)

    today = await cost_repo.aggregate_for_window(user_id=user_id, since=day_start)
    month = await cost_repo.aggregate_for_window(user_id=user_id, since=month_start)
    month_by_role = await cost_repo.aggregate_by_role_for_window(
        user_id=user_id, since=month_start
    )

    # 近 7 日趋势: zero-fill into a fixed, oldest-first series ending today (same
    # shape as /v1/usage/summary) so the sparkline is stable even for sparse spend.
    trend_start = day_start - timedelta(days=_TREND_DAYS - 1)
    daily = await cost_repo.aggregate_daily_for_window(
        user_id=user_id, since=trend_start
    )
    recent_daily_cost = []
    for i in range(_TREND_DAYS):
        iso = (trend_start + timedelta(days=i)).date().isoformat()
        recent_daily_cost.append(DailyCost(date=iso, cost_total=daily.get(iso, 0)))

    # Recent conversations (live list, newest-activity first) + their message counts
    # in one batched query (no per-row N+1).
    convs, _ = await conversations.list_by_user(user_id, limit=_USER_CONVERSATIONS)
    counts = await messages_repo.counts_for_conversations([c.id for c in convs])
    conversation_lines = [
        AdminConversationLine(
            id=c.id,
            title=c.title or None,
            created_at=c.created_at,
            updated_at=c.updated_at,
            messages=counts.get(c.id, 0),
        )
        for c in convs
    ]

    recent_turns = await metrics_repo.list_recent_for_user(
        user_id, limit=_USER_RECENT_TURNS
    )

    return AdminUserDetail(
        user=_admin_user_response(user),
        today=UsageWindow(
            usage=usage_breakdown(today["usage"]),
            cost=cost_breakdown(today["cost"]),
            requests=today["turns"],
        ),
        month=UsageWindow(
            usage=usage_breakdown(month["usage"]),
            cost=cost_breakdown(month["cost"]),
            requests=month["turns"],
        ),
        month_by_role=[
            RoleCostLine(
                role=row["role"],
                cost_total=int(row["cost_total"]),
                turns=int(row["turns"]),
            )
            for row in month_by_role
        ],
        recent_daily_cost=recent_daily_cost,
        conversations=conversation_lines,
        recent_turns=[TurnMetricLine.model_validate(r) for r in recent_turns],
        cny_per_usd=settings.cny_per_usd,
        billing_mode=settings.billing_mode,
    )


@router.get("/usage/summary", response_model=AdminUsageSummary)
async def usage_summary(
    admin: AdminUser,
    repo: CostEventRepository = Depends(get_cost_event_repo),
) -> AdminUsageSummary:
    """全站用量看板: platform-wide today / month totals, the Top spenders by user
    (工资单 by user), and the 7-day platform trend.

    The cross-user counterpart of ``GET /v1/usage/summary`` — same windows (bounded
    at the current UTC day / month start, MVP), but aggregated over *every* account
    instead of scoped to the caller. ``billing_mode`` lets the client frame cost
    honestly: in "byok" these totals are the sum of each user's spend on their own
    DeepSeek key (not platform-paid).
    """
    now = datetime.now(UTC)
    day_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    month_start = day_start.replace(day=1)

    today = await repo.aggregate_for_window(since=day_start)
    month = await repo.aggregate_for_window(since=month_start)
    month_by_user = await repo.aggregate_by_user_for_window(
        since=month_start, limit=_TOP_USERS
    )

    # 近 7 日趋势: zero-fill the daily map into a fixed, oldest-first series ending
    # today so the sparkline is a stable length even for sparse spend.
    trend_start = day_start - timedelta(days=_TREND_DAYS - 1)
    daily = await repo.aggregate_daily_for_window(since=trend_start)
    recent_daily_cost = []
    for i in range(_TREND_DAYS):
        iso = (trend_start + timedelta(days=i)).date().isoformat()
        recent_daily_cost.append(DailyCost(date=iso, cost_total=daily.get(iso, 0)))

    return AdminUsageSummary(
        today=UsageWindow(
            usage=usage_breakdown(today["usage"]),
            cost=cost_breakdown(today["cost"]),
            requests=today["turns"],
        ),
        month=UsageWindow(
            usage=usage_breakdown(month["usage"]),
            cost=cost_breakdown(month["cost"]),
            requests=month["turns"],
        ),
        month_by_user=[
            AdminUserCostLine(
                user_id=row["user_id"],
                username=row["username"],
                display_name=row["display_name"],
                cost_total=int(row["cost_total"]),
                turns=int(row["turns"]),
            )
            for row in month_by_user
        ],
        recent_daily_cost=recent_daily_cost,
        cny_per_usd=settings.cny_per_usd,
        billing_mode=settings.billing_mode,
    )


@router.get("/system", response_model=AdminSystemStatus)
async def system_status(
    admin: AdminUser,
    users: UserRepository = Depends(get_user_repo),
) -> AdminSystemStatus:
    """系统状态 (read-only): billing mode + global quota defaults + FX rate (config),
    database reachability, build provenance, and account tallies.

    A deployment sanity-check — nothing here is editable from the console (config is
    env + redeploy). Reuses the same DB probe as ``/readyz`` and the same version as
    ``/version`` so the panel never drifts from the real signals.
    """
    counts = await users.count_overview()
    db_ok = await database_ready()
    return AdminSystemStatus(
        billing_mode=settings.billing_mode,
        cny_per_usd=settings.cny_per_usd,
        quota=QuotaStatus(
            daily_tokens=settings.quota_daily_tokens,
            monthly_cost_nano=int(settings.quota_monthly_cost_usd * NANO_PER_USD),
            daily_requests=settings.quota_daily_requests,
        ),
        database_ok=db_ok,
        version=app_version(),
        git_sha=settings.git_sha,
        built_at=settings.built_at,
        users_total=counts["total"],
        users_active=counts["active"],
        admins=counts["admins"],
    )


@router.get("/observability/summary", response_model=AdminObservabilitySummary)
async def observability_summary(
    admin: AdminUser,
    repo: TurnMetricsRepository = Depends(get_turn_metrics_repo),
) -> AdminObservabilitySummary:
    """运营观测看板 (观测, P1): platform-wide turn health (today + trailing 7 days),
    the 7-day daily trend, and the most recent errored turns.

    Sourced from ``turn_metrics`` (the per-turn telemetry sink), NOT the dev log
    file — so it works under prod's stdout-only logging posture and aggregates with
    indexed SQL instead of scanning a multi-MB JSONL. Aggregated over *every*
    account (admin is a cross-user surface). Each error row carries its ``trace_id``
    / ``conversation_id`` to drill from a failure into the full turn (会话复盘, P2).
    """
    now = datetime.now(UTC)
    day_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    # The trailing-7-day window shares its start with the trend so「近 7 日」health and
    # the trend bars span exactly the same UTC days.
    week_start = day_start - timedelta(days=_TREND_DAYS - 1)

    today = await repo.aggregate_health_for_window(since=day_start)
    week = await repo.aggregate_health_for_window(since=week_start)

    # 近 7 日趋势: zero-fill the daily map into a fixed, oldest-first series ending
    # today so the bars are a stable length even on a quiet day.
    daily = await repo.aggregate_daily_for_window(since=week_start)
    recent_daily = []
    for i in range(_TREND_DAYS):
        iso = (week_start + timedelta(days=i)).date().isoformat()
        point = daily.get(iso) or {}
        recent_daily.append(
            DailyTurns(
                date=iso,
                turns=int(point.get("turns", 0)),
                errors=int(point.get("errors", 0)),
            )
        )

    errors = await repo.list_recent_errors(limit=_ERROR_FEED)
    return AdminObservabilitySummary(
        today=_health_window(today),
        week=_health_window(week),
        recent_daily=recent_daily,
        recent_errors=[TurnMetricLine.model_validate(row) for row in errors],
    )


@router.get(
    "/observability/conversations/{conversation_id}",
    response_model=AdminConversationReplay,
)
async def observability_conversation(
    conversation_id: str,
    admin: AdminUser,
    conversations: ConversationRepository = Depends(get_conversation_repo),
    messages_repo: MessageRepository = Depends(get_message_repo),
    metrics_repo: TurnMetricsRepository = Depends(get_turn_metrics_repo),
    cost_repo: CostEventRepository = Depends(get_cost_event_repo),
    journal_repo: TurnJournalRepository = Depends(get_turn_journal_repo),
    users: UserRepository = Depends(get_user_repo),
) -> AdminConversationReplay:
    """会话复盘 (观测 P2): one conversation's merged timeline — the message thread
    (bodies) overlaid with each turn's outcome/quality (turn_metrics), spend
    (cost_events), and execution spans (turn_journal), joined by trace_id /
    message_id.

    Admin-only and cross-user (any account's conversation), unlike the owner-scoped
    ``/v1/conversations/*``. The drill-down target of the 近期错误 feed: open a
    failed turn in full context (prompt + reply/error + rounds/latency + ¥ + the
    turn's tool/LLM spans).
    """
    conv = await conversations.get_by_id(conversation_id)  # unscoped: admin cross-user
    if conv is None:
        raise NotFoundError("对话不存在")

    owner = await users.get_by_id(conv.user_id)
    rows, _ = await messages_repo.list_by_conversation(
        conversation_id, limit=_REPLAY_MAX_MESSAGES
    )
    metrics = await metrics_repo.list_for_conversation(conversation_id)
    # Only the assistant reply carries a trace_id (the user prompt's is NULL), so a
    # trace overlays exactly one message — its turn's outcome/quality.
    metrics_by_trace = {m.trace_id: m for m in metrics if m.trace_id}
    cost_by_message = await cost_repo.aggregate_cost_by_message_for_conversation(
        conversation_id
    )
    # Each turn's execution spans live in turn_journal keyed by turn_id == the
    # assistant message id (NOT turn_metrics.turn_id, a separate id). Batch-load all
    # assistant turns' journals in one query (no N+1); a plain chat journaled nothing.
    journals = await journal_repo.load_map(
        [m.id for m in rows if m.role == "assistant"]
    )

    # The timeline is the messages ⟕ turns outer-join: a turn with a text reply rides
    # that assistant message (overlay); a text-less turn (e.g. an early hard error
    # that persisted no reply) has no message to ride, so it joins as a bare turn
    # marker — 复盘 must never hide a failure. Its spend stays in the rollup below.
    timeline: list[ReplayMessage] = []
    consumed: set[str] = set()
    for m in rows:
        overlay = metrics_by_trace.get(m.trace_id) if m.trace_id else None
        if overlay is not None:
            consumed.add(m.trace_id)
        timeline.append(
            ReplayMessage(
                id=m.id,
                role=m.role,
                content=m.content,
                created_at=m.created_at,
                trace_id=m.trace_id,
                metrics=TurnMetricLine.model_validate(overlay) if overlay else None,
                cost_total=cost_by_message.get(m.id, 0),
                spans=_project_spans(journals.get(m.id, [])),
            )
        )
    for tm in metrics:
        if not tm.trace_id or tm.trace_id in consumed:
            continue
        timeline.append(
            ReplayMessage(
                id=tm.turn_id,
                role="assistant",
                content=None,
                created_at=tm.created_at,
                trace_id=tm.trace_id,
                metrics=TurnMetricLine.model_validate(tm),
                cost_total=0,
            )
        )
    timeline.sort(key=lambda r: r.created_at)

    return AdminConversationReplay(
        conversation=ReplayConversation(
            id=conv.id,
            title=conv.title,
            user_id=conv.user_id,
            username=owner.username if owner else None,
            display_name=owner.display_name if owner else None,
            created_at=conv.created_at,
        ),
        messages=timeline,
        turns=len(metrics),
        errors=sum(1 for m in metrics if m.status == "error"),
        cost_total=sum(cost_by_message.values()),
        cny_per_usd=settings.cny_per_usd,
    )
