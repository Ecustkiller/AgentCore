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

    host: str = "0.0.0.0"
    port: int = 8000
    debug: bool = False

    # Local data dir for server-side artifacts (e.g. the MVP long-term memory
    # files at <data_dir>/memory/<user_id>.md). See memory/store.py.
    data_dir: str = "./data"

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


settings = Settings()
