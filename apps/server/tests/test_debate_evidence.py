"""举证责任·证据状态铁律（P3，辩论编排设计.md §4-2.3 契约②）自测（per-PR 零 LLM）。

方案 A（内联标记）的验收面是【prompt 契约】：辩手被要求给关键事实主张标 `【已核实·出处】`/
`【待核实·推断】`，主持人质询盯 `待核实` 当决定性论据、裁判据标记记分与罚分（诚实标注不罚、
硬拗成事实才罚）。这些是喂给 LLM 的 prompt 里必须在场的约束——记分质量本身需真模型/eval 验，
但「约束是否注入」是可无 LLM 断言的契约。真模型留给 nightly；这里直接调纯函数 + 脚本化假 provider。
"""

import asyncio
import json

from agentcore.llm.provider.protocol import LLMResponse
from agentcore.runtime.debate import (
    DebateBrief,
    DebateConfig,
    DebateForm,
    DebateHandoff,
    DebateResult,
    DebateSide,
    JudgeVerdict,
    Moderator,
    RoundPolicy,
    RoundResult,
    SideTurn,
    normalize_handoff_kind,
)
from agentcore.runtime.debate.moderator import (
    _ASSESS_SYSTEM,
    _BRIEF_SYSTEM,
    _CROSS_EXAM_SYSTEM,
)
from agentcore.runtime.debate.moderator_brief import _as_handoffs
from agentcore.runtime.debate.prompt import (
    ARGUMENT_SKELETON_RULE,
    EVIDENCE_NOTES_SPEC,
    EVIDENCE_RULE,
    NO_PREAMBLE_RULE,
    SEARCH_QUERY_RULE,
    closing_task,
    cx_answer_feedback,
    cx_draft_brief,
    debater_task,
    draft_system,
    opening_draft_brief,
    round_draft_brief,
    round_feedback,
    side_system,
)

# --- 共用夹具 ---------------------------------------------------------------


def _two_sides() -> list[DebateSide]:
    return [
        DebateSide(key="pro", name="正方", stance="支持做 X"),
        DebateSide(key="con", name="反方", stance="反对做 X"),
    ]


def _config(*, thorough: bool = True) -> DebateConfig:
    return DebateConfig(
        motion="该不该做 X",
        form=DebateForm.DEBATE,
        sides=_two_sides(),
        policy=RoundPolicy(thorough=thorough, max_rounds=5),
    )


def _turns() -> list[SideTurn]:
    return [
        SideTurn(side_key="pro", side_name="正方", run_id="r_pro", content="正方立论。"),
        SideTurn(side_key="con", side_name="反方", run_id="r_con", content="反方立论。"),
    ]


def _last_round() -> RoundResult:
    return RoundResult(
        round_no=1,
        focus="成本是否可控",
        turns=_turns(),
        verdict=JudgeVerdict(real_clash=True, new_arguments=True, converged=False),
        summary="上一轮小结。",
    )


class _CaptureLLM:
    """记录每次 complete 请求、回固定 JSON——供断言 prompt 里注入了什么约束。"""

    def __init__(self) -> None:
        self.requests: list = []

    async def complete(self, request):  # noqa: ANN001
        self.requests.append(request)
        return LLMResponse(content=json.dumps({}))


# --- 辩手侧：证据状态铁律进系统提示、立论/续论/质询作答有提醒 -----------------


def test_side_system_carries_evidence_burden_rule():
    """证据状态铁律进【系统提示】（continue_run 全程生效）：含两种标记 + 举证责任 + 诚实不罚。"""
    text = side_system(_config(), _two_sides()[0])
    assert "举证责任" in text
    assert "【已核实" in text and "【待核实" in text
    # 诚实存疑不罚、硬拗才罚——铁律的核心平衡（否则辩手会因怕扣分而不敢标待核实）。
    assert "诚实标注待核实" in text or "诚实标注待核实【不扣分】" in text


def test_evidence_rule_constant_is_the_single_source():
    """side_system 的证据段来自共享常量 EVIDENCE_RULE（口径单一、防漂移）。"""
    assert EVIDENCE_RULE in side_system(_config(), _two_sides()[0])


def test_side_system_carries_search_query_rule():
    """查询构造铁律进【系统提示】（会话 7e1baca0 复盘 §1.6）：短查询 + 空结果删词重搜。

    治的是「辩手把 web_search 写成 6–8 词长句 → 健康引擎也返 0 结果 → 回落无法核实」。断言约束
    在场（是否注入是可无 LLM 验的 prompt 契约；命中率本身留 evals/nightly）。"""
    text = side_system(_config(), _two_sides()[0])
    assert SEARCH_QUERY_RULE in text  # 来自共享常量、口径单一
    assert "2–4 个核心词" in text  # 短查询铁律
    assert "空结果" in text and "再搜一次" in text  # 空→删词重搜，别当「不存在」


def test_side_system_omits_preamble_and_skeleton():
    """检索侧 side_system 不含前言/骨架（二者迁入成稿 draft_system）。"""
    text = side_system(_config(), _two_sides()[0])
    assert NO_PREAMBLE_RULE not in text
    assert ARGUMENT_SKELETON_RULE not in text
    assert EVIDENCE_RULE in text and SEARCH_QUERY_RULE in text


def test_draft_system_carries_no_preamble_and_opening_skeleton():
    """成稿 draft_system：全 beat 禁前言；立论/续辩另挂论点骨架。"""
    cfg, side = _config(), _two_sides()[0]
    opening = draft_system(cfg, side, beat="opening")
    cont = draft_system(cfg, side, beat="continue")
    cx = draft_system(cfg, side, beat="cross_exam")
    closing = draft_system(cfg, side, beat="closing")
    assert NO_PREAMBLE_RULE in opening
    assert ARGUMENT_SKELETON_RULE in opening
    assert ARGUMENT_SKELETON_RULE in cont
    assert ARGUMENT_SKELETON_RULE not in cx
    assert ARGUMENT_SKELETON_RULE not in closing
    assert "### 质询一" in NO_PREAMBLE_RULE


def test_research_tasks_ask_for_evidence_notes_not_speech():
    """检索阶段交付物 = 证据笔记；成稿 brief 才是发言任务。"""
    cfg, sides = _config(), _two_sides()
    task_payload = debater_task(cfg, sides[0], 0, round_no=1, focus="成本")
    assert task_payload["research_then_draft"] is True
    assert EVIDENCE_NOTES_SPEC in task_payload["task"]
    assert ARGUMENT_SKELETON_RULE not in task_payload["task"]
    assert ARGUMENT_SKELETON_RULE in task_payload["draft_system"]
    assert "开场立论" in task_payload["draft_brief"] or "立论" in task_payload["draft_brief"]

    fb = round_feedback(cfg, sides[0], 2, "风险", _last_round())
    assert EVIDENCE_NOTES_SPEC in fb
    assert ARGUMENT_SKELETON_RULE not in fb
    brief = round_draft_brief(cfg, sides[0], 2, "风险", _last_round())
    assert "完整发言" in brief
    assert EVIDENCE_NOTES_SPEC not in brief


def test_debater_task_and_round_feedback_carry_argument_skeleton():
    """论点骨架只进立论/续辩成稿 draft_system；质询/结辩不套立论骨架。"""
    cfg, sides = _config(), _two_sides()
    assert "### " in ARGUMENT_SKELETON_RULE
    assert "X方立论" in ARGUMENT_SKELETON_RULE or "开场立论" in ARGUMENT_SKELETON_RULE
    assert ARGUMENT_SKELETON_RULE in draft_system(cfg, sides[0], beat="opening")
    assert ARGUMENT_SKELETON_RULE in draft_system(cfg, sides[0], beat="continue")

    cx = cx_answer_feedback(cfg, sides[0], 1, "成本", ["出处？"])
    closing = closing_task(cfg, sides[0])
    assert ARGUMENT_SKELETON_RULE not in cx
    assert ARGUMENT_SKELETON_RULE not in closing
    assert ARGUMENT_SKELETON_RULE not in draft_system(cfg, sides[0], beat="cross_exam")
    assert ARGUMENT_SKELETON_RULE not in draft_system(cfg, sides[0], beat="closing")


def test_debater_task_reminds_evidence_markers():
    """首轮立论 task 提醒按证据状态标注（系统提示扛全量、task 只轻提醒）。"""
    task = debater_task(_config(), _two_sides()[0], 0, round_no=1, focus="成本")["task"]
    assert "【已核实" in task and "【待核实" in task


def test_round_feedback_reminds_evidence_markers():
    """后续轮续论 feedback 同样提醒证据状态标注。"""
    fb = round_feedback(_config(), _two_sides()[0], 2, "风险", _last_round())
    assert "【已核实" in fb and "【待核实" in fb


def test_cx_answer_feedback_uses_canonical_markers():
    """质询检索 feedback 要笔记；成稿 brief 要求 markdown 标题体 + 证据标记。"""
    cfg, side = _config(), _two_sides()[0]
    qs = ["你这条有出处吗？"]
    research = cx_answer_feedback(cfg, side, 1, "成本", qs)
    assert EVIDENCE_NOTES_SPEC in research
    assert "需要补证就查" in research
    assert "别反复空搜" in research
    assert "至多 1–2 次检索" not in research

    brief = cx_draft_brief(cfg, side, 1, "成本", qs)
    assert "【已核实" in brief and "【待核实" in brief
    assert "### 质询一" in brief
    assert "question_index" not in brief
    assert "JSON" not in brief or "不要输出 JSON" in brief
    assert "directly_addressed" not in brief
    assert "【证据状态铁律】" in brief


def test_opening_draft_brief_is_speech_not_notes():
    """首轮成稿 brief 是发言任务，不含证据笔记规格。"""
    brief = opening_draft_brief(_config(), _two_sides()[0], focus="成本")
    assert EVIDENCE_NOTES_SPEC not in brief
    assert "立论" in brief
    assert "【已核实" in brief


# --- 主持人侧：质询盯待核实、裁判据标记记分/罚且诚实不罚 ---------------------


def test_cross_exam_questions_prompt_targets_unverified_claims():
    """质询 prompt（system + user）都要求盯【待核实】当决定性论据 / 未标证据状态的主张追问。"""
    llm = _CaptureLLM()
    mod = Moderator(provider=llm, model="m")
    asyncio.run(mod._cross_exam_questions(_config(), "成本是否可控", _turns()))

    assert "举证责任" in _CROSS_EXAM_SYSTEM
    user = llm.requests[-1].messages[-1].content
    assert "待核实" in user  # 盯待核实当决定性论据
    assert "出处" in user


def test_cross_exam_questions_prompt_demands_distinct_targets():
    """源头质询去重：同一方多条质询须各打不同命门，不得换问法重复问同一点。"""
    llm = _CaptureLLM()
    mod = Moderator(provider=llm, model="m")
    asyncio.run(mod._cross_exam_questions(_config(), "成本是否可控", _turns()))

    user = llm.requests[-1].messages[-1].content
    assert "各打一个不同的命门" in user
    assert "重复问" in user


def test_judge_prompt_scores_evidence_by_markers_and_spares_honest_hedging():
    """裁判 prompt：evidence 据标记判、penalties 罚『无据硬拗』但【诚实标注待核实不罚】。"""
    llm = _CaptureLLM()
    mod = Moderator(provider=llm, model="m")
    asyncio.run(mod._judge_and_summarize(_config(), "成本是否可控", _turns(), []))

    # 系统词与 user 词都得带上「诚实标注待核实不罚」的平衡，否则辩手会因怕罚不敢诚实存疑。
    assert "待核实" in _ASSESS_SYSTEM
    user = llm.requests[-1].messages[-1].content
    assert "已核实" in user and "待核实" in user
    assert "诚实标注待核实" in user  # 只罚硬拗、不罚诚实存疑


def test_judge_prompt_still_penalizes_unsupported_when_passed_off_as_fact():
    """无据硬拗仍必罚——举证护栏不能因『诚实不罚』而放水到『无据也不罚』。"""
    llm = _CaptureLLM()
    mod = Moderator(provider=llm, model="m")
    asyncio.run(mod._judge_and_summarize(_config(), "成本是否可控", _turns(), []))
    user = llm.requests[-1].messages[-1].content
    assert "无据硬拗" in user or "硬拗" in user


# --- 决定性事实要一手来源（A）+ 结论继承置信标注（B）----------------------------
# 方案 A+B（辩论编排设计.md §4-2.2/§4-2.3·grounding）验收面同样是【prompt 契约】：记分对来源分级
# （一手/权威 vs 单一二手）、简报把【待核实/二手】证据状态继承进结论、CEO 收尾不得抹平保留语。
# 命中率本身留真模型/eval，这里只断言约束是否注入（可无 LLM）。


def _brief_user_prompt() -> str:
    """跑一次 _brief 并取回喂给 LLM 的 user prompt（假 provider 回 {} 触发降级、但请求已被捕获）。"""
    llm = _CaptureLLM()
    mod = Moderator(provider=llm, model="m")
    asyncio.run(mod._brief(_config(), [_last_round()]))
    return llm.requests[-1].messages[-1].content


def test_judge_prompt_grades_evidence_by_source_tier():
    """裁判 evidence 记分对【已核实】再分来源等级：一手/权威 = 强、决定性事实仅单一二手 = 封顶打低。"""
    llm = _CaptureLLM()
    mod = Moderator(provider=llm, model="m")
    asyncio.run(mod._judge_and_summarize(_config(), "成本是否可控", _turns(), []))
    user = llm.requests[-1].messages[-1].content
    assert "来源等级" in user
    assert "一手" in user and "二手来源" in user
    assert "决定性事实" in user  # 决定性事实靠单一二手来源要封顶
    assert "封顶打低" in user or "多源交叉印证" in user


def test_assess_system_carries_source_tier():
    """裁判系统提示带上来源等级维度（口径与 user 细则一致，别只在 user 单侧交代）。"""
    assert "来源等级" in _ASSESS_SYSTEM
    assert "二手来源" in _ASSESS_SYSTEM


def test_brief_prompt_inherits_evidence_status_into_conclusion():
    """简报 prompt：decisive/leaning 依赖的【待核实/仅二手】事实不得当既定，须降置信或移进分歧。"""
    user = _brief_user_prompt()
    assert "继承到结论" in user
    assert "需一手核实" in user
    assert "二手来源" in user  # 单一二手来源不当既定事实
    # 要么显式降级、要么移进交接清单（factual_disputes / open_questions；别在收尾抹平）。
    assert "factual_disputes" in user and "open_questions" in user
    assert "交接清单" in user or "value_disputes" in user


def test_brief_prompt_keeps_reversal_condition_after_grounding_insert():
    """插入 grounding 约束后，原有『反转条件』要求仍在场（不被覆盖回归）。"""
    user = _brief_user_prompt()
    assert "反转条件" in user


def test_brief_prompt_handoffs_questionify_value_and_length_discipline():
    """交接清单：value 问句化 + 影响结论；三键去水压成单句（对齐 strongest_points）。"""
    user = _brief_user_prompt()
    assert "问句" in user
    assert "你的选择如何影响结论" in user
    assert "去水压成单句" in user and "只留命门" in user
    assert "禁复合长句堆叠" in user
    # 判别铁律与证据状态内联仍在场（不被问句化覆盖回归）。
    assert "按解决路径互斥归类" in user
    assert "内联在条目文本" in user or "证据状态语内联" in user


def test_brief_prompt_field_mutex_and_length_discipline():
    """简报字段互斥 + 对抗形态字数纪律：禁互相复述 / 禁抄记分 / 单句上限。"""
    user = _brief_user_prompt()
    assert "字段互斥" in user and "互不复述" in user
    assert "单句≤50字" in user
    assert "≤60字" in user and "禁分号堆叠" in user
    assert "禁复述记分数字" in user or "禁】把记分数字" in user
    assert "下一步动作单句" in user and "不复述判断理由" in user
    assert "方向" in user  # 与累计记分仅方向一致，不是抄数字
    # crux 生成要求仍在场（其他消费方仍用）。
    assert '"crux"' in user and "争议焦点" in user


def test_brief_system_carries_grounding_principle():
    """简报系统提示带上『二手/待核实的决定性事实须保留证据状态、不抹成既定事实』。"""
    assert "既定事实" in _BRIEF_SYSTEM
    assert "二手来源" in _BRIEF_SYSTEM or "待核实" in _BRIEF_SYSTEM


def test_ceo_output_preserves_unverified_reservations():
    """CEO 收尾折算文本带【别抹平证据状态】铁律：转述【待核实/二手】关键事实须保留保留语。"""
    result = DebateResult(
        config=_config(),
        rounds=[_last_round()],
        brief=DebateBrief(crux="成本可控性"),
    )
    out = result.to_ceo_output()
    assert "待核实" in out
    assert "保留" in out
    assert "既定事实" in out


def test_as_handoffs_maps_three_keys_and_normalizes_bad_kind():
    """LLM 三键 → handoffs；坏 kind 归 question，不丢内容。"""
    items = _as_handoffs(
        {
            "value_disputes": ["更看重速度还是稳妥"],
            "factual_disputes": ["成本口径【待核实·推断】"],
            "open_questions": ["政策窗口会不会变"],
        }
    )
    assert [(h.kind, h.text) for h in items] == [
        ("value", "更看重速度还是稳妥"),
        ("fact", "成本口径【待核实·推断】"),
        ("question", "政策窗口会不会变"),
    ]
    assert normalize_handoff_kind("weird") == "question"
    assert normalize_handoff_kind("FACT") == "fact"
    bad = _as_handoffs({"handoffs": [{"kind": "mystery", "text": "仍要保留"}]})
    assert bad == [DebateHandoff(kind="question", text="仍要保留")]


def test_ceo_output_renders_handoffs_by_kind():
    """CEO 简报文本按三类交接清单分组渲染。"""
    result = DebateResult(
        config=_config(),
        rounds=[_last_round()],
        brief=DebateBrief(
            crux="成本",
            handoffs=[
                DebateHandoff(kind="value", text="速度优先？"),
                DebateHandoff(kind="fact", text="真实成本【待核实】"),
                DebateHandoff(kind="question", text="明年监管会不会收紧？"),
            ],
        ),
    )
    out = result.to_ceo_output()
    assert "需你定夺" in out and "速度优先？" in out
    assert "事实分歧" in out and "真实成本【待核实】" in out
    assert "待解问题" in out and "明年监管会不会收紧？" in out
    assert "仅剩需你拍板的点" not in out
