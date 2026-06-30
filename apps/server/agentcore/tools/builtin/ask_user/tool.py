"""AskUserTool: CEO asking primitive (blocking suspend + non-blocking surface)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from agentcore.core.logging import get_logger
from agentcore.core.types import ToolApproval, ToolCategory, ToolEffect, new_id
from agentcore.runtime.checkpoints import CheckpointDecision, CheckpointResponse
from agentcore.runtime.events import (
    EventSink,
    checkpoint_required,
    checkpoint_resolved,
    content_delta,
    question_posted,
)
from agentcore.runtime.interaction import InteractionKind
from agentcore.runtime.ports import ClientRequestBridge
from agentcore.tools.builtin.ask_user.result import ask_user_tool_result
from agentcore.tools.builtin.ask_user.schema import (
    normalize_assumptions,
    normalize_questions,
    normalize_style_options,
    option_label,
)
from agentcore.tools.builtin.ask_user.suspend import drop_suspension, persist_suspension
from agentcore.tools.protocol import ToolContext, ToolResult, ToolSchema

if TYPE_CHECKING:
    from agentcore.runtime.suspension import SuspensionDeleter, SuspensionSaver

logger = get_logger(__name__)


@dataclass
class AskUserTool:
    """The CEO's asking primitive: surface a card, suspend, resume on the answer.

    Constructed per turn where the sink is available (mirrors ``ApprovalGate`` /
    ``DelegateTool``): ``sink`` carries the prompt + resolution to the client,
    ``registry`` bridges the resolve endpoint, ``timeout_seconds`` bounds the wait.

    结构化挂起 2b: when ``message_id`` + the suspension closures are wired (always, on
    the live CEO path), the pause is also persisted to ``paused_turns`` so a
    disconnect / restart is recoverable via ``POST .../resume``. The frame needs the
    turn-level constants (``captain_run_id`` / ``base_system_prompt`` /
    ``user_message``) to re-wire the CEO toolset on resume. Left ``None`` / empty
    (standalone / tests) ⇒ no durable frame, so the pause degrades to the backend-only
    timed wait (窄兜底) that auto-continues on timeout.
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

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name="ask_user",
            description=(
                "向用户发问。默认【暂停回合】等 ta 回应后回到你的循环继续（用户选「停止」则结束"
                "本回合）；也可设 blocking=false 做【非阻塞发问】——抛出问题但你按既定默认继续、"
                "不等待，用户答复会作为新消息在后续轮次并入。这是你唯一的「问用户」原语，开场引导"
                "与执行途中拍板共用。对「能做但没说全」的产出类请求，开工提案卡是首选开场（预填默认、"
                "可一键通过，不是问题墙）；要克制的是【执行途中为能自行决定的小事打断用户】，"
                "不是【开工前对齐】。何时该问 / 该不该阻塞、开工提案卡怎么分档、途中拍板怎么给选项，"
                "见 consult_skill（开场用 ask_user_kickoff、途中用 ask_user_midtask）。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "message": {
                        "type": "string",
                        "description": (
                            "必填。你这次发问的开场白 / 框架：用自己的口吻说清你在问什么、"
                            "为什么需要 ta 定夺（开场时复述你理解的目标与起步计划，途中时"
                            "说明现状与岔路）。这是卡片顶部展示给用户的文字。"
                        ),
                    },
                    "context": {
                        "type": "string",
                        "description": "可选：帮助用户判断的背景补充。",
                    },
                    "assumptions": {
                        "type": "array",
                        "description": (
                            "可选（多用于开场）：起步计划——你替用户定好的低影响、可逆、"
                            "用户多半不关心的决策（技术栈 / 目录 / 部署 / 命名等），以"
                            "「项 + 值」陈列让用户知情即可（只读）。影响大、用户可能真有偏好的"
                            "决策放进 questions，别放这里。"
                        ),
                        "items": {
                            "type": "object",
                            "properties": {
                                "label": {
                                    "type": "string",
                                    "description": "决策项，如「部署」「目录结构」。",
                                },
                                "value": {
                                    "type": "string",
                                    "description": "你定的默认值，如「纯静态，可直接打开」。",
                                },
                            },
                            "required": ["label", "value"],
                        },
                    },
                    "questions": {
                        "type": "array",
                        "description": (
                            "可选：真正要用户拍板的问题（最多 5 个）。途中岔路通常就一个；"
                            "开场可摊开数个高杠杆决策（含影响大的技术选择，如是否响应式 / "
                            "双语 / 带后台）。开场的问题应尽量预填 default，让想省事的用户一键"
                            "全默认通过；途中的关键岔路通常不填 default（就是要 ta 选）。choice "
                            "选项可给每项配一行 detail（权衡/代价），并把你最建议的一项标 "
                            "recommended，帮用户看懂取舍、快速拍板。"
                        ),
                        "items": {
                            "type": "object",
                            "properties": {
                                "prompt": {
                                    "type": "string",
                                    "description": "问题本身，简洁清楚。",
                                },
                                "kind": {
                                    "type": "string",
                                    "enum": ["choice", "text"],
                                    "description": (
                                        "choice=从 options 里选；text=让用户填一句。默认 choice。"
                                    ),
                                },
                                "options": {
                                    "type": "array",
                                    "description": "kind=choice 时的候选项（最多 6 个）。",
                                    "items": {
                                        "type": "object",
                                        "properties": {
                                            "label": {
                                                "type": "string",
                                                "description": (
                                                    "选项文字（即用户选它时回传的答案）。"
                                                ),
                                            },
                                            "detail": {
                                                "type": "string",
                                                "description": (
                                                    "可选：这个选项的一行权衡 / 代价，展示在"
                                                    "选项下方，帮用户看懂「为什么选它」。"
                                                ),
                                            },
                                            "recommended": {
                                                "type": "boolean",
                                                "description": (
                                                    "可选：标记你建议的那一项（至多一个）。"
                                                    "仅「推荐」高亮、不会替用户预选；"
                                                    "要预选请用 default。"
                                                ),
                                            },
                                        },
                                        "required": ["label"],
                                    },
                                },
                                "multiple": {
                                    "type": "boolean",
                                    "description": (
                                        "可选：options 是否允许多选，默认 false。互斥的"
                                        "二选一/多选一保持 false；可同时挑多个才设 true。"
                                    ),
                                },
                                "default": {
                                    "type": "string",
                                    "description": (
                                        "可选：你的默认答案（开场强烈建议填）。choice 时应是 "
                                        "options 中某一项的 label，text 时是预填文本。"
                                    ),
                                },
                            },
                            "required": ["prompt"],
                        },
                    },
                    "style_options": {
                        "type": "array",
                        "description": (
                            "可选：仅当产物是视觉类（网站 / 海报 / 幻灯…）时给出风格预设，"
                            "供用户挑选基调。非视觉类省略。"
                        ),
                        "items": {
                            "type": "object",
                            "properties": {
                                "label": {
                                    "type": "string",
                                    "description": "风格名，如「深色科技」「简约商务」。",
                                },
                            },
                            "required": ["label"],
                        },
                    },
                    "blocking": {
                        "type": "boolean",
                        "description": (
                            "可选，默认 true。true=【暂停回合】等用户答复再继续——高风险 / 不可逆"
                            "的岔路、或你没有合理默认时用。false=【非阻塞】——你已有合理默认、"
                            "只是想给用户一个纠偏机会时用：抛出问题后你【立刻按默认继续、不等待】，"
                            "用户回复会在后续轮次并入。设 false 时必须在 assumptions 或某个 "
                            "question 的 default 里写明你将先采用的默认，否则该调用会被拒。"
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
        ctx_text = str(arguments.get("context") or "")
        assumptions = normalize_assumptions(arguments.get("assumptions"))
        questions = normalize_questions(arguments.get("questions"))
        style_options = normalize_style_options(arguments.get("style_options"))

        # 非阻塞发问 (Cursor 式): surface + proceed, never freeze the turn. Branch BEFORE
        # any suspend / durable-frame machinery — it shares none of it.
        blocking_arg = arguments.get("blocking")
        blocking = True if blocking_arg is None else bool(blocking_arg)
        if not blocking:
            return self._post_nonblocking(message, ctx_text, assumptions, questions, style_options)

        checkpoint_id = new_id()
        required = checkpoint_required(
            checkpoint_id=checkpoint_id,
            conversation_id=self.conversation_id,
            question=message,
            context=ctx_text,
            assumptions=assumptions,
            questions=questions,
            style_options=style_options,
        )
        # 结构化挂起 2b: durable backstop BEFORE the wait (best-effort). A cancel
        # (disconnect) / crash during the wait propagates past the drop below, leaving
        # the frame for ``POST .../resume``; the in-memory resolve still settles a
        # live turn even if the save failed.
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
        )
        # 挂起即收口 (②): once the durable frame is saved, END the turn in place instead of
        # parking on the in-memory interaction Future. We emit the card here (the wait path
        # emits it via ``on_suspended``) and return a SUSPEND effect — the engine maps it to
        # FinishReason.PAUSED and leaves THIS call pending (no tool result), so the resumed
        # window ends exactly at the assistant and EVERY resolution (even in-session) flows
        # through the one cold ``POST .../resume`` path, collapsing the live/durable dual-state
        # at its source. Gated on ``saved`` (§六-1 窄兜底): a turn we could not persist can't be
        # finalized (resume would have no frame to reclaim), so it falls through to the
        # backend-only timed wait below.
        if saved:
            self.sink.emit(required)
            logger.info("checkpoint.finalized", checkpoint_id=checkpoint_id)
            return ToolResult(tool_call_id="", success=True, output="", effect=ToolEffect.SUSPEND)
        # 窄兜底（薄网，挂起即收口 ② Phase 3）: no durable frame, so hold the turn on a BACKEND-ONLY
        # bounded wait — the card is surfaced, but no client can settle an ask_user anymore (its
        # resolve schema is gone from the unified endpoint), so this can only end by timeout →
        # auto-continue (不丢回合). A disconnect cancels it and the engine salvages the turn.
        try:
            response = await self.registry.suspend(
                checkpoint_id,
                self.conversation_id,
                kind=InteractionKind.ASK_USER,
                payload={
                    "question": message,
                    "context": ctx_text,
                    "assumptions": assumptions,
                    "questions": questions,
                    "style_options": style_options,
                },
                timeout=self.timeout_seconds,
                on_suspended=lambda: self.sink.emit(required),
            )
        except TimeoutError:
            logger.info("checkpoint.timeout", checkpoint_id=checkpoint_id)
            response = CheckpointResponse(decision=CheckpointDecision.TIMEOUT)
        # Reached only on the timeout auto-continue — no client resolve path remains for an
        # ask_user (its schema is gone from the unified endpoint). A cancel raises
        # CancelledError, which propagates PAST this; with no saved frame the engine salvages
        # the turn as usual.
        await drop_suspension(self)

        # Keep only picks that were actually on some question's menu — a resolve can't
        # inject arbitrary strings into the CEO's context (the desktop composes its
        # answer into ``note`` and sends no picks, so this is a guard for other clients).
        allowed = {option_label(o) for q in questions for o in q.get("options", [])}
        response.selected = [s for s in response.selected if s in allowed]

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
