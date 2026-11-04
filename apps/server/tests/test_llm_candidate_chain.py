"""Opt-in 跨 provider 候选链（生成 / 最后修订 2026-11-04）。

重点不是「能换」，而是**默认关、只在 commit 前换、只换值得换的故障、
解析不到凭据的候选不进链**。最后一条最容易变成「看起来换了其实没换」。
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest

from agentcore.config import settings
from agentcore.core.errors import (
    LLMAuthError,
    LLMError,
    LLMInsufficientBalanceError,
    LLMQuotaExceededError,
    LLMRateLimitError,
    LLMTimeoutError,
    LLMUpstreamError,
    OurServiceUnavailableError,
)
from agentcore.llm.candidate_chain import (
    CANDIDATE_CHAIN_CAPABILITIES,
    Candidate,
    CandidateChainRouter,
    parse_chain,
    plan_for,
    should_hop,
)
from agentcore.llm.credentials import LLMCredentials
from agentcore.llm.factory import build_turn_router
from agentcore.llm.provider.protocol import (
    LLMChunk,
    LLMMessage,
    LLMRequest,
    LLMResponse,
)
from agentcore.llm.provider.router import ProviderRouter
from agentcore.llm.turn_auth_dead import credential_source_from_llm


def _req(model: str = "primary") -> LLMRequest:
    return LLMRequest(messages=[LLMMessage(role="user", content="hi")], model=model)


class _Leaf:
    """duck-typed leaf：按 model 注入失败，可先吐 chunk 再抛（post-commit 场景）。"""

    def __init__(
        self,
        name: str = "user",
        *,
        failures: dict[str, BaseException] | None = None,
        pre_chunks: tuple[LLMChunk, ...] = (),
    ) -> None:
        self.name = name
        self.failures = dict(failures or {})
        self.pre_chunks = list(pre_chunks)
        self.models: list[str] = []
        self.closed = False

    async def complete(self, request: LLMRequest) -> LLMResponse:
        self.models.append(request.model)
        if request.model in self.failures:
            raise self.failures[request.model]
        return LLMResponse(content=f"{self.name}:{request.model}", model=request.model)

    def stream(self, request: LLMRequest):
        return self._stream(request)

    async def _stream(self, request: LLMRequest):
        self.models.append(request.model)
        for chunk in self.pre_chunks:
            yield chunk
        if request.model in self.failures:
            raise self.failures[request.model]
        yield LLMChunk(delta_content=f"{self.name}:{request.model}")

    def clone(self) -> _Leaf:
        return _Leaf(
            self.name, failures=self.failures, pre_chunks=tuple(self.pre_chunks)
        )

    async def close(self) -> None:
        self.closed = True


def _router(
    *,
    primary_failure: BaseException | None = None,
    pre_chunks: tuple[LLMChunk, ...] = (),
    fallbacks: tuple[Candidate, ...] = (),
    max_hops: int = 2,
    backup_failure: BaseException | None = None,
) -> tuple[CandidateChainRouter, _Leaf, _Leaf]:
    failures = {"primary": primary_failure} if primary_failure is not None else {}
    default = _Leaf("user", failures=failures, pre_chunks=pre_chunks)
    backup_failures = {"m2": backup_failure} if backup_failure is not None else {}
    backup = _Leaf("p2", failures=backup_failures)
    router = CandidateChainRouter(
        default=default,
        providers={"p2": backup},
        fallbacks=fallbacks,
        max_hops=max_hops,
    )
    return router, default, backup


# --- 配置解析 -----------------------------------------------------------------


class TestParseChain:
    def test_empty_and_broken_shapes_fail_closed(self):
        assert parse_chain("") == ()
        assert parse_chain("   ") == ()
        assert parse_chain("not-json") == ()
        assert parse_chain("{}") == ()
        assert parse_chain("[]") == ()
        assert parse_chain("[1, 2]") == ()

    def test_valid_entries_keep_order_and_dedupe(self):
        raw = json.dumps(
            [
                {"provider_id": "", "model": "same-model"},
                {"provider_id": "", "model": "same-model"},
                {"provider_id": "p2", "model": "claude-sonnet-5.5"},
                {"provider_id": "platform", "model": "deepseek-v4-flash"},
                "garbage",
                {"model": ""},
            ]
        )
        chain = parse_chain(raw)
        assert chain == (
            Candidate("same-model"),
            Candidate("claude-sonnet-5.5", "p2"),
            Candidate("deepseek-v4-flash", "platform"),
        )
        assert chain[1].route_key() == "p2/claude-sonnet-5.5"

    def test_unsafe_ids_are_dropped_not_spliced_into_route_keys(self):
        raw = json.dumps(
            [
                {"provider_id": "p/evil", "model": "m"},
                {"provider_id": "p2", "model": "m\x00bad"},
                {"provider_id": "p2", "model": "x" * 500},
                {"provider_id": 12, "model": "m"},
                {"provider_id": "", "model": "  "},
                {"provider_id": "p2", "model": "openrouter/auto"},
            ]
        )
        assert parse_chain(raw) == (Candidate("openrouter/auto", "p2"),)

    def test_limit_is_hard_capped(self):
        raw = json.dumps([{"model": f"m{i}"} for i in range(20)])
        assert len(parse_chain(raw, limit=3)) == 3
        assert len(parse_chain(raw, limit=99)) <= 8
        assert parse_chain(raw, limit=0) == ()


class TestPlanAndHopDecision:
    def test_plan_dedups_primary_and_respects_hop_cap(self):
        plan = plan_for(
            "primary",
            (Candidate("primary"), Candidate("m2", "p2"), Candidate("m3", "p3")),
            max_hops=2,
        )
        assert plan == ((0, "primary"), (1, "p2/m2"), (2, "p3/m3"))

    def test_plan_rotates_with_absolute_indices_for_sticky(self):
        plan = plan_for(
            "primary",
            (Candidate("m2", "p2"), Candidate("m3", "p3")),
            max_hops=2,
            start=1,
        )
        assert plan == ((1, "p2/m2"), (2, "p3/m3"), (0, "primary"))

    @pytest.mark.parametrize(
        "exc",
        [
            LLMRateLimitError(),
            LLMQuotaExceededError(),
            LLMUpstreamError("5xx"),
            LLMTimeoutError("timeout"),
            OurServiceUnavailableError("hop"),
        ],
    )
    def test_hops_on_recoverable_upstream_failures(self, exc: BaseException):
        assert should_hop(exc) is True

    @pytest.mark.parametrize(
        "exc",
        [
            LLMAuthError(),
            LLMInsufficientBalanceError(),
            LLMError("400"),
            ValueError("bug"),
            asyncio.CancelledError(),
        ],
    )
    def test_never_hops_on_payer_death_protocol_error_or_cancel(self, exc: BaseException):
        assert should_hop(exc) is False


# --- router 行为 ---------------------------------------------------------------


class TestStreamChain:
    async def test_hop_sends_stream_reset_and_uses_next_provider(self):
        router, default, backup = _router(
            primary_failure=LLMRateLimitError(),
            fallbacks=(Candidate("m2", "p2"),),
        )
        chunks = [c async for c in router.stream(_req())]
        assert any(c.stream_reset for c in chunks)
        assert chunks[-1].delta_content == "p2:m2"
        assert default.models == ["primary"]
        assert backup.models == ["m2"]

    async def test_post_commit_never_hops(self):
        router, default, backup = _router(
            primary_failure=LLMRateLimitError(),
            pre_chunks=(LLMChunk(delta_content="already-shown"),),
            fallbacks=(Candidate("m2", "p2"),),
        )
        with pytest.raises(LLMRateLimitError):
            _ = [c async for c in router.stream(_req())]
        assert backup.models == []
        assert default.models == ["primary"]

    async def test_auth_death_is_not_masked_by_a_hop(self):
        router, _default, backup = _router(
            primary_failure=LLMAuthError(),
            fallbacks=(Candidate("m2", "p2"),),
        )
        with pytest.raises(LLMAuthError):
            _ = [c async for c in router.stream(_req())]
        assert backup.models == []

    async def test_all_candidates_failing_raises_the_last_error(self):
        router, _default, _backup = _router(
            primary_failure=LLMRateLimitError(),
            backup_failure=LLMUpstreamError("down"),
            fallbacks=(Candidate("m2", "p2"),),
        )
        with pytest.raises(LLMUpstreamError):
            _ = [c async for c in router.stream(_req())]

    async def test_no_fallbacks_keeps_plain_router_behaviour(self):
        router, default, backup = _router(fallbacks=())
        chunks = [c async for c in router.stream(_req())]
        assert [c.delta_content for c in chunks] == ["user:primary"]
        assert backup.models == []

    async def test_sticky_hint_reuses_last_successful_candidate(self):
        router, default, backup = _router(
            primary_failure=LLMRateLimitError(),
            fallbacks=(Candidate("m2", "p2"),),
        )
        _ = [c async for c in router.stream(_req())]
        assert router._preferred["primary"] == 1
        _ = [c async for c in router.stream(_req())]
        # 第二次直接从成功过的候选起跑，不重复打已经坏掉的主候选。
        assert default.models == ["primary"]
        assert backup.models == ["m2", "m2"]

    async def test_unprefixed_candidate_only_switches_model_on_default_leaf(self):
        default = _Leaf("user", failures={"primary": LLMUpstreamError("down")})
        router = CandidateChainRouter(
            default=default, fallbacks=(Candidate("backup-model"),), max_hops=1
        )
        chunks = [c async for c in router.stream(_req())]
        assert chunks[-1].delta_content == "user:backup-model"
        assert default.models == ["primary", "backup-model"]


class TestCompleteAndRouterContract:
    async def test_complete_hops_then_returns(self):
        router, default, backup = _router(
            primary_failure=LLMQuotaExceededError(),
            fallbacks=(Candidate("m2", "p2"),),
        )
        response = await router.complete(_req())
        assert response.content == "p2:m2"
        assert default.models == ["primary"]
        assert backup.models == ["m2"]

    async def test_complete_does_not_hop_on_auth_death(self):
        router, _default, backup = _router(
            primary_failure=LLMAuthError(),
            fallbacks=(Candidate("m2", "p2"),),
        )
        with pytest.raises(LLMAuthError):
            await router.complete(_req())
        assert backup.models == []

    async def test_clone_preserves_chain_and_clones_leaves(self):
        router = CandidateChainRouter(
            default=_Leaf("user"),
            providers={"p2": _Leaf("p2")},
            fallbacks=(Candidate("m2", "p2"),),
            max_hops=2,
        )
        router._preferred["primary"] = 1
        cloned = router.clone()
        assert isinstance(cloned, CandidateChainRouter)
        assert cloned._fallbacks == router._fallbacks
        assert cloned._max_hops == 2
        assert cloned._preferred == {"primary": 1}
        assert cloned._default is not router._default
        assert cloned.available_prefixes == frozenset({"p2"})

    async def test_credential_source_still_sees_a_provider_router(self):
        # credential_source_from_llm 靠 isinstance(ProviderRouter) 判 payer；
        # 子类必须继续通过，否则平台回合会被误判成 user。
        router = CandidateChainRouter(default=_Leaf("platform"))
        assert credential_source_from_llm(router) == "platform"

    def test_capabilities_do_not_overclaim(self):
        assert CANDIDATE_CHAIN_CAPABILITIES["enabled_by_default"] is False
        assert CANDIDATE_CHAIN_CAPABILITIES["post_commit_hop"] is False
        assert CANDIDATE_CHAIN_CAPABILITIES["cross_payer_hop"] is False
        assert CANDIDATE_CHAIN_CAPABILITIES["auth_or_balance_death_hops"] is False
        assert CANDIDATE_CHAIN_CAPABILITIES["run_level_pricing_uses_hopped_model"] is False


class TestEngineRoundIntegration:
    async def test_failed_candidate_reasoning_is_cleared_by_stream_reset(self):
        """端到端：走真正的 run_llm_round，验证换候选不会把坏候选的半成品带进结果。"""
        from structlog.testing import capture_logs

        from agentcore.runtime.engine.round import LlmRoundOutput, run_llm_round
        from tests.llm_helpers import make_profile_params

        default = _Leaf(
            "user",
            failures={"primary": LLMRateLimitError()},
            pre_chunks=(LLMChunk(delta_reasoning="draft-from-bad-candidate"),),
        )
        backup = _Leaf("p2")
        router = CandidateChainRouter(
            default=default,
            providers={"p2": backup},
            fallbacks=(Candidate("m2", "p2"),),
            max_hops=1,
        )
        emitted: list[str] = []
        resets: list[str] = []

        with capture_logs() as caps:
            result = await run_llm_round(
                llm=router,  # type: ignore[arg-type]
                profile=make_profile_params(),
                messages=[LLMMessage(role="user", content="hi")],
                investigation_tools=frozenset(),
                tool_defs=None,
                active_model="primary",
                emit_content=emitted.append,
                emit_reasoning=lambda _d: None,
                on_tool_progress=None,
                round_idx=0,
                run_id="r-candidate-chain",
                raise_on_error=False,
                # 实际调用带 reason 参数（round.py 的类型标注是 Callable[[], None]，
                # 但 stream.py 传的是 on_reset("retry")）。按真实行为接。
                on_reset=lambda reason: resets.append(reason),
            )

        assert isinstance(result, LlmRoundOutput)
        assert result.content == "p2:m2"
        assert "draft-from-bad-candidate" not in result.reasoning
        assert resets == ["retry"]
        assert any(c.get("event") == "llm.candidate_hop" for c in caps)
        assert default.models == ["primary"]
        assert backup.models == ["m2"]


# --- factory 接线（默认关 + fail closed）---------------------------------------


def _creds(provider_id: str | None = None) -> LLMCredentials:
    return LLMCredentials(
        api_key="test-key",
        base_url="https://example.com/v1",
        provider_id=provider_id,
    )


def _platform_creds() -> LLMCredentials:
    return LLMCredentials(
        api_key="platform-key",
        base_url="https://platform.example.com/v1",
        source="platform",
    )


class _SessionCM:
    async def __aenter__(self) -> Any:
        return object()

    async def __aexit__(self, *_args: object) -> bool:
        return False


@pytest.fixture
def chain_env(monkeypatch):
    monkeypatch.setattr(settings, "llm_candidate_chain_enabled", True)
    monkeypatch.setattr(settings, "llm_candidate_chain_max_hops", 2)
    monkeypatch.setattr(settings, "llm_candidate_chain_spec", "")
    monkeypatch.setattr("agentcore.db.base.async_session_factory", lambda: _SessionCM())
    return monkeypatch


class TestFactoryGate:
    async def test_default_off_returns_exactly_the_plain_router(self, monkeypatch):
        monkeypatch.setattr(settings, "llm_candidate_chain_enabled", False)
        router = await build_turn_router(_creds(), user_id="u1")
        assert type(router) is ProviderRouter

    async def test_enabled_with_invalid_spec_keeps_plain_router(self, chain_env):
        chain_env.setattr(settings, "llm_candidate_chain_spec", "{not json")
        router = await build_turn_router(_creds(), user_id="u1")
        assert type(router) is ProviderRouter

    async def test_enabled_registers_resolvable_byok_prefix(self, chain_env):
        chain_env.setattr(
            settings,
            "llm_candidate_chain_spec",
            json.dumps([{"provider_id": "p2", "model": "m2"}]),
        )

        async def _resolve(_session, user_id, provider_id):
            assert user_id == "u1"
            assert provider_id == "p2"
            return _creds("p2")

        chain_env.setattr(
            "agentcore.llm.resolve.resolve_provider_credentials", _resolve
        )
        router = await build_turn_router(_creds(), user_id="u1")
        assert isinstance(router, CandidateChainRouter)
        assert "p2" in router.available_prefixes
        assert router._fallbacks == (Candidate("m2", "p2"),)

    async def test_unresolvable_provider_is_dropped_not_left_in_chain(self, chain_env):
        chain_env.setattr(
            settings,
            "llm_candidate_chain_spec",
            json.dumps([{"provider_id": "ghost", "model": "m2"}]),
        )

        async def _resolve(_session, _user_id, _provider_id):
            return None

        chain_env.setattr(
            "agentcore.llm.resolve.resolve_provider_credentials", _resolve
        )
        router = await build_turn_router(_creds(), user_id="u1")
        # 关键：未注册前缀绝不能留在链里，否则 _route 会把 "ghost/m2" 原样
        # 丢给默认 leaf，制造「已换 provider」的假象。
        assert type(router) is ProviderRouter
        assert "ghost" not in router.available_prefixes

    async def test_platform_sentinel_registers_platform_leaf(self, chain_env):
        chain_env.setattr(
            settings,
            "llm_candidate_chain_spec",
            json.dumps([{"provider_id": "platform", "model": "flash"}]),
        )
        chain_env.setattr(
            "agentcore.llm.resolve.platform_llm_credentials",
            lambda model: _creds() if model == "flash" else None,
        )
        router = await build_turn_router(_platform_creds(), user_id="u1")
        assert isinstance(router, CandidateChainRouter)
        assert "platform" in router.available_prefixes
        assert router._fallbacks == (Candidate("flash", "platform"),)

    async def test_user_payer_never_hops_to_platform(self, chain_env):
        chain_env.setattr(
            settings,
            "llm_candidate_chain_spec",
            json.dumps([{"provider_id": "platform", "model": "flash"}]),
        )
        router = await build_turn_router(_creds(), user_id="u1")
        assert type(router) is ProviderRouter
        assert "platform" not in router.available_prefixes

    async def test_platform_payer_never_hops_to_byok(self, chain_env):
        chain_env.setattr(
            settings,
            "llm_candidate_chain_spec",
            json.dumps([{"provider_id": "p2", "model": "m2"}]),
        )
        calls: list[str] = []

        async def _resolve(_session, _user_id, provider_id):
            calls.append(provider_id)
            return _creds(provider_id)

        chain_env.setattr(
            "agentcore.llm.resolve.resolve_provider_credentials", _resolve
        )
        router = await build_turn_router(_platform_creds(), user_id="u1")
        assert type(router) is ProviderRouter
        # 跨 payer 连 DB 都不该查：fail closed 要在解析之前发生。
        assert calls == []

    async def test_already_registered_prefix_is_not_overwritten(self, chain_env):
        chain_env.setattr(
            settings,
            "llm_candidate_chain_spec",
            json.dumps([{"provider_id": "kimi", "model": "moonshot"}]),
        )
        # 钉住一个已注册前缀（vendor extra / 辩手身份同理）：链只复用，不覆盖，
        # 也不该为该前缀去查 DB 凭据。
        existing = _Leaf("kimi")
        chain_env.setattr(
            "agentcore.llm.factory._vendor_extras", lambda: {"kimi": existing}
        )
        router = await build_turn_router(_creds(), user_id="u1")
        assert isinstance(router, CandidateChainRouter)
        assert router._providers["kimi"] is existing
        assert router._fallbacks == (Candidate("moonshot", "kimi"),)
