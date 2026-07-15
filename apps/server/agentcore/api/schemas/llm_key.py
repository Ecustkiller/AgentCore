"""BYOK LLM configuration (用户自带 OpenAI 兼容端点, llm/key_service.py) schemas."""

from pydantic import BaseModel, Field

from agentcore.config import settings
from agentcore.llm.profiles import DEEPSEEK_V4_FLASH


class SetBillingPreferenceRequest(BaseModel):
    """Switch the user's billing mode (platform free quota vs BYOK)."""

    billing_preference: str = Field(..., pattern="^(platform|byok)$")


class SetLlmKeyRequest(BaseModel):
    """Store the user's OpenAI-compatible LLM configuration (BYOK)."""

    api_key: str = Field(..., min_length=1, max_length=400)
    base_url: str | None = Field(
        default=None,
        max_length=500,
        description="OpenAI-compatible endpoint including version prefix",
        examples=[settings.platform_base_url],
    )
    default_model: str | None = Field(
        default=None,
        max_length=200,
        description="Default model name for all turns",
        examples=[DEEPSEEK_V4_FLASH],
    )
    price_cache_hit: str | None = Field(
        default=None,
        max_length=40,
        description="Optional user-defined USD per 1M cache-hit tokens (decimal string)",
    )
    price_cache_miss: str | None = Field(
        default=None,
        max_length=40,
        description="Optional user-defined USD per 1M cache-miss tokens (decimal string)",
    )
    price_output: str | None = Field(
        default=None,
        max_length=40,
        description="Optional user-defined USD per 1M output tokens (decimal string)",
    )
    background_model: str | None = Field(
        default=None,
        max_length=200,
        description="Optional cheaper model for title/memory/compaction/followups",
    )


class LlmKeyStatusResponse(BaseModel):
    """Settings view of a user's BYOK config — never the plaintext key."""

    configured: bool
    status: str
    masked_key: str | None = None
    message: str | None = None
    base_url: str | None = None
    default_model: str | None = None
    byok_model: str | None = Field(
        default=None,
        description=(
            "The user's stored BYOK model, independent of billing mode. Unlike "
            "default_model (the *effective* model, which becomes the platform model "
            "while platform billing is active), this always echoes the saved key's "
            "own model. None when no key is configured."
        ),
    )
    supports_tools: bool | None = None
    billing_mode: str = Field(
        default="byok",
        description="Effective billing mode for this user (platform free quota vs BYOK)",
    )
    billing_preference: str = Field(
        default="byok",
        description="User's stored billing preference",
    )
    platform_available: bool = Field(
        default=False,
        description="Whether platform free quota can be selected on this deployment",
    )
    platform_model: str | None = Field(
        default=None,
        description="Operator-configured model when billing_mode is platform",
    )
    free_tier_active: bool = Field(
        default=False,
        description=(
            "True when this user has no BYOK key, free tier is enabled, and "
            "platform credentials are available (keyless users can chat on free quota)"
        ),
    )
    price_cache_hit: str | None = None
    price_cache_miss: str | None = None
    price_output: str | None = None
    background_model: str | None = None
