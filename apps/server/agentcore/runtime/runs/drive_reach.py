"""引擎还够不够得着这个 run —— 按人干预受理判定的唯一事实源。

客户端此前靠「气泡还在流吗」(``turnLive``) 猜这件事。团队转后台执行后两者分离：
气泡早已收口，驱动循环却照样在排干 stop / redirect；反过来，回合还在流但这批 delegate
已经跑完时，队列上入的请求永远没人来取。猜的两边都会错，所以答案由驱动循环自己登记。

登记的是**活的 ``RunPlan`` 对象本身**（``drive`` 拿的那一只），于是两个问题一次答完：
- 这条 execution 有没有活的驱动循环 → 注册表里有没有条目；
- 这个 ``run_id`` 在不在当前计划里 → 问那只 plan（冷回落 ``_redir`` 追加进来的节点同样算）。

一条 execution 可以同时有多只驱动（嵌套子团队与父团队共用 ``execution_id``），故按
token 存多条；任一命中即算够得着。进程内即可——REST 路由、sidecar handler 与驱动循环
跑在同一进程（云端 API / 桌面 sidecar 各自如此）。
"""

from __future__ import annotations

import itertools
from dataclasses import dataclass

from agentcore.runtime.runs.plan import RunPlan

_tokens = itertools.count(1)
_live: dict[str, dict[int, RunPlan]] = {}


@dataclass(frozen=True, slots=True)
class DriveReach:
    """引擎对「我还能作用于这个 run 吗」的回答。"""

    driving: bool
    """这条 execution 上有活的驱动循环（会来排干 stop / redirect 队列）。"""

    in_plan: bool
    """目标 run 在某只活计划里。``run_id`` 省略（停全部）时随 ``driving``。"""

    @property
    def reachable(self) -> bool:
        return self.driving and self.in_plan


def register_drive(execution_id: str, plan: RunPlan) -> int:
    """驱动循环开跑：登记它正在跑的活计划，返回注销用的 token。"""
    token = next(_tokens)
    eid = (execution_id or "").strip()
    if eid:
        _live.setdefault(eid, {})[token] = plan
    return token


def unregister_drive(execution_id: str, token: int) -> None:
    """驱动循环退出：摘掉这只计划（必须在 ``finally`` 里调，否则会留下幽灵）。"""
    eid = (execution_id or "").strip()
    bucket = _live.get(eid)
    if bucket is None:
        return
    bucket.pop(token, None)
    if not bucket:
        _live.pop(eid, None)


def drive_reach(execution_id: str, run_id: str | None = None) -> DriveReach:
    """引擎此刻够不够得着 ``run_id``（省略 = 这条 execution 的全体队员）。"""
    eid = (execution_id or "").strip()
    plans = list(_live.get(eid, {}).values())
    if not plans:
        return DriveReach(driving=False, in_plan=False)
    rid = (run_id or "").strip()
    if not rid:
        return DriveReach(driving=True, in_plan=True)
    if any(plan.by_id(rid) is not None for plan in plans):
        return DriveReach(driving=True, in_plan=True)
    return DriveReach(driving=True, in_plan=False)


def reset_drive_registry() -> None:
    """测试清场：丢弃所有登记（生产路径靠 ``unregister_drive``）。"""
    _live.clear()
