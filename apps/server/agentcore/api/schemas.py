"""Pydantic request/response schemas for API layer."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

# --- Auth ---


class RegisterRequest(BaseModel):
    username: str = Field(..., min_length=3, max_length=100)
    password: str = Field(..., min_length=8, max_length=256)
    invite_code: str = Field(..., min_length=1, max_length=64)
    display_name: str | None = Field(None, max_length=200)
    # Plain string for now (email is a reserved/optional profile field); upgrade
    # to validated EmailStr if/when email-validator is added as a dependency.
    email: str | None = Field(None, max_length=255)


class LoginRequest(BaseModel):
    username: str = Field(..., min_length=1, max_length=100)
    password: str = Field(..., min_length=1, max_length=256)


class UserResponse(BaseModel):
    id: str
    username: str
    display_name: str
    email: str | None
    role: str
    created_at: datetime


# --- Conversations ---


class CreateConversationRequest(BaseModel):
    title: str | None = None


class ConversationSummary(BaseModel):
    id: str
    title: str | None
    updated_at: datetime
    created_at: datetime

    model_config = {"from_attributes": True}


class ConversationListResponse(BaseModel):
    data: list[ConversationSummary]
    total: int
    page: int
    page_size: int


class UpdateConversationRequest(BaseModel):
    title: str | None = None


# --- Messages ---


class MessageAttachment(BaseModel):
    """A file the user referenced (@-mention or paperclip) as message context.

    Text is extracted client-side from an authorized local root; this MVP carries
    only text-extractable files (images are out of scope until a vision model).
    """

    name: str = Field(..., min_length=1, max_length=500)
    path: str = Field(..., max_length=4000)
    # File: extracted text. Directory: a recursive file listing (paths only, no
    # file bodies) built client-side.
    text: str = Field(..., max_length=300_000)
    truncated: bool = False
    kind: Literal["file", "dir"] = "file"


class StoredAttachment(BaseModel):
    """Persisted attachment display metadata (no extracted text)."""

    name: str
    path: str
    truncated: bool = False
    kind: Literal["file", "dir"] = "file"


class SendMessageRequest(BaseModel):
    content: str = Field(..., min_length=1, max_length=32000)
    attachments: list[MessageAttachment] = Field(default_factory=list, max_length=20)


class RegenerateMessageRequest(BaseModel):
    """Re-run a turn from an existing user message.

    The path's ``message_id`` must be a user message. When ``content`` is set the
    user message is edited in place first (edit-and-resend); otherwise the stored
    text is reused as-is (plain regenerate). Either way, every message after that
    user turn is dropped and the assistant reply is produced anew.
    """

    content: str | None = Field(None, min_length=1, max_length=32000)


class ResolveCheckpointRequest(BaseModel):
    action: Literal["approve", "adjust", "stop"]
    feedback: str | None = Field(None, max_length=32000)


class AgentOverridePayload(BaseModel):
    """One agent's user-chosen override at the team-preview gate (提案 B).

    ``thinking`` / ``reasoning_effort`` are still clamped upgrade-only against the
    tier baseline when the run resolves them, so a user raises capability and
    downgrades by choosing the ``fast`` tier.
    """

    model_preference: Literal["fast", "strong"] | None = None
    thinking: bool | None = None
    reasoning_effort: Literal["high", "max"] | None = None


class ResolvePlanReviewRequest(BaseModel):
    """User's decision at the pre-execution team-preview gate.

    ``start`` begins the run, optionally applying per-agent model overrides
    (tier + reasoning depth); ``cancel`` aborts before anything runs.
    """

    action: Literal["start", "cancel"]
    overrides: dict[str, AgentOverridePayload] | None = None


class MessageDetail(BaseModel):
    id: str
    conversation_id: str
    role: str
    content: str | None
    reasoning_content: str | None = None
    attachments: list[StoredAttachment] = Field(default_factory=list)
    created_at: datetime

    model_config = {"from_attributes": True}


class MessageListResponse(BaseModel):
    data: list[MessageDetail]
    total: int
    page: int
    page_size: int


# --- Generic ---


class StatusResponse(BaseModel):
    status: str = "ok"
