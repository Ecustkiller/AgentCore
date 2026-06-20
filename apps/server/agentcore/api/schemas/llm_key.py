"""BYOK LLM key (用户自带 DeepSeek key, llm/key_service.py) schemas."""

from pydantic import BaseModel, Field


class SetLlmKeyRequest(BaseModel):
    """Store the user's own DeepSeek API key (BYOK)."""

    api_key: str = Field(..., min_length=1, max_length=400)


class LlmKeyStatusResponse(BaseModel):
    """Settings view of a user's BYOK key — never the plaintext key."""

    configured: bool
    # unconfigured | unchecked | active | error
    status: str
    # Last 4 chars only (e.g. "••••cdef"), for recognition.
    masked_key: str | None = None
    # Connectivity-test failure reason (POST .../test), surfaced when status="error".
    message: str | None = None
