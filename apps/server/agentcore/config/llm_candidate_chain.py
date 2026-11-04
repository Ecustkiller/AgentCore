"""Cross-provider candidate chain settings (生成 / 最后修订 2026-11-04).

上游现状：``platform_pool_scheduler.failover_member`` 只做**同模型换账号**
（429/403 跳、401 不跳），引擎的流式停滞闸只重试同一个 leaf，没有
「这个 provider 挂了就换下一个 provider / 模型」的路。本 fork 的 #6 补一条
**显式配置、opt-in、默认关**的候选链。

为什么默认关：换 provider 会改变 wire 方言、计价模型与准入闸语义，属于
产品级行为变化；按本 fork 原则不覆盖上游默认行为。开关关掉时
``build_turn_router`` 返回的对象与上游字节一致。

v1 边界（详见 ``llm/candidate_chain.py::CANDIDATE_CHAIN_CAPABILITIES``）：
- 实例级配置（env ``LLM_CANDIDATE_CHAIN_SPEC``），**不是**按用户存的表 / API；
- 只跳「换个人就好」的可恢复上游故障（429 / 额度 / 5xx / 超时），
  **不跳** 401/403 鉴权死亡与 402 余额耗尽 —— ``turn_auth_dead`` 是 payer 级
  latch，一锁就会挡住同 payer 的后续候选，且按上游设计这是 turn 级短路；
- 流式 commit 之后绝不换候选（半成品不重放）；
- **只在同一个 payer 内换**：user BYOK ↔ platform 的跨 payer 候选会被跳过，
  因为 ``bind_credential_pricing_context`` 只在回合装配时绑一次，跨 payer 跳
  不会重绑 ambient ``credential_source``，会把计价 / 归因静默留在主 payer；
- run 级计价仍用静态 ``turn_model``，按候选实际模型计价的只有单次 ``llm.call``。

env（pydantic-settings 无前缀，字段大写即变量名）::

    LLM_CANDIDATE_CHAIN_ENABLED=1
    LLM_CANDIDATE_CHAIN_MAX_HOPS=2
    LLM_CANDIDATE_CHAIN_SPEC='[
      {"provider_id":"", "model":"openrouter/free-backup"},
      {"provider_id":"other-byok-id", "model":"claude-sonnet-5.5"},
      {"provider_id":"platform", "model":"deepseek-v4-flash"}
    ]'

``provider_id`` 空串 = 沿用本回合默认 leaf 只换模型；``platform`` = 平台凭据
哨兵；其他值 = 该用户的 BYOK provider id（构造回合时解析凭据并注册前缀）。
"""

from pydantic import BaseModel, Field


class LlmCandidateChainSettings(BaseModel):
    # 默认关：关掉时 build_turn_router 返回原生 ProviderRouter，不套任何包装。
    llm_candidate_chain_enabled: bool = False

    # 一次调用里最多允许换几次候选；0 = 只走主候选（等价关闭）。
    llm_candidate_chain_max_hops: int = Field(default=2, ge=0, le=5)

    # JSON 数组字符串。解析严格 fail closed：任何坏形状都按「没配链」处理，
    # 绝不把半个配置拼进路由键。纯解析函数在 llm/candidate_chain.py。
    llm_candidate_chain_spec: str = ""
