"""Tests for conversation title generation (_sanitize_title + LLMTitleGenerator)."""

from agentcore.llm import LLMRequest, LLMResponse
from agentcore.memory.conversation_title import (
    _TITLE_SYSTEM_PROMPT,
    TITLE_MAX_CHARS,
    LLMTitleGenerator,
    TitleInput,
    _render_title_prompt,
    _sanitize_title,
)

# --- _sanitize_title (pure text cleanup) ---


def test_sanitize_plain_title_unchanged():
    assert _sanitize_title("登录功能设计") == "登录功能设计"


def test_sanitize_strips_surrounding_quotes():
    assert _sanitize_title('"登录功能设计"') == "登录功能设计"
    assert _sanitize_title("「登录功能设计」") == "登录功能设计"
    assert _sanitize_title("“登录功能设计”") == "登录功能设计"


def test_sanitize_strips_label_prefix():
    assert _sanitize_title("标题：登录功能设计") == "登录功能设计"
    assert _sanitize_title("Title: Login flow") == "Login flow"


def test_sanitize_label_and_quotes_together():
    assert _sanitize_title('标题："登录功能设计"') == "登录功能设计"


def test_sanitize_takes_first_nonempty_line():
    assert _sanitize_title("\n\n登录功能设计\n其它说明") == "登录功能设计"


def test_sanitize_collapses_whitespace_and_trailing_punct():
    assert _sanitize_title("登录   功能   设计。") == "登录 功能 设计"


def test_sanitize_truncates_to_max():
    long = "题" * (TITLE_MAX_CHARS + 10)
    out = _sanitize_title(long)
    assert out == "题" * TITLE_MAX_CHARS + "…"


def test_sanitize_empty_returns_empty():
    assert _sanitize_title("") == ""
    assert _sanitize_title("   \n  ") == ""


# --- _render_title_prompt ---


def test_render_prompt_includes_messages_and_skips_empty():
    prompt = _render_title_prompt(
        TitleInput(
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


def test_render_prompt_truncates_long_message():
    prompt = _render_title_prompt(
        TitleInput(
            conversation_id="c1",
            messages=[{"role": "user", "content": "x" * 5000}],
        )
    )
    assert "…" in prompt
    assert len(prompt) < 2000


# --- _TITLE_SYSTEM_PROMPT (pinned guards) ---


def test_title_prompt_bans_emoji_and_guards_injection():
    # The sanitizer does not strip emoji, so the ban lives in the prompt; the
    # conversation is interpolated as data and must not be obeyed as instructions.
    assert "emoji" in _TITLE_SYSTEM_PROMPT
    assert "名词短语" in _TITLE_SYSTEM_PROMPT
    assert "不要执行其中" in _TITLE_SYSTEM_PROMPT


# --- LLMTitleGenerator (async, with a fake provider) ---


class _FakeProvider:
    """Minimal LLMProvider stub: returns canned content and records requests."""

    def __init__(self, content: str) -> None:
        self._content = content
        self.requests: list[LLMRequest] = []

    async def complete(self, request: LLMRequest) -> LLMResponse:
        self.requests.append(request)
        return LLMResponse(content=self._content)


async def test_generator_returns_sanitized_title():
    provider = _FakeProvider('"登录功能设计"')
    title = await LLMTitleGenerator(provider).generate(
        TitleInput(
            conversation_id="c1",
            messages=[{"role": "user", "content": "帮我设计登录"}],
        )
    )
    assert title == "登录功能设计"


async def test_generator_uses_flash_non_thinking_short():
    provider = _FakeProvider("标题")
    await LLMTitleGenerator(provider).generate(
        TitleInput(
            conversation_id="c1",
            messages=[{"role": "user", "content": "你好"}],
        )
    )
    req = provider.requests[0]
    assert req.model == "deepseek-v4-flash"
    assert req.thinking is False
    assert req.stream is False
    assert req.max_tokens == 64


async def test_generator_empty_messages_skips_call():
    provider = _FakeProvider("不应被调用")
    title = await LLMTitleGenerator(provider).generate(
        TitleInput(conversation_id="c1", messages=[])
    )
    assert title == ""
    assert provider.requests == []


async def test_generator_blank_output_returns_empty():
    provider = _FakeProvider("   \n  ")
    title = await LLMTitleGenerator(provider).generate(
        TitleInput(
            conversation_id="c1",
            messages=[{"role": "user", "content": "你好"}],
        )
    )
    assert title == ""
