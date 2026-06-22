"""DebateTool 集成自测（辩论编排设计.md · per-PR 零 LLM 硬门禁）。

与 ``test_debate_moderator`` 互补：那个用假 RoundRunner 只验证主持人循环本身；这个走【真实
RoundRunner】——首轮 ``build_agent_executor`` + ``WaveScheduler`` 派并行辩手、后续轮
``continue_run`` 续写——用一个同时实现 ``complete``（主持人 JSON）+ ``stream``（辩手发言）的
假 provider 驱动，验证工具壳：双产物输出、三层折账（captain→主持人→辩手）、辩手跨轮带记忆、
入参校验、本地执行门、红队形态立场注入。真模型留给 nightly。
"""

import json
from pathlib import Path

from agentcore.llm.protocol import LLMChunk, LLMResponse, TokenUsage
from agentcore.runtime.approvals import ApprovalGate
from agentcore.runtime.debate import (
    DebateConfig,
    DebateForm,
    DebateSide,
    JudgeVerdict,
    RoundResult,
    SideTurn,
)
from agentcore.runtime.events import EventSink, EventType
from agentcore.runtime.interaction import InteractionRegistry
from agentcore.runtime.runs.types import RunPhase, RunState
from agentcore.tools.builtin.debate import DebateTool
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
    "factual_disputes": ["X 的成本到底多少"],
    "value_disputes": ["你更看重速度还是稳妥"],
    "leaning": "基于事实反方略稳",
    "confidence": "中",
    "recommendation": "先小步验证再决定",
    "open_questions": ["你的风险偏好是什么"],
}


class _DebateLLM:
    """假 provider：``complete`` 按 scenario 末段返回主持人 JSON，``stream`` 产辩手发言。

    ``converge_at`` 控制裁判第几轮起判收敛（测最小轮门槛 / 收敛）；``stream_requests`` 记录每
    次辩手调用的 LLMRequest，供断言跨轮 feedback 注入与形态角色指引。"""

    def __init__(self, *, converge_at: int = 1, brief: dict | None = None) -> None:
        self.converge_at = converge_at
        self.brief = brief if brief is not None else _BRIEF
        self.judge_calls = 0
        self.stream_calls = 0
        self.stream_requests: list = []

    async def complete(self, request):  # noqa: ANN001
        step = (request.scenario or "").rsplit(".", 1)[-1]
        if step == "frame":
            return LLMResponse(content=json.dumps({"focus": "本轮焦点"}), usage=_USAGE)
        if step == "judge":
            self.judge_calls += 1
            converged = self.judge_calls >= self.converge_at
            verdict = {
                "real_clash": True,
                "new_arguments": not converged,
                "converged": converged,
                "stop_reason": "converged",
                "next_focus": "更深的点",
                "rationale": "理由",
            }
            return LLMResponse(content=json.dumps(verdict), usage=_USAGE)
        if step == "summary":
            return LLMResponse(content=json.dumps({"summary": "本轮小结"}), usage=_USAGE)
        if step == "brief":
            return LLMResponse(content=json.dumps(self.brief), usage=_USAGE)
        return LLMResponse(content="{}", usage=_USAGE)

    async def stream(self, request):  # noqa: ANN001
        self.stream_calls += 1
        self.stream_requests.append(request)
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
    # 3 轮 × 2 辩手 = 6 次 stream（首轮 executor + 第2/3 轮 continue_run 续写）
    assert llm.stream_calls == 6
    # 后续轮经 continue_run 注入「本轮焦点 + 对方上轮论点」→ 辩手跨轮带记忆
    msgs = [m.content for req in llm.stream_requests for m in req.messages]
    assert any("第 2 轮" in c for c in msgs)
    assert any("辩手发言#" in c for c in msgs)
    # ledger 含后续轮续写行（run_id 形如 *_r2_pro / *_r3_con，按 side.key 定位同一辩手）
    ledger_ids = [r.run_id for r in tool.run_ledger]
    assert any("_r2_pro" in rid for rid in ledger_ids)
    assert any("_r3_con" in rid for rid in ledger_ids)


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
    tool = _tool(_DebateLLM())
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
    fb = tool._round_feedback(config, config.sides[0], 2, "第二轮焦点", last)

    assert "第 2 轮" in fb and "第二轮焦点" in fb
    assert "反方上轮论点内容" in fb  # 注入【对方】上轮论点
    assert "正方上轮论点内容" not in fb  # 不注入【自己】上轮（自己 transcript 已有）
    assert "只补" in fb and "不要重述你上一轮" in fb


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
