"""Auth, cookies, CORS, and rate-limit settings."""

from pydantic import BaseModel, computed_field


class AuthSettings(BaseModel):
    jwt_secret_key: str = "dev-secret-change-in-production"
    jwt_access_token_expire_minutes: int = 30
    jwt_refresh_token_expire_days: int = 7
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

    csrf_enabled: bool = True
    # ``memory`` = process-local counters (dev / single worker). ``redis`` = shared
    # limiters + CSRF store for multi-worker production.
    rate_limit_backend: str = "memory"

    @computed_field  # type: ignore[prop-decorator]
    @property
    def cors_origins(self) -> list[str]:
        """Parsed, trimmed list of allowed CORS origins."""
        return [o.strip() for o in self.cors_allow_origins.split(",") if o.strip()]
