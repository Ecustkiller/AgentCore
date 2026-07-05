"""Auth credentials and tokens: Credentials, UserLlmKey, Invite, RefreshToken."""

from datetime import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    Integer,
    LargeBinary,
    String,
    text,
)
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from agentcore.db.base import Base

from ._helpers import _new_uuid

# --- Credentials ---
# Local password auth, separated from the user profile. One row per user.


class Credentials(Base):
    __tablename__ = "credentials"

    user_id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), primary_key=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    # Brute-force lockout bookkeeping.
    failed_attempts: Mapped[int] = mapped_column(Integer, default=0, server_default=text("0"))
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Set by admin password reset; cleared after the user sets a new password on next login.
    password_must_change: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=text("false")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()")
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()"), onupdate=datetime.now
    )


# --- User LLM keys (BYOK) ---
# 用户自带 DeepSeek API Key（内测期唯一计费路径，见 config.billing_mode）。一人
# 一行：endpoint / model 由服务端固定（DeepSeek-only），故此处只存「加密后的 key
# + 连通状态」，不存 endpoint / model。明文永不落库——api_key_enc 是 AES-256-GCM
# 密文（security.KeyEncryptor 加密，解析见 llm/byok.py）。


class UserLlmKey(Base):
    __tablename__ = "user_llm_keys"
    __table_args__ = (
        CheckConstraint(
            "status in ('unchecked', 'active', 'error')",
            name="ck_user_llm_keys_status",
        ),
    )

    user_id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), primary_key=True)
    # AES-256-GCM ciphertext (nonce ‖ ct+tag); never the plaintext key.
    api_key_enc: Mapped[bytes] = mapped_column(LargeBinary)
    # Last connectivity-test outcome surfaced in 设置·模型配置 ('测试连接'):
    # 'unchecked' until tested, then 'active'/'error'. Reset to 'unchecked' on
    # every key change (a new key hasn't been verified yet).
    status: Mapped[str] = mapped_column(
        String(20), default="unchecked", server_default=text("'unchecked'")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()")
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()"), onupdate=datetime.now
    )


# --- Invites ---
# Invite-code gated registration (D6).


class Invite(Base):
    __tablename__ = "invites"

    id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), primary_key=True, default=_new_uuid)
    code: Mapped[str] = mapped_column(String(64), unique=True)
    created_by: Mapped[str | None] = mapped_column(
        PG_UUID(as_uuid=False), index=True, nullable=True
    )
    used_by: Mapped[str | None] = mapped_column(PG_UUID(as_uuid=False), index=True, nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Admin revocation (邀请码撤销): set when an admin kills an unused code so it can
    # no longer register an account. Distinct from expiry (time-based) and use
    # (consumed) — a revoked code was deliberately retired before either happened.
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()")
    )


# --- Refresh Tokens ---


class RefreshToken(Base):
    __tablename__ = "refresh_tokens"

    id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), primary_key=True, default=_new_uuid)
    user_id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), index=True)
    token_hash: Mapped[str] = mapped_column(String(255))
    token_family: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), index=True)
    # Session audience bound at issuance (product vs admin); refresh inherits it.
    client_aud: Mapped[str] = mapped_column(
        String(20), default="product", server_default=text("'product'")
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    rotated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()")
    )
