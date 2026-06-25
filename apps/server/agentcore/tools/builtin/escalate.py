"""escalate — a worker's upward channel: flag a decision/blocker for the CEO.

Worker-only. Wired into the delegated worker toolset (``build_worker_registry``) and
deliberately NOT in ``build_builtin_registry`` — so it never reaches the CEO's own
toolset (``build_ceo_tool_registry`` derives from the builtins) or the read-only
``GET /tools`` capability catalog. It is the WORKER's counterpart to the CEO's
``ask_user``: a delegated worker can't talk to the user (隔离边界), so when it hits a
fork only a human / 上级 can settle, it escalates to the CEO instead of either
silently guessing or burying a clarifying question in its prose.

Two modes, one primitive — the worker picks via ``blocking`` (the dual of the CEO's
``ask_user``). NON-BLOCKING (default, ``blocking`` false): the call returns immediately
(``ToolEffect.CONTINUE``) and tells the worker to PROCEED on its best assumption — it is
NOT a stop. The escalation is harvested from the worker's transcript
(``runs.serialize.escalations_from_transcript``) into ``RunState.escalations`` and surfaced
PROMINENTLY in the CEO-facing aggregate (``DelegateTool._format_for_ceo``), where the CEO
resolves it at synthesis with its OWN levers: ``ask_user`` (if the user must decide),
``revise`` (recall the author with the answer), or a fresh ``delegate``. A wrong assumption
is corrected at synthesis, not propagated silently down the chain.

BLOCKING (阻塞式求决策, ``blocking`` true): for a「只有用户能定、且猜错你的产物基本作废」fork,
the worker SUSPENDS in place and asks the user DIRECTLY — because the CEO is parked at its
``delegate`` mid-wave and can't mediate (硬约束: 波内没有在跑的 CEO). It parks on the same
interaction bridge as ``ask_user`` (``InteractionKind.ESCALATION``); the answer flows back
into its ReAct loop and it resumes. This needs a live interactive user (the ``ask_user``
gate) — un-armed turns (autonomous / handoff) and a full concurrency cap degrade it to the
non-blocking path, and a timeout falls back to the stated ``assumption``. So blocking is a
strict SUPERSET of non-blocking: 先等用户 T 秒，等不到就退回今天的行为。The mechanism (cap /
suspend / SSE events / RunState recording) lives behind ``ToolContext.escalation`` so this
tool stays off the event vocabulary (引擎纯化); the tool owns only the decision + the
outcome→result mapping (:func:`escalate_tool_result`). 设计见
docs/07-规划/阻塞式求决策设计.md; 对比见 docs/03-AI核心/Agent协作模式.md（升级通道）.
"""

from __future__ import annotations

from typing import Any

from agentcore.core.logging import get_logger
from agentcore.core.types import ToolApproval, ToolCategory
from agentcore.runtime.runs.constants import ESCALATE_TOOL_NAME
from agentcore.tools.protocol import ToolContext, ToolResult, ToolSchema

logger = get_logger(__name__)


class EscalateTool:
    """The worker's「向上求决策」primitive: record a待决问题 for the CEO, keep working.

    Stateless: the call's structured args ride the worker's transcript, from which the
    executor harvests them into ``RunState.escalations``. ``execute`` only validates and
    returns a CONTINUE acknowledgement that steers the worker to deliver its best-effort
    result under its stated assumption (so an escalation never becomes an excuse to stop).
    """

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name=ESCALATE_TOOL_NAME,
            description=(
                "把一个【必须由上级/用户拍板】的待决问题、或一个【职责/范围偏离】上报。你是被"
                "委派的 worker、够不到用户，这是你唯一的向上通道。仅在遇到【缺了就会让整件事"
                "走偏的关键信息】【只有上级/用户能定的关键岔路】或【发现真正该做的与初始计划"
                "不符】时才用——能自行合理假设的小事不要升级。\n"
                "blocking 维度：默认 false【非阻塞】——上报后你立刻按假设继续、主管收尾时纠偏；"
                "true【阻塞·求决策】——仅当岔路【只有用户能定、且猜错你的产物基本作废】时用：你"
                "原地挂起、把问题直送用户、拿到答复再继续（须写明 assumption）。\n"
                "kind 维度（正交）：默认 normal=普通待决问题；scope=【职责偏离】——你发现真正"
                "该做的与初始计划/子任务设定不符（如上游产出显示真问题是 X 不是 Y），主管会在"
                "波边界据此校准【尚未运行】的下游步骤（你照常把当前能做的做完、不必阻塞）。"
                "克制使用。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "question": {
                        "type": "string",
                        "description": (
                            "必填。需要上级拍板的具体问题，写清楚、自包含——主管可能会把它"
                            "near-verbatim 转给用户，所以别依赖只有你才懂的局部上下文。"
                        ),
                    },
                    "assumption": {
                        "type": "string",
                        "description": (
                            "在拿到答复前你暂时采用的假设（你正/将据此继续）。blocking=true 时"
                            "【必填】：等不到用户答复时按它继续（超时回落）；blocking=false 时"
                            "强烈建议——写明它，主管才能判断你的产物是否需要据真实答案返工。"
                        ),
                    },
                    "blocking": {
                        "type": "boolean",
                        "description": (
                            "可选，默认 false。false=【非阻塞】：上报后你立刻按假设把活做完、"
                            "主管收尾纠偏。true=【阻塞·求决策】：仅当这个岔路【只有用户能定、且"
                            "猜错你的产物基本作废】时用——你会原地挂起等用户答复再继续（须写明 "
                            "assumption；等不到/无活跃用户则自动按假设继续，绝不会把你永久卡住）。"
                        ),
                    },
                    "kind": {
                        "type": "string",
                        "enum": ["normal", "scope"],
                        "description": (
                            "可选，默认 normal。scope=【职责偏离】：你发现真正要做的事与初始计划"
                            "/你的子任务设定不符（例如上游产出显示真问题是 X 不是 Y），需要主管据此"
                            "校准【尚未运行】的下游步骤——主管会在波边界读到你的偏离信号并操舵下游。"
                            "你仍照常把当前能做的做完、不必阻塞。normal=普通待决问题（默认）。"
                        ),
                    },
                    "questions": {
                        "type": "array",
                        "description": (
                            "可选，仅 blocking=true 时有意义：把这个【只有用户能定】"
                            "的岔路拆成结构化选项，让用户一键拍板、不必读你的散文再手敲。"
                            "岔路是干净的 A/B 或多选时强烈建议给（结构同 ask_user 的 "
                            "questions，最多 5 个）；纯开放问题（无明确候选）则省略，"
                            "用户直接文本作答。"
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
                                    "description": "可选：options 是否允许多选，默认 false。",
                                },
                                "default": {
                                    "type": "string",
                                    "description": (
                                        "可选：你的暂定倾向（choice 时应是 options 中一项）。"
                                    ),
                                },
                            },
                            "required": ["prompt"],
                        },
                    },
                },
                "required": ["question"],
            },
            category=ToolCategory.ORCHESTRATION,
            approval=ToolApproval.NEVER,
        )

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        question = str(arguments.get("question") or "").strip()
        if not question:
            return ToolResult(
                tool_call_id="",
                success=False,
                output="",
                error="escalate 需要非空的 question（写清你要上级拍板的问题）。",
            )
        assumption = str(arguments.get("assumption") or "").strip()
        blocking = bool(arguments.get("blocking"))
        # 执行引擎架构设计.md §受监督的波循环: kind=scope marks a 职责/范围 deviation
        # the WaveScheduler consumes at a wave boundary (CEO re-steers the un-run tail);
        # (which is the 阻塞式求决策 user axis). Unknown values degrade to "normal".
        kind = str(arguments.get("kind") or "normal").strip().lower()
        if kind not in ("normal", "scope"):
            kind = "normal"
        # blocking=true 须带 assumption: it is the超时回落 (设计 §4.1, the dual of
        # ask_user(blocking=false) requiring a fallback). Without it a timeout would have
        # nowhere to land — so reject rather than silently guess.
        if blocking and not assumption:
            return ToolResult(
                tool_call_id="",
                success=False,
                output="",
                error=(
                    "escalate(blocking=true) 必须写明 assumption：等不到用户答复时你将按它继续"
                    "（超时回落）。若你本就能自行假设、不需用户拍板，请改用 blocking=false。"
                ),
            )
        logger.info(
            "worker.escalate",
            run_id=context.run_id,
            blocking=blocking,
            kind=kind,
            has_assumption=bool(assumption),
        )
        # 阻塞·求决策: suspend for the user when the turn is armed (a live interactive
        # client). The channel owns cap / suspend / SSE / RunState recording; we only map
        # its outcome. A ``degraded`` outcome (concurrency cap full) or an unarmed turn (no
        # channel) falls through to the non-blocking path below — so blocking is a strict
        # superset of non-blocking, never a regression (设计 §4.4).
        # 结构化升级（复用 ask_user 的问题规整）：把岔路拆成 choice/text 选项随挂起卡下发，
        # 让用户一键拍板。仅阻塞挂起路径用到（非阻塞无卡可答）。Local import 避免经 ask_user
        # 包 __init__ 触发 runtime 依赖环。
        from agentcore.tools.builtin.ask_user.schema import normalize_questions

        channel = context.escalation
        if blocking and channel is not None and channel.armed:
            questions = normalize_questions(arguments.get("questions"))
            outcome = await channel.request(question, assumption, questions)
            if outcome.status != "degraded":
                return escalate_tool_result(outcome.status, outcome.answer, assumption)
        # 非阻塞 (default) / degraded / unarmed: surface the escalation live (best-effort,
        # non-fatal — the durable transcript → RunState.escalations path is unconditional)
        # and steer the worker to deliver under its assumption; the CEO纠偏 at synthesis.
        if context.on_escalate is not None:
            try:
                context.on_escalate(question, assumption, blocking)
            except Exception:  # noqa: BLE001 — liveliness only; never break the worker
                logger.warning("worker.escalate.emit_failed", run_id=context.run_id)
        note = (
            "已记录你的职责偏离信号，主管会在波边界据此校准尚未运行的下游步骤。"
            "这不是停工：请立刻按你当前最合理的假设把任务继续做完、交付最佳结果"
            if kind == "scope"
            else "已记录你的升级，主管会在汇总你的产物时处理。"
            "这不是停工：请立刻按你当前最合理的假设把任务继续做完、交付最佳结果"
        )
        note += (
            "（你已写明假设，主管能据此判断是否需要返工）。"
            if assumption
            else "，并尽量在产出里写明你采用了什么假设，方便主管纠偏。"
        )
        return ToolResult(tool_call_id="", success=True, output=note)


def escalate_tool_result(status: str, answer: str | None, assumption: str) -> ToolResult:
    """Map a blocking escalate's outcome to the CONTINUE result the worker loop consumes.

    The single source of truth for the live suspend path (and any future durable resume),
    the worker-side dual of :func:`~agentcore.tools.builtin.ask_user.ask_user_tool_result`:

    - ``"resolved"`` → feed the user's ``answer`` back into the worker's loop, told to
      prefer it over its暂定假设 and回改 any work already done under the assumption;
    - ``"timeout"`` (no answer within the window, or the user chose 按假设继续) → steer the
      worker to proceed on its stated ``assumption`` — exactly today's non-blocking behaviour.

    Never terminal: an escalation RESUMES the worker, it never ends the turn (停回合 is the
    CEO ``ask_user`` / 对话级 job, never a single worker's call — 设计 §4.5).
    """
    if status == "resolved":
        ans = (answer or "").strip()
        output = (
            f"用户就你的升级问题答复：\n{ans}\n"
            "请据此继续；与你的暂定假设冲突处以用户答复为准，并回改已按假设做出的部分。"
        )
        return ToolResult(tool_call_id="", success=True, output=output)
    # timeout (含「按假设继续」): fall back to the stated assumption — today's behaviour.
    return ToolResult(
        tool_call_id="",
        success=True,
        output=(
            "未在时限内得到用户答复（或用户选择按你的假设继续）。"
            f"请按你写明的假设把任务继续做完：{assumption}。"
        ),
    )
