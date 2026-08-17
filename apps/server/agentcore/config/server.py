"""HTTP server, logging, build provenance, desktop updates, client floors, push."""

from typing import Self

from pydantic import BaseModel, model_validator


class ServerSettings(BaseModel):
    host: str = "0.0.0.0"
    port: int = 8000
    debug: bool = False
    # None = follow debug (WatchFiles on when DEBUG=true). Explicit false keeps
    # DEBUG=true (dev logs / auto-migrate) but disables uvicorn hot-reload for
    # long live collaboration runs. Env: AGENTCORE_RELOAD.
    agentcore_reload: bool | None = None
    # Production uvicorn drain after SIGTERM. None used to wait forever on SSE
    # keep-alives and never reach FastAPI lifespan (Docker then SIGKILL at 40s).
    # Reload mode still uses a 2s hard cap in ``__main__`` (WatchFiles + long SSE).
    uvicorn_graceful_shutdown_seconds: float = 5.0
    # Hard cap for lifespan work after turn salvage (ledger / browsers / folds).
    # Docker stop_grace_period stays 40s: 5 drain + 20 salvage + 8 teardown + 7 slack.
    shutdown_teardown_seconds: float = 8.0

    log_level: str = "info"
    log_file: str = ""
    log_llm_bodies: bool = False

    git_sha: str = "unknown"
    built_at: str = "unknown"

    desktop_updates_enabled: bool = True
    # Desktop floor (GET /updates/policy → min_desktop_version + HTTP 426 hard gate).
    # Empty = no banner / no API gate (dev-friendly). Production e.g. 0.6.25.
    desktop_min_version: str = ""
    # Native mobile floor (HTTP 426 hard gate). Covers android / ios; mobile-web is a
    # browser surface and never gated. Deliberately absent from /updates/policy — the
    # Android shell discovers versions from the brand CDN android/latest.json, never
    # that endpoint (发布与门禁.md §7.6a). Empty = no gate; raising it is a release-time
    # decision, so production ships empty.
    mobile_min_version: str = ""

    push_enabled: bool = False
    fcm_project_id: str = ""
    fcm_service_account_path: str = ""

    @model_validator(mode="after")
    def _default_dev_log_file(self) -> Self:
        """Dev writes queryable JSONL without requiring LOG_FILE in .env."""
        if self.debug and not self.log_file:
            self.log_file = "logs/dev.jsonl"
        return self
