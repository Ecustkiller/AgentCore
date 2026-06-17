"""ask_user — the CEO pauses the turn to ask the user (the one asking primitive).

CEO-only: wired in ``runtime.pipeline`` next to ``delegate`` and deliberately NOT in
``build_builtin_registry`` (a delegated worker never talks to the user). This is the
single「向用户发问」primitive — it absorbed the former 引导式开场 (``kickoff``): whether
the CEO is **opening** a producible-but-underspecified request (做网站 / 文档…) or
hitting a **mid-execution** high-cost fork (A vs B / an irreversible step), it asks the
SAME way and through the SAME mechanism.

ONE mechanism — always suspend + resume. The card surfaces, the turn suspends on the
interaction registry's Future, and the user's answer flows back into the CEO's ReAct
loop as this tool's result. There is no separate「开场即结束回合」path: 挂起+恢复 is the
general case (it preserves any in-flight context — delegate results, read files), and it
subsumes the opening case (where there is simply little context to preserve) at a
negligible cost, so the runtime — not the model — owns「该结束还是该挂起」. The model
only decides WHETHER to ask (restraint), never WHICH kind of asking.

The card's content is one adaptive shape (rich when opening, compact mid-task):
``message`` (the framing / opening line — always shown), optional ``context``
background, optional ``assumptions`` (起步计划 — low-impact decisions the CEO made for
the user, read-only chips), optional ``questions`` (the askable items, each pre-fillable
with a ``default`` so a 想省事 user one-clicks through), and optional ``style_options``
(visual products only). A mid-task A/B is just ``message`` + a one-item ``questions``.

A submit answer is ``ToolEffect.CONTINUE`` (the CEO resumes with the user's picks); a
stop is ``ToolEffect.INTERACT`` — a terminal effect that ends the turn gracefully in-band
(its closing note rides as ``ToolResult.final_text``). The question + answer are
journaled (``events._JOURNAL_EVENT_TYPES``) so a reload replays the exchange inline.

结构化挂起 2b (turn 级落盘 + ``POST .../resume``): like the ``delegate`` checkpoint hook,
the suspend is backed by a durable frame — an :class:`AskUserSuspension` is saved to
``paused_turns`` BEFORE the wait and dropped after a live in-process resolve / timeout. A
disconnect / restart during the wait leaves the frame so ``POST .../resume`` can map the
user's answer back to this tool's result and continue the CEO loop. The answer→result
mapping is the module-level :func:`ask_user_tool_result` so the live path and resume
share one source of truth.
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

# Caps so a runaway prompt can't bloat the card / event. The free-form note on the
# card always lets the user steer beyond these.
_MAX_QUESTIONS = 5  # 开场重点问题最多 5 个（对齐 Cursor 2.1 的 3–5）
_MAX_OPTIONS = 6  # 每个 choice 问题的选项上限
_MAX_ASSUMPTIONS = 10
_MAX_STYLES = 6


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
                "向用户发问并【暂停回合】，等 ta 回应后回到你的循环继续；用户选「停止」则结束"
                "本回合。这是你唯一的「问用户」原语，开场引导与执行途中拍板共用。克制使用，别为"
                "能自行决定的小事打断用户；何时该问、开工提案卡怎么分档、途中拍板怎么给选项，"
                "见 consult_skill(asking_the_user)。"
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
                            "全默认通过；途中的关键岔路通常不填 default（就是要 ta 选）。"
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
                                    "items": {"type": "string"},
                                    "description": "kind=choice 时的候选项（最多 6 个）。",
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
                                        "options 中的一项，text 时是预填文本。"
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
                },
                "required": ["message"],
            },
            category=ToolCategory.INTERACTION,
            approval=ToolApproval.NEVER,
        )

    async def execute(
        self, arguments: dict[str, Any], context: ToolContext
    ) -> ToolResult:
        message = str(arguments.get("message") or "").strip()
        if not message:
            return ToolResult(
                tool_call_id="",
                success=False,
                output="",
                error="ask_user 需要非空的 message 参数（向用户说明你在问什么）。",
            )
        ctx_text = str(arguments.get("context") or "")
        assumptions = _normalize_assumptions(arguments.get("assumptions"))
        questions = _normalize_questions(arguments.get("questions"))
        style_options = _normalize_style_options(arguments.get("style_options"))

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
        await self._persist_suspension(
            checkpoint_id, context, message, ctx_text, assumptions, questions, style_options, required
        )
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
        # Reached only on a live resolve / timeout — a cancel raises CancelledError,
        # which propagates PAST this and leaves the frame for /resume.
        await self._drop_suspension()

        # Keep only picks that were actually on some question's menu — a resolve can't
        # inject arbitrary strings into the CEO's context (the desktop composes its
        # answer into ``note`` and sends no picks, so this is a guard for other clients).
        allowed = {o for q in questions for o in q.get("options", [])}
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

    def _can_persist_suspension(self) -> bool:
        """Whether this ask_user pause should be durably persisted (结构化挂起 2b).

        The turn's ``message_id`` + the persist closure must be wired (the live CEO
        path) — a standalone / un-wired construction (tests) keeps 2a in-memory only."""
        return bool(
            self.message_id and self.suspension_saver is not None and self.conversation_id
        )

    async def _persist_suspension(
        self,
        checkpoint_id,
        context,
        message,
        ctx_text,
        assumptions,
        questions,
        style_options,
        required_event,
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
            question=message,
            context=ctx_text,
            assumptions=assumptions,
            questions=questions,
            style_options=style_options,
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
    a durable resume (``runtime/pipeline.resume_chat_pipeline``): submit feeds back as
    a ``CONTINUE`` result (the CEO resumes); stop returns an ``INTERACT`` (terminal)
    result whose closing note rides as ``final_text`` so the engine — or the resume —
    ends the turn gracefully with that text; a timeout hands control back to the CEO to
    wrap up on its own. Pure (no SSE side-effect): the caller streams the stop's
    ``final_text`` via ``content_delta`` (it is persist-only, the engine never re-emits
    it).

    答复正文 (α 答复模型): the desktop composes the user's per-question picks + style +
    free-form note into ONE readable ``note`` string (the picks live in the UI, so the
    answer is composed where the data is — no structured wire payload the only-reader CEO
    would just flatten back to prose anyway). ``selected`` stays for any non-desktop /
    legacy single-option client.
    """
    decision = response.decision
    picks = "、".join(response.selected)
    note = response.note.strip()
    if decision is CheckpointDecision.CONTINUE:
        if note and picks:
            output = f"用户选择：{picks}；并补充：\n{note}\n请据此继续。"
        elif note:
            # The desktop's composed answer (per-question picks + style + note) rides here.
            output = f"用户答复：\n{note}\n请据此继续。"
        elif picks:
            output = f"用户选择：{picks}。请按此继续。"
        else:
            output = "用户确认：按你提出的方向继续。"
        return ToolResult(tool_call_id="", success=True, output=output)
    # ADJUST stays mapped for any non-desktop client + old journaled turns (the desktop
    # card merged 调整 into 提交 / CONTINUE).
    if decision is CheckpointDecision.ADJUST:
        if picks and note:
            output = f"用户选择：{picks}；并调整：\n{note}\n请据此调整后再继续。"
        elif note:
            output = f"用户调整指令：\n{note}\n请据此调整后再继续。"
        elif picks:
            output = f"用户选择：{picks}。\n请据此继续。"
        else:
            output = "用户未填写具体调整说明，请据上下文稳妥推进。"
        return ToolResult(tool_call_id="", success=True, output=output)
    if decision is CheckpointDecision.STOP:
        closing = note or "好的，已按你的要求停止本回合。"
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


def _normalize_assumptions(raw: Any) -> list[dict[str, Any]]:
    """Cap + id the 起步计划 chips, dropping malformed / empty-label entries."""
    items = raw if isinstance(raw, list) else []
    out: list[dict[str, Any]] = []
    for i, it in enumerate(items[:_MAX_ASSUMPTIONS]):
        if not isinstance(it, dict):
            continue
        label = str(it.get("label") or "").strip()
        if not label:
            continue
        out.append(
            {"id": f"a{i}", "label": label, "value": str(it.get("value") or "").strip()}
        )
    return out


def _normalize_questions(raw: Any) -> list[dict[str, Any]]:
    """Cap (≤5) + id the questions, normalizing kind/options/multiple/default.

    ``default`` is optional here (unlike the old kickoff): an opening question should
    pre-fill one, but a mid-task fork usually wants the user to actively choose, so it
    is left empty when the CEO omits it.
    """
    items = raw if isinstance(raw, list) else []
    out: list[dict[str, Any]] = []
    for i, it in enumerate(items[:_MAX_QUESTIONS]):
        if not isinstance(it, dict):
            continue
        prompt = str(it.get("prompt") or "").strip()
        if not prompt:
            continue
        kind = "text" if str(it.get("kind") or "").strip() == "text" else "choice"
        if kind == "choice":
            options = [
                str(o).strip() for o in (it.get("options") or []) if str(o).strip()
            ][:_MAX_OPTIONS]
            multiple = bool(it.get("multiple") or False)
        else:
            options = []
            multiple = False
        out.append(
            {
                "id": f"q{i}",
                "prompt": prompt,
                "kind": kind,
                "options": options,
                "multiple": multiple,
                "default": str(it.get("default") or "").strip(),
            }
        )
    return out


def _normalize_style_options(raw: Any) -> list[dict[str, Any]]:
    """Cap + id the 风格预设, accepting either ``{label}`` dicts or bare strings."""
    items = raw if isinstance(raw, list) else []
    out: list[dict[str, Any]] = []
    for i, it in enumerate(items[:_MAX_STYLES]):
        raw_label = it.get("label") if isinstance(it, dict) else it
        label = str(raw_label or "").strip()
        if not label:
            continue
        out.append({"id": f"s{i}", "label": label})
    return out
