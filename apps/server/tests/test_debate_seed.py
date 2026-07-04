"""结构化补轮·B（可逆叫停）自测：续辩种子的宽容解析 + 播种效果（per-PR 零 LLM）。

覆盖 `辩论编排设计.md §6.6` 的播种链三段：
- :meth:`DebateSeed.from_payload` —— 从前端送来的 ``debate_result``-形载荷宽容解析（完整 / 最小
  投影同形；缺字段降级、无实质内容回 ``None`` = 不播种、逐字回退全新辩论）。
- :func:`seed_block` —— 首轮辩手「上一场摘要」块（喂事实摘要 + 本方最强论点 + 未决分歧；**刻意
  不喂 leaning**，且只喂【本方】最强论点不泄漏对方）。
- :meth:`Moderator._frame` —— 续辩首轮焦点正交于上一场已谈焦点（有种子才续辩，无则逐字不变）。

真模型留给 nightly；这里全用脚本化假 provider + 直接调纯函数。
"""

import asyncio
import json

from agentcore.llm.protocol import LLMResponse
from agentcore.runtime.debate import (
    DebateConfig,
    DebateForm,
    DebateSeed,
    DebateSeedRound,
    DebateSide,
    Moderator,
    RoundPolicy,
)
from agentcore.tools.builtin.debate.prompt import debater_task, seed_block

# --- 共用夹具 ---------------------------------------------------------------


def _two_sides() -> list[DebateSide]:
    return [
        DebateSide(key="pro", name="正方", stance="支持做 X"),
        DebateSide(key="con", name="反方", stance="反对做 X"),
    ]


def _config() -> DebateConfig:
    return DebateConfig(
        motion="该不该做 X",
        form=DebateForm.DEBATE,
        sides=_two_sides(),
        policy=RoundPolicy(max_rounds=5),
    )


def _full_payload() -> dict:
    """一份完整的 ``debate_result``-形载荷（前端投影的最小形与之同形，仅可缺字段）。"""
    return {
        "motion": "该不该做 X",
        "rounds": [
            {"round_no": 1, "focus": "成本是否可控", "summary": "正反就成本各执一词"},
            {"round_no": 2, "focus": "风险敞口多大", "summary": "反方点出长尾风险"},
        ],
        "brief": {
            "crux": "做 X 的核心权衡",
            "strongest_points": {"pro": "正方最强：先发优势", "con": "反方最强：不可逆风险"},
            "leaning": "基于事实反方略稳",
            "value_disputes": ["你更看重速度还是稳妥"],
            "open_questions": ["你的风险偏好是什么"],
        },
    }


# --- from_payload 宽容解析 --------------------------------------------------


def test_from_payload_parses_full_result_shape():
    seed = DebateSeed.from_payload(_full_payload())
    assert seed is not None
    assert seed.motion == "该不该做 X"
    assert seed.crux == "做 X 的核心权衡"
    assert seed.leaning == "基于事实反方略稳"
    assert seed.covered_focuses == ["成本是否可控", "风险敞口多大"]
    assert seed.strongest_points == {"pro": "正方最强：先发优势", "con": "反方最强：不可逆风险"}
    assert seed.value_disputes == ("你更看重速度还是稳妥",)
    assert seed.open_questions == ("你的风险偏好是什么",)
    assert seed.rounds[0] == DebateSeedRound(round_no=1, focus="成本是否可控", summary="正反就成本各执一词")


def test_from_payload_none_for_non_dict_or_empty():
    """非 dict / None / 空 dict / 无实质内容 → None（不播种，逐字回退全新辩论）。"""
    assert DebateSeed.from_payload(None) is None
    assert DebateSeed.from_payload([]) is None  # type: ignore[arg-type]
    assert DebateSeed.from_payload("nope") is None  # type: ignore[arg-type]
    assert DebateSeed.from_payload({}) is None
    # 只有 motion、没有任何轮次摘要 / 最强论点 / 未决分歧 ⇒ 不值得播种。
    assert DebateSeed.from_payload({"motion": "仅命题无内容"}) is None


def test_from_payload_degrades_on_bad_fields_never_raises():
    """字段类型不符 / 部分缺失逐项降级，绝不抛错中断辩论（只要有一项实质内容即成种）。"""
    seed = DebateSeed.from_payload(
        {
            "motion": 123,  # 非字符串 → 降为空
            "rounds": [
                "garbage",  # 非 dict → 跳过
                {"round_no": "x", "focus": "有焦点无轮号", "summary": ""},  # 坏 round_no → 0
                {"focus": "", "summary": ""},  # 焦点与小结皆空 → 跳过
            ],
            "brief": {
                "crux": 999,  # 非字符串 → 降为空
                # value_disputes / open_questions 读自 brief；混杂 → 仅留非空字符串。
                "value_disputes": ["真分歧", 7, ""],
            },
        }
    )
    assert seed is not None
    assert seed.motion == ""  # 非字符串 motion → 降空
    assert seed.crux == "" and seed.leaning == ""  # 非字符串 / 缺失 → 降空
    assert seed.covered_focuses == ["有焦点无轮号"]
    assert seed.rounds[0].round_no == 0  # 坏 round_no 容错为 0
    assert seed.value_disputes == ("真分歧",)  # _strs 过滤非字符串 / 空串


# --- seed_block 首轮辩手摘要块 ----------------------------------------------


def test_seed_block_none_is_empty():
    assert seed_block(None, _two_sides()[0]) == ""


def test_seed_block_includes_arc_mine_unresolved_and_excludes_leaning():
    seed = DebateSeed.from_payload(_full_payload())
    assert seed is not None
    pro = _two_sides()[0]
    block = seed_block(seed, pro)

    assert "续辩" in block
    assert "成本是否可控" in block and "风险敞口多大" in block  # 逐轮交锋弧
    assert "正方最强：先发优势" in block  # 本方最强论点
    assert "做 X 的核心权衡" in block  # 争议焦点
    assert "你更看重速度还是稳妥" in block and "你的风险偏好是什么" in block  # 未决分歧
    # leaning 是裁判口径，喂给辩手会污染中立性 → 刻意不进辩手摘要块。
    assert "基于事实反方略稳" not in block


def test_seed_block_only_leaks_own_strongest_point():
    """本方摘要块只含【本方】最强论点（按 side.key 取），不泄漏对方最强论点。"""
    seed = DebateSeed.from_payload(_full_payload())
    assert seed is not None
    con = _two_sides()[1]
    block = seed_block(seed, con)
    assert "反方最强：不可逆风险" in block
    assert "正方最强：先发优势" not in block


# --- debater_task 注入 ------------------------------------------------------


def test_debater_task_injects_seed_block_only_when_seeded():
    seed = DebateSeed.from_payload(_full_payload())
    assert seed is not None
    pro = _two_sides()[0]
    seeded = debater_task(_config(), pro, 0, round_no=1, focus="新维度", seed=seed)
    plain = debater_task(_config(), pro, 0, round_no=1, focus="新维度")

    assert "续辩" in seeded["task"] and "正方最强：先发优势" in seeded["task"]
    assert "续辩" not in plain["task"]  # 无种子 → 首轮 task 逐字回退全新辩论


# --- _frame 续辩首轮焦点正交 ------------------------------------------------


def test_frame_first_round_with_seed_demands_orthogonal_focus():
    """有种子 + 空 history（续辩首轮）→ frame prompt 标【续辩】、列已覆盖焦点、要求正交。"""
    captured: list = []

    class _CaptureLLM:
        async def complete(self, request):  # noqa: ANN001
            captured.append(request)
            return LLMResponse(content=json.dumps({"focus": "正交新焦点"}))

    mod = Moderator(provider=_CaptureLLM(), model="m")
    seed = DebateSeed.from_payload(_full_payload())
    focus, _ = asyncio.run(mod._frame(_config(), [], seed=seed))

    assert focus == "正交新焦点"
    prompt = captured[-1].messages[-1].content
    assert "续辩" in prompt and "正交" in prompt
    assert "成本是否可控" in prompt and "风险敞口多大" in prompt  # 已覆盖焦点全列出


def test_frame_first_round_without_seed_is_verbatim_fresh():
    """无种子（全新辩论）首轮 frame prompt 逐字不变——不含【续辩】，零行为变化。"""
    captured: list = []

    class _CaptureLLM:
        async def complete(self, request):  # noqa: ANN001
            captured.append(request)
            return LLMResponse(content=json.dumps({"focus": "开场焦点"}))

    mod = Moderator(provider=_CaptureLLM(), model="m")
    focus, _ = asyncio.run(mod._frame(_config(), []))

    assert focus == "开场焦点"
    prompt = captured[-1].messages[-1].content
    assert "续辩" not in prompt and "最核心争议焦点" in prompt


def test_frame_seed_without_round_focuses_falls_back_to_fresh():
    """种子有未决分歧但无逐轮焦点（covered_focuses 空）→ 首轮回退全新 frame（无可正交对象）。

    播种仍生效在辩手侧（seed_block 含未决分歧），但 frame 无已覆盖焦点可正交，故走全新开场。
    """
    captured: list = []

    class _CaptureLLM:
        async def complete(self, request):  # noqa: ANN001
            captured.append(request)
            return LLMResponse(content=json.dumps({"focus": "开场焦点"}))

    mod = Moderator(provider=_CaptureLLM(), model="m")
    seed = DebateSeed.from_payload(
        {"brief": {"value_disputes": ["仅有未决分歧、无逐轮焦点"]}}
    )
    assert seed is not None and seed.covered_focuses == []
    asyncio.run(mod._frame(_config(), [], seed=seed))
    assert "续辩" not in captured[-1].messages[-1].content
