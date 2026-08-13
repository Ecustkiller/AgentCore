"""Hard-timeout kill is reported as a timeout, not as a re-task.

The kill reuses the cancel channel, and the cancel arg is the ONLY carrier of why
the worker died — it lands verbatim on the wire ``run_cancelled.reason`` (协作图
node label). Hardcoding ``redirect`` there told the user「已改派」for a worker that
nobody re-tasked: it hit the timeout ceiling and was killed.
"""

import asyncio

from agentcore.runtime.events import EventSink, EventType
from agentcore.runtime.runs.builder import build_run_plan
from agentcore.runtime.runs.timeout_hard import (
    HardTimeoutPhase,
    arm_hard_timeout,
    disarm_hard_timeout,
)
from agentcore.runtime.runs.types import RunPhase
from agentcore.runtime.runs.wave import WaveScheduler
from tests.runs_executor.conftest import _ContentProvider, _executor


async def _walk_to_post_grace(run_id: str):
    guard = arm_hard_timeout(run_id, timeout_s=0.01, warn_ratio=0.0, grace_wall_s=600)
    assert guard is not None
    for _ in range(200):
        if guard.phase is HardTimeoutPhase.TIMED_OUT:
            break
        await asyncio.sleep(0.01)
    assert guard.begin_grace_round() is True
    guard.end_grace_round()  # 宽限一轮已交卷/用尽 → 下一次入口即强杀
    return guard


async def test_hard_timeout_kill_emits_run_cancelled_reason_worker_timeout():
    plan, _ = build_run_plan([{"role": "A", "task": "做A"}], id_prefix="t")
    sink = EventSink()
    provider = _ContentProvider(["AOUT"])
    await _walk_to_post_grace("t_1")
    try:
        res = await WaveScheduler().run(plan, _executor(plan, provider, sink))
    finally:
        disarm_hard_timeout("t_1")

    state = res["t_1"]
    assert state.phase is RunPhase.CANCELLED
    assert state.error == "worker_timeout"
    assert provider.calls == 0  # killed at the round boundary, no new LLM work

    cancelled = [e for e in sink._history if e.type is EventType.RUN_CANCELLED]  # noqa: SLF001
    assert [e.payload.get("reason") for e in cancelled] == ["worker_timeout"]
    assert cancelled[0].payload.get("run_id") == "t_1"
