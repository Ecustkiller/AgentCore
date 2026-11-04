"""Opt-in cross-provider candidate chain (生成 / 最后修订 2026-11-04).

纯策略 + ``ProviderRouter`` 子类，不改引擎一行代码。

**不 import ``agentcore.db``**：``tests/test_arch_boundaries.py`` 禁止 ``llm/*``
直接碰 DB。凭据解析留在已豁免的 bridge（``factory`` / ``resolve``），这里只吃
「已经注册好前缀的 router」+ 一条纯配置。

为什么是 ``ProviderRouter`` 子类而不是外层包装：
- ``credential_source_from_llm`` 用 ``isinstance(node, ProviderRouter)`` 判 payer；
  包一层会让 delegate / debate / wave 的准入闸把平台回合误判成 user。
- ``clone()`` / ``close()`` / ``register()`` / ``available_prefixes`` / ``base_url``
  全部继承，行为与上游 router 一致。
- ``build_turn_router`` 的返回类型不变。

候选游标**只在本次 ``stream()`` / ``complete()`` 调用的局部里**：同一个 router
会被 captain 与并发 worker 共用，任何「当前候选」实例状态都会被彼此踩。
跨 round 的粘滞只是一个 best-effort 提示（按主模型字符串记一个成功过的下标），
不是正确性依赖。

透明重来复用引擎现成的 ``LLMChunk(stream_reset=True)``：消费端会清空累积器、
回调 ``on_reset("retry")``，且该 chunk 属于 forward chunk，会重置流式停滞闸的
idle 窗口 —— 新候选确实应该重新计时。
"""

from __future__ import annotations

import json
import re
from collections.abc import AsyncIterator
from dataclasses import dataclass, replace
from typing import Any

from agentcore.core.errors import (
    LLMQuotaExceededError,
    LLMRateLimitError,
    LLMTimeoutError,
    LLMUpstreamError,
    OurServiceUnavailableError,
)
from agentcore.core.logging import get_logger
from agentcore.llm.provider.protocol import LLMChunk, LLMProvider, LLMRequest, LLMResponse
from agentcore.llm.provider.router import ProviderRouter

logger = get_logger(__name__)

MAX_CHAIN_ENTRIES = 8
MAX_MODEL_LENGTH = 200
_PROVIDER_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$")
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")

# 如实声明 v1 没做的事；别把实验能力写成「已对齐生产」。
CANDIDATE_CHAIN_CAPABILITIES = {
    "enabled_by_default": False,
    "config_scope": "instance-level env (LLM_CANDIDATE_CHAIN_SPEC)",
    "per_user_api": False,
    "auth_or_balance_death_hops": False,
    "post_commit_hop": False,
    "cross_payer_hop": False,
    "sticky": "best-effort per-model hint, not a guarantee",
    "run_level_pricing_uses_hopped_model": False,
    "engine_files_touched": False,
}


@dataclass(frozen=True, slots=True)
class Candidate:
    """一个候选：``provider_id`` 空串 = 沿用默认 leaf 只换模型。"""

    model: str
    provider_id: str = ""

    def route_key(self) -> str:
        return f"{self.provider_id}/{self.model}" if self.provider_id else self.model


def _clean_text(value: Any, *, max_length: int) -> str:
    if not isinstance(value, str):
        return ""
    text = value.strip()
    if not text or len(text) > max_length or _CONTROL_RE.search(text):
        return ""
    return text


def parse_chain(raw: str, *, limit: int = 5) -> tuple[Candidate, ...]:
    """把 JSON 配置解析成候选元组；任何坏形状都 fail closed（跳过坏项 / 返回空）。

    绝不把半个配置拼进路由键：``provider_id`` 会与 ``model`` 拼成
    ``provider/model`` 交给 ``ProviderRouter._route``，所以这里必须挡掉
    控制字符、斜杠、空白与超长值。
    """
    text = (raw or "").strip()
    if not text:
        return ()
    try:
        payload = json.loads(text)
    except (ValueError, TypeError):
        return ()
    if not isinstance(payload, list):
        return ()
    cap = max(0, min(int(limit), MAX_CHAIN_ENTRIES))
    if cap == 0:
        return ()
    out: list[Candidate] = []
    seen: set[str] = set()
    for item in payload:
        if len(out) >= cap:
            break
        if not isinstance(item, dict):
            continue
        model = _clean_text(item.get("model"), max_length=MAX_MODEL_LENGTH)
        if not model:
            continue
        raw_pid = item.get("provider_id", "")
        if raw_pid is None:
            raw_pid = ""
        if not isinstance(raw_pid, str):
            continue
        pid = raw_pid.strip()
        if pid and not _PROVIDER_ID_RE.fullmatch(pid):
            continue
        candidate = Candidate(model=model, provider_id=pid)
        if candidate.route_key() in seen:
            continue
        seen.add(candidate.route_key())
        out.append(candidate)
    return tuple(out)


# 只跳「换个人就好」的可恢复上游故障。
# 不跳 LLMAuthError / LLMInsufficientBalanceError：turn_auth_dead 是 payer 级
# latch，一旦锁上，同 payer 的后续候选会在 leaf 准入闸被短掉；且按上游设计
# 鉴权 / 余额死亡本来就该让整个 turn 短路，不该偷偷换账号继续烧。
# 不跳通用 LLMError（400 / 404 / 地区 403 等）：换 provider 通常也修不好，
# 还会把一个明确的协议错误伪装成「已自动恢复」。
_HOPPABLE = (
    LLMRateLimitError,
    LLMQuotaExceededError,
    LLMUpstreamError,
    LLMTimeoutError,
    OurServiceUnavailableError,
)


def should_hop(exc: BaseException) -> bool:
    return isinstance(exc, _HOPPABLE)


def plan_for(
    primary: str,
    fallbacks: tuple[Candidate, ...],
    *,
    max_hops: int,
    start: int = 0,
) -> tuple[tuple[int, str], ...]:
    """主候选 + 去重后的备选，按 ``max_hops`` 截断，再从 ``start`` 循环旋转。

    返回 ``(绝对下标, 路由键)``：绝对下标用于 sticky 记忆，路由键用于改写
    ``LLMRequest.model``。旋转成环是为了「粘滞候选后来又坏了」时仍能回头试主候选。
    """
    keys: list[str] = [primary]
    for candidate in fallbacks:
        key = candidate.route_key()
        if key not in keys:
            keys.append(key)
    keys = keys[: max(0, int(max_hops)) + 1]
    indexed = list(enumerate(keys))
    if not indexed:
        return ()
    offset = max(0, min(int(start), len(indexed) - 1))
    return tuple(indexed[offset:] + indexed[:offset])


class CandidateChainRouter(ProviderRouter):
    """带候选链的 turn router；默认关闭时 ``build_turn_router`` 不会构造它。"""

    def __init__(
        self,
        *,
        default: LLMProvider,
        providers: dict[str, LLMProvider] | None = None,
        fallbacks: tuple[Candidate, ...] = (),
        max_hops: int = 2,
    ) -> None:
        super().__init__(default=default, providers=providers)
        self._fallbacks = tuple(fallbacks)
        self._max_hops = max(0, int(max_hops))
        # best-effort 粘滞提示：按主模型记成功过的绝对下标。并发 worker 可能读到
        # 稍旧的值，但永远是一个合法下标，不影响正确性。
        self._preferred: dict[str, int] = {}

    @classmethod
    def from_router(
        cls,
        router: ProviderRouter,
        *,
        fallbacks: tuple[Candidate, ...],
        max_hops: int,
    ) -> CandidateChainRouter:
        return cls(
            default=router._default,
            providers=dict(router._providers),
            fallbacks=fallbacks,
            max_hops=max_hops,
        )

    def _plan(self, primary: str) -> tuple[tuple[int, str], ...]:
        return plan_for(
            primary,
            self._fallbacks,
            max_hops=self._max_hops,
            start=self._preferred.get(primary, 0),
        )

    def _remember(self, primary: str, index: int) -> None:
        if len(self._preferred) > 32:
            self._preferred.clear()
        self._preferred[primary] = index

    def clone(self) -> CandidateChainRouter:
        """后台 drive 独立持有：叶子照常 clone，链配置与粘滞提示一起带过去。"""
        base = super().clone()
        cloned = self.from_router(
            base, fallbacks=self._fallbacks, max_hops=self._max_hops
        )
        cloned._preferred = dict(self._preferred)
        return cloned

    def stream(self, request: LLMRequest) -> AsyncIterator[LLMChunk]:
        return self._stream_with_chain(request)

    async def _stream_with_chain(self, request: LLMRequest) -> AsyncIterator[LLMChunk]:
        plan = self._plan(request.model)
        if len(plan) == 1:
            async for chunk in super().stream(request):
                yield chunk
            return

        for position, (index, key) in enumerate(plan):
            committed = False
            try:
                async for chunk in super().stream(replace(request, model=key)):
                    # 与叶层一致：只有正文 / 工具调用算 commit，reasoning 不算。
                    if chunk.delta_content or chunk.delta_tool_calls:
                        committed = True
                    yield chunk
            except Exception as exc:
                # 取消信号是 BaseException，不会被这里吞掉。
                if committed or position + 1 >= len(plan) or not should_hop(exc):
                    raise
                nxt = plan[position + 1][1]
                logger.info(
                    "llm.candidate_hop",
                    from_model=key,
                    to_model=nxt,
                    reason=type(exc).__name__,
                    hop=position + 1,
                )
                yield LLMChunk(stream_reset=True)
                continue
            self._remember(request.model, index)
            return

    async def complete(self, request: LLMRequest) -> LLMResponse:
        plan = self._plan(request.model)
        for position, (index, key) in enumerate(plan):
            try:
                response = await super().complete(replace(request, model=key))
            except Exception as exc:
                if position + 1 >= len(plan) or not should_hop(exc):
                    raise
                logger.info(
                    "llm.candidate_hop",
                    from_model=key,
                    to_model=plan[position + 1][1],
                    reason=type(exc).__name__,
                    hop=position + 1,
                )
                continue
            self._remember(request.model, index)
            return response
        raise RuntimeError("candidate chain plan is empty")  # pragma: no cover
