"""AskUserTool: CEO asking primitive (blocking suspend + non-blocking surface)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from agentcore.core.logging import get_logger
from agentcore.core.types import ToolApproval, ToolCategory, ToolEffect, new_id
from agentcore.runtime.events import (
    EventSink,
    checkpoint_required,
    question_posted,
)
from agentcore.runtime.ports import ClientRequestBridge
from agentcore.tools.builtin.ask_user.card import (
    CARD_KINDS,
    card_max_options,
    card_overrides_intent,
    parse_card,
    validate_card_shape,
)
from agentcore.tools.builtin.ask_user.intent import resolve_ask_checkpoint_intent
from agentcore.tools.builtin.ask_user.schema import (
    normalize_assumptions,
    normalize_questions,
    normalize_style_options,
)
from agentcore.tools.builtin.ask_user.suspend import persist_suspension
from agentcore.tools.protocol import ToolContext, ToolResult, ToolSchema

if TYPE_CHECKING:
    from agentcore.runtime.suspension import SuspensionDeleter, SuspensionSaver

logger = get_logger(__name__)


@dataclass
class AskUserTool:
    """The CEO's asking primitive: surface a card, suspend, resume on the answer.

    Constructed per turn where the sink is available (mirrors ``ApprovalGate`` /
    ``DelegateTool``): ``sink`` carries the prompt + resolution to the client,
    ``registry`` bridges the resolve endpoint, ``timeout_seconds`` is the ops-configured
    wait bound (default unlimited / D2 — ``None`` at settings maps to a large sentinel).

    结构化挂起 2b + 挂起即收口 (②) / D11: when ``message_id`` + the suspension closures
    are wired (live CEO path), the pause is persisted to ``paused_turns`` and the turn
    ends in place (``ToolEffect.SUSPEND``); resume is the single cold path
    ``POST .../resume``. The frame needs the turn-level constants (``captain_run_id`` /
    ``base_system_prompt`` / ``user_message``) to re-wire the CEO toolset on resume.
    If the durable frame cannot be saved ⇒ **explicit failure** (no in-memory timed
    wait, no auto-continue on timeout — the narrow兜底 was deleted).
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
    # The cloud project (= workspace folder) scope, carried so a durable ask_user pause
    # captures it into the frame — the resumed toolset re-wires consult_memory to the same
    # project (Agent记忆与知识系统 §二). ``None`` for 裸聊 / local. Capture-only (unused live).
    folder_id: str | None = None
    # The memory master switch, captured so resume re-wires consult_memory as this turn did
    # (off ⇒ stays off). Capture-only; defaults True (always-on).
    memory_enabled: bool = True
    # Advertise desktop-only ask_user option actions (bind_local_folder /
    # grant_readonly_folder) when the desktop client can fulfil them.
    advertise_bind_local_folder: bool = False

    @property
    def schema(self) -> ToolSchema:
        option_properties: dict[str, Any] = {
            "label": {
                "type": "string",
                "description": "选项文字（即用户选它时回传的答案）。",
            },
            "detail": {
                "type": "string",
                "description": (
                    "可选：这个选项的一行权衡 / 代价，展示在选项下方，帮用户看懂「为什么选它」。"
                ),
            },
            "recommended": {
                "type": "boolean",
                "description": (
                    "可选：标记你建议的那一项（至多一个）。仅「推荐」高亮、不会替用户预选；"
                    "要预选请用 default。"
                ),
            },
        }
        # Schema layer (工具面瘦身): short trigger. HOW → ask_user_kickoff / ask_user_midtask.
        questions_desc = (
            "可选：要用户拍板的问题（最多 5）。开场预填 default；途中关键岔路通常不填。"
            "choice 可配 detail / recommended。用法见 consult_skill。"
        )
        tool_desc = (
            "向用户发问（唯一问用户原语）。默认 blocking 暂停回合；blocking=false 非阻塞按默认继续。"
            "开场用开工提案卡；途中克制打断。详见 consult_skill"
            "（ask_user_kickoff / ask_user_midtask）。"
        )
        if self.advertise_bind_local_folder:
            option_properties["action"] = {
                "type": "string",
                "enum": ["bind_local_folder", "grant_readonly_folder"],
                "description": (
                    "可选。bind_local_folder=绑定本机工作区；"
                    "grant_readonly_folder=授权区外目录只读（仅本对话）。"
                ),
            }
            questions_desc += (
                " 本机需求可标 action=bind_local_folder；区外目录分析标 grant_readonly_folder。"
            )
            tool_desc += " 桌面在线时可标 bind_local_folder / grant_readonly_folder。"

        return ToolSchema(
            name="ask_user",
            description=tool_desc,
            parameters={
                "type": "object",
                "properties": {
                    "message": {
                        "type": "string",
                        "description": "必填。卡片顶部开场白 / 框架（问什么、为何需拍板）。",
                    },
                    "context": {
                        "type": "string",
                        "description": "可选：背景补充。",
                    },
                    "assumptions": {
                        "type": "array",
                        "description": "可选（开场）：低影响默认可逆决策（只读陈列）。高杠杆放 questions。",
                        "items": {
                            "type": "object",
                            "properties": {
                                "label": {
                                    "type": "string",
                                    "description": "决策项。",
                                },
                                "value": {
                                    "type": "string",
                                    "description": "默认值。",
                                },
                            },
                            "required": ["label", "value"],
                        },
                    },
                    "questions": {
                        "type": "array",
                        "description": questions_desc,
                        "items": {
                            "type": "object",
                            "properties": {
                                "prompt": {
                                    "type": "string",
                                    "description": "问题正文。",
                                },
                                "kind": {
                                    "type": "string",
                                    "enum": ["choice", "text"],
                                    "description": "choice 或 text，默认 choice。",
                                },
                                "options": {
                                    "type": "array",
                                    "description": "kind=choice 候选项（最多 6）。",
                                    "items": {
                                        "type": "object",
                                        "properties": option_properties,
                                        "required": ["label"],
                                    },
                                },
                                "multiple": {
                                    "type": "boolean",
                                    "description": "可选：允许多选，默认 false。",
                                },
                                "default": {
                                    "type": "string",
                                    "description": "可选默认答案（开场建议填；choice=某 label）。",
                                },
                            },
                            "required": ["prompt"],
                        },
                    },
                    "style_options": {
                        "type": "array",
                        "description": "可选：视觉类产物的风格预设。",
                        "items": {
                            "type": "object",
                            "properties": {
                                "label": {
                                    "type": "string",
                                    "description": "风格名。",
                                },
                            },
                            "required": ["label"],
                        },
                    },
                    "blocking": {
                        "type": "boolean",
                        "description": (
                            "可选，默认 true。false=非阻塞（须在 assumptions/default 写明默认）。"
                        ),
                    },
                    "card": {
                        "type": "string",
                        "enum": ["proposal_pick", "risk_ack", "organize_plan"],
                        "description": (
                            "可选卡型：proposal_pick / risk_ack / organize_plan"
                            "（须 blocking；形状见 ask_user_* skill）。"
                        ),
                    },
                },
                "required": ["message"],
            },
            category=ToolCategory.INTERACTION,
            approval=ToolApproval.NEVER,
        )

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        message = str(arguments.get("message") or "").strip()
        if not message:
            return ToolResult(
                tool_call_id="",
                success=False,
                output="",
                error="ask_user 需要非空的 message 参数（向用户说明你在问什么）。",
            )
        card_parsed = parse_card(arguments.get("card"))
        # Success returns a known card literal (also a str); errors return a Chinese
        # guidance string not in CARD_KINDS.
        if card_parsed is None:
            card = None
        elif card_parsed in CARD_KINDS:
            card = card_parsed  # type: ignore[assignment]
        else:
            return ToolResult(
                tool_call_id="",
                success=False,
                output="",
                error=str(card_parsed),
            )

        ctx_text = str(arguments.get("context") or "")
        assumptions = normalize_assumptions(arguments.get("assumptions"))
        questions = normalize_questions(
            arguments.get("questions"),
            max_options=card_max_options(card),
        )
        style_options = normalize_style_options(arguments.get("style_options"))
        if not self.advertise_bind_local_folder:
            for q in questions:
                for opt in q.get("options") or []:
                    if isinstance(opt, dict):
                        opt.pop("action", None)

        # 非阻塞发问 (Cursor 式): surface + proceed, never freeze the turn. Branch BEFORE
        # any suspend / durable-frame machinery — it shares none of it.
        blocking_arg = arguments.get("blocking")
        blocking = True if blocking_arg is None else bool(blocking_arg)

        if card is not None:
            card_err = validate_card_shape(card, blocking=blocking, questions=questions)
            if card_err:
                return ToolResult(
                    tool_call_id="",
                    success=False,
                    output="",
                    error=card_err,
                )

        if not blocking:
            return self._post_nonblocking(message, ctx_text, assumptions, questions, style_options)

        checkpoint_id = new_id()
        from agentcore.runtime.suspension import captain_transcript

        intent = (
            card_overrides_intent(card)
            if card is not None
            else resolve_ask_checkpoint_intent(captain_transcript.get())
        )
        required = checkpoint_required(
            checkpoint_id=checkpoint_id,
            conversation_id=self.conversation_id,
            question=message,
            context=ctx_text,
            assumptions=assumptions,
            questions=questions,
            style_options=style_options,
            intent=intent,
        )
        # 结构化挂起 2b + D11: persist the durable frame BEFORE finalize. Save success
        # ⇒ 挂起即收口 (②); save failure ⇒ explicit error (no in-memory wait fallback).
        # CEO 协调模式 Phase 2: snapshot coordination state into the journal before
        # SUSPEND so resume can rebuild draft / completed / budget.
        from agentcore.runtime.coordination.session import active_coordination

        coord = active_coordination(context.execution_id)
        if coord is not None:
            from agentcore.runtime.coordination.journal import record_coordination_snapshot

            record_coordination_snapshot(coord)
            # Soft-stop the background scheduler — resume re-drives unfinished workers
            # from the journal seed. Cancelling avoids orphan tasks after turn end.
            if coord.drive_task is not None and not coord.drive_task.done():
                coord.drive_task.cancel()
        try:
            saved = await persist_suspension(
                self,
                checkpoint_id=checkpoint_id,
                context=context,
                message=message,
                ctx_text=ctx_text,
                assumptions=assumptions,
                questions=questions,
                style_options=style_options,
                required_event=required,
                intent=intent,
            )
        except Exception:
            # D11：运行态落帧失败 ⇒ 显式失败终止回合（与配置态不可用同文案）。
            logger.exception(
                "checkpoint.persist_failed",
                checkpoint_id=checkpoint_id,
            )
            return ToolResult(
                tool_call_id="",
                success=False,
                output="无法持久化检查点，回合已终止。请重试。",
            )
        # 挂起即收口 (②): once the durable frame is saved, END the turn in place.
        # D11：删窄兜底——无法落盘则显式失败终止回合（不再假等待）。
        if saved:
            self.sink.emit(required)
            logger.info(
                "checkpoint.finalized",
                checkpoint_id=checkpoint_id,
                intent=intent,
                card=card,
            )
            return ToolResult(tool_call_id="", success=True, output="", effect=ToolEffect.SUSPEND)
        logger.error(
            "checkpoint.persist_unavailable",
            checkpoint_id=checkpoint_id,
            reason="no_durable_frame",
        )
        return ToolResult(
            tool_call_id="",
            success=False,
            output="无法持久化检查点，回合已终止。请重试。",
        )

    def _post_nonblocking(
        self,
        message: str,
        ctx_text: str,
        assumptions: list[dict[str, Any]],
        questions: list[dict[str, Any]],
        style_options: list[dict[str, Any]],
    ) -> ToolResult:
        """非阻塞发问 (Cursor 式)：抛出确认但不挂起——CEO 按既定默认续跑，答复后续并入。

        The counterpart to suspend+resume: rather than freezing the turn on the user's
        answer, surface the question as a non-gating ``question_posted`` card (the client
        renders chips that 回填 the composer; the answer rides an ordinary next-turn
        message) and feed the CEO a ``CONTINUE`` that orders it to keep working on its
        stated default. Guarded: a non-blocking ask MUST carry a fallback (an assumption,
        or a question ``default``) or the user can't trust the CEO to proceed — without
        one it returns an error steering the model to ``blocking=true`` instead. No
        suspend / frame / extra round, so it costs nothing the worker-side ``escalate``
        doesn't.
        """
        has_fallback = bool(assumptions) or any(q.get("default") for q in questions)
        if not has_fallback:
            return ToolResult(
                tool_call_id="",
                success=False,
                output="",
                error=(
                    "非阻塞发问（blocking=false）必须写明你将先采用的默认：在 assumptions "
                    "列出你的暂定决策，或给某个 question 填 default。否则用户无从判断能否放心"
                    "不管。若你确实要等用户拍板再动，请改用 blocking=true。"
                ),
            )
        self.sink.emit(
            question_posted(
                ask_id=new_id(),
                conversation_id=self.conversation_id,
                question=message,
                context=ctx_text,
                assumptions=assumptions,
                questions=questions,
                style_options=style_options,
            )
        )
        logger.info(
            "ask_user.nonblocking",
            conversation_id=self.conversation_id,
            questions=len(questions),
            assumptions=len(assumptions),
        )
        return ToolResult(
            tool_call_id="",
            success=True,
            output=(
                "已（非阻塞）把这个确认抛给用户，并按你写明的默认继续。【不要等待、不要停】："
                "立刻继续推进手头工作、把本回合做完；用户若回复会作为新消息在后续轮次到达，"
                "届时再据此调整。"
            ),
        )
