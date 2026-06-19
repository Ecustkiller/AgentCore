"""Application configuration loaded from environment variables."""

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# Repository root, anchored off this file (…/apps/server/agentcore/config.py →
# parents[3]). Used to resolve relative paths (e.g. LOG_FILE → <root>/logs/...)
# against the project root rather than the process CWD (the server runs from
# apps/server, but logs/ live at the repo root so tooling finds them).
_resolved_parents = Path(__file__).resolve().parents
# Repo layout: …/apps/server/agentcore/config.py → parents[3] is the repo root.
# Container layout (Dockerfile COPY agentcore /app/agentcore): only 3 parents
# exist, so fall back to /app (parents[1]) instead of IndexError-crashing on
# import — relative LOG_FILE/data paths then resolve under the app dir.
_PROJECT_ROOT = (
    _resolved_parents[3] if len(_resolved_parents) > 3 else _resolved_parents[1]
)

# The backend's dotenv lives beside the package at apps/server/.env (parents[1]).
# Anchor it to an ABSOLUTE path: pydantic resolves a bare relative "env_file"
# against the *process CWD*, so launching the server from anywhere but
# apps/server silently loaded NOTHING — DB/DEBUG still arrived via exported env
# vars, but unexported secrets (ENCRYPTION_KEY, LOG_FILE) fell back to defaults,
# yielding a half-configured boot that 402'd every BYOK turn and wrote no JSONL
# logs. Anchoring makes .env load regardless of CWD. A missing file here is fine:
# pydantic-settings ignores it and uses real env vars (12-factor prod posture).
_ENV_FILE = Path(__file__).resolve().parents[1] / ".env"


class Settings(BaseSettings):
    database_url: str = "postgresql+asyncpg://agentcore:agentcore@localhost:5432/agentcore"
    redis_url: str = "redis://localhost:6379/0"

    deepseek_api_key: str = ""
    deepseek_base_url: str = "https://api.deepseek.com"

    # --- 计费模式 (BYOK 内测) ---
    # "byok": 每个用户必须自带 DeepSeek API Key（用户自付额度）；平台不提供 key、
    # 不计配额——发起对话前 preflight 校验用户已配置可用 key（见 api/routes/
    # conversations.py），并以该 key 解析出的凭据贯穿整条 turn。
    # "platform": 回到平台统一付费（用 deepseek_api_key + 配额防线）。
    # 内测期默认 byok；平台付费路径（全局 key / 配额 / 成本账本）全部保留，仅靠此
    # 开关休眠——日后翻回 platform + 填 deepseek_api_key 即恢复，零迁移。
    billing_mode: str = "byok"

    # AES-256-GCM 主密钥，用于把 BYOK API Key 加密后落库（security.py KeyEncryptor →
    # user_llm_keys.api_key_enc）。64 个十六进制字符 = 32 字节；生成：
    #   python -c "import secrets; print(secrets.token_hex(32))"
    # 留空则禁用 BYOK key 存储——set-key 接口会拒绝存一把无法加密的 key（fail-safe，
    # 明文永不落库）。
    encryption_key: str = ""

    # Web search via a self-hosted SearXNG instance (engine set curated to
    # mainland-China-reachable engines, see deploy/searxng/settings.yml). Dev port
    # 18888 avoids the Windows winnat reserved range 8866–8965.
    searxng_url: str = "http://localhost:18888"

    # Tavily fallback search (案例1 检索韧性残留补齐). When tavily_api_key is set,
    # get_search_backend() wraps the SearXNG primary in a FallbackSearchBackend: a
    # query that FAILS on SearXNG (breaker-open / transport / persistent 5xx — the
    # "whole team goes search-blind" mode from 实测案例复盘 案例1) retries ONCE via
    # Tavily, a hosted search API reachable from outside mainland China. SearXNG stays
    # the primary so normal queries pay no Tavily cost; Tavily fires only on a primary
    # failure. Empty key ⇒ no fallback (pure SearXNG, behaviour unchanged). The
    # protocol's intended second implementation — see search_backend.SearchBackend.
    tavily_api_key: str = ""
    tavily_base_url: str = "https://api.tavily.com"

    jwt_secret_key: str = "dev-secret-change-in-production"
    jwt_access_token_expire_minutes: int = 30
    jwt_refresh_token_expire_days: int = 7

    # Sidecar 云推理代理令牌 TTL（双模式工作区 §一.1 / Slice 4a）。桌面以 cookie 换一个
    # 短期「推理令牌」交给本机 sidecar；sidecar 的 LLM 调用以它作 Bearer 命中 /v1/inference
    # 代理（平台 key 永不下放本机，且平台计量在代理侧权威落账）。比 access JWT 长——一个本地
    # 引擎会话内多回合复用、避免频繁重铸；但仍有限，过期后桌面在 sidecar 重连时重新换取。
    inference_token_expire_minutes: int = 720  # 12h

    # Auth cookies. `secure` requires HTTPS (keep False for local http dev).
    # `samesite` "lax" suits same-site dev (renderer + API both on localhost). The
    # packaged desktop renderer (app://agentcore) is cross-site to the cloud API,
    # so production must set COOKIE_SAMESITE=none + COOKIE_SECURE=true or the auth
    # cookies won't ride credentialed cross-origin requests (部署与运维.md §8.2).
    cookie_secure: bool = False
    cookie_samesite: str = "lax"

    # CORS: browser/desktop origins allowed to call the API with credentials.
    # Credentialed CORS forbids "*", so each origin must be listed. Comma-separated
    # in the env var; read as a list via the `cors_origins` property. The packaged
    # desktop renderer is served from app://agentcore (前端技术与架构.md §7.2), so
    # that fixed origin ships in the default alongside the dev Vite/preview ports.
    # The mobile client (手机端落地设计 P0) adds its own origins: the mobile-web dev
    # server (5175) and the Capacitor shells whose webview origin is non-standard —
    # capacitor://localhost (iOS) + http(s)://localhost (Android). They authenticate by
    # bearer token (not cookies), but the browser still requires a CORS allow-listing.
    cors_allow_origins: str = (
        "http://localhost:5173,http://localhost:5174,http://localhost:3000,"
        "http://localhost:5175,app://agentcore,"
        "capacitor://localhost,http://localhost,https://localhost"
    )

    # Auth-endpoint rate limiting (per client IP, fixed window). Blunts
    # credential-stuffing / registration spam on top of per-account lockout.
    # State is in-process, so it assumes a single server process — front with
    # Redis if you scale to multiple workers.
    rate_limit_enabled: bool = True
    auth_rate_limit_max: int = 10
    auth_rate_limit_window_seconds: int = 60
    # Per-user message-send rate limit (sliding window, enforced in the conversation
    # routes). Caps how fast one account can fire turns; resolved against the
    # authenticated user, so it lives at the route layer (next to quota) rather than
    # middleware, which only sees the client IP. <=0 disables this dimension; the
    # shared `rate_limit_enabled` toggle gates it too. Same in-process posture —
    # front with a Redis ZSET sliding window for multiple workers (成本配额与计费.md §一).
    user_message_rate_limit_max: int = 20
    user_message_rate_limit_window_seconds: int = 60
    # Trust the first hop of X-Forwarded-For as the client IP. Enable ONLY behind
    # a trusted reverse proxy that sets it; otherwise clients can spoof their IP.
    trust_proxy: bool = False

    # Tool approval gate (CEO chat path). When enabled, GRANTABLE tools
    # (file_write / str_replace / code_execute) pause for the user to authorize
    # before running. State is in-process (a request suspends on an asyncio
    # Future the resolve endpoint settles), so it assumes a single server
    # process — front with Redis to scale to multiple workers. A request the
    # user never answers is auto-denied after the timeout (never silently run).
    approval_gate_enabled: bool = True
    approval_timeout_seconds: float = 300.0

    # User checkpoints (CEO ask_user — Agent协作模式.md §三).
    # The CEO pauses the turn to ask the user a decision; the turn suspends until
    # answered. Same single-worker in-process posture as the approval gate. The
    # deadline is longer than approvals' — the user is making a judgement call, not
    # a quick allow/deny — and a no-answer timeout resumes the CEO with "no
    # response" so it wraps up rather than hanging.
    checkpoint_gate_enabled: bool = True
    checkpoint_timeout_seconds: float = 600.0

    # Engine-level tool execution backstop (B1 工具超时兜底). A uniform ceiling the
    # ReAct loop wraps around each tool call so a wedged tool (a hung network read, a
    # runaway subprocess) can't stall a whole turn; on expiry the call returns a
    # ``[超时]`` tool result the model adapts to (and that feeds LoopController's
    # repeated-failure detection). Layered ABOVE each tool's own finer timeout — e.g.
    # ``code_execute`` caps its sandbox at ≤60s, so the EXECUTION ceiling sits higher
    # (90s) and only fires if the sandbox itself wedges. ORCHESTRATION (delegate /
    # revise) and INTERACTION (ask_user) tools are EXEMPT: they legitimately wait
    # minutes on sub-runs / the user and are bounded by their own lifecycle, not this.
    tool_default_timeout_seconds: float = 60.0
    tool_execution_timeout_seconds: float = 90.0

    # Engine degraded handling + fallback (B2). An "empty response" round (the model
    # returns no content AND no tool call) is a degradation, not a normal end: the
    # ReAct loop (via LoopController) first retries ONCE on the profile's
    # ``fallback_model`` (Flash → Pro escalation — the economy model choked, try the
    # stronger one), and if a 2nd consecutive empty round follows, ends the turn with
    # ``FinishReason.DEGRADED`` instead of a blank reply. The fallback fires only on
    # this (rare) empty-round path, so the extra Pro call is bounded; disable it to
    # go straight to degraded. ``empty_response_threshold`` is the consecutive-empty
    # count that trips the degraded finish (the fallback retry sits inside it).
    engine_fallback_enabled: bool = True
    engine_empty_response_threshold: int = 2

    # Convergence governance — tool failure circuit breaker + no-output early stop
    # (B2, via LoopController). The circuit breaker counts a tool's *cumulative*
    # failures across the run (args-agnostic, unlike fingerprint-keyed repeated-
    # failure detection): at ``tool_failure_warn`` failures the model is told to stop
    # retrying that tool; at ``tool_failure_disable`` the tool is removed from the
    # toolset for the rest of the run. ``unproductive_threshold`` is the number of
    # consecutive rounds where every tool call failed AND no content was produced
    # that trips an early stop (forced tool-free answer, FinishReason.UNPRODUCTIVE)
    # instead of spinning to the round cap.
    engine_tool_failure_warn: int = 2
    engine_tool_failure_disable: int = 3
    engine_unproductive_threshold: int = 3
    # Periodic progress-review reflection (B2 反思注入): inject a "step back and re-plan"
    # steer starting at this round (0-indexed; 3 = the 4th round) and every
    # ``reflection_interval`` rounds after — proactive cadence for long runs, separate
    # from the event-driven NUDGE.
    engine_reflection_start_round: int = 3
    engine_reflection_interval: int = 3

    # Manager-CEO breadth nudge (档2.5 纯粹管理者 CEO): a delegation-capable run (the CEO
    # captain / a can_delegate worker) that keeps doing read-only investigation ITSELF —
    # cumulative info-gathering calls crossing ``threshold`` while it has not delegated —
    # gets ONE steer to fan the breadth out to a parallel research team instead of reading
    # everything solo (which serializes the work and bloats the CEO context within the
    # turn). One-shot per run; gated on ``min_round`` so a legitimate pre-delegation scout
    # batch in the opening round doesn't trip it. ``threshold = 0`` disables it; runs that
    # cannot delegate (leaf workers) never fire it regardless. Tunable — calibrate from the
    # delegation rate now made observable at chat.turn_complete (delegated = workers > 0).
    engine_delegation_nudge_threshold: int = 4
    engine_delegation_nudge_min_round: int = 1

    # Observability — execution span tree (D2 可观测性; 契约见 管理员后台.md). Off the user path,
    # best-effort: at turn end the durable Turn Journal is projected into an
    # OTel-GenAI-semconv-aligned span tree (one span per run node + nested tool spans,
    # see runtime/spans.py) and handed to the SpanExporter port. The default
    # LogSpanExporter emits it as a structured ``obs.turn_spans`` log line (greppable by
    # trace_id) — a multi-agent run's execution trace without a heavyweight OTel SDK; a
    # future OTLP exporter (跨进程 trace) is a drop-in via the same port. Disable to skip
    # the projection entirely.
    observability_span_export_enabled: bool = True

    # Durable structured suspension (结构化挂起 2b: turn 级落盘 + POST .../resume). When
    # enabled, a turn that pauses at a top-level plan_review checkpoint is persisted to
    # the paused_turns table BEFORE the in-memory wait, so a client disconnect / server
    # restart during the pause leaves a frame the resume endpoint can rebuild and
    # continue. The frame is dropped after a live in-process resolve, so a normally
    # connected turn behaves exactly as 2a. Disabled → 2a in-memory-only (a pause lost
    # on disconnect). 7-day idle TTL sweep prunes abandoned frames (mirrors the roster).
    structured_suspension_persist_enabled: bool = True
    paused_turn_retention_days: int = 7
    paused_turn_sweep_interval_seconds: int = 6 * 3600  # every 6h
    paused_turn_sweep_batch_limit: int = 200

    # Salvage a disconnected/stopped turn's already-completed worker output (断线别白干).
    # When a turn is cancelled mid-flight (client disconnect / user stop / pending
    # approval) the in-flight coroutine — and its delegated team — is torn down, so a
    # turn that never reached its reply used to vanish, discarding workers that had
    # ALREADY finished. When enabled, the cancel path persists those finished members'
    # output (the execution journal) as one "incomplete" assistant message so the work
    # is kept (zero replay risk — only what already happened is saved, no side-effect
    # tool re-runs). A turn sitting at a DURABLE plan_review / ask_user pause is left to
    # the resume path instead (no double handling); approval pauses — not journaled, not
    # resumable — are exactly what this covers. Best-effort, off the user-visible path.
    incomplete_turn_persist_enabled: bool = True

    # Recoverable worker roster persistence (留人 跨进程落盘, 乙 热修 P3). The roster
    # lives in-process (runtime/sessions.py); when enabled, each finished worker is
    # also written through to the run_sessions table so a 定向唤回 (revise) still hits
    # after a restart / memory eviction (loaded on an in-memory miss). A 7-day idle
    # TTL sweeper prunes it (mirrors workspace retention). Disabled → P2 behaviour
    # (in-memory only; a cross-process miss falls back to 甲 re-delegate).
    session_roster_persist_enabled: bool = True
    session_roster_retention_days: int = 7
    session_roster_sweep_interval_seconds: int = 6 * 3600  # every 6h
    session_roster_sweep_batch_limit: int = 200

    # Long-term memory consolidation (Agent记忆与知识系统 §1.5, 对标 Dreaming V3).
    # The user's memory file is refreshed by an OFFLINE consolidation pass — not a
    # per-turn single-exchange extract — that reads the whole recent conversation +
    # the current memory and merges / dedups / temporally-refreshes it (LLM decides
    # structured ops, deterministic code applies). It is triggered by an idle
    # debounce after a turn (reset on each new message, so it fires once the user
    # pauses), a turn-count safety cap for marathon chats, and a periodic sweeper
    # backstop (for restarts / closed clients). All best-effort, off the
    # user-visible path; state is in-process (single-server posture, like approvals).
    memory_consolidation_enabled: bool = True
    # Run consolidation this long after a conversation's last turn (each new message
    # resets the timer, so it consolidates the whole conversation once the user pauses).
    memory_consolidation_idle_seconds: float = 90.0
    # Force a consolidation every N turns even if the chat never idles (marathon guard).
    memory_consolidation_turn_cap: int = 8
    # Recent messages fed to one consolidation pass (the window reconciled against
    # the existing memory). The 1M model window makes a generous window cheap.
    memory_consolidation_window_messages: int = 40
    # Periodic sweeper backstop: scan for settled conversations with un-consolidated
    # messages and consolidate them (covers a dropped debounce / closed client).
    memory_consolidation_sweep_interval_seconds: int = 300  # every 5 min
    memory_consolidation_sweep_batch_limit: int = 100
    # Max bullets kept per memory section (合并/去重: bounds growth, forces merge).
    memory_section_bullet_cap: int = 20

    # --- Long-conversation compaction (执行引擎架构设计 §十三 长对话压缩) ---
    # A rolling summary folds turns OLDER than the recency window into 已确立事实 /
    # 决策 / 未决问题 / 文件路径, so a long chat feeds [summary] + recent turns rather
    # than the whole transcript. The win is context-rot + cache-lapse cost resilience,
    # NOT window overflow (DeepSeek's 1M does not overflow). Off-turn, token-triggered,
    # watermark-gated; state is on the conversation row (compute once, reuse — never
    # per-turn, so the exact-prefix cache holds). All best-effort, off the user path.
    compaction_enabled: bool = True
    # Trigger: when a finished turn's input tokens (DeepSeek-reported prompt size)
    # exceed this, a background pass folds the older turns. Aligned with llm.mdc's 64K
    # cost-control guidance; well under the 1M ceiling on purpose. The turn total is an
    # upper bound on the captain prompt, so the trigger is conservative (folds early);
    # the runner no-ops when there is nothing old enough to fold.
    compaction_trigger_input_tokens: int = 64_000
    # Recent messages kept VERBATIM after the watermark (older ones fold into the
    # summary). Messages, not turns — a turn is ~2 messages.
    compaction_recency_messages: int = 20
    # Don't fire the LLM for a trivial fold: need at least this many messages BEYOND
    # the recency window to be worth a summary pass.
    compaction_min_fold_messages: int = 4
    # Hard cap on messages folded in one pass (bounds the compaction call's own input);
    # a longer backlog folds incrementally across triggers, oldest-first.
    compaction_max_fold_messages: int = 200
    # Safety cap on the un-folded tail the loader replays above the summary; only hit
    # if compaction stalls (then recent-biased — see MessageRepository.list_recent_after).
    compaction_context_max_messages: int = 300
    # Char budget for the rolling summary (head+tail safety-net truncation).
    compaction_summary_char_budget: int = 4_000

    # Cost display + free-tier quotas (成本与用量可观测 §六). Money flows and is
    # stored as integer nano-USD; `cny_per_usd` converts to CNY at the display
    # boundary ONLY (single source of truth, never re-derived per site). A quota
    # of 0 means "unlimited"; the defaults are a generous starter tier (决策④)
    # tuned later by ops, and may be overridden per user (P2).
    cny_per_usd: float = 7.2
    quota_daily_tokens: int = 2_000_000
    quota_monthly_cost_usd: float = 5.0
    quota_daily_requests: int = 200

    # --- Model quality modes (质量档, llm/modes.py) ---
    # `default_model_mode` is the operator-wide default 质量档 a turn falls back to
    # when neither the conversation nor the user picked one ("economy" = all Flash).
    # `user_selectable_models` is the operator CEILING: the models a user may pick.
    # 内测决策 (方案 A-中+): Pro is pulled from the ceiling so every user turn runs
    # Flash (single tier) — the `quality` preset and any custom mode clamp to Flash
    # via `_clamp_to_ceiling`. Pro is NOT deleted (constant/pricing/judge stay): eval
    # reaches it through its own full catalog ceiling (evals/harness.py), and adding
    # "deepseek-v4-pro" back here restores the Pro tier with zero migration.
    default_model_mode: str = "economy"
    user_selectable_models: str = "deepseek-v4-flash"

    host: str = "0.0.0.0"
    port: int = 8000
    debug: bool = False

    # --- Logging (日志规范 / conversation-logs) ---
    # `log_level`: debug / info / warning / error. `log_file`: when set, the
    # runtime also writes one JSON object per line (JSONL, no ANSI) to this path —
    # the queryable 产品AI日志 that scripts/log_*.py + the conversation-logs rule
    # read. A relative path resolves against the repo root (see _PROJECT_ROOT);
    # empty = stdout only (12-factor prod posture). Dev sets it to logs/dev.jsonl.
    log_level: str = "info"
    log_file: str = ""

    # Capture LLM prompt/response bodies (the llm.request / llm.response DEBUG
    # events) — the lever for prompt tuning. OFF by default: bodies are large and
    # sensitive, so the metrics-only `llm.call` (model/scenario/tokens/latency/
    # finish_reason) always logs, but the actual prompt/completion text is only
    # captured when this is on. Even then it is TRUNCATED + secret-redacted
    # (logging.mdc 铁律: never BYOK key / never full file content). Needs LOG_LEVEL=debug
    # to surface (the events are debug-level). Use transiently while调 prompt.
    log_llm_bodies: bool = False

    # SQLAlchemy statement echo — deliberately DECOUPLED from `debug`. Turning on
    # app-level DEBUG logging should NOT also dump every SQL statement + bound
    # parameters to stdout: that回显 drowns the AI turn logs (产品AI日志) and makes a
    # conversation impossible to follow. Flip this on only when diagnosing a query;
    # it stays off even in dev by default.
    db_echo: bool = False

    # Build provenance, stamped by the release/image build (env GIT_SHA / BUILT_AT)
    # and surfaced via GET /version for traceability + instant rollback (deploy doc
    # §7 版本钉定). Defaults to "unknown" on an un-stamped build (e.g. local dev).
    git_sha: str = "unknown"
    built_at: str = "unknown"

    # Desktop auto-update remote circuit breaker (前端技术与架构.md §7.6, 部署与运维.md
    # §7.9). The desktop updater polls GET /updates/policy before each check and pauses
    # downloads when this is false — a kill switch for a bad release. **fail-open**:
    # the client treats any non-200/transport error as enabled, so an API outage never
    # strands clients without updates (the opposite default of feature flags, which
    # fail-safe). Full staged rollout (stagingPercentage) / channels ride on the
    # feature-flag system (§7.9) and are not wired here yet.
    desktop_updates_enabled: bool = True

    # Local data dir for server-side artifacts (e.g. the MVP long-term memory
    # files at <data_dir>/memory/<user_id>.md, and per-conversation/-folder
    # workspaces at <data_dir>/workspaces/...). See memory/store.py, workspace/.
    data_dir: str = "./data"

    # Workspace snapshot storage (axis-3 persistence; 双模式工作区设计 §四/§六 P1).
    # "auto" uses S3 when credentials+bucket are set, else the filesystem default
    # (snapshots under <data_dir>/snapshots). The S3 path targets any S3-compatible
    # store — Aliyun OSS in prod, MinIO in dev — so swapping vendors needs no code
    # change. Path-style addressing is the safe default (required by MinIO, fine
    # for OSS); set s3_endpoint_url to the vendor endpoint.
    storage_backend: str = "auto"  # "auto" | "filesystem" | "s3"
    s3_endpoint_url: str = ""
    s3_region: str = "cn-shenzhen"
    s3_bucket: str = "agentcore-workspaces"
    s3_access_key_id: str = ""
    s3_secret_access_key: str = ""
    s3_addressing_style: str = "path"

    # Auto-snapshot a workspace after any turn that changed its files (决策⑥:
    # 改过文件的任务结束后后台异步备份). Best-effort and off the user-visible path;
    # set false to disable automatic backups (manual snapshots still work).
    workspace_snapshot_enabled: bool = True

    # Cap on automatic (unlabeled) snapshots kept per workspace (决策⑥: 非每写必
    # 存). After each new auto snapshot the oldest auto backups beyond this count
    # are pruned; manually kept versions (labeled, 手动留版本) are never pruned.
    # 0 disables the cap (keep every auto snapshot).
    workspace_auto_snapshot_max: int = 10

    # Retention cleanup of soft-deleted workspaces (决策⑦: 与软删除对齐). A deleted
    # folder / ungrouped conversation keeps its files (recoverable) until its
    # deleted_at is older than the retention period; then a periodic background
    # sweep physically removes the workspace directory, its snapshots, and the DB
    # records. Set enabled=false to keep soft-deleted data indefinitely.
    workspace_retention_enabled: bool = True
    workspace_retention_days: int = 30
    workspace_retention_sweep_interval_seconds: int = 6 * 3600  # every 6h
    # Max folders / conversations purged per sweep (bounds one sweep's I/O).
    workspace_retention_batch_limit: int = 100

    # Max size (bytes) for a single workspace file upload (文件进出·先上传). The
    # raw request body is read into memory, so this bounds per-request memory.
    workspace_upload_max_bytes: int = 25 * 1024 * 1024  # 25 MiB

    # Max size (bytes) of a raw avatar upload (头像上传). Tighter than a workspace
    # file: it's read into memory and re-encoded to a small WebP, so the original
    # never needs to be large. Bounds per-request memory for the avatar endpoint.
    avatar_upload_max_bytes: int = 5 * 1024 * 1024  # 5 MiB

    # Timeout (seconds) for a `git clone` into a workspace (文件进出·git clone).
    # The clone is shallow (--depth 1) so this bounds a slow/large public repo.
    workspace_clone_timeout_seconds: int = 120

    # Timeout (seconds) for one local-workspace op routed to the desktop (双模式
    # 工作区 P2: LocalWorkspace). The server suspends on an asyncio Future the
    # desktop settles via the ops resolve endpoint; an op the client never
    # answers fails (raised as a WorkspaceIOError) after this — the file tool then
    # reports the failure rather than hanging the turn. Same in-process posture as
    # the approval gate (front with Redis for multiple workers).
    workspace_op_timeout_seconds: float = 60.0

    # Extra transport budget (seconds) added on top of a code execution's OWN
    # timeout when routing an ``execute`` op to the desktop (双模式工作区 P2d 执行门).
    # The desktop kills runaway code at the request's ``timeout_seconds`` (the
    # authoritative limit); the channel must outlive that by enough to cover SSE
    # delivery + process spawn + SIGKILL + the result POST round-trip, or a long
    # but legal run would lose its result to a premature transport timeout. So an
    # execute's channel deadline = ``timeout_seconds`` + this slack (NOT the flat
    # ``workspace_op_timeout_seconds``, which still bounds the quick file ops).
    workspace_execute_timeout_slack_seconds: float = 30.0

    # Transport deadline (seconds) for a local→云 handoff archive op (双模式工作区
    # P2e / e1). Packing a whole local repo into one archive over the channel is far
    # slower than a single file op, so the handoff gets its own wide budget instead
    # of the flat ``workspace_op_timeout_seconds``. The desktop caps the archive
    # size; this only bounds how long the server waits before failing the handoff as
    # a transport error (a dropped desktop still fails cleanly, never hangs).
    workspace_handoff_timeout_seconds: float = 300.0

    # --- 原生推送 (FCM, 手机端落地设计 P2) ---
    # Default OFF: with this false, build_push_sender() returns NullPushSender and
    # notify_user() short-circuits before any DB hit, so a turn carries zero push
    # overhead until an operator wires Firebase. Enable + point at a Firebase
    # service-account JSON (含 client_email / private_key / project_id) to deliver.
    push_enabled: bool = False
    # Optional override for the FCM project id; falls back to the JSON's project_id.
    fcm_project_id: str = ""
    # Filesystem path to the Firebase service-account JSON used to mint the OAuth2
    # bearer (signed with python-jose, exchanged via httpx — no new dependency).
    fcm_service_account_path: str = ""

    @property
    def cors_origins(self) -> list[str]:
        """Parsed, trimmed list of allowed CORS origins."""
        return [o.strip() for o in self.cors_allow_origins.split(",") if o.strip()]

    @property
    def selectable_models(self) -> frozenset[str]:
        """Operator ceiling: the set of models a user may pick in a custom mode."""
        return frozenset(
            m.strip() for m in self.user_selectable_models.split(",") if m.strip()
        )

    model_config = SettingsConfigDict(env_file=_ENV_FILE, env_file_encoding="utf-8")


settings = Settings()
