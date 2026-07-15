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
        questions_desc = (
            "可选：真正要用户拍板的问题（最多 5 个）。途中岔路通常就一个；"
            "开场可摊开数个高杠杆决策（含影响大的技术选择，如是否响应式 / "
            "双语 / 带后台）。开场的问题应尽量预填 default，让想省事的用户一键"
            "全默认通过；途中的关键岔路通常不填 default（就是要 ta 选）。choice "
            "选项可给每项配一行 detail（权衡/代价），并把你最建议的一项标 "
            "recommended，帮用户看懂取舍、快速拍板。"
        )
        tool_desc = (
            "向用户发问。默认【暂停回合】等 ta 回应后回到你的循环继续（用户选「停止」则结束"
            "本回合）；也可设 blocking=false 做【非阻塞发问】——抛出问题但你按既定默认继续、"
            "不等待，用户答复会作为新消息在后续轮次并入。这是你唯一的「问用户」原语，开场引导"
            "与执行途中拍板共用。对「能做但没说全」的产出类请求，开工提案卡是首选开场（预填默认、"
            "可一键通过，不是问题墙）；要克制的是【执行途中为能自行决定的小事打断用户】，"
            "不是【开工前对齐】。何时该问 / 该不该阻塞、"
            "开工提案卡怎么分档、途中拍板怎么给选项，"
            "见 consult_skill（开场用 ask_user_kickoff、途中用 ask_user_midtask）。"
        )
        if self.advertise_bind_local_folder:
            option_properties["action"] = {
                "type": "string",
                "enum": ["bind_local_folder", "grant_readonly_folder"],
                "description": (
                    "可选。bind_local_folder：桌面端把该选项渲染为「选择本地文件夹」并绑定本对话"
                    "工作区（任务需本机而执行位置仍是云端时用）。"
                    "grant_readonly_folder：授权一个区外目录在**本次对话内只读**可用"
                    "（分析整文件夹；卡片须说明只读/仅本次对话/可撤销；不改变工作区绑定）。"
                ),
            }
            questions_desc += (
                " 当任务需要用户本机而执行位置仍是云端时，给 choice 选项加 "
                "action=bind_local_folder，引导绑定本地文件夹（不要先空跑委派）。"
                " 当用户要分析工作区外的整个目录时，加 action=grant_readonly_folder"
                "（只读、仅本次对话、可撤销）。"
            )
            tool_desc += (
                " 本回合桌面端在线：choice 选项可标 action=bind_local_folder 或 "
                "grant_readonly_folder。"
            )

        return ToolSchema(
            name="ask_user",
            description=tool_desc,
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
                        "description": questions_desc,
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
                                        "properties": option_properties,
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
                    "card": {
                        "type": "string",
                        "enum": ["proposal_pick", "risk_ack", "organize_plan"],
                        "description": (
                            "可选：显式确认卡类型（会覆盖转录推导的 intent，并校验 questions 形状）。"
                            "proposal_pick=方案挑选卡：恰好 1 个 choice 单选问题、options 2–6，"
                            "让用户从候选方案里挑一个。"
                            "risk_ack=风险确认卡：恰好 1 个 choice 多选问题、options 1–10，"
                            "让用户勾选要处理哪些风险/问题。"
                            "organize_plan=整理方案卡：恰好 1 个 choice 多选问题、options 1–50，"
                            "每项带 op/source/destination（或 path），默认全选、取消勾选即剔除；"
                            "确认后即该批次能力授权（file_batch 带 organize_plan_id 不再二次弹卡）。"
                            "三种 card 都要求 blocking=true（或缺省）；不可与 blocking=false 同用。"
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
