"""Drive-level run-redirect (中间可见性 Phase 2a Step 2–3B): a user redirect on a still-running
worker cancels ONLY that worker and cold-re-runs it with the user's ``steer``, while parallel
teammates keep running. The turn-level redirect queue + WaveScheduler single cancel + drive's
cold re-run are exercised end-to-end through the real DelegateTool (fake LLM, no network).
"""

import asyncio

from agentcore.llm.provider.protocol import LLMChunk
from agentcore.runtime.events import EventSink
from agentcore.runtime.events.types import EventType
from agentcore.runtime.runs.redirect_queue import enqueue_redirect, take_redirects
from tests.delegate.conftest import Provider, ctx, tool

_STEER = "改成B方向重做"


class _RedirectProvider:
    """Every ORIGINAL worker sleeps (so a redirect can cancel it mid-flight); a COLD RE-RUN
    — its prompt now carries the user's ``steer`` block — returns immediately. Keyed only on the
    steer text (never on task text, which also leaks into a sibling's「并行队友」summary)."""

    def __init__(self) -> None:
        self.steered_calls = 0

    async def stream(self, request):  # noqa: ANN001 - duck-typed for the loop
        user = " ".join(m.content or "" for m in request.messages if m.role == "user")
        if _STEER in user:  # the user's steer reached the cold-re-run node's prompt (Step 3B)
            self.steered_calls += 1
            yield LLMChunk(delta_content="STEERED_DONE")
            return
        await asyncio.sleep(0.5)  # a slow original — the redirected one is cancelled here
        yield LLMChunk(delta_content="ORIG_DONE")


class _RedirectOnStartSink(EventSink):
    """Enqueues ONE redirect the instant the first worker starts — mimics the user clicking
    「立即改此人」on a running worker (POST …/run-redirect) while ``delegate`` drives."""

    def __init__(self, feedback: str) -> None:
        super().__init__()
        self._feedback = feedback
        self._sent = False
        self.redirected_run_id = ""

    def emit(self, event) -> None:  # noqa: ANN001
        if not self._sent and event.type is EventType.RUN_STARTED:
            run_id = str(event.payload.get("run_id") or "")
            if run_id:
                self.redirected_run_id = run_id
                enqueue_redirect(
                    execution_id="e",
                    run_id=run_id,
                    feedback=self._feedback,
                    conversation_id="c",
                )
                self._sent = True
        super().emit(event)


async def test_redirect_cancels_running_worker_and_cold_reruns_with_steer():
    """Redirect the only running worker → it is cancelled and cold-re-run with the steer;
    the cancelled original's product is dropped, the steered re-run's is delivered."""
    provider = _RedirectProvider()
    sink = _RedirectOnStartSink(_STEER)
    t = tool(provider, sink)

    result = await t.execute(
        {"tasks": [{"id": "a", "role": "研究员", "task": "原方向调研"}]}, ctx()
    )

    assert result.success is True
    assert provider.steered_calls == 1  # the cold re-run happened once, with the steer
    assert "STEERED_DONE" in result.output  # steered re-run delivered
    assert "ORIG_DONE" not in result.output  # cancelled original NOT delivered


async def test_redirect_one_worker_leaves_sibling_running():
    """并行 ≥2 worker，redirect 其一 → 另一照常 completed，整轮不 cancelled (验收 §10.2-1)."""
    provider = _RedirectProvider()
    sink = _RedirectOnStartSink(_STEER)
    t = tool(provider, sink)

    result = await t.execute(
        {
            "tasks": [
                {"id": "a", "role": "研究员", "task": "并行调研甲"},
                {"id": "b", "role": "编辑", "task": "并行撰写乙"},
            ]
        },
        ctx(),
    )

    assert result.success is True
    # Exactly one worker was redirected + cold-re-ran (STEERED_DONE); the untouched sibling
    # ran to completion normally (ORIG_DONE present), so the whole turn is not cancelled.
    assert provider.steered_calls == 1
    assert "STEERED_DONE" in result.output
    assert "ORIG_DONE" in result.output


async def test_redirect_that_cannot_apply_is_recorded_ignored(monkeypatch):
    """跑一半改方向 · 忽略路径收口 (Step 4): a redirect whose target never runs (already terminal /
    arrived too late) can't be applied mid-run → drive records it as ignored (audit-only, no wire
    effect) so the run detail can surface「改方向未生效」+ offer an explicit accept."""
    take_redirects("e")  # isolate from any redirect a prior test left queued for this execution
    recorded: list[dict] = []

    def _capture(*, run_id, feedback=None, execution_id=None):
        recorded.append({"run_id": run_id, "feedback": feedback, "execution_id": execution_id})

    monkeypatch.setattr("agentcore.runtime.audit.hooks.on_run_redirect_ignored", _capture)

    # A steer for a run id that is never in-flight (the worker already finished / never existed):
    # the WaveScheduler can't cancel it, so the cold re-run never happens and it is ignored.
    enqueue_redirect(execution_id="e", run_id="ghost", feedback="太晚了改不动", conversation_id="c")

    t = tool(Provider(["调研完成"]))
    result = await t.execute({"tasks": [{"id": "a", "role": "研究员", "task": "调研"}]}, ctx())

    assert result.success is True
    assert [r["run_id"] for r in recorded] == ["ghost"]
    assert recorded[0]["feedback"] == "太晚了改不动"
    assert recorded[0]["execution_id"] == "e"
