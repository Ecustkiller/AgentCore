"""5xx user-facing copy (A′): capacity phrasing for all leaves; body in preview."""

from __future__ import annotations

import pytest

from agentcore.core.errors import LLMUpstreamError
from agentcore.llm.provider.openai_compatible import OpenAICompatibleProvider


@pytest.mark.parametrize("leaf_name", ["platform", "user", "deepseek"])
def test_upstream_503_uses_capacity_copy_for_all_leaves(leaf_name: str):
    leaf = OpenAICompatibleProvider(
        name=leaf_name, api_key="k", base_url="http://example.com/v1"
    )
    with pytest.raises(LLMUpstreamError) as ei:
        leaf._raise_for_status(
            503,
            1.0,
            {},
            body=b'{"error":{"message":"overloaded"}}',
            attempt=0,
        )
    err = ei.value
    assert str(err) == "上游模型服务暂时不可用（503），请稍后再试"
    assert "服务端错误" not in str(err)
    assert leaf_name not in str(err)
    assert err.details.get("upstream_status") == 503
    assert "overloaded" in (err.details.get("upstream_body_preview") or "")


def test_named_provider_502_same_capacity_copy():
    leaf = OpenAICompatibleProvider(
        name="deepseek", api_key="k", base_url="http://example.com/v1"
    )
    with pytest.raises(LLMUpstreamError) as ei:
        leaf._raise_for_status(502, 1.0, {}, body=None, attempt=0)
    assert str(ei.value) == "上游模型服务暂时不可用（502），请稍后再试"
