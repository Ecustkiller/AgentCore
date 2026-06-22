"""主持人辩论循环自测（辩论编排设计.md §二/§四/§五 · per-PR 零 LLM 硬门禁）。

用**假 provider（脚本化 JSON）+ 假 RoundRunner** 零成本验证主持人循环本身：收敛终止、防过早
收敛最小轮门槛、快速对碰单轮、不收敛跑到安全上限、双产物（决策简报 + 三层叙事线）齐全、辩手
跨轮记忆的 history 输入、裁判坏 JSON 保守容错、全员失败提前终止、收场归因传递、CEO 折算文本与
按形态自适应的呈现顺序。真模型留给 nightly。
"""

import asyncio
import json

from agentcore.llm.protocol import LLMResponse
from agentcore.runtime.debate import (
    STOP_ALL_FAILED,
    STOP_CONVERGED,
    STOP_FOCUS_CLARIFIED,
    STOP_MAX_ROUNDS,
    DebateBrief,
    DebateConfig,
    DebateForm,
    DebateResult,
    DebateSide,
    JudgeVerdict,
    Moderator,
    RoundPolicy,
    RoundResult,
    SideTurn,
)

# --- 假 provider / 假 runner -------------------------------------------------

_CONVERGE = {
    "real_clash": True,
    "new_arguments": False,
    "converged": True,
    "stop_reason": "converged",
    "rationale": "各方开始重复",
}
_KEEP_GOING = {
    "real_clash": True,
    "new_arguments": True,
    "converged": False,
    "next_focus": "更深的点",
    "rationale": "仍在产生新论点",
}
_DEFAULT_BRIEF = {
    "crux": "做不做 X 的核心权衡",
    "strongest_points": {"pro": "正方最强论点", "con": "反方最强论点"},
    "factual_disputes": ["X 的成本到底多少"],
    "value_disputes": ["你更看重速度还是稳妥"],
    "leaning": "基于事实反方略稳",
    "confidence": "中（若你更看重速度则正方成立）",
    "recommendation": "先小步验证再决定",
    "open_questions": ["你的风险偏好是什么"],
}


class _ScriptedLLM:
    """按 scenario 末段（frame/judge/summary/brief）返回脚本化 JSON 的假 provider。

    ``judge_results`` 是每轮裁判的 JSON（用完取最后一个）；``judge_content`` 设了则裁判直接返回
    该原始字符串（测坏 JSON 容错）；``brief`` 覆盖默认简报。各步调用计数暴露给断言。
    """

    def __init__(self, *, judge_results=None, judge_content=None, brief=None):  # noqa: ANN001
        self.judge_results = judge_results or [_KEEP_GOING]
        self.judge_content = judge_content
        self.brief = brief if brief is not None else _DEFAULT_BRIEF
        self.frame_calls = 0
        self.judge_calls = 0
        self.summary_calls = 0
        self.brief_calls = 0

    async def complete(self, request):  # noqa: ANN001
        step = request.scenario.rsplit(".", 1)[-1]
        if step == "frame":
            self.frame_calls += 1
            return LLMResponse(content=json.dumps({"focus": f"焦点{self.frame_calls}"}))
        if step == "judge":
            idx = min(self.judge_calls, len(self.judge_results) - 1)
            self.judge_calls += 1
            if self.judge_content is not None:
                return LLMResponse(content=self.judge_content)
            return LLMResponse(content=json.dumps(self.judge_results[idx]))
        if step == "summary":
            self.summary_calls += 1
            return LLMResponse(content=json.dumps({"summary": f"第{self.summary_calls}轮小结"}))
        if step == "brief":
            self.brief_calls += 1
            return LLMResponse(content=json.dumps(self.brief))
        return LLMResponse(content="{}")


class _RecordingRunner:
    """假 RoundRunner：记录每次被调的 (round_no, focus, history 长度)，返回各方发言。

    ``history_len`` 序列即「辩手跨轮带记忆」的输入证据：第 k 轮应看到前 k-1 轮。``fail_all``
    模拟某轮全员发言失败（ok=False）。
    """

    def __init__(self, *, fail_all=False):  # noqa: ANN001
        self.calls = []
        self.fail_all = fail_all

    async def __call__(self, *, round_no, focus, sides, history):  # noqa: ANN001
        self.calls.append({"round_no": round_no, "focus": focus, "history_len": len(history)})
        return [
            SideTurn(
                side_key=s.key,
                side_name=s.name,
                run_id=f"{s.key}_r{round_no}",
                content=f"{s.name}就「{focus}」的第{round_no}轮发言",
                ok=not self.fail_all,
            )
            for s in sides
        ]


def _two_sides():
    return [
        DebateSide(key="pro", name="正方", stance="支持做 X"),
        DebateSide(key="con", name="反方", stance="反对做 X"),
    ]


def _config(*, form=DebateForm.DEBATE, policy=None, sides=None):
    return DebateConfig(
        motion="该不该做 X",
        form=form,
        sides=sides or _two_sides(),
        policy=policy or RoundPolicy(max_rounds=5),
    )


def _run(llm, runner, config):
    return asyncio.run(Moderator(provider=llm, model="m").run(config, run_round=runner))


# --- 收敛 / 轮次治理 ---------------------------------------------------------


def test_for_form_thorough_false_is_single_round_for_all_forms():
    """thorough=False 对所有形态（含圆桌）都降为快速单轮（max=1）——「测试/简单看看」不被强制多轮。

    回归：旧实现圆桌恒多轮、忽略 thorough，trivial 命题也跑满多轮、产出冗余「修订 v2」。
    thorough=True 时形态默认仅【安全上限】各异（圆桌 4、正反/红队 5）；轮数由主持人逐轮自判收敛。
    """
    for form in (DebateForm.DEBATE, DebateForm.RED_TEAM, DebateForm.ROUNDTABLE):
        quick = RoundPolicy.for_form(form, thorough=False)
        assert (quick.thorough, quick.max_rounds) == (False, 1), form
    assert RoundPolicy.for_form(DebateForm.ROUNDTABLE).max_rounds == 4
    assert RoundPolicy.for_form(DebateForm.DEBATE).max_rounds == 5
    assert RoundPolicy.for_form(DebateForm.DEBATE).thorough is True


def test_node_summary_is_rounds_and_stop_label():
    """主持人节点预览 = 「N 轮 · 收敛归因」（复用 stop_reason 词表），取代旧的 brief.crux 近空预览。"""

    def _result(rounds_n: int, stop_reason: str) -> DebateResult:
        verdict = JudgeVerdict(real_clash=True, new_arguments=False, converged=True)
        rounds = [
            RoundResult(i, f"焦点{i}", [], verdict, summary=f"小结{i}")
            for i in range(1, rounds_n + 1)
        ]
        return DebateResult(
            config=_config(),
            rounds=rounds,
            brief=DebateBrief(crux="争议焦点"),
            stop_reason=stop_reason,
        )

    assert _result(2, STOP_CONVERGED).node_summary == "2 轮 · 已收敛"
    assert _result(3, STOP_FOCUS_CLARIFIED).node_summary == "3 轮 · 焦点已澄清为价值之争"
    assert _result(5, STOP_MAX_ROUNDS).node_summary == "5 轮 · 达轮数上限"


def test_frame_followup_injects_covered_focuses_and_orthogonality():
    """后续轮定焦点：注入【全部历史轮】已覆盖焦点清单 + 强制正交，降「换汤不换药」冗余轮。"""
    captured: list = []

    class _CaptureLLM:
        async def complete(self, request):  # noqa: ANN001
            captured.append(request)
            return LLMResponse(content=json.dumps({"focus": "新焦点"}))

    mod = Moderator(provider=_CaptureLLM(), model="m")
    verdict = JudgeVerdict(real_clash=True, new_arguments=True, converged=False)
    history = [
        RoundResult(1, "焦点甲", [], verdict, summary="一轮小结"),
        RoundResult(2, "焦点乙", [], verdict, summary="二轮小结"),
    ]
    focus = asyncio.run(mod._frame(_config(), history))

    assert focus == "新焦点"
    prompt = captured[-1].messages[-1].content
    assert "已覆盖焦点" in prompt and "正交" in prompt
    # 全部历史轮的焦点都在清单里（非仅上一轮），主持人才能挑一个正交于整场的新维度。
    assert "焦点甲" in prompt and "焦点乙" in prompt


def test_judge_gate_hint_round1_continue_and_quick_converge():
    """「别过早收敛」内化进裁判标准：多轮模式第 1 轮默认继续（除非命题空泛）；快速单轮则一次即收。"""
    captured: list = []

    class _CaptureLLM:
        async def complete(self, request):  # noqa: ANN001
            captured.append(request)
            return LLMResponse(content=json.dumps(_KEEP_GOING))

    mod = Moderator(provider=_CaptureLLM(), model="m")
    turns = [
        SideTurn("pro", "正方", "r1_pro", "正方开场"),
        SideTurn("con", "反方", "r1_con", "反方开场"),
    ]
    # 多轮模式第 1 轮：默认继续、仅命题空泛才收（楼层智慧搬进了 prompt）。
    asyncio.run(mod._judge(_config(policy=RoundPolicy(max_rounds=5)), "焦点", turns, []))
    multi = captured[-1].messages[-1].content
    assert "第 1 轮" in multi and "默认" in multi and "继续" in multi and "空泛" in multi
    # 快速单轮（max=1）：一次对碰即判收敛（避免错误兜底成 达轮数上限）。
    asyncio.run(mod._judge(_config(policy=RoundPolicy.quick()), "焦点", turns, []))
    assert "快速单轮" in captured[-1].messages[-1].content


def test_judge_converged_stops_immediately_no_floor():
    """裁判第 1 轮即判收敛 → 立即收场（无最小轮门槛强制多轮）——收敛治理交给裁判逐轮自判。

    回归：旧实现有机械楼层（min_rounds），裁判首轮判收敛也被逼跑满 N 轮。现在拆掉楼层，
    「别过早收敛」内化进裁判标准（第 1 轮默认继续，由 _judge prompt 注入，假 LLM 不受其约束）。
    """
    llm = _ScriptedLLM(judge_results=[_CONVERGE])
    runner = _RecordingRunner()
    result = _run(llm, runner, _config(policy=RoundPolicy(max_rounds=5)))

    assert len(result.rounds) == 1
    assert len(runner.calls) == 1
    assert result.stop_reason == STOP_CONVERGED


def test_quick_single_round():
    """快速对碰（max=1）：第 1 轮收敛即收场。"""
    llm = _ScriptedLLM(judge_results=[_CONVERGE])
    runner = _RecordingRunner()
    result = _run(llm, runner, _config(policy=RoundPolicy.quick()))

    assert len(result.rounds) == 1
    assert result.stop_reason == STOP_CONVERGED


def test_runs_to_max_when_never_converges():
    """裁判持续不收敛 → 跑到安全上限兜底停，归因 max_rounds。"""
    llm = _ScriptedLLM(judge_results=[_KEEP_GOING])
    runner = _RecordingRunner()
    result = _run(llm, runner, _config(policy=RoundPolicy(max_rounds=4)))

    assert len(result.rounds) == 4
    assert result.stop_reason == STOP_MAX_ROUNDS


def test_converged_stop_reason_propagates():
    """裁判给的终止归因（focus_clarified）透传到结果（§五 终止条件）。"""
    verdict = {**_CONVERGE, "stop_reason": "focus_clarified"}
    llm = _ScriptedLLM(judge_results=[verdict])
    runner = _RecordingRunner()
    result = _run(llm, runner, _config(policy=RoundPolicy(max_rounds=5)))

    assert len(result.rounds) == 1
    assert result.stop_reason == STOP_FOCUS_CLARIFIED


# --- 跨轮记忆 / 容错 / 失败 --------------------------------------------------


def test_round_runner_receives_growing_history():
    """第 k 轮 run_round 应看到前 k-1 轮 —— 辩手跨轮带记忆的输入（§7.2）。"""
    llm = _ScriptedLLM(judge_results=[_KEEP_GOING])
    runner = _RecordingRunner()
    _run(llm, runner, _config(policy=RoundPolicy(max_rounds=3)))

    assert [c["history_len"] for c in runner.calls] == [0, 1, 2]


def test_judge_bad_json_is_conservative():
    """裁判输出坏 JSON → 保守判未收敛（宁可多辩一轮也不草草收场），跑到上限。"""
    llm = _ScriptedLLM(judge_content="嗯……我觉得还能再辩，但这里没有 JSON。")
    runner = _RecordingRunner()
    result = _run(llm, runner, _config(policy=RoundPolicy(max_rounds=3)))

    assert len(result.rounds) == 3
    assert result.stop_reason == STOP_MAX_ROUNDS
    assert result.rounds[0].verdict.converged is False


def test_all_failed_early_stop():
    """某轮全员发言失败 → 不调裁判、提前终止，归因 all_failed。"""
    llm = _ScriptedLLM()
    runner = _RecordingRunner(fail_all=True)
    result = _run(llm, runner, _config())

    assert len(result.rounds) == 1
    assert result.stop_reason == STOP_ALL_FAILED
    assert llm.judge_calls == 0  # 无可裁判内容，跳过裁判


# --- 双产物 / 呈现 -----------------------------------------------------------


def test_dual_products_present():
    """收场交付双产物：结论（决策简报字段齐全）+ 过程（每轮含小结 L1 与各方发言 L2/L3）。"""
    llm = _ScriptedLLM(judge_results=[_CONVERGE])
    runner = _RecordingRunner()
    result = _run(llm, runner, _config(policy=RoundPolicy(max_rounds=5)))

    # 结论产物
    assert result.brief.crux
    assert result.brief.strongest_points == {"pro": "正方最强论点", "con": "反方最强论点"}
    assert result.brief.factual_disputes and result.brief.value_disputes
    assert result.brief.recommendation
    # 过程产物（叙事线）
    assert all(r.summary for r in result.rounds)  # L1
    assert all(len(r.turns) == 2 for r in result.rounds)  # L2/L3
    assert all(t.content for r in result.rounds for t in r.turns)


def test_to_ceo_output_has_brief_and_narrative():
    """CEO 折算文本同时含决策简报与交锋叙事线（双产物都交回 CEO 收尾）。"""
    llm = _ScriptedLLM(judge_results=[_CONVERGE])
    runner = _RecordingRunner()
    result = _run(llm, runner, _config(policy=RoundPolicy(max_rounds=5)))
    out = result.to_ceo_output()

    assert "决策简报" in out
    assert "交锋叙事线" in out
    assert "争议焦点" in out
    assert "正方最强论点" in out


def test_roundtable_narrative_first():
    """探讨/学习类（圆桌）过程叙事线先行、简报收尾（§4.3 自适应呈现）。"""
    sides = [
        DebateSide(key="a", name="视角A", stance="A"),
        DebateSide(key="b", name="视角B", stance="B"),
        DebateSide(key="c", name="视角C", stance="C"),
    ]
    llm = _ScriptedLLM(judge_results=[_CONVERGE])
    runner = _RecordingRunner()
    result = _run(
        llm,
        runner,
        _config(
            form=DebateForm.ROUNDTABLE,
            sides=sides,
            policy=RoundPolicy(max_rounds=3),
        ),
    )
    out = result.to_ceo_output()

    assert result.narrative_first is True
    assert out.index("交锋叙事线") < out.index("决策简报")
    assert len(result.rounds[0].turns) == 3


# --- 逐轮增量回调（debate_round_started / debate_round 的注入点） -----------------


def test_round_hooks_order_start_before_speak_before_round():
    """逐轮增量回调注入点：每轮 on_round_start(发言【前】, 携本轮焦点) → 辩手发言 → on_round
    (裁判 + 小结【后】, 携完整 RoundResult)。DebateTool 据此 emit debate_round_started /
    debate_round，让前端进行中先亮焦点、再流式发言、收尾叠裁判小结。"""
    order: list[str] = []
    starts: list[tuple[int, str]] = []
    seen: list = []

    class _OrderRunner:
        def __init__(self) -> None:
            self.calls: list[dict] = []

        async def __call__(self, *, round_no, focus, sides, history):  # noqa: ANN001
            order.append(f"speak{round_no}")
            self.calls.append({"round_no": round_no, "focus": focus})
            return [
                SideTurn(
                    side_key=s.key,
                    side_name=s.name,
                    run_id=f"{s.key}_r{round_no}",
                    content=f"{s.name} r{round_no}",
                    ok=True,
                )
                for s in sides
            ]

    runner = _OrderRunner()

    async def on_start(round_no, focus):  # noqa: ANN001
        order.append(f"start{round_no}")
        starts.append((round_no, focus))

    async def on_round(rr):  # noqa: ANN001
        order.append(f"round{rr.round_no}")
        seen.append(rr)

    # 裁判持续不收敛（无楼层强制多轮了）→ 跑到 max_rounds=2 兜底，拿到稳定的 2 轮做钩子序断言。
    llm = _ScriptedLLM(judge_results=[_KEEP_GOING])
    config = _config(policy=RoundPolicy(max_rounds=2))
    asyncio.run(
        Moderator(provider=llm, model="m").run(
            config, run_round=runner, on_round_start=on_start, on_round=on_round
        )
    )

    # 2 轮，每轮严格 start → speak → round（焦点先于发言，裁判小结后于发言）。
    assert order == ["start1", "speak1", "round1", "start2", "speak2", "round2"]
    # on_round_start 携本轮焦点，与 run_round 收到的一致（同一焦点先报后用）。
    assert [s[0] for s in starts] == [1, 2]
    assert starts[0][1] == runner.calls[0]["focus"]
    # on_round 携完整 RoundResult（含小结，可直接折算事件 payload）。
    assert all(r.summary for r in seen)
    assert seen[0].to_event_payload()["round_no"] == 1


def test_round_to_event_payload_matches_result_round_unit():
    """RoundResult.to_event_payload 是 debate_round 事件与 debate_result.rounds 的【同源】逐轮
    单元：round_no/focus/summary/verdict/各方→辩手 run_id，且与收场全量 payload 的该轮逐字一致。"""
    llm = _ScriptedLLM(judge_results=[_CONVERGE])
    runner = _RecordingRunner()
    result = _run(llm, runner, _config(policy=RoundPolicy(max_rounds=1)))
    payload = result.rounds[0].to_event_payload()

    assert payload["round_no"] == 1
    assert payload["focus"]
    assert set(payload["verdict"]) == {
        "real_clash",
        "new_arguments",
        "converged",
        "stop_reason",
        "rationale",
    }
    assert [s["run_id"] for s in payload["sides"]] == ["pro_r1", "con_r1"]
    # 收场全量 payload 的逐轮单元由同一方法产出 → 必逐字相等（单一源，防漂移）。
    assert result.to_event_payload()["rounds"][0] == payload
