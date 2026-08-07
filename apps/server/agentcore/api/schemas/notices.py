"""Product notice schemas (全局 Notice)."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator

Severity = Literal["critical", "high", "normal"]
Surface = Literal["banner", "inbox", "both", "modal"]
NoticeStatus = Literal["draft", "published", "archived"]
DismissPolicy = Literal["once", "never"]
CardTemplate = Literal["service", "article"]


def _empty_str_to_none(value: str | None) -> str | None:
    if value is None:
        return None
    stripped = value.strip()
    return stripped or None


class CreateNoticeRequest(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)
    body: str = Field(..., min_length=1)
    severity: Severity = "normal"
    surface: Surface = "both"
    dismiss_policy: DismissPolicy = "once"
    card_template: CardTemplate | None = None
    summary: str | None = None
    cover_url: str | None = Field(None, max_length=2000)
    cta_label: str | None = Field(None, max_length=100)
    cta_url: str | None = Field(None, max_length=2000)
    start_at: datetime | None = None
    end_at: datetime | None = None

    @field_validator("summary", "cover_url", mode="before")
    @classmethod
    def _blank_optional(cls, value: object) -> object:
        if isinstance(value, str):
            return _empty_str_to_none(value)
        return value


class UpdateNoticeRequest(BaseModel):
    title: str | None = Field(None, min_length=1, max_length=200)
    body: str | None = Field(None, min_length=1)
    severity: Severity | None = None
    surface: Surface | None = None
    dismiss_policy: DismissPolicy | None = None
    card_template: CardTemplate | None = None
    summary: str | None = None
    cover_url: str | None = Field(None, max_length=2000)
    cta_label: str | None = Field(None, max_length=100)
    cta_url: str | None = Field(None, max_length=2000)
    start_at: datetime | None = None
    end_at: datetime | None = None

    @field_validator("summary", "cover_url", mode="before")
    @classmethod
    def _blank_optional(cls, value: object) -> object:
        if isinstance(value, str):
            return _empty_str_to_none(value)
        return value


class NoticeSummary(BaseModel):
    id: str
    title: str
    body: str
    severity: str
    surface: str
    status: str
    dismiss_policy: str
    card_template: str
    summary: str | None
    cover_url: str | None
    cta_label: str | None
    cta_url: str | None
    start_at: datetime | None
    end_at: datetime | None
    created_by: str
    created_at: datetime
    updated_at: datetime
    published_at: datetime | None


class NoticeListResponse(BaseModel):
    data: list[NoticeSummary]
    total: int


class ActiveNotice(BaseModel):
    id: str
    title: str
    body: str
    severity: str
    surface: str
    dismiss_policy: str
    card_template: str
    summary: str | None
    cover_url: str | None
    cta_label: str | None
    cta_url: str | None
    published_at: datetime | None
    dismissed: bool


class ActiveNoticesResponse(BaseModel):
    banner: ActiveNotice | None
    modal: ActiveNotice | None
    inbox: list[ActiveNotice]
