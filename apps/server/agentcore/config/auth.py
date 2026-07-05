"""Auth, cookies, CORS, and rate-limit settings."""

from pydantic import BaseModel, computed_field


class AuthSettings(BaseModel):
    jwt_secret_key: str = "dev-secret-change-in-production"
    jwt_access_token_expire_minutes: int = 30
    # Refresh tokens rotate on every use and each rotation stamps a fresh
    # now+N-day expiry (auth/service.py _issue_tokens) with no absolute family
    # cap — a *sliding* window: any launch within N days of the last keeps the
    # user signed in. 30d (was 7d) tolerates a month of inactivity before a forced
    # re-login. The refresh + CSRF cookies' max_age both track this value.
    jwt_refresh_token_expire_days: int = 30
    inference_token_expire_minutes: int = 120  # 2h — scoped sidecar proxy token

    inference_token_mint_max: int = 10
    inference_token_mint_window_seconds: int = 60

    cookie_secure: bool = False
    cookie_samesite: str = "lax"
    cookie_path_prefix: str = ""

    cors_allow_origins: str = (
        "http://localhost:5173,http://localhost:5174,http://localhost:3000,"
        "http://localhost:5175,app://agentcore,"
        "capacitor://localhost,http://localhost,https://localhost"
    )

    rate_limit_enabled: bool = True
    auth_rate_limit_max: int = 10
    auth_rate_limit_window_seconds: int = 60
    user_message_rate_limit_max: int = 20
    user_message_rate_limit_window_seconds: int = 60
    trust_proxy: bool = False
    # When trust_proxy is on, the client IP is read from X-Forwarded-For. XFF is appended
    # left→right by each hop, so the *leftmost* entry is client-controlled and trivially
    # spoofed to rotate the rate-limit key past per-IP throttling; the trustworthy value
    # is the entry your own proxy appended, counted from the RIGHT. Set this to the number
    # of trusted proxies you run in front of the app (1 = one nginx; 2 = CDN + nginx), so
    # the limiter keys off ``parts[-trusted_proxy_hops]`` (SEC-008).
    trusted_proxy_hops: int = 1

    csrf_enabled: bool = True

    # TOTP issuer shown in authenticator apps (admin MFA).
    mfa_issuer_name: str = "AgentCore Admin"
    # When false, admin login is password-only (session isolation still applies).
    admin_mfa_required: bool = True
    # ``memory`` = process-local counters (dev / single worker). ``redis`` = shared
    # limiters + CSRF store for multi-worker production.
    rate_limit_backend: str = "memory"

    @computed_field  # type: ignore[prop-decorator]
    @property
    def cors_origins(self) -> list[str]:
        """Parsed, trimmed list of allowed CORS origins."""
        return [o.strip() for o in self.cors_allow_origins.split(",") if o.strip()]
