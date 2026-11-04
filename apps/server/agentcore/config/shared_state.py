"""Opt-in shared backends for two process-local seams (生成 / 最后修订 2026-11-04).

**先把口径讲清楚，免得本项被误读成「多 worker 解锁」**（上游文档与实现一致）：

《部署拓扑与环境》§六「API 进程约束：多 worker 一律拒启」——即使
``RATE_LIMIT_BACKEND=redis`` 也拒启；**放开的前置是跨进程扇出，不是任何
环境变量，故上游有意不留 opt-in 逃生阀**。``main.py`` 的
``_validate_single_process_assumptions`` 是 fail-closed 实现，
``tests/test_startup_validation.py`` 两条用例把「redis 也不放行」钉死。
真正卡住多实例的是设备履约中枢与对话事件流里的**活 SSE 连接**，Redis 存不了
``asyncio.Future`` / 订阅对象。

本项**不修改那段启动校验、不新增解锁 worker 的开关、不宣称多机就绪**。只把
两处「上游已书面接受 skew」的进程内状态做成可切共享后端：

1. 429 冷却槽（``llm/provider/cooldown_gate.py``，模块注释写明
   "Multi-worker skew is accepted"）；
2. sidecar 单回合计费 claim（``conversation/inference_rate_limit.py``）。

默认 ``memory`` 时行为与上游逐位等价；``redis`` 只是减少将来真做跨进程扇出
时还要补的两处补丁面，**不能**据此放开多 worker。

仓库里另有三处陈旧注释（``config/auth.py``、``billing/cost_ledger_queue.py``
与《发布与门禁》）曾写「redis 解锁多 worker」，与实现相悖；前两处已随本项
改成指向 §六，文档那处未擅动。
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator

SharedBackend = Literal["memory", "redis"]


class SharedStateSettings(BaseModel):
    """实例级 opt-in；两个后端互相独立，不复用 ``rate_limit_backend``。

    ``rate_limit_backend`` 是安全限流语义，复用它会让运维以为「切限流后端」
    顺带改了冷却 / 计费 claim，属于静默扩大变更面。
    """

    llm_cooldown_backend: SharedBackend = Field(default="memory")
    inference_turn_claim_backend: SharedBackend = Field(default="memory")

    @field_validator("llm_cooldown_backend", "inference_turn_claim_backend", mode="before")
    @classmethod
    def _normalize_lowercase_choice(cls, value: object) -> object:
        if isinstance(value, str):
            return value.strip().lower()
        return value
