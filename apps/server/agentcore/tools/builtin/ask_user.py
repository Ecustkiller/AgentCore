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

结构化挂起 2b (turn 级落盘 + ``POST .../resume``): like the ``delegate`` checkpoint
hook, the suspend is backed by a durable frame — an :class:`AskUserSuspension` is
saved to ``paused_turns`` BEFORE the wait and dropped after a live in-process
resolve / timeout. A disconnect / restart during the wait leaves the frame so
``POST .../resume`` can map the user's answer back to this tool's result and
continue the CEO loop. The answer→result mapping is the module-level
:func:`ask_user_tool_result` so the live path and resume share one source of truth.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

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

if TYPE_CHECKING:
    from agentcore.runtime.suspension import SuspensionDeleter, SuspensionSaver

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

    结构化挂起 2b: when ``message_id`` + the suspension closures are wired (always, on
    the live CEO path), the pause is also persisted to ``paused_turns`` so a
    disconnect / restart is recoverable via ``POST .../resume``. The frame needs the
    turn-level constants (``captain_run_id`` / ``base_system_prompt`` /
    ``user_message``) to re-wire the CEO toolset on resume. Left ``None`` / empty
    (standalone / tests) ⇒ 2a in-memory only (the live resolve still works).
    """

    sink: EventSink
    conversation_id: str
    registry: ClientRequestBridge
    timeout_seconds: float
    captain_run_id: str | None = None
    base_system_prompt: str = ""
    user_message: str = ""
    message_id: str | None = None
    suspension_saver: SuspensionSaver | None = None
    suspension_deleter: SuspensionDeleter | None = None

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name="ask_user",
            description=(
                "在你（CEO）遇到自己无法独自定夺、且选错代价高的关键岔路时，暂停并征询用户。"
                "适用场景：方案 A/B 抉择、执行不可逆操作前确认、任务范围明显超出预期需用户拍板。"
                "不要用于：你能自行决定的细节、可用合理默认值的小选择、简单任务——滥用会打断体验。"
                "用户会以「提交 / 停止」回应：提交可带上 ta 勾选的选项与可选补充说明（即采纳或"
                "修正你的方向），其答复作为本工具的结果回到你的对话循环；「停止」会直接结束本回合，"
                "故仅在确有必要时调用。"
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
                        "description": (
                            "可选：供用户挑选的具体选项（最多 6 个）。默认单选；需要"
                            "用户能同时选多个时，把 multiple 设为 true。"
                        ),
                    },
                    "multiple": {
                        "type": "boolean",
                        "description": (
                            "可选：options 是否允许多选，默认 false。互斥的二选一/多选一"
                            "保持单选；「可同时挑多个」（如选要包含的若干功能/文件）才设 "
                            "true。仅在给了 options 时有意义。"
                        ),
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
        multiple = bool(arguments.get("multiple") or False)

        checkpoint_id = new_id()
        required = checkpoint_required(
            checkpoint_id=checkpoint_id,
            conversation_id=self.conversation_id,
            question=question,
            options=options,
            context=ctx_text,
            multiple=multiple,
        )
        # 结构化挂起 2b: durable backstop BEFORE the wait (best-effort). A cancel
        # (disconnect) / crash during the wait propagates past the drop below, leaving
        # the frame for ``POST .../resume``; the in-memory resolve still settles a
        # live turn even if the save failed.
        await self._persist_suspension(
            checkpoint_id, context, question, options, ctx_text, multiple, required
        )
        try:
            response = await self.registry.suspend(
                checkpoint_id,
                self.conversation_id,
                kind=InteractionKind.ASK_USER,
                payload={
                    "question": question,
                    "options": options,
                    "context": ctx_text,
                    "multiple": multiple,
                },
                timeout=self.timeout_seconds,
                on_suspended=lambda: self.sink.emit(required),
            )
        except TimeoutError:
            logger.info("checkpoint.timeout", checkpoint_id=checkpoint_id)
            response = CheckpointResponse(decision=CheckpointDecision.TIMEOUT)
        # Reached only on a live resolve / timeout — a cancel raises CancelledError,
        # which propagates PAST this and leaves the frame for /resume.
        await self._drop_suspension()

        # Keep only picks that were actually on the menu — a resolve can't inject
        # arbitrary strings into the CEO's context, and a stale option is dropped.
        response.selected = [s for s in response.selected if s in options]

        self.sink.emit(
            checkpoint_resolved(
                checkpoint_id=checkpoint_id,
                decision=response.decision.value,
                note=response.note,
                selected=response.selected,
            )
        )
        result = ask_user_tool_result(response)
        # A stop's closing note rides as ``final_text`` (persist-only); stream it so
        # the user sees it live too (the engine won't re-emit it). Resume does the same.
        if result.effect is ToolEffect.INTERACT and result.final_text:
            self.sink.emit(content_delta(result.final_text))
        return result

    def _can_persist_suspension(self) -> bool:
        """Whether this ask_user pause should be durably persisted (结构化挂起 2b).

        The turn's ``message_id`` + the persist closure must be wired (the live CEO
        path) — a standalone / un-wired construction (tests) keeps 2a in-memory only."""
        return bool(
            self.message_id and self.suspension_saver is not None and self.conversation_id
        )

    async def _persist_suspension(
        self, checkpoint_id, context, question, options, ctx_text, multiple, required_event
    ) -> None:
        """Capture + persist the durable suspension frame for this ask_user pause (2b).

        Reads the CEO transcript off the ``captain_transcript`` contextvar (published
        by the captain executor) — without it a faithful resume is impossible, so
        capture is skipped (the live resolve still works). Folds the about-to-emit
        ``checkpoint_required`` into the frame's journal so a resume replays the
        prompt+resolution as a pair. Best-effort: the saver swallows its own errors.
        """
        if not self._can_persist_suspension():
            return
        from agentcore.core.log_context import get_log_value
        from agentcore.runtime.suspension import (
            AskUserSuspension,
            captain_transcript,
            find_tool_call_id,
        )

        transcript = captain_transcript.get()
        if not transcript:
            logger.info("suspension.no_transcript", checkpoint_id=checkpoint_id)
            return
        journal = list(self.sink.execution_journal() or [])
        journal.append(
            {
                "type": required_event.type.value,
                "payload": required_event.payload,
                "timestamp": required_event.timestamp,
            }
        )
        frame = AskUserSuspension(
            message_id=self.message_id or "",
            conversation_id=self.conversation_id,
            user_id=context.user_id,
            captain_run_id=self.captain_run_id or "",
            checkpoint_id=checkpoint_id,
            tool_call_id=find_tool_call_id(transcript, "ask_user"),
            base_system_prompt=self.base_system_prompt,
            user_message=self.user_message,
            transcript=list(transcript),
            question=question,
            options=options,
            context=ctx_text,
            multiple=multiple,
            journal=journal,
            trace_id=get_log_value("trace_id"),
        )
        await self.suspension_saver(frame)  # type: ignore[misc]

    async def _drop_suspension(self) -> None:
        """Delete the durable frame after a live in-process resolve / timeout (2b)."""
        if self._can_persist_suspension() and self.suspension_deleter is not None:
            await self.suspension_deleter(self.message_id or "")


def ask_user_tool_result(response: CheckpointResponse) -> ToolResult:
    """Map the user's ask_user answer to the tool result the CEO loop consumes.

    The single source of truth for both the live tool (``AskUserTool.execute``) and
    a durable resume (``runtime/pipeline.resume_chat_pipeline``): continue / adjust
    feed back as ``CONTINUE`` results (the CEO resumes); stop returns an ``INTERACT``
    (terminal) result whose closing note rides as ``final_text`` so the engine — or
    the resume — ends the turn gracefully with that text; a timeout hands control
    back to the CEO to wrap up on its own. Pure (no SSE side-effect): the caller
    streams the stop's ``final_text`` via ``content_delta`` (it is persist-only, the
    engine never re-emits it).
    """
    decision = response.decision
    picks = "、".join(response.selected)
    if decision is CheckpointDecision.CONTINUE:
        # 提交：the merged 继续+调整 answer — picks and/or a free-form note both
        # ride here, so continue now honors the note too (it used to ignore it).
        note = response.note.strip()
        if picks and note:
            output = f"用户选择：{picks}；并补充：{note}\n请据此继续。"
        elif picks:
            output = f"用户选择：{picks}。请按此继续。"
        elif note:
            output = f"用户补充：{note}\n请据此继续。"
        else:
            output = "用户确认：按你提出的方向继续。"
        return ToolResult(tool_call_id="", success=True, output=output)
    # ADJUST is no longer raised by the desktop (the card merged it into 提交 /
    # CONTINUE) but stays mapped for any other client + old journaled turns.
    if decision is CheckpointDecision.ADJUST:
        note = response.note.strip()
        if picks and note:
            output = f"用户选择：{picks}；并调整：{note}\n请据此调整后再继续。"
        elif picks:
            output = f"用户选择：{picks}。\n请据此继续。"
        elif note:
            output = f"用户调整指令：{note}\n请据此调整后再继续。"
        else:
            output = "用户未填写具体调整说明，请据上下文稳妥推进。"
        return ToolResult(tool_call_id="", success=True, output=output)
    if decision is CheckpointDecision.STOP:
        closing = response.note.strip() or "好的，已按你的要求停止本回合。"
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
