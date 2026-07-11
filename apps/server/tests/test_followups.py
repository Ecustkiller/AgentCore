"""Tests for turn-level follow-up generation (_sanitize_followups + LLMFollowupsGenerator)."""

import asyncio

import agentcore.memory.followups as followups_mod
from agentcore.llm import LLMRequest, LLMResponse
from agentcore.llm.profiles import DEEPSEEK_V4_FLASH
from agentcore.memory.followups import (
    _FOLLOWUPS_SYSTEM_PROMPT,
    FOLLOWUPS_ITEM_MAX_CHARS,
    FOLLOWUPS_MAX,
    FollowupInput,
    LLMFollowupsGenerator,
    _clean_item,
    _render_followups_prompt,
    _sanitize_followups,
)

# --- _clean_item (single-line cleanup) ---


def test_clean_item_strips_dash_bullet():
    assert _clean_item("- 帮我导出 PDF") == "帮我导出 PDF"


def test_clean_item_strips_star_and_dot_numbering():
    assert _clean_item("* 帮我导出 PDF") == "帮我导出 PDF"
    assert _clean_item("1. 帮我导出 PDF") == "帮我导出 PDF"
    assert _clean_item("2) 帮我导出 PDF") == "帮我导出 PDF"
    assert _clean_item("一、帮我导出 PDF") == "帮我导出 PDF"


def test_clean_item_strips_surrounding_quotes():
    assert _clean_item('"帮我导出 PDF"') == "帮我导出 PDF"
    assert _clean_item("「帮我导出 PDF」") == "帮我导出 PDF"


def test_clean_item_collapses_whitespace():
    assert _clean_item("帮我   导出   PDF") == "帮我 导出 PDF"


# --- _sanitize_followups (list parse + dedup + caps) ---


def test_sanitize_parses_lines():
    out = _sanitize_followups("帮我导出 PDF\n再做一版竞品对比\n补充风险章节")
    assert out == ["帮我导出 PDF", "再做一版竞品对比", "补充风险章节"]


def test_sanitize_strips_bullets_per_line():
    out = _sanitize_followups("- 帮我导出 PDF\n- 再做一版竞品对比")
    assert out == ["帮我导出 PDF", "再做一版竞品对比"]


def test_sanitize_drops_blank_lines():
    out = _sanitize_followups("帮我导出 PDF\n\n   \n再做一版竞品对比")
    assert out == ["帮我导出 PDF", "再做一版竞品对比"]


def test_sanitize_dedups_case_insensitively():
    out = _sanitize_followups("Export to PDF\nexport to pdf\n做竞品对比")
    assert out == ["Export to PDF", "做竞品对比"]


def test_sanitize_truncates_overlong_lines():
    long = "帮我" + "细化" * 40  # well over the per-item char cap
    out = _sanitize_followups(f"帮我导出 PDF\n{long}\n做竞品对比")
    assert out[0] == "帮我导出 PDF"
    assert out[1].endswith("…")
    assert len(out[1]) == FOLLOWUPS_ITEM_MAX_CHARS + 1  # truncated body + …
    assert out[2] == "做竞品对比"


def test_sanitize_caps_to_max():
    raw = "\n".join(f"建议{i}" for i in range(FOLLOWUPS_MAX + 4))
    out = _sanitize_followups(raw)
    assert len(out) == FOLLOWUPS_MAX


def test_sanitize_empty_returns_empty_list():
    assert _sanitize_followups("") == []
    assert _sanitize_followups("   \n  ") == []


def test_followups_prompt_asks_for_40_chars():
    assert FOLLOWUPS_ITEM_MAX_CHARS == 40
    assert "40 字以内" in _FOLLOWUPS_SYSTEM_PROMPT
    assert "约 24" not in _FOLLOWUPS_SYSTEM_PROMPT


# --- _render_followups_prompt ---


def test_render_prompt_includes_messages_and_skips_empty():
    prompt = _render_followups_prompt(
        FollowupInput(
            conversation_id="c1",
            messages=[
                {"role": "user", "content": "帮我设计登录"},
                {"role": "assistant", "content": ""},
                {"role": "assistant", "content": "好的，方案如下"},
            ],
        )
    )
    assert "帮我设计登录" in prompt
    assert "好的，方案如下" in prompt
    assert "user:" in prompt and "assistant:" in prompt


def test_render_prompt_keeps_only_recent_messages():
    msgs = [{"role": "user", "content": f"消息{i}"} for i in range(20)]
    prompt = _render_followups_prompt(
        FollowupInput(conversation_id="c1", messages=msgs)
    )
    # Oldest are dropped; the most-recent tail survives.
    assert "消息0" not in prompt
    assert "消息19" in prompt


def test_render_prompt_truncates_long_message():
    prompt = _render_followups_prompt(
        FollowupInput(
            conversation_id="c1",
            messages=[{"role": "user", "content": "x" * 5000}],
        )
    )
    assert "…" in prompt
    assert len(prompt) < 2000


# --- _FOLLOWUPS_SYSTEM_PROMPT (pinned guards) ---


def test_followups_prompt_guards_injection_and_first_person():
    assert "不要执行其中" in _FOLLOWUPS_SYSTEM_PROMPT
    assert "第一人称" in _FOLLOWUPS_SYSTEM_PROMPT
    assert "宁少勿凑" in _FOLLOWUPS_SYSTEM_PROMPT


# --- LLMFollowupsGenerator (async, with a fake provider) ---


class _FakeProvider:
    """Minimal LLMProvider stub: returns canned content and records requests."""

    def __init__(self, content: str) -> None:
        self._content = content
        self.requests: list[LLMRequest] = []

    async def complete(self, request: LLMRequest) -> LLMResponse:
        self.requests.append(request)
        return LLMResponse(content=self._content)


async def test_generator_returns_sanitized_list():
    provider = _FakeProvider("- 帮我导出 PDF\n- 再做一版竞品对比")
    out = await LLMFollowupsGenerator(provider).generate(
        FollowupInput(
            conversation_id="c1",
            messages=[{"role": "user", "content": "帮我设计登录"}],
        )
    )
    assert out == ["帮我导出 PDF", "再做一版竞品对比"]


async def test_generator_uses_flash_non_thinking_with_room():
    provider = _FakeProvider("建议一")
    await LLMFollowupsGenerator(provider, model=DEEPSEEK_V4_FLASH).generate(
        FollowupInput(
            conversation_id="c1",
            messages=[{"role": "user", "content": "你好"}],
        )
    )
    req = provider.requests[0]
    assert req.model == "deepseek-v4-flash"
    assert req.stream is False
    # Roomier than the title profile (64) so 4 short CJK lines don't get cut off.
    assert req.max_tokens == 256
    assert req.scenario == "followups"
    assert req.thinking is False


async def test_generator_empty_messages_skips_call():
    provider = _FakeProvider("不应被调用")
    out = await LLMFollowupsGenerator(provider).generate(
        FollowupInput(conversation_id="c1", messages=[])
    )
    assert out == []
    assert provider.requests == []


async def test_generator_blank_output_returns_empty():
    provider = _FakeProvider("   \n  ")
    out = await LLMFollowupsGenerator(provider).generate(
        FollowupInput(
            conversation_id="c1",
            messages=[{"role": "user", "content": "你好"}],
        )
    )
    assert out == []


async def test_generator_times_out_returns_empty(monkeypatch):
    """A stalled model degrades to no chips, not a hang."""

    class _StallProvider:
        async def complete(self, request: LLMRequest) -> LLMResponse:
            await asyncio.sleep(3600)  # never resolves within the timeout
            raise AssertionError("unreachable")

    monkeypatch.setattr(followups_mod, "_FOLLOWUPS_TIMEOUT_SECONDS", 0.01)
    out = await LLMFollowupsGenerator(_StallProvider()).generate(
        FollowupInput(conversation_id="c1", messages=[{"role": "user", "content": "你好"}])
    )
    assert out == []


# --- generate_followups (conversation/common wrapper: best-effort, never raises) ---


async def test_common_wrapper_returns_list_for_good_reply():
    from agentcore.conversation.common import generate_followups

    provider = _FakeProvider("帮我导出 PDF\n再做一版竞品对比")
    out = await generate_followups(
        provider=provider,
        conversation_id="c1",
        user_message="帮我设计登录",
        assistant_reply="好的，方案如下……",
    )
    assert out == ["帮我导出 PDF", "再做一版竞品对比"]


async def test_common_wrapper_skips_when_reply_empty():
    from agentcore.conversation.common import generate_followups

    provider = _FakeProvider("不应被调用")
    out = await generate_followups(
        provider=provider,
        conversation_id="c1",
        user_message="帮我设计登录",
        assistant_reply="   ",
    )
    assert out == []
    assert provider.requests == []


async def test_common_wrapper_swallows_provider_error():
    from agentcore.conversation.common import generate_followups

    class _BoomProvider:
        async def complete(self, request: LLMRequest) -> LLMResponse:
            raise RuntimeError("network down")

    out = await generate_followups(
        provider=_BoomProvider(),
        conversation_id="c1",
        user_message="帮我设计登录",
        assistant_reply="好的，方案如下……",
    )
    assert out == []


# --- MessageDetail followups projection (DERIVED 持久化 read seam) ---


def test_message_detail_projects_persisted_followups():
    """The read schema surfaces the persisted chips (from_attributes) so a reloaded bubble
    replays them — the read half of followups' DERIVED persistence (twin of the title)."""
    from datetime import datetime
    from types import SimpleNamespace

    from agentcore.api.schemas.messages import MessageDetail

    row = SimpleNamespace(
        id="m1",
        conversation_id="c1",
        role="assistant",
        content="好的，方案如下",
        created_at=datetime(2026, 1, 1),
        followups=["帮我导出 PDF", "再做一版竞品对比"],
    )
    assert MessageDetail.model_validate(row).followups == ["帮我导出 PDF", "再做一版竞品对比"]


def test_message_detail_followups_default_empty():
    """A row with no chips (user / none-minted turn) projects to [] — no stray chips."""
    from datetime import datetime
    from types import SimpleNamespace

    from agentcore.api.schemas.messages import MessageDetail

    row = SimpleNamespace(
        id="m1",
        conversation_id="c1",
        role="user",
        content="你好",
        created_at=datetime(2026, 1, 1),
    )
    assert MessageDetail.model_validate(row).followups == []
