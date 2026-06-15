"""ask_user — the CEO pauses the turn to ask the user a decision (checkpoint).

CEO-only: wired in ``runtime.pipeline`` next to ``delegate`` and deliberately
NOT in ``build_builtin_registry`` (so delegated workers never get it — a worker
does not talk to the user). When the CEO reaches a fork it genuinely cannot
resolve alone — A vs B, an irreversible step, scope clearly larger than expected
— it calls ``ask_user``; the turn suspends on the checkpoint registry's Future, a
checkpoint card surfaces in the chat, and the user's answer flows back into the
CEO's ReAct loop as this tool's result. The question + answer are journaled
(``events._JOURNAL_EVENT_TYPES``) so a reload replays the exchange inline.

A continue / adjust answer is ``ToolEffect.CONTINUE`` (the CEO resumes); a stop is
``ToolEffect.INTERACT`` — a terminal effect that ends the turn gracefully in-band
(its closing note rides as ``ToolResult.final_text``), not an SSE abort. The tool
is :class:`ToolCategory.INTERACTION` — a declarative classification; the engine
acts on the ToolResult's effect, not on the tool's category.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

from agentcore.core.logging import get_logger
from agentcore.core.types import ToolApproval, ToolCategory, ToolEffect, new_id
from agentcore.runtime.checkpoints import (
    CheckpointDecision,
    CheckpointResponse,
)
from agentcore.runtime.events import (
    EventSink,
    checkpoint_required,
    checkpoint_resolved,
    content_delta,
)
from agentcore.runtime.interaction import InteractionKind
from agentcore.runtime.ports import ClientRequestBridge
from agentcore.tools.protocol import ToolContext, ToolResult, ToolSchema

logger = get_logger(__name__)

# Cap how many concrete choices the CEO can offer, so a runaway prompt can't bloat
# the card / event. The user can always type a free-form steer via "adjust".
_MAX_OPTIONS = 6


@dataclass
class AskUserTool:
    """The CEO's checkpoint primitive: ask the user, suspend, resume on the answer.

    Constructed per turn where the sink is available (mirrors ``ApprovalGate`` /
    ``DelegateTool``): ``sink`` carries the prompt + resolution to the client,
    ``registry`` bridges the resolve endpoint, ``timeout_seconds`` bounds the wait.
    """

    sink: EventSink
    conversation_id: str
    registry: ClientRequestBridge
    timeout_seconds: float

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name="ask_user",
            description=(
                "在你（CEO）遇到自己无法独自定夺、且选错代价高的关键岔路时，暂停并征询用户。"
                "适用场景：方案 A/B 抉择、执行不可逆操作前确认、任务范围明显超出预期需用户拍板。"
                "不要用于：你能自行决定的细节、可用合理默认值的小选择、简单任务——滥用会打断体验。"
                "用户会以「继续 / 调整 / 停止」回应，其答复会作为本工具的结果回到你的对话循环；"
                "「停止」会直接结束本回合，故仅在确有必要时调用。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "question": {
                        "type": "string",
                        "description": (
                            "向用户清晰说明的决策点：当前状况、为什么需要 ta 来定夺。"
                        ),
                    },
                    "options": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "可选：供用户挑选的具体选项（最多 6 个）。",
                    },
                    "context": {
                        "type": "string",
                        "description": "可选：帮助用户判断的背景补充。",
                    },
                },
                "required": ["question"],
            },
            category=ToolCategory.INTERACTION,
            approval=ToolApproval.NEVER,
        )

    async def execute(
        self, arguments: dict[str, Any], context: ToolContext
    ) -> ToolResult:
        question = str(arguments.get("question") or "").strip()
        if not question:
            return ToolResult(
                tool_call_id="",
                success=False,
                output="",
                error="ask_user 需要非空的 question 参数。",
            )
        options = [str(o) for o in (arguments.get("options") or [])][:_MAX_OPTIONS]
        ctx_text = str(arguments.get("context") or "")

        checkpoint_id = new_id()
        fut = self.registry.create(
            checkpoint_id,
            self.conversation_id,
            kind=InteractionKind.ASK_USER,
            payload={
                "question": question,
                "options": options,
                "context": ctx_text,
            },
        )
        self.sink.emit(
            checkpoint_required(
                checkpoint_id=checkpoint_id,
                conversation_id=self.conversation_id,
                question=question,
                options=options,
                context=ctx_text,
            )
        )
        try:
            response = await asyncio.wait_for(fut, timeout=self.timeout_seconds)
        except TimeoutError:
            logger.info("checkpoint.timeout", checkpoint_id=checkpoint_id)
            response = CheckpointResponse(decision=CheckpointDecision.TIMEOUT)
        finally:
            self.registry.discard(checkpoint_id)

        self.sink.emit(
            checkpoint_resolved(
                checkpoint_id=checkpoint_id,
                decision=response.decision.value,
                note=response.note,
            )
        )
        return self._to_result(response)

    def _to_result(self, response: CheckpointResponse) -> ToolResult:
        """Map the user's answer to a tool result the CEO loop consumes.

        continue / adjust feed back as ``CONTINUE`` results (the CEO resumes); stop
        returns an ``INTERACT`` (terminal) result so the engine ends the turn
        gracefully (its closing note is also streamed to the bubble so the user
        sees it live and a reload renders the same persisted text); a timeout hands
        control back to the CEO to wrap up on its own.
        """
        decision = response.decision
        if decision is CheckpointDecision.CONTINUE:
            return ToolResult(
                tool_call_id="",
                success=True,
                output="用户确认：按你提出的方向继续。",
            )
        if decision is CheckpointDecision.ADJUST:
            note = response.note.strip() or "（用户未填写具体调整说明，请据上下文稳妥推进）"
            return ToolResult(
                tool_call_id="",
                success=True,
                output=f"用户调整指令：{note}\n请据此调整后再继续。",
            )
        if decision is CheckpointDecision.STOP:
            closing = response.note.strip() or "好的，已按你的要求停止本回合。"
            self.sink.emit(content_delta(closing))
            return ToolResult(
                tool_call_id="",
                success=True,
                output="用户选择停止本回合。",
                effect=ToolEffect.INTERACT,
                final_text=closing,
            )
        # TIMEOUT — never silently picked a branch; let the CEO decide how to close.
        return ToolResult(
            tool_call_id="",
            success=True,
            output="用户未在时限内回应。请基于目前已掌握的信息，自行决定如何稳妥收尾。",
        )
