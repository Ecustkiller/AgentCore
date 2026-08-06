"""Auth ``parse_client_platform``: fail-closed, no legacy desktop default."""

from __future__ import annotations

import pytest

from agentcore.auth.client import (
    is_product_platform,
    parse_client_platform,
    platform_to_audience,
)
from agentcore.core.errors import ValidationError


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("desktop", "desktop"),
        ("Desktop", "desktop"),
        ("admin", "admin"),
        ("web", "web"),
        ("mobile", "mobile"),
        ("android", "mobile"),
        ("ios", "mobile"),
        ("mobile-web", "mobile"),
    ],
)
def test_parse_client_platform_known(raw: str, expected: str):
    assert parse_client_platform(raw) == expected


@pytest.mark.parametrize("raw", [None, "", "  ", "unknown", "cli", "electron"])
def test_parse_client_platform_fail_closed(raw: str | None):
    with pytest.raises(ValidationError):
        parse_client_platform(raw)


def test_platform_to_audience_and_product():
    assert platform_to_audience("admin") == "admin"
    assert platform_to_audience("desktop") == "product"
    assert platform_to_audience("web") == "product"
    assert platform_to_audience("mobile") == "product"
    assert is_product_platform("desktop")
    assert is_product_platform("web")
    assert is_product_platform("mobile")
    assert not is_product_platform("admin")
