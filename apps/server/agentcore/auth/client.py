"""Client platform identification for session audience (aud) binding."""

from typing import Literal

from fastapi import Header

from agentcore.core.errors import ValidationError

ClientPlatform = Literal["desktop", "admin", "mobile", "web"]
TokenAudience = Literal["product", "admin"]

_PRODUCT_PLATFORMS: frozenset[str] = frozenset({"desktop", "mobile", "web"})
# ChannelProfile mobile surfaces → auth ``mobile`` (product aud).
_MOBILE_ALIASES: frozenset[str] = frozenset({"mobile", "android", "ios", "mobile-web"})


def parse_client_platform(
    x_client_platform: str | None = Header(default=None, alias="X-Client-Platform"),
) -> ClientPlatform:
    """Resolve the calling client from ``X-Client-Platform`` (fail-closed).

    Missing / blank / unknown values raise :class:`ValidationError` — never
    legacy-default to ``desktop``. Known product surfaces align with
    :func:`resolve_channel_profile` (``web`` kept distinct; mobile aliases
    collapse to ``mobile`` for JWT aud / session meta).
    """
    raw = (x_client_platform or "").strip().lower()
    if not raw:
        raise ValidationError("缺少 X-Client-Platform 请求头")
    if raw == "admin":
        return "admin"
    if raw == "desktop":
        return "desktop"
    if raw == "web":
        return "web"
    if raw in _MOBILE_ALIASES:
        return "mobile"
    raise ValidationError("未知的 X-Client-Platform")


def platform_to_audience(platform: ClientPlatform) -> TokenAudience:
    """Map a client platform to the JWT ``aud`` claim issued at login."""
    return "admin" if platform == "admin" else "product"


def is_product_platform(platform: ClientPlatform) -> bool:
    return platform in _PRODUCT_PLATFORMS
