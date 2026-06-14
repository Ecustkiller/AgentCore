"""Application configuration loaded from environment variables."""

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = "postgresql+asyncpg://agentcore:agentcore@localhost:5432/agentcore"
    redis_url: str = "redis://localhost:6379/0"

    deepseek_api_key: str = ""
    deepseek_base_url: str = "https://api.deepseek.com"

    # Web search via a self-hosted SearXNG instance (engine set curated to
    # mainland-China-reachable engines, see deploy/searxng/settings.yml). Dev port
    # 18888 avoids the Windows winnat reserved range 8866–8965.
    searxng_url: str = "http://localhost:18888"

    jwt_secret_key: str = "dev-secret-change-in-production"
    jwt_access_token_expire_minutes: int = 30
    jwt_refresh_token_expire_days: int = 7

    # Auth cookies. `secure` requires HTTPS (keep False for local http dev).
    # `samesite` "lax" is a compatibility-friendly default that still blocks
    # cross-site POST CSRF; tighten to "strict" once the client origin is fixed.
    cookie_secure: bool = False
    cookie_samesite: str = "lax"

    # CORS: browser/desktop origins allowed to call the API with credentials.
    # Credentialed CORS forbids "*", so each origin must be listed. Comma-separated
    # in the env var; read as a list via the `cors_origins` property.
    cors_allow_origins: str = "http://localhost:5173,http://localhost:3000"

    # Auth-endpoint rate limiting (per client IP, fixed window). Blunts
    # credential-stuffing / registration spam on top of per-account lockout.
    # State is in-process, so it assumes a single server process — front with
    # Redis if you scale to multiple workers.
    rate_limit_enabled: bool = True
    auth_rate_limit_max: int = 10
    auth_rate_limit_window_seconds: int = 60
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

    # Cost display + free-tier quotas (成本与用量可观测 §六). Money flows and is
    # stored as integer nano-USD; `cny_per_usd` converts to CNY at the display
    # boundary ONLY (single source of truth, never re-derived per site). A quota
    # of 0 means "unlimited"; the defaults are a generous starter tier (决策④)
    # tuned later by ops, and may be overridden per user (P2).
    cny_per_usd: float = 7.2
    quota_daily_tokens: int = 2_000_000
    quota_monthly_cost_usd: float = 5.0
    quota_daily_requests: int = 200

    host: str = "0.0.0.0"
    port: int = 8000
    debug: bool = False

    # Build provenance, stamped by the release/image build (env GIT_SHA / BUILT_AT)
    # and surfaced via GET /version for traceability + instant rollback (deploy doc
    # §7 版本钉定). Defaults to "unknown" on an un-stamped build (e.g. local dev).
    git_sha: str = "unknown"
    built_at: str = "unknown"

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

    # Max size (bytes) for a single workspace file upload (文件进出·先上传). The
    # raw request body is read into memory, so this bounds per-request memory.
    workspace_upload_max_bytes: int = 25 * 1024 * 1024  # 25 MiB

    # Timeout (seconds) for a `git clone` into a workspace (文件进出·git clone).
    # The clone is shallow (--depth 1) so this bounds a slow/large public repo.
    workspace_clone_timeout_seconds: int = 120

    @property
    def cors_origins(self) -> list[str]:
        """Parsed, trimmed list of allowed CORS origins."""
        return [o.strip() for o in self.cors_allow_origins.split(",") if o.strip()]

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


settings = Settings()
