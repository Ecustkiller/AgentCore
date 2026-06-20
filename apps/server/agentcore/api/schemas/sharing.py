"""Conversation share (公开只读分享链接: 对标 ChatGPT 分享) schemas."""

from datetime import datetime

from pydantic import BaseModel


class ShareSummary(BaseModel):
    """One public read-only conversation share (分享链接).

    ``url`` is a RELATIVE path (``/shared/<id>``) — like ``UserResponse.avatar_url``,
    the client prepends the API origin so the backend stays agnostic of its public
    host. ``id`` is the management handle (used to revoke); it is also the URL token.
    """

    id: str
    url: str
    title: str
    created_at: datetime


class ShareListResponse(BaseModel):
    data: list[ShareSummary]
    total: int
