"""HTTP server, logging, build provenance, desktop updates, push."""

from pydantic import BaseModel


class ServerSettings(BaseModel):
    host: str = "0.0.0.0"
    port: int = 8000
    debug: bool = False

    log_level: str = "info"
    log_file: str = ""
    log_llm_bodies: bool = False

    git_sha: str = "unknown"
    built_at: str = "unknown"

    desktop_updates_enabled: bool = True

    push_enabled: bool = False
    fcm_project_id: str = ""
    fcm_service_account_path: str = ""
