"""「这次 429 该不该睡着等」由本次调用自己剩下多少「可睡时间」决定，不再由一个全局 30 秒。

**先把前提摆正。** 生产 2.35 天 1983 条 ``llm.rate_limit_no_retry`` 里那 138 条
``attempt=5, retry_after=32.0``，32 秒不是上游要的——那批 429 压根没带 ``Retry-After``
头，32 是我们自己 2→4→8→16→32 退避链的末项（零离散度、全样本唯一一个 ≤60 秒的值）。走到
它之前已经睡掉 30 秒，所以 45 秒预算减去这 30 秒再减去重试自己那份，只剩 10 秒，仍然小于
32：**任何预算都救不回那 138 条**，本模块也不假装能救。另外 92% 是上游真声明的小时级日
配额重置（中位 12.9h），那部分放弃从来都是对的。

**预算真正买到的是「不睡」。** 同一个 45 秒的压缩，回合前近顶那次被回合同步 await：它省下
的是我们自己那 30 秒退避链，不是一次上游冷却。判据因此是**谁在等**（``user_waiting``），
不是场景名。

四条不变量在这里钉死：
1. 无头 429 上，45 秒预算与交互 30 秒上限在**同一次尝试**放弃——预算不改变结局；
2. 一旦回合被它挡着（``user_waiting``），第一个 429 就放弃，一秒也不睡；
3. 上游声明的小时级冷却在任何预算下都不睡——预算再大也买不到一次绝望的等待；
4. 用户看到的文案只有一个来源（``core.errors.MAX_RETRY_AFTER``）：per-call 上限只动
   ``retryable``；只有「失败会被静默吞掉」的场景才准带 patience，而且这条由**读**它的
   provider 把关，不靠调用方自觉。
"""

from __future__ import annotations

import httpx
import pytest

from agentcore.core.errors import (
    MAX_RETRY_AFTER,
    RETRY_AFTER_FROM_HEADER,
    LLMQuotaExceededError,
    LLMRateLimitError,
    upstream_rate_limit_error,
)
from agentcore.llm.profiles import DEEPSEEK_V4_FLASH
from agentcore.llm.provider.call_budget import (
    HOPELESS_RETRY_AFTER,
    RETRY_ATTEMPT_RESERVE,
    SILENT_DEGRADE_SCENARIOS,
    complete_within_budget,
    provider_retry_ceiling,
    retry_after_ceiling,
)
from agentcore.llm.provider.cooldown_gate import reset_cooldown_gate
from agentcore.llm.provider.openai_compatible import OpenAICompatibleProvider
from agentcore.llm.provider.protocol import LLMMessage, LLMRequest

# 生产那 138 条的形状：无头 429，我们自己的退避链睡满四次，第五次的 32 秒超出上限放弃。
_OUR_BACKOFF_CHAIN = [2.0, 4.0, 8.0, 16.0]
_LAST_BACKOFF = 32.0
# 平台号日配额打光的那 92%（中位 12.9h）——这一档上游是真的声明了。
_DAY_RESET = 46440.0

_TITLE_BUDGET = 20.0
_COMPACT_BUDGET = 45.0


def _ok_body() -> dict:
    return {
        "choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 1, "completion_tokens": 1},
    }


def _req(scenario: str, patience: float | None, *, stream: bool = False) -> LLMRequest:
    return LLMRequest(
        messages=[LLMMessage(role="user", content="hi")],
        model=DEEPSEEK_V4_FLASH,
        scenario=scenario,
        stream=stream,
        retry_patience_seconds=patience,
    )


async def _mock_provider(handler, *, name: str = "deepseek") -> OpenAICompatibleProvider:
    base_url = "http://example.invalid/v1"
    provider = OpenAICompatibleProvider(name=name, api_key="k", base_url=base_url)
    await provider._client.aclose()
    provider._client = httpx.AsyncClient(
        base_url=base_url, transport=httpx.MockTransport(handler)
    )
    return provider


def _throttled(headers: dict[str, str] | None, calls: dict[str, int]):
    """429 forever. ``headers=None`` = the production shape: upstream states nothing."""

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(
            429, headers=headers or {}, content=b'{"error":"rate_limited"}'
        )

    return handler


@pytest.fixture(autouse=True)
def _reset_cooldown_gate():
    reset_cooldown_gate()
    yield
    reset_cooldown_gate()


@pytest.fixture
def sleeps(monkeypatch) -> list[float]:
    recorded: list[float] = []

    async def fake_sleep(sec: float) -> None:
        recorded.append(sec)

    monkeypatch.setattr(
        "agentcore.llm.provider.openai_compatible.asyncio.sleep", fake_sleep
    )
    return recorded


@pytest.fixture
def clock(monkeypatch) -> list[float]:
    """Sleeps that also advance the provider's clock, recorded in order.

    MockTransport answers instantly, so with a real clock ``elapsed`` stays 0 and every
    budget looks infinitely wide — which is exactly the arithmetic error this file was
    written under. Production pays for each of these sleeps out of the same wall clock,
    so the fake one does too. Only the provider module's ``time`` is swapped; the global
    clock is untouched.
    """
    slept: list[float] = []
    ticks = {"t": 0.0}

    async def sleeping_clock(sec: float) -> None:
        slept.append(sec)
        ticks["t"] += sec

    class _Clock:
        @staticmethod
        def monotonic() -> float:
            return ticks["t"]

    monkeypatch.setattr(
        "agentcore.llm.provider.openai_compatible.asyncio.sleep", sleeping_clock
    )
    monkeypatch.setattr("agentcore.llm.provider.openai_compatible.time", _Clock)
    return slept


# ---- 前提校正：无头 429 上，预算改变不了结局 -------------------------------------


async def test_a_budget_does_not_buy_back_the_headerless_giveups(clock):
    """交互 30 秒上限与 45 秒压缩预算，在同一次尝试、睡满同样四次之后放弃。

    这条用例存在的唯一理由是钉住那个被读错的前提：32 秒不是「上游只要 32 秒、比阈值多
    2 秒」，而是我们自己退避链的末项，走到它已经花掉 30 秒。谁再想靠放宽预算救回这 138
    条，先让这条用例红。
    """
    from agentcore.llm.provider.cooldown_gate import reset_cooldown_gate

    runs: dict[str, tuple[int, list[float], float | None]] = {}
    for label, scenario, patience in (
        ("interactive", "title", None),
        ("budgeted", "compaction", _COMPACT_BUDGET),
    ):
        reset_cooldown_gate()
        calls = {"n": 0}
        clock.clear()
        provider = await _mock_provider(_throttled(None, calls))
        try:
            with pytest.raises(LLMRateLimitError) as ei:
                await provider.complete(_req(scenario, patience))
            runs[label] = (calls["n"], list(clock), ei.value.retry_after)
        finally:
            await provider.close()

    assert runs["budgeted"] == runs["interactive"]
    assert runs["interactive"] == (5, _OUR_BACKOFF_CHAIN, _LAST_BACKOFF)
    # 算术本身：睡掉那 30 秒之后，45 秒预算剩下的上限已经小于链条的下一格。
    assert retry_after_ceiling(_COMPACT_BUDGET, elapsed=sum(_OUR_BACKOFF_CHAIN)) < _LAST_BACKOFF


def test_the_two_wired_callers_hand_over_their_own_ceiling():
    """标题 / 压缩用的就是各自 wait_for 的那个常量，不是新抄的一份。"""
    from agentcore.conversation.compaction import _COMPACT_TIMEOUT_SECONDS
    from agentcore.memory.conversation_title import _TITLE_TIMEOUT_SECONDS

    assert _TITLE_TIMEOUT_SECONDS == _TITLE_BUDGET
    assert _COMPACT_TIMEOUT_SECONDS == _COMPACT_BUDGET
    # 生产分叉的真实算术：两个预算走到链条末项时都已经等不起它了，差别只在早晚。
    spent = sum(_OUR_BACKOFF_CHAIN)
    assert retry_after_ceiling(_COMPACT_TIMEOUT_SECONDS, elapsed=spent) < _LAST_BACKOFF
    assert retry_after_ceiling(_TITLE_TIMEOUT_SECONDS) < _LAST_BACKOFF


# ---- 预算买到的那件事：不睡 -------------------------------------------------------


async def test_a_blocked_turn_refuses_the_very_first_headerless_429(clock):
    """回合前的近顶压缩：预算照旧 45 秒，可睡时间是 0——第一个 429 就当场失败。

    省下的不是一次上游冷却，是我们自己那条 2→4→8→16 的退避链：整整 30 秒里用户盯着空
    白，末了照样没有摘要，区别只是回合晚了半分钟才开始。
    """
    calls = {"n": 0}
    provider = await _mock_provider(_throttled(None, calls))
    try:
        with pytest.raises(LLMRateLimitError):
            await complete_within_budget(
                provider,
                _req("compaction", None),
                budget=_COMPACT_BUDGET,
                user_waiting=True,
            )
        assert calls["n"] == 1
        assert clock == []
    finally:
        await provider.close()


async def test_the_same_fold_spends_its_backoff_when_nobody_is_blocked(clock):
    """后台那次没人等，退避链照跑——省下的那 30 秒只对被挡着的回合才有价值。"""
    calls = {"n": 0}
    provider = await _mock_provider(_throttled(None, calls))
    try:
        with pytest.raises(LLMRateLimitError):
            await complete_within_budget(
                provider, _req("compaction", None), budget=_COMPACT_BUDGET
            )
        assert calls["n"] == 5
        assert clock == _OUR_BACKOFF_CHAIN
    finally:
        await provider.close()


async def test_a_title_stops_one_link_early_instead_of_timing_out(clock):
    """标题只有 20 秒：退避链睡到第三格就停，而不是睡进第四格再被自己的 wait_for 掐掉。

    差别不只是早 6 秒——失败的**种类**也变了。睡进 16 秒那格会把 20 秒预算耗光，调用方
    收到的是 TimeoutError；提前收手它收到的是限流错误，后台清扫据此走的是「整条上游都在
    限流」的退避，而不是「这一条对话超时了」的本地冷却。
    """
    calls = {"n": 0}
    provider = await _mock_provider(_throttled(None, calls))
    try:
        with pytest.raises(LLMRateLimitError):
            await provider.complete(_req("title", _TITLE_BUDGET))
        assert calls["n"] == 4
        assert clock == _OUR_BACKOFF_CHAIN[:3]
    finally:
        await provider.close()
    # 下一格睡完就越过标题自己的 deadline —— 提前收手不是保守，是唯一能收到限流错误的走法。
    assert sum(clock) + _OUR_BACKOFF_CHAIN[3] > _TITLE_BUDGET


# ---- 上游真声明的小时级：任何预算下都不睡 ----------------------------------------


@pytest.mark.parametrize(
    ("scenario", "budget"),
    [
        ("chat", None),
        ("title", _TITLE_BUDGET),
        ("compaction", _COMPACT_BUDGET),
        # 预算再离谱也买不到一次绝望的等待。
        ("compaction", _DAY_RESET * 2),
    ],
)
async def test_a_declared_hour_scale_cooldown_is_never_slept_on(scenario, budget, sleeps):
    calls = {"n": 0}
    provider = await _mock_provider(_throttled({"retry-after": str(_DAY_RESET)}, calls))
    try:
        with pytest.raises(LLMRateLimitError) as ei:
            await provider.complete(_req(scenario, budget))
        assert ei.value.retry_after == _DAY_RESET
        assert calls["n"] == 1
        assert sleeps == []
    finally:
        await provider.close()


def test_ceiling_never_exceeds_the_hopeless_cap():
    assert retry_after_ceiling(None) <= HOPELESS_RETRY_AFTER
    assert retry_after_ceiling(10_000.0) == HOPELESS_RETRY_AFTER
    assert retry_after_ceiling(_DAY_RESET, elapsed=1.0) == HOPELESS_RETRY_AFTER


# ---- 剩余预算，不是初始预算 ----------------------------------------------------


def test_ceiling_shrinks_with_time_already_spent():
    fresh = retry_after_ceiling(_COMPACT_BUDGET)
    assert fresh == _COMPACT_BUDGET - RETRY_ATTEMPT_RESERVE
    # 退避链每睡一格，剩下的上限就窄一格——这正是它跟不上 2→4→8→16→32 的原因。
    ladder = [
        retry_after_ceiling(_COMPACT_BUDGET, elapsed=sum(_OUR_BACKOFF_CHAIN[:n]))
        for n in range(len(_OUR_BACKOFF_CHAIN) + 1)
    ]
    assert ladder == sorted(ladder, reverse=True)
    assert ladder[-1] < _LAST_BACKOFF
    # 预算烧光不会产生负数上限。
    assert retry_after_ceiling(_TITLE_BUDGET, elapsed=999.0) == 0.0
    # 0 秒可睡 = 任何冷却都当场放弃，而 None（交互回合）走的是另一条分支。
    assert retry_after_ceiling(0.0) == 0.0
    assert retry_after_ceiling(None) == MAX_RETRY_AFTER


# ---- 用户面文案仍然只有一个来源 --------------------------------------------------


@pytest.mark.parametrize("retry_ceiling", [None, 10.0, 40.0, HOPELESS_RETRY_AFTER])
@pytest.mark.parametrize("retry_after", [5.0, MAX_RETRY_AFTER, _LAST_BACKOFF, _DAY_RESET])
def test_copy_is_keyed_on_the_interactive_ceiling_only(retry_after, retry_ceiling):
    """同一个 Retry-After 在任何预算下都给同一句话；预算只动 retryable。"""
    baseline = upstream_rate_limit_error(
        retry_after, credential_source="user", retry_after_source=RETRY_AFTER_FROM_HEADER
    )
    scoped = upstream_rate_limit_error(
        retry_after,
        credential_source="user",
        retry_ceiling=retry_ceiling,
        retry_after_source=RETRY_AFTER_FROM_HEADER,
    )
    assert scoped.message == baseline.message
    assert scoped.retryable is (retry_after <= (retry_ceiling or MAX_RETRY_AFTER))


def test_a_cooldown_we_intend_to_wait_out_never_takes_the_quota_wall_face():
    """给得起就还是普通限流：换成 QUOTA_EXCEEDED 会让重试循环直接跳过这次重试。"""
    waiting = upstream_rate_limit_error(
        _LAST_BACKOFF,
        credential_source="platform",
        retry_ceiling=40.0,
        retry_after_source=RETRY_AFTER_FROM_HEADER,
    )
    assert isinstance(waiting, LLMRateLimitError)
    assert waiting.retryable is True
    # 真放弃时才是那堵墙。
    giving_up = upstream_rate_limit_error(
        _DAY_RESET,
        credential_source="platform",
        retry_ceiling=40.0,
        retry_after_source=RETRY_AFTER_FROM_HEADER,
    )
    assert isinstance(giving_up, LLMQuotaExceededError)
    assert giving_up.retryable is False


async def test_only_silent_degrade_callers_may_carry_a_budget():
    """交互面调用的 429 会变成气泡上的句子，不能有自己的上限。"""
    provider = await _mock_provider(lambda r: httpx.Response(200, json=_ok_body()))
    try:
        for scenario in ("chat", "agent", "file.rewrite"):
            with pytest.raises(ValueError, match="预算"):
                await complete_within_budget(
                    provider, _req(scenario, None), budget=_COMPACT_BUDGET
                )
        assert "chat" not in SILENT_DEGRADE_SCENARIOS
        # 白名单只列真的接了 ``complete_within_budget`` 的场景：预留一个名字就是在
        # 不变量上留一个洞，将来接的人自然会撞上上面那句 ValueError。memory 占本次限流
        # 失败的 76%，仍然不在这里——它没有 wait_for，没有可分配的 wall clock，也没人
        # 被它挡着。
        assert set(SILENT_DEGRADE_SCENARIOS) == {"title", "compaction"}
    finally:
        await provider.close()


def test_a_patience_on_a_user_facing_scenario_is_ignored_not_obeyed():
    """读的一侧把关：chat 请求上出现 patience，也不许收窄这次回合的上限。"""
    assert provider_retry_ceiling(scenario="chat", patience=5.0) == MAX_RETRY_AFTER
    assert provider_retry_ceiling(scenario="agent", patience=0.0) == MAX_RETRY_AFTER
    # 静默降级的调用照常按剩余可睡时间收窄。
    assert provider_retry_ceiling(
        scenario="compaction", patience=_COMPACT_BUDGET
    ) == _COMPACT_BUDGET - RETRY_ATTEMPT_RESERVE
    assert provider_retry_ceiling(scenario="compaction", patience=0.0) == 0.0


async def test_stream_path_does_not_take_a_budget_on_the_callers_word(sleeps):
    """流式回合被塞了 5 秒 patience：仍不按 patience 收窄，短头照等一次。

    这条口子只靠调用方自觉时，一个仍在交互上限内的 429 会当场放弃，而气泡上写着
    「请约 2 秒后再试」——引擎已经否决了它自己印出来的那句话。交互回合会静默坐等
    短冷却（≤ silent threshold），所以这条用不了长头来钉 patience 被忽略；2s 的短头
    仍能证明 patience=5 没有把上限收到 0。
    """
    calls = {"n": 0}
    sse = (
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n'
        "data: [DONE]\n\n"
    )

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(
                429, headers={"retry-after": "2"}, content=b'{"error":"rate_limited"}'
            )
        return httpx.Response(200, text=sse)

    provider = await _mock_provider(handler)
    try:
        chunks = [c async for c in provider.stream(_req("chat", 5.0, stream=True))]
        assert any(c.delta_content == "ok" for c in chunks)
        assert calls["n"] == 2
        assert sleeps == [2.0]
    finally:
        await provider.close()


async def test_who_is_waiting_is_the_only_thing_that_differs():
    """两条路只差一个布尔：deadline 永远是预算，可睡时间由「有没有人在等」给出。"""
    seen: list[float | None] = []

    class _Recorder:
        async def complete(self, request):
            seen.append(request.retry_patience_seconds)
            return "done"

    result = await complete_within_budget(
        _Recorder(), _req("compaction", None), budget=_COMPACT_BUDGET
    )
    await complete_within_budget(
        _Recorder(), _req("compaction", None), budget=_COMPACT_BUDGET, user_waiting=True
    )
    assert result == "done"
    assert seen == [_COMPACT_BUDGET, 0.0]
