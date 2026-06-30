"""Apply a resume decision to a paused suspension frame, by kind."""

from __future__ import annotations

from typing import NamedTuple

from agentcore.core.types import ToolEffect
from agentcore.llm.protocol import LLMMessage
from agentcore.runtime.checkpoints import CheckpointDecision, CheckpointResponse
from agentcore.runtime.events import EventSink, checkpoint_resolved, plan_review_resolved
from agentcore.runtime.journal import completed_from_journal, plan_from_journal
from agentcore.runtime.suspension import AskUserSuspension, PlanReviewSuspension, TurnSuspension
from agentcore.tools.builtin.ask_user import ask_user_tool_result
from agentcore.tools.builtin.ask_user.schema import option_label
from agentcore.tools.builtin.delegate import DelegateTool


def append_resumed_tool_results(
    messages: list[LLMMessage], tool_call_id: str, output: str
) -> None:
    """Close the suspended tool-call in the rebuilt CEO transcript (结构化挂起 2b).

    The transcript ends with the assistant message that issued the suspended call
    (``delegate`` for plan_review, ``ask_user`` for ask_user — the pause happened
    inside it). Append the settled result as that call's tool result so the loop
    continues from a valid assistant-tool_call → tool-result pair. Any SIBLING
    tool_calls in the same assistant turn (a rare concurrent call) get a placeholder
    result, since every tool_call MUST have a matching result or the next request
    400s — their work wasn't captured (the pause unwound only the suspended call).
    """
    last = messages[-1] if messages else None
    if last is None or last.role != "assistant" or not last.tool_calls:
        messages.append(LLMMessage(role="tool", content=output, tool_call_id=tool_call_id))
        return
    target = tool_call_id or (last.tool_calls[0].id if last.tool_calls else "")
    for tc in last.tool_calls:
        if tc.id == target:
            messages.append(LLMMessage(role="tool", content=output, tool_call_id=tc.id))
        else:
            messages.append(
                LLMMessage(
                    role="tool",
                    content="（该并行工具调用在本回合暂停时未保留结果，已跳过。）",
                    tool_call_id=tc.id,
                )
            )


class SettledSuspension(NamedTuple):
    """The outcome of applying a resume decision to a paused frame (结构化挂起 2b).

    ``output`` is the suspended tool-call's result text, fed back into the rebuilt
    CEO transcript. ``terminal_text`` is set only when the answer ended the turn
    in-band (ask_user ``stop``) — its closing note IS the reply, so resume finishes
    on it WITHOUT another CEO round (mirroring the engine's terminal-effect branch);
    ``None`` means run the CEO loop to its reply (plan_review always; ask_user
    continue / adjust / timeout).
    """

    output: str
    terminal_text: str | None


async def settle_resumed_suspension(
    suspension: TurnSuspension,
    *,
    decision: CheckpointDecision,
    note: str,
    selected: list[str],
    sink: EventSink,
    delegate_tool: DelegateTool,
    execution_id: str,
) -> SettledSuspension:
    """Apply the user's resume decision to the paused frame, by kind (结构化挂起 2b).

    plan_review: emit the resolution, then ``delegate.resume_plan`` drives the
    remaining tail (continue / adjust-steer / stop-skip) and returns the workers'
    product — always fed back to the CEO loop (which writes the overview).

    ask_user: emit the resolution, then map the answer to the ``ask_user`` tool
    result via the shared :func:`ask_user_tool_result`. A ``stop`` yields a terminal
    result whose closing note ends the turn directly (no CEO round); the picks are
    validated against the offered options just like the live path.
    """
    if isinstance(suspension, AskUserSuspension):
        response = CheckpointResponse(decision=decision, note=note, selected=list(selected))
        # Drop any pick that was not on some question's menu (same guard as the live
        # tool; the desktop composes its answer into ``note`` and sends no picks).
        # ``option_label`` tolerates both the rich-object shape and a bare-string option
        # from a frame persisted before options carried detail/recommended.
        allowed = {
            option_label(o) for q in suspension.questions for o in q.get("options", [])
        }
        response.selected = [s for s in response.selected if s in allowed]
        sink.emit(
            checkpoint_resolved(
                checkpoint_id=suspension.checkpoint_id,
                decision=response.decision.value,
                note=response.note,
                selected=response.selected,
            )
        )
        result = ask_user_tool_result(response)
        terminal = result.final_text if result.effect is ToolEffect.INTERACT else None
        return SettledSuspension(result.output, terminal)

    if isinstance(suspension, PlanReviewSuspension):
        sink.emit(
            plan_review_resolved(
                checkpoint_id=suspension.checkpoint_id,
                decision=decision.value,
                note=note,
            )
        )
        # Re-seed finished workers from the §8.3 journal run-final facts (执行级事件溯源
        # Phase 2 ⑥ — `completed_from_journal` == the dropped `frame.completed`, gated by
        # the conformance golden), so the resumed plan bills the whole graph once without
        # the旁路 blob. Falls back to the in-memory `completed` for a same-process resume
        # (tests) whose journal was not hydrated; a claimed frame always carries the facts
        # (else `resumed_captain_window` already raised on the empty journal upstream).
        seed_completed = completed_from_journal(suspension.journal_entries) or suspension.completed
        # Rebuild the DAG from the journal's plan_snapshot fact (执行级事件溯源 Phase 2 —
        # `plan_from_journal` == the dropped `frame.plan`, gated by the conformance golden),
        # so the resumed drive re-mints nothing and its run_ids match `seed_completed`. Same
        # fallback posture as the seed: the in-memory `plan` carrier covers a same-process
        # resume (tests) whose journal was not bound; a claimed frame always carries the fact.
        plan = plan_from_journal(suspension.journal_entries) or suspension.plan
        delegate_result = await delegate_tool.resume_plan(
            plan,
            seed_completed,
            decision=decision,
            note=note,
            checkpoint_run_ids=suspension.checkpoint_run_ids,
            execution_id=execution_id,
        )
        return SettledSuspension(delegate_result.output, None)

    raise ValueError(f"unknown suspension kind: {suspension.kind!r}")
