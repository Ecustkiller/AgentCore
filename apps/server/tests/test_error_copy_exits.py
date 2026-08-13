"""每条用户面错误文案指向的出口，必须真的存在。

两个反复踩的坑，各自烧掉过一批用户的时间：

1. **「设置 · 模型配置」**——设置里并列的是「模型」和「服务商」两项，从来没有
   叫「模型配置」的页。文案让人去填 key，人翻遍设置找不到那一页。
2. **「点重试」/「点击重试」**——红错误卡按定案 A 不挂重试入口
   （``AssistantMessage.tsx``），最接近的「重新生成」还会截断后续历史。点名一个
   不存在的按钮，等于让人在屏幕上白找。「请稍后再试」= 重发本条，没有这个问题。

新增用户面文案时把它挂进 ``_USER_FACING_COPY`` 即可，这两条不必再各写一遍。
"""

from __future__ import annotations

import pytest

from agentcore.conversation.quota import _BYOK_EXIT
from agentcore.core.errors import (
    BYOK_KEY_REQUIRED_MESSAGE,
    MAX_RETRY_AFTER,
    InferenceTokenExpiredError,
    LLMAuthError,
    LLMInsufficientBalanceError,
    LLMKeyRequiredError,
    LLMQuotaExceededError,
    LLMRateLimitError,
    upstream_rate_limit_error,
)
from agentcore.llm.factory import _MISSING_LLM_CREDENTIALS_USER_MESSAGE
from agentcore.llm.tools_gate import (
    TOOLS_SOFT_GATE_WARNING,
    TOOLS_UNAVAILABLE_RUNTIME_MESSAGE,
)

# 设置里真实存在的两页（apps/desktop … MorePage.tsx: /more/model · /more/providers）。
_REAL_SETTINGS_PAGES = ("设置 · 模型", "设置 · 服务商", "设置·模型", "设置·服务商")

_USER_FACING_COPY: dict[str, str] = {
    "byok_key_required": BYOK_KEY_REQUIRED_MESSAGE,
    "llm_key_required": LLMKeyRequiredError().message,
    "quota_exceeded": LLMQuotaExceededError().message,
    "quota_byok_exit": _BYOK_EXIT,
    "auth_byok": LLMAuthError(provider_name="user").message,
    "auth_platform": LLMAuthError(provider_name="platform").message,
    "balance_byok": LLMInsufficientBalanceError(provider_name="user").message,
    "balance_platform": LLMInsufficientBalanceError(provider_name="platform").message,
    "inference_token_expired": InferenceTokenExpiredError().message,
    "rate_limit_unknown_cooldown": LLMRateLimitError().message,
    "rate_limit_short_cooldown": LLMRateLimitError(retry_after=12).message,
    "rate_limit_day_reset_byok": upstream_rate_limit_error(
        59760.0, credential_source="user"
    ).message,
    "rate_limit_day_reset_platform": upstream_rate_limit_error(
        59760.0, credential_source="platform"
    ).message,
    "rate_limit_at_ceiling": upstream_rate_limit_error(MAX_RETRY_AFTER).message,
    "missing_credentials": _MISSING_LLM_CREDENTIALS_USER_MESSAGE,
    "tools_soft_gate": TOOLS_SOFT_GATE_WARNING,
    "tools_unavailable": TOOLS_UNAVAILABLE_RUNTIME_MESSAGE,
}


@pytest.mark.parametrize("name", sorted(_USER_FACING_COPY))
def test_copy_never_names_a_settings_page_that_does_not_exist(name):
    assert "模型配置" not in _USER_FACING_COPY[name]


@pytest.mark.parametrize("name", sorted(_USER_FACING_COPY))
def test_copy_never_tells_the_user_to_press_a_retry_button(name):
    copy = _USER_FACING_COPY[name]
    assert "点重试" not in copy
    assert "点击重试" not in copy


@pytest.mark.parametrize("name", sorted(_USER_FACING_COPY))
def test_copy_that_routes_to_settings_names_a_real_page(name):
    """提到「设置」就必须落在真实那两页之一，不能是含糊的第三个名字。"""
    copy = _USER_FACING_COPY[name]
    if "设置" not in copy:
        return
    assert any(page in copy for page in _REAL_SETTINGS_PAGES), copy


def test_key_required_copy_is_single_sourced_across_leaf_and_preflight():
    """曾经同一句话散在四处，改页名要改四遍——改一遍就漏一处。"""
    from agentcore.api.routes.conversations import _helpers
    from agentcore.api.routes.inference import proxy

    assert LLMKeyRequiredError().message == BYOK_KEY_REQUIRED_MESSAGE
    assert _helpers.BYOK_KEY_REQUIRED_MESSAGE is BYOK_KEY_REQUIRED_MESSAGE
    assert proxy.BYOK_KEY_REQUIRED_MESSAGE is BYOK_KEY_REQUIRED_MESSAGE


def test_key_related_copy_points_at_the_provider_page_not_the_model_page():
    """key 存在「服务商」，换模型才是「模型」——两页别互指。"""
    assert "设置 · 服务商" in BYOK_KEY_REQUIRED_MESSAGE
    assert "设置 · 服务商" in LLMAuthError(provider_name="user").message
    assert "设置 · 模型" in TOOLS_UNAVAILABLE_RUNTIME_MESSAGE
    assert "设置 · 模型" in _MISSING_LLM_CREDENTIALS_USER_MESSAGE
