"""Opt-in lab: user-level scheduled outbound notifications (生成 / 最后修订 2026-11-04).

⚠️ 与上游产品口径**相悖**，用户 2026-11-04 明确裁定「做成 opt-in 实验功能，默认关」：
上游迁移 ``c1e7a9d4b2f6`` 退役了 clock/webhook proxy runs，《后端架构》写
「不抽统一 job 框架 / 用户工作流·定时代跑否决 / 无人值守不做」，术语表补
「不是远期」。本模块是**本地实验**，未来同步上游时可能整块撤回。

为把冲突面压到最小，这里：
- 只做「到点发一个 HMAC 签名的出站 HTTP 通知」，**不启动 AI 回合、不代跑
  agent、不复活工作流物种 / 画布 / 商店、不抽统一 job 框架**；
- 独立 ``lab_`` 命名空间 + 独立表，不碰任何既有产品表；
- **默认关**：API 一律 404、调度 loop 不启动、不写任何行。
"""

from pydantic import BaseModel, Field


class LabScheduleSettings(BaseModel):
    # 默认关 = 上游现状。开了才会挂 loop / 放行 API / 允许写 lab_scheduled_jobs。
    lab_scheduled_jobs_enabled: bool = False

    lab_scheduled_jobs_tick_seconds: float = Field(default=30.0, ge=5.0, le=3600.0)
    lab_scheduled_jobs_max_per_tick: int = Field(default=20, ge=1, le=200)
    lab_scheduled_jobs_timeout_seconds: float = Field(default=5.0, ge=1.0, le=30.0)
    # 高频任务不是这个实验的目标，也不该给本机造流量。
    lab_scheduled_jobs_min_interval_seconds: int = Field(default=60, ge=30, le=86400)
