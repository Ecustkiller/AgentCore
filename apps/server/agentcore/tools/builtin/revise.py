"""revise: the CEO's 定向唤回（乙 热修）primitive — recall a finished worker to
revise its OWN draft.

The complement to ``delegate``: where ``delegate`` spins up cold new workers,
``revise`` recalls the ORIGINAL author of an already-finished product (kept alive
as a :class:`~agentcore.runtime.runs.session.RunSession` in the turn's roster) and
has it continue on its own transcript with the CEO's feedback — faster, cheaper,
and keeping the original train of thought. Non-terminal, exactly like ``delegate``:
the revised product returns to the CEO's loop to wrap up.

P1 范围：只命中【本回合】委派过的成员（同轮热修）。命中不了（run 不在本回合 / 已超改次
上限）时拒绝并提示回落甲（带旧产物重新 ``delegate``）——这正是甲作为 miss 分支的体现。

→ 见设计: docs/07-规划/多轮编排与队员热修.md §三（统一「续写」原语）
"""

from __future__ import annotations

import time
from dataclasses import replace
from typing import TYPE_CHECKING, Any

from agentcore.core.logging import get_logger
from agentcore.core.types import ToolApproval, ToolCategory, new_id
from agentcore.llm.deepseek import DeepSeekProvider
from agentcore.llm.modes import ProfileSet, default_profile_set
from agentcore.runtime.citations import merge_citations
from agentcore.runtime.events import EventSink
from agentcore.runtime.runs.constants import DEFAULT_RECALL_LIMIT
from agentcore.tools.protocol import ToolContext, ToolResult, ToolSchema

if TYPE_CHECKING:
    from agentcore.runtime.approvals import ApprovalGate
    from agentcore.runtime.costing import RunCost
    from agentcore.runtime.sessions import SessionLoader, SessionSaver, SessionStore

logger = get_logger(__name__)

# The CEO reads the revised product as this tool's output; match delegate's raised
# budget so a long revision isn't clipped before the CEO can integrate it.
_REVISE_OUTPUT_LIMIT = 16000

_REVISE_DESCRIPTION = (
    "对【本回合内已完成】的某个 worker 产物做定向修订：唤回原作者，带着它的现场记忆在"
    "自己上一版产出的基础上按你的意见继续改，而不是从零另派一个看不到旧稿的新人重做"
    "（更快、更省，且不丢原有思路）。\n"
    "何时用：用户看到某个 worker 的产物后要求小改 / 增补 / 调整（如『把风险那节展开』"
    "『换个更正式的语气』『再补一节测试』），且仍由原角色来改最合适。\n"
    "何时不要用、改用 delegate 带上旧产物重新委派：要换一个角色来改（研究员稿让工程师"
    "重写）、原稿本身是失败的、或要把多份产物合并了再改。\n"
    "本工具不会替你回复用户：修订结果会作为结果回到你这里，由你照常写简短概览或继续。"
)

_REVISE_PARAMETERS = {
    "type": "object",
    "properties": {
        "target_run_id": {
            "type": "string",
            "description": (
                "要修订的那个 worker 产物的 run_id（取自团队执行结果里每个成员标注的 "
                "run_id）。必须是本回合委派过、且成功完成的成员。"
            ),
        },
        "feedback": {
            "type": "string",
            "description": "具体、可执行的修改意见——要清楚说明改哪里、怎么改 / 加什么。",
        },
    },
    "required": ["target_run_id", "feedback"],
}


class ReviseTool:
    """CEO-agent tool that recalls a finished worker to revise its own draft
    (non-terminal, like ``delegate``)."""

    def __init__(
        self,
        *,
        llm: DeepSeekProvider,
        sink: EventSink,
        session_store: SessionStore,
        tools: Any,
        base_tool_context: ToolContext,
        profile_set: ProfileSet | None = None,
        captain_run_id: str | None = None,
        approval_gate: ApprovalGate | None = None,
        session_saver: SessionSaver | None = None,
        session_loader: SessionLoader | None = None,
    ) -> None:
        self._llm = llm
        self._sink = sink
        self._session_store = session_store
        # Durable roster (P3 跨进程落盘): ``_session_loader`` rehydrates a session by
        # run_id when the in-memory roster misses (restart / eviction), and
        # ``_session_saver`` write-throughs the revised session. Both None ⇒ in-memory
        # only (P2): a cross-process miss falls back to 甲.
        self._session_saver = session_saver
        self._session_loader = session_loader
        # The worker toolset (same as delegate's): a revision re-runs under the
        # original spec's allow-list, intersected with these.
        self._tools = tools
        self._base_tool_context = base_tool_context
        self._profile_set = profile_set or default_profile_set()
        self._captain_run_id = captain_run_id
        # Forwarded to the continuation ONLY in local mode (by the pipeline), so a
        # recalled worker's machine-touching tools stay gated exactly like delegate.
        self._approval_gate = approval_gate
        # Mirrors DelegateTool: a revision is another member run, so its token
        # usage + cost row + web sources fold back into the turn totals the pipeline
        # reads (one ledger row per revision, 决策②).
        self.usage: dict[str, int] = {
            "input": 0,
            "output": 0,
            "reasoning": 0,
            "cache_hit": 0,
            "cache_miss": 0,
        }
        self.run_ledger: list[RunCost] = []
        self.citations: list[dict[str, Any]] = []

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name="revise",
            description=_REVISE_DESCRIPTION,
            parameters=_REVISE_PARAMETERS,
            category=ToolCategory.ORCHESTRATION,
            approval=ToolApproval.NEVER,
        )

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        from agentcore.runtime.runs import RunPhase, continue_run

        target = arguments.get("target_run_id")
        feedback = arguments.get("feedback")
        if not isinstance(target, str) or not target.strip():
            msg = "revise 需要 target_run_id（要修订的成员 run_id，取自团队执行结果）。"
            return ToolResult(tool_call_id="", success=False, output=msg, error=msg)
        if not isinstance(feedback, str) or not feedback.strip():
            msg = "revise 需要 feedback（具体、可执行的修改意见）。"
            return ToolResult(tool_call_id="", success=False, output=msg, error=msg)

        target = target.strip()
        session = self._session_store.get(target)
        # In-memory miss → try the durable roster (P3 跨进程落盘): a restart / eviction
        # drops the live session, but a persisted one rehydrates here and re-warms the
        # in-memory store for any further same-process revise.
        if session is None and self._session_loader is not None:
            session = await self._session_loader(target)
            if session is not None:
                self._session_store.put(session)
        # miss 分支 = 甲：run 既不在内存、也未落盘（更早被清 / 从未委派）→ 引导回落 delegate。
        if session is None:
            msg = (
                f"找不到 run_id 为 `{target}` 的可修订成员（可能不在本回合范围内，或来自"
                "更早的回合）。请改用 delegate：带上需要修改的旧产物内容 + 具体修改要求，"
                "重新委派一个 worker 来改。"
            )
            logger.info("revise.miss", target=target)
            return ToolResult(tool_call_id="", success=False, output=msg, error=msg)
        # 改次闸：超上限不再热修，回落甲，避免无限打磨。
        if session.recall_count >= DEFAULT_RECALL_LIMIT:
            msg = (
                f"成员 `{target}` 的定向修订已达上限（{DEFAULT_RECALL_LIMIT} 次），不再"
                "热修以避免无限打磨。如仍需调整，请改用 delegate 带上当前产物重新委派。"
            )
            logger.info("revise.capped", target=target, recall_count=session.recall_count)
            return ToolResult(tool_call_id="", success=False, output=msg, error=msg)

        revision_run_id = f"{target}_rev{session.recall_count + 1}"
        execution_id = self._base_tool_context.execution_id or new_id()
        logger.info("revise.started", target=target, revision_run_id=revision_run_id)
        state = await continue_run(
            session=session,
            feedback=feedback,
            revision_run_id=revision_run_id,
            llm=self._llm,
            tools=self._tools,
            sink=self._sink,
            base_tool_context=self._base_tool_context,
            execution_id=execution_id,
            profile_set=self._profile_set,
            approval_gate=self._approval_gate,
        )
        if state.phase is not RunPhase.COMPLETED or not state.content.strip():
            reason = state.error or "修订未产出有效结果"
            msg = (
                f"对 `{target}` 的修订未成功（{reason}）。可重试，或改用 delegate "
                "带上当前产物重新委派。"
            )
            return ToolResult(tool_call_id="", success=False, output=msg, error=msg)

        # Commit the extended transcript back to the roster so a FURTHER revise of
        # the same product continues from here, and the 改次闸 counts up.
        session.recall_count += 1
        session.transcript = state.transcript
        session.content = state.content
        session.updated_at = time.time()
        self._session_store.put(session)
        # Write-through the revised session so the next revise — even after a restart
        # / eviction — continues from this version and the 改次闸 holds (P3).
        if self._session_saver is not None:
            await self._session_saver(session)

        self._accumulate(
            state, revision_run_id=revision_run_id, spec=session.spec, parent_run_id=session.run_id
        )

        role = session.spec.role or session.run_id
        output = (
            f"## 修订结果（{role}，第 {session.recall_count} 次修订 · run_id: "
            f"`{revision_run_id}`）\n{state.content}\n\n---\n"
            "以上为该成员在原稿基础上的修订产出（用户可在界面查看 / 对比各版本）。请据此"
            "用你自己的声音收尾或继续；如需再次修订，仍用同一个 target_run_id。"
        )
        return ToolResult(
            tool_call_id="",
            success=True,
            output=output,
            output_limit=_REVISE_OUTPUT_LIMIT,
            metadata={
                "input_tokens": state.usage.get("input", 0),
                "output_tokens": state.usage.get("output", 0),
                "reasoning_tokens": state.usage.get("reasoning", 0),
                "cache_hit_tokens": state.usage.get("cache_hit", 0),
                "cache_miss_tokens": state.usage.get("cache_miss", 0),
            },
        )

    def _accumulate(self, state, *, revision_run_id: str, spec, parent_run_id: str | None) -> None:
        """Fold a revision into the turn totals: token usage, a member ledger row,
        and any web sources it consulted — mirroring how DelegateTool rolls up
        workers (一 run 一行, 决策②). The row carries the revision's own ``run_id``
        parented to the original run, so the version chain is reconstructable."""
        from agentcore.runtime.costing import member_run_cost

        for key in self.usage:
            self.usage[key] += state.usage.get(key, 0)
        if state.usage:
            self.run_ledger.append(
                member_run_cost(
                    replace(spec, run_id=revision_run_id, agent_id=revision_run_id),
                    state,
                    parent_run_id=parent_run_id,
                )
            )
        if state.citations:
            merge_citations(self.citations, state.citations)
