"""DebateTool 集成自测（辩论编排设计.md · per-PR 零 LLM 硬门禁）。

与 ``test_debate_moderator`` 互补：那个用假 RoundRunner 只验证主持人循环本身；这个走【真实
RoundRunner】——首轮 ``build_agent_executor`` + ``WaveScheduler`` 派并行辩手、后续轮
``continue_run`` 续写——用一个同时实现 ``complete``（主持人 JSON）+ ``stream``（辩手发言）的
假 provider 驱动，验证工具壳：双产物输出、三层折账（captain→主持人→辩手）、辩手跨轮带记忆、
入参校验、本地执行门、红队形态立场注入。真模型留给 nightly。

质询回合（P1）：``questions`` 非空时 ``complete(cross_exam)`` 产出定向质询，``stream`` 对质询
feedback 回结构化 JSON，驱动真实 ``make_cross_exam_runner``（continue_run → 解析 → 落
``RoundResult.cross_exam`` / 失败兜底）。默认 ``questions=None`` → cross_exam 步回 ``{}``，
与既有 thorough 用例「跳过质询 beat」行为一致。
"""

import json
from pathlib import Path

from agentcore.llm.provider.protocol import LLMChunk, LLMResponse, TokenUsage
from agentcore.runtime.approvals import ApprovalGate
from agentcore.runtime.debate import (
    DebateConfig,
    DebateForm,
    DebateSide,
    JudgeVerdict,
    RoundResult,
    SideTurn,
    UserInterjection,
)
from agentcore.runtime.debate.prompt import debater_task, round_feedback
from agentcore.runtime.events import EventSink, EventType
from agentcore.runtime.interaction import InteractionRegistry
from agentcore.runtime.runs.types import RunPhase, RunState
from agentcore.tools.builtin.debate import DebateTool
from agentcore.tools.builtin.debate.schema import parse_background, parse_sides
from agentcore.tools.protocol import ToolContext
from agentcore.tools.registry import ToolRegistry
from agentcore.tools.sandbox.subprocess import SubprocessSandbox
from agentcore.workspace.server import ServerWorkspace

_USAGE = TokenUsage(
    input_tokens=10,
    output_tokens=5,
    reasoning_tokens=0,
    cache_hit_tokens=6,
    cache_miss_tokens=4,
)
_BRIEF = {
    "crux": "做不做 X 的核心权衡",
    "strongest_points": {"pro": "正方最强论点", "con": "反方最强论点"},
    "value_disputes": ["你更看重速度还是稳妥"],
    "factual_disputes": ["X 的成本到底多少"],
    "leaning": "基于事实反方略稳",
    "confidence": "中",
    "recommendation": "先小步验证再决定",
    "open_questions": ["灰度窗口外的政策会不会变"],
}

# 质询集成默认题集（与断言文案对齐；thorough + 正反才会开质询 beat）。
_CX_QUESTIONS = {
    "pro": ["收益是否计入尾部风险？", "熔断成本由谁承担？"],
    "con": ["你反对的替代方案是什么？"],
}


class _DebateLLM:
    """假 provider：``complete`` 按 scenario 末段返回主持人 JSON，``stream`` 产辩手发言。

    ``converge_at`` 控制裁判第几轮起判收敛（测最小轮门槛 / 收敛）；``stream_requests`` 记录每
    次辩手调用的 LLMRequest，供断言跨轮 feedback 注入与形态角色指引。

    质询（opt-in）：``questions`` 非空时 ``cross_exam`` 步回定向质询；``stream`` 若看到质询
    feedback（含「质询环节」）则按 ``cx_answer_style`` 产 markdown 标题体作答（``headings`` =
    ``### 质询一`` 切段；``prose`` = 无标题散文，驱动挂第一题降级）。
    ``cx_fail_sides`` 内的方对质询回空内容，驱动 runner 失败兜底（exchanges answer 空）。
    """

    def __init__(
        self,
        *,
        converge_at: int = 1,
        brief: dict | None = None,
        questions: dict[str, list[str]] | None = None,
        cx_answer_style: str = "headings",
        cx_fail_sides: frozenset[str] | None = None,
    ) -> None:
        self.converge_at = converge_at
        self.brief = brief if brief is not None else _BRIEF
        self.questions = questions
        self.cx_answer_style = cx_answer_style
        self.cx_fail_sides = cx_fail_sides or frozenset()
        self.judge_calls = 0
        self.cross_exam_calls = 0
        self.stream_calls = 0
        self.stream_requests: list = []

    async def complete(self, request):  # noqa: ANN001
        step = (request.scenario or "").rsplit(".", 1)[-1]
        if step == "frame":
            return LLMResponse(content=json.dumps({"focus": "本轮焦点"}), usage=_USAGE)
        if step == "cross_exam":
            self.cross_exam_calls += 1
            # 未配置 questions → {}，主持人跳过质询 beat（既有 thorough 用例零行为变化）。
            payload = {"questions": self.questions} if self.questions else {}
            return LLMResponse(content=json.dumps(payload), usage=_USAGE)
        if step == "assess":
            # 合并裁判：一次调用同产裁判判定 + 本轮小结（:meth:`Moderator._judge_and_summarize`）。
            self.judge_calls += 1
            converged = self.judge_calls >= self.converge_at
            payload = {
                "real_clash": True,
                "new_arguments": not converged,
                "converged": converged,
                "stop_reason": "converged",
                "next_focus": "更深的点",
                "rationale": "理由",
                "summary": "本轮小结",
            }
            return LLMResponse(content=json.dumps(payload), usage=_USAGE)
        if step == "brief":
            return LLMResponse(content=json.dumps(self.brief), usage=_USAGE)
        return LLMResponse(content="{}", usage=_USAGE)

    def _cx_answer_content(self, joined: str) -> str:
        """按 feedback 里出现的质询题匹配 side，产出标题体作答（或空串触发失败兜底）。"""
        _ords = "一二三四五六七八九十"
        for key, qs in (self.questions or {}).items():
            if not qs or qs[0] not in joined:
                continue
            if key in self.cx_fail_sides:
                return ""
            if self.cx_answer_style == "prose":
                return f"散文答·{key}【待核实·推断】"
            parts: list[str] = []
            for i in range(len(qs)):
                label = _ords[i] if i < len(_ords) else str(i + 1)
                parts.append(f"### 质询{label}\n正面答·{key}·{i + 1}【待核实·推断】")
            return "\n\n".join(parts)
        return ""

    async def stream(self, request):  # noqa: ANN001
        self.stream_calls += 1
        self.stream_requests.append(request)
        joined = "\n".join(getattr(m, "content", "") or "" for m in request.messages)
        # 质询 continue_run：feedback 含「质询环节」——回 markdown 标题体，驱动真实 runner 解析落库。
        if "质询环节" in joined:
            content = self._cx_answer_content(joined)
            if content:
                yield LLMChunk(delta_content=content)
            yield LLMChunk(usage=_USAGE)
            return
        yield LLMChunk(delta_content=f"辩手发言#{self.stream_calls}")
        yield LLMChunk(usage=_USAGE)


def _ctx(backend=None) -> ToolContext:  # noqa: ANN001
    return ToolContext(
        execution_id="e",
        run_id="s",
        agent_id="a",
        backend=backend or ServerWorkspace(root=Path("."), sandbox=SubprocessSandbox()),
        user_id="u",
    )


def _sides() -> list[dict]:
    return [
        {"key": "pro", "name": "正方", "stance": "支持做 X"},
        {"key": "con", "name": "反方", "stance": "反对做 X"},
    ]


def _tool(llm, *, ctx=None, sink=None, approval_gate=None) -> DebateTool:  # noqa: ANN001
    return DebateTool(
        llm=llm,
        sink=sink or EventSink(),
        system_prompt="SYS",
        user_message="原始请求",
        tools=ToolRegistry(),
        base_tool_context=ctx or _ctx(),
        captain_run_id="captain1",
        approval_gate=approval_gate,
    )


async def test_quick_debate_returns_dual_products_non_terminal():
    llm = _DebateLLM(converge_at=1)
    tool = _tool(llm)
    result = await tool.execute(
        {"motion": "该不该做 X", "form": "debate", "sides": _sides(), "thorough": False}, _ctx()
    )
    assert result.success is True
    assert result.is_terminal is False  # 非终结：产物回 CEO 循环
    # 双产物都折进 CEO 文本
    assert "决策简报" in result.output
    assert "交锋叙事线" in result.output
    assert "先小步验证再决定" in result.output  # brief.recommendation
    # quick = 单轮：2 辩手 = 2 次 stream
    assert llm.stream_calls == 2
    # token 折算回 metadata（与 delegate 同形）
    assert set(result.metadata) == {
        "input_tokens",
        "output_tokens",
        "reasoning_tokens",
        "cache_hit_tokens",
        "cache_miss_tokens",
    }
    assert result.metadata["input_tokens"] > 0


async def test_emits_debate_result_event_for_frontend_view():
    sink = EventSink()
    llm = _DebateLLM(converge_at=1)
    tool = _tool(llm, sink=sink)
    await tool.execute(
        {"motion": "该不该做 X", "form": "debate", "sides": _sides(), "thorough": False}, _ctx()
    )
    sink.close()
    events = [e async for e in sink if e.type == EventType.DEBATE_RESULT]
    assert len(events) == 1
    p = events[0].payload
    assert p["moderator_run_id"].startswith("debate_")
    assert p["form"] == "debate"
    assert p["motion"] == "该不该做 X"
    assert p["stop_reason"]  # 收场归因非空
    # 叙事线：逐轮焦点 + 裁判 + 各方→辩手 run_id 映射（前端据此取发言全文 L3）
    assert len(p["rounds"]) == 1
    assert p["rounds"][0]["focus"]
    assert "verdict" in p["rounds"][0]
    assert len(p["rounds"][0]["sides"]) == 2
    assert all(s["run_id"] for s in p["rounds"][0]["sides"])
    # 决策简报：结论产物齐全
    assert p["brief"]["recommendation"] == "先小步验证再决定"
    assert p["brief"]["strongest_points"]


async def test_emits_batch_metrics_for_diagnostics():
    """首轮辩手经 WaveScheduler 并行扇出 → 调度埋点快照也 emit 给前端 (诊断模式/时间线),
    与 delegate drive 同形 (前端UX设计.md §十)；此前只 logger.info、前端诊断区为空。"""
    sink = EventSink()
    llm = _DebateLLM(converge_at=1)
    tool = _tool(llm, sink=sink)
    await tool.execute(
        {"motion": "该不该做 X", "form": "debate", "sides": _sides(), "thorough": False}, _ctx()
    )
    sink.close()
    events = [e async for e in sink if e.type == EventType.BATCH_METRICS]
    assert len(events) == 1
    p = events[0].payload
    assert p["execution_id"]
    assert p["nodes"] == 2  # 两名辩手一波并行


async def test_ledger_three_tier_parenting():
    llm = _DebateLLM(converge_at=1)
    tool = _tool(llm)
    await tool.execute(
        {"motion": "该不该做 X", "form": "debate", "sides": _sides(), "thorough": False}, _ctx()
    )
    ledger = tool.run_ledger
    # ledger 行的 role 统一为 member（与 delegate 同；节点的「主持人 / 辩手」角色由 plan 事件
    # 携带）。三层账靠 parent 链区分：主持人 parent=captain、辩手 parent=主持人 run_id。
    mod_rows = [r for r in ledger if r.parent_run_id == "captain1"]
    assert len(mod_rows) == 1
    mod_run_id = mod_rows[0].run_id
    assert mod_run_id.startswith("debate_")
    debater_rows = [r for r in ledger if r.parent_run_id == mod_run_id]
    assert len(debater_rows) == 2  # 2 辩手 × 1 轮
    assert len(ledger) == 3  # 1 主持人 + 2 辩手 → captain→主持人→辩手三层
    # 首轮 run_id 用语义后缀 `_r1_{key}`（与后续轮 `_r{n}_{key}` 同构、对齐 conformance 向量），
    # 而非旧的位置序号 `_r1_1`。
    assert {r.run_id for r in debater_rows} == {f"{mod_run_id}_r1_pro", f"{mod_run_id}_r1_con"}


async def test_multi_round_cross_round_memory():
    # 无最小轮门槛了：轮数由裁判逐轮自判。converge_at=3 → 裁判前两轮判未收敛、第 3 轮收敛 →
    # 跑满 3 轮（thorough 默认 max=5，收敛早于上限发生），借此验证后续轮 continue_run 续写。
    llm = _DebateLLM(converge_at=3)
    tool = _tool(llm)
    result = await tool.execute(
        {"motion": "该不该做 X", "form": "debate", "sides": _sides()}, _ctx()
    )
    assert result.success is True
    # 3 轮 × 2 辩手 = 6 次立论 stream（首轮 executor + 第2/3 轮 continue_run 续写）+ 收场结辩 beat
    # （P4·结辩收束）各方 continue_run 各 1 次 = 2 → 共 8。thorough 正反默认开启结辩（_closing_enabled）。
    assert llm.stream_calls == 8
    # 后续轮经 continue_run 注入「本轮焦点 + 对方上轮论点」→ 辩手跨轮带记忆
    msgs = [m.content for req in llm.stream_requests for m in req.messages]
    assert any("第 2 轮" in c for c in msgs)
    assert any("辩手发言#" in c for c in msgs)
    # 结辩 beat 的 feedback 注入「结辩陈词 / 只讲胜负手」→ 辩手在自己 transcript 上收尾。
    assert any("结辩" in c for c in msgs)
    # ledger 含后续轮续写行（run_id 形如 *_r2_pro / *_r3_con）+ 收场结辩行（*_closing_pro/con）。
    ledger_ids = [r.run_id for r in tool.run_ledger]
    assert any("_r2_pro" in rid for rid in ledger_ids)
    assert any("_r3_con" in rid for rid in ledger_ids)
    assert any("_closing_pro" in rid for rid in ledger_ids)
    assert any("_closing_con" in rid for rid in ledger_ids)


async def test_cross_exam_real_runner_lands_exchanges():
    """真实 make_cross_exam_runner：主持人 cross_exam 出题 → continue_run 作答 → 解析落
    RoundResult.cross_exam；ledger 含 ``_r{n}_cx_{key}``；质询 feedback 进辩手 prompt。"""
    llm = _DebateLLM(converge_at=1, questions=_CX_QUESTIONS)
    sink = EventSink()
    tool = _tool(llm, sink=sink)
    result = await tool.execute(
        {"motion": "该不该做 X", "form": "debate", "sides": _sides()}, _ctx()
    )
    assert result.success is True
    assert llm.cross_exam_calls == 1
    # 1 轮 × 2 立论 + 2 质询作答 + 2 结辩 = 6
    assert llm.stream_calls == 6
    msgs = [m.content for req in llm.stream_requests for m in req.messages]
    assert any("质询环节" in c for c in msgs)

    sink.close()
    events = [e async for e in sink if e.type == EventType.DEBATE_RESULT]
    assert len(events) == 1
    cx = events[0].payload["rounds"][0]["cross_exam"]
    assert [c["target"] for c in cx] == ["pro", "con"]
    assert cx[0]["answer_run_id"].endswith("_r1_cx_pro")
    assert cx[1]["answer_run_id"].endswith("_r1_cx_con")
    assert len(cx[0]["exchanges"]) == 2
    assert cx[0]["exchanges"][0]["question"] == _CX_QUESTIONS["pro"][0]
    assert "正面答·pro·1" in cx[0]["exchanges"][0]["answer"]
    assert "正面答·pro·2" in cx[0]["exchanges"][1]["answer"]
    assert len(cx[1]["exchanges"]) == 1
    assert "正面答·con·1" in cx[1]["exchanges"][0]["answer"]
    assert all("ok" not in ex for c in cx for ex in c["exchanges"])
    assert all(ex["answer"] for c in cx for ex in c["exchanges"])

    ledger_ids = [r.run_id for r in tool.run_ledger]
    assert any("_r1_cx_pro" in rid for rid in ledger_ids)
    assert any("_r1_cx_con" in rid for rid in ledger_ids)


async def test_cross_exam_real_runner_prose_hangs_on_first():
    """无标题散文作答 → 优雅降级：整段挂第一题，其余空答。"""
    llm = _DebateLLM(converge_at=1, questions=_CX_QUESTIONS, cx_answer_style="prose")
    sink = EventSink()
    tool = _tool(llm, sink=sink)
    result = await tool.execute(
        {"motion": "该不该做 X", "form": "debate", "sides": _sides()}, _ctx()
    )
    assert result.success is True
    sink.close()
    events = [e async for e in sink if e.type == EventType.DEBATE_RESULT]
    cx = events[0].payload["rounds"][0]["cross_exam"]
    pro = next(c for c in cx if c["target"] == "pro")
    assert len(pro["exchanges"]) == 2
    assert "散文答·pro" in pro["exchanges"][0]["answer"]
    assert pro["exchanges"][1]["answer"] == ""
    con = next(c for c in cx if c["target"] == "con")
    assert "散文答·con" in con["exchanges"][0]["answer"]


async def test_cross_exam_real_runner_failed_answer_leaves_empty():
    """质询 continue_run 空内容 → runner 走失败兜底：exchanges answer 空、无 ok 字段。"""
    llm = _DebateLLM(
        converge_at=1,
        questions=_CX_QUESTIONS,
        cx_fail_sides=frozenset({"con"}),
    )
    sink = EventSink()
    tool = _tool(llm, sink=sink)
    result = await tool.execute(
        {"motion": "该不该做 X", "form": "debate", "sides": _sides()}, _ctx()
    )
    assert result.success is True
    sink.close()
    events = [e async for e in sink if e.type == EventType.DEBATE_RESULT]
    cx = events[0].payload["rounds"][0]["cross_exam"]
    by_target = {c["target"]: c for c in cx}
    assert all(ex["answer"] for ex in by_target["pro"]["exchanges"])
    assert "正面答·pro" in by_target["pro"]["exchanges"][0]["answer"]
    assert by_target["con"]["answer_run_id"].endswith("_r1_cx_con")
    assert len(by_target["con"]["exchanges"]) == 1
    assert by_target["con"]["exchanges"][0]["question"] == _CX_QUESTIONS["con"][0]
    assert by_target["con"]["exchanges"][0]["answer"] == ""
    assert "ok" not in by_target["con"]["exchanges"][0]


async def test_rejects_missing_motion():
    tool = _tool(_DebateLLM())
    result = await tool.execute({"motion": "  ", "form": "debate", "sides": _sides()}, _ctx())
    assert result.success is False


async def test_rejects_too_few_sides():
    tool = _tool(_DebateLLM())
    result = await tool.execute(
        {"motion": "X", "form": "debate", "sides": [{"key": "a", "name": "A", "stance": "s"}]},
        _ctx(),
    )
    assert result.success is False


async def test_rejects_duplicate_side_key():
    tool = _tool(_DebateLLM())
    dup = [
        {"key": "x", "name": "A", "stance": "s"},
        {"key": "x", "name": "B", "stance": "t"},
    ]
    result = await tool.execute({"motion": "X", "form": "debate", "sides": dup}, _ctx())
    assert result.success is False


async def test_red_team_form_injects_subject_and_attacker_roles():
    llm = _DebateLLM(converge_at=1)
    tool = _tool(llm)
    sides = [
        {"key": "plan", "name": "方案方", "stance": "方案 A 可行", "is_subject": True},
        {"key": "red", "name": "红队", "stance": "找出方案漏洞"},
    ]
    result = await tool.execute(
        {"motion": "压力测试方案 A", "form": "red_team", "sides": sides, "thorough": False}, _ctx()
    )
    assert result.success is True
    # 红队形态的差异化角色指引注入了辩手 prompt（system_prompt_supplement + task）
    joined = "\n".join(m.content for req in llm.stream_requests for m in req.messages)
    assert "红队" in joined
    assert "被审" in joined or "方案方" in joined


def test_round_feedback_demands_new_args_and_no_self_restate():
    """后续轮 feedback：注入【对方】上轮论点 + 明令「只补新论点、勿重述自己上轮」——降冗余轮相似度。

    辩手在自己 transcript 上续写（已带自己上轮全文），故只喂对方论点、不喂自己上轮；与 _frame 的
    焦点正交约束一上一下夹击「修订 v2 内容相似」。
    """
    config = DebateConfig(
        motion="该不该做 X",
        form=DebateForm.DEBATE,
        sides=[DebateSide("pro", "正方", "支持"), DebateSide("con", "反方", "反对")],
    )
    last = RoundResult(
        1,
        "第一轮焦点",
        [
            SideTurn("pro", "正方", "r1_pro", "正方上轮论点内容"),
            SideTurn("con", "反方", "r1_con", "反方上轮论点内容"),
        ],
        JudgeVerdict(real_clash=True, new_arguments=True, converged=False),
    )
    fb = round_feedback(config, config.sides[0], 2, "第二轮焦点", last)

    assert "第 2 轮" in fb and "第二轮焦点" in fb
    assert "反方上轮论点内容" in fb  # 注入【对方】上轮论点
    assert "正方上轮论点内容" not in fb  # 不注入【自己】上轮（自己 transcript 已有）
    # 检索 feedback：只记新素材；成稿 brief 才说「只补」发言
    assert "只记" in fb and "不要重述你上一轮" in fb
    from agentcore.runtime.debate.prompt import round_draft_brief

    brief = round_draft_brief(config, config.sides[0], 2, "第二轮焦点", last)
    assert "只补" in brief and "不要重述你上一轮" in brief
    assert "用户在本轮追问" not in fb  # 无追问时不出现追问块（零行为变化）


def test_round_feedback_injects_targeted_user_followup():
    """用户【追问】注入后续轮 feedback：定向某方的只喂那一方、未定向的喂全场，且明令【本轮优先正面
    回答】——把用户的最高优先级诉求摆到辩手面前（交互式逐轮 / Phase 2）。"""
    config = DebateConfig(
        motion="该不该做 X",
        form=DebateForm.DEBATE,
        sides=[DebateSide("pro", "正方", "支持"), DebateSide("con", "反方", "反对")],
    )
    last = RoundResult(
        1,
        "第一轮焦点",
        [
            SideTurn("pro", "正方", "r1_pro", "正方上轮论点内容"),
            SideTurn("con", "反方", "r1_con", "反方上轮论点内容"),
        ],
        JudgeVerdict(real_clash=True, new_arguments=True, converged=False),
    )
    # 定向【正方】的追问。
    asks = [UserInterjection(ask="灰度期谁兜底？", target_key="pro")]
    fb_pro = round_feedback(config, config.sides[0], 2, "第二轮焦点", last, asks)
    fb_con = round_feedback(config, config.sides[1], 2, "第二轮焦点", last, asks)

    assert "灰度期谁兜底？" in fb_pro and "用户在本轮追问" in fb_pro
    assert "优先正面回答" in fb_pro and "向你" in fb_pro
    assert "灰度期谁兜底？" not in fb_con  # 定向正方 → 不喂反方

    # 未定向（全场）的追问 → 各方都喂。
    all_ask = [UserInterjection(ask="边界在哪？", target_key="")]
    fb_pro_all = round_feedback(config, config.sides[0], 2, "焦点", last, all_ask)
    fb_con_all = round_feedback(config, config.sides[1], 2, "焦点", last, all_ask)
    assert "边界在哪？" in fb_pro_all and "向全场" in fb_pro_all
    assert "边界在哪？" in fb_con_all


def test_submit_debate_steer_body_shape():
    """REST debate-steer body 契约：decision/focus/ask/ask_target 可入队。"""
    from agentcore.api.schemas.messages import SubmitDebateSteerRequest

    body = SubmitDebateSteerRequest(
        execution_id="exec1",
        decision="continue",
        focus="加角度",
        ask="谁兜底？",
        ask_target="pro",
    )
    assert body.decision == "continue"
    assert body.focus == "加角度"
    assert body.ask == "谁兜底？"
    assert body.ask_target == "pro"
    bare = SubmitDebateSteerRequest(execution_id="exec1", decision="conclude")
    assert bare.focus == "" and bare.ask == "" and bare.ask_target == ""


# --- 本地执行门（双模式工作区 P2d）：辩手仅在 local backend 继承 CEO 的 gate -----


class _LocalBackend:
    """最小本地后端桩 —— DebateTool 只读 ``.location`` 判是否下放 gate。"""

    location = "local"
    root_label = "ws"


def _gate() -> ApprovalGate:
    return ApprovalGate(
        sink=EventSink(),
        conversation_id="c",
        registry=InteractionRegistry(),
        timeout_seconds=1.0,
    )


def test_side_model_parsed_but_not_injected_into_debater_task():
    """MVP 统一用户 model：sides[].model 仍解析保留（Phase 3 多模型辩手），但不注入 task。"""
    sides, err = parse_sides(
        [
            {
                "key": "a",
                "name": "豆包",
                "stance": "我最聪明",
                "model": "doubao/doubao-seed-2-1-turbo-260628",
            },
            {"key": "b", "name": "DeepSeek", "stance": "我才最聪明"},
        ]
    )
    assert err == ""
    assert sides[0].model == "doubao/doubao-seed-2-1-turbo-260628"
    assert sides[1].model == ""
    cfg = DebateConfig(motion="谁更聪明", form=DebateForm.DEBATE, sides=sides)
    t_a = debater_task(cfg, sides[0], 0, round_no=1, focus="智商")
    t_b = debater_task(cfg, sides[1], 1, round_no=1, focus="智商")
    assert "model" not in t_a
    assert "model" not in t_b


def test_quick_mode_injects_concise_hint_thorough_does_not():
    """快速对碰（thorough=False）给首轮辩手注入「少检索、收窄到 1 个论点」的轻量约束；认真辩透
    （thorough=True）不注入，保留深挖取证。根治观测到的「为 trivial 命题刷十余次 web_search、
    跑近十轮」——辩手自停在轮数上限内，故有效杠杆是提示词而非轮数上限。"""
    from agentcore.runtime.debate import RoundPolicy
    from agentcore.tools.builtin.debate.schema import QUICK_DEBATER_HINT

    sides, _ = parse_sides(
        [
            {"key": "pro", "name": "正方", "stance": "甜"},
            {"key": "con", "name": "反方", "stance": "咸"},
        ]
    )
    quick_cfg = DebateConfig(
        motion="甜豆腐脑 vs 咸豆腐脑",
        form=DebateForm.DEBATE,
        sides=sides,
        policy=RoundPolicy.quick(),
    )
    thorough_cfg = DebateConfig(  # default policy → thorough
        motion="甜豆腐脑 vs 咸豆腐脑", form=DebateForm.DEBATE, sides=sides
    )
    quick_task = debater_task(quick_cfg, sides[0], 0, round_no=1, focus="正统")["task"]
    thorough_task = debater_task(thorough_cfg, sides[0], 0, round_no=1, focus="正统")["task"]
    assert QUICK_DEBATER_HINT in quick_task
    assert QUICK_DEBATER_HINT not in thorough_task


def test_parse_background_strips_and_rejects_non_str():
    """可选 background：字符串 strip；缺省 / 非字符串 → 空串（零行为变化路径）。"""
    assert parse_background(None) == ""
    assert parse_background(123) == ""
    assert parse_background(["a"]) == ""
    assert parse_background("  主体A 于 2024 年起诉  ") == "主体A 于 2024 年起诉"
    assert parse_background("") == ""
    assert parse_background("   ") == ""


def test_debate_config_carries_background():
    """DebateConfig 默认 background 空串；显式传入后可被 debater_task 读到。"""
    sides = [DebateSide("pro", "正方", "支持"), DebateSide("con", "反方", "反对")]
    bare = DebateConfig(motion="X", form=DebateForm.DEBATE, sides=sides)
    assert bare.background == ""
    filled = DebateConfig(
        motion="X", form=DebateForm.DEBATE, sides=sides, background="事实一：判赔 100 万"
    )
    assert filled.background == "事实一：判赔 100 万"


def test_debater_task_omits_background_when_empty():
    """不传 / 空底料：首轮 task 不含案件底料块（与现网逐字同形）。"""
    sides = [DebateSide("pro", "正方", "支持"), DebateSide("con", "反方", "反对")]
    cfg = DebateConfig(motion="该不该做 X", form=DebateForm.DEBATE, sides=sides)
    task = debater_task(cfg, sides[0], 0, round_no=1, focus="成本")["task"]
    assert "案件底料" not in task
    assert "双方共享" not in task


def test_debater_task_injects_kickoff_interjection():
    """开赛嘱咐：首轮 task 注入追问块（全场定向，双方可见）。"""
    from agentcore.runtime.debate import UserInterjection

    sides = [DebateSide("pro", "正方", "支持"), DebateSide("con", "反方", "反对")]
    cfg = DebateConfig(motion="该不该做 X", form=DebateForm.DEBATE, sides=sides)
    asks = (UserInterjection(ask="最关心成本谁买单", target_key=""),)
    for i, side in enumerate(sides):
        task = debater_task(
            cfg, side, i, round_no=1, focus="成本", interjections=asks
        )["task"]
        assert "用户在本轮追问" in task
        assert "最关心成本谁买单" in task


def test_debater_task_injects_background_block():
    """有底料：首轮 task 注入「主持人整理的案件底料·双方共享」+ 事实正文 + 独立检索 / 出处沿用口径。"""
    sides = [DebateSide("pro", "正方", "支持"), DebateSide("con", "反方", "反对")]
    facts = "- 主体：甲公司 vs 乙公司\n- 时间线：2023 起诉，2024 一审判赔 80 万"
    cfg = DebateConfig(
        motion="该不该上诉", form=DebateForm.DEBATE, sides=sides, background=facts
    )
    for i, side in enumerate(sides):
        task = debater_task(cfg, side, i, round_no=1, focus="风险")["task"]
        assert "【主持人整理的案件底料·双方共享】" in task
        assert facts in task
        assert "独立检索" in task
        assert "不得把本底料本身包装成新的【已核实】来源" in task


def test_debater_task_clips_oversized_background():
    """超长底料进 prompt 前头尾裁剪（与 _clip 同思路），防撑爆首轮。"""
    from agentcore.runtime.debate.prompt import _BG_CLIP, _clip

    sides = [DebateSide("pro", "正方", "支持"), DebateSide("con", "反方", "反对")]
    head = "HEAD_MARKER_" + ("甲" * 100)
    tail = ("乙" * 100) + "_TAIL_MARKER"
    mid = "中段应被略去_" + ("X" * (_BG_CLIP + 500))
    long_bg = head + mid + tail
    assert len(long_bg) > _BG_CLIP
    cfg = DebateConfig(
        motion="X", form=DebateForm.DEBATE, sides=sides, background=long_bg
    )
    task = debater_task(cfg, sides[0], 0, round_no=1, focus="焦点")["task"]
    clipped = _clip(long_bg, _BG_CLIP)
    assert "……（中段略）……" in task
    assert clipped in task
    assert "HEAD_MARKER_" in task
    assert "_TAIL_MARKER" in task
    assert mid not in task  # 中段全文不应原样出现
    assert len(clipped) < len(long_bg)


async def test_tool_passes_background_into_first_round_tasks():
    """工具壳：arguments.background → DebateConfig → 首轮辩手 prompt（stream 消息可见）。"""
    llm = _DebateLLM(converge_at=1)
    tool = _tool(llm)
    facts = "已核实：2024 年报披露营收 12 亿"
    result = await tool.execute(
        {
            "motion": "该不该扩产",
            "form": "debate",
            "sides": _sides(),
            "thorough": False,
            "background": facts,
        },
        _ctx(),
    )
    assert result.success is True
    joined = "\n".join(m.content for req in llm.stream_requests for m in req.messages)
    assert "【主持人整理的案件底料·双方共享】" in joined
    assert facts in joined


async def test_workers_gated_in_local_mode(monkeypatch):
    captured: dict = {}

    def fake_build(**kwargs):
        captured["gate"] = kwargs.get("approval_gate")

        async def _exec(spec, completed):  # noqa: ANN001 - duck-typed RunExecutor
            return RunState(phase=RunPhase.COMPLETED, content="X", usage=_USAGE.as_dict())

        return _exec

    monkeypatch.setattr("agentcore.runtime.runs.build_agent_executor", fake_build)
    gate = _gate()
    tool = _tool(_DebateLLM(converge_at=1), ctx=_ctx(backend=_LocalBackend()), approval_gate=gate)
    await tool.execute(
        {"motion": "X", "form": "debate", "sides": _sides(), "thorough": False},
        _ctx(backend=_LocalBackend()),
    )
    # 本地：辩手团队继承 CEO 的同一 gate（碰盘前需用户同意）。
    assert captured["gate"] is gate
