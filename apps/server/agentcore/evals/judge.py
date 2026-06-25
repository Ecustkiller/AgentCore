"""LLM 裁判（后端架构.md §五：L1 结果评分主轴 + 多 Agent 诊断成对裁判）.

本文件容纳两类裁判，共用一个 :class:`~agentcore.llm.protocol.LLMProvider`：

- :class:`LLMJudge`（绝对分裁判，**L1 结果评分主轴**）：按 rubric 给 1–5 分、pass = 均分 ≥
  阈值。CoT（先理由后分）+ 反长度偏差系统提示提升与人对齐；``samples>1`` 多采样取均分压裁判
  方差（思考模型不吃 temperature，靠重采样降噪）。这是新评测体系判「任务是否成功」的主轴。
- :class:`LLMPairwiseJudge`（成对偏好裁判，多 Agent 对比**诊断**用）：判「主臂 vs 基准臂」哪个
  更好——盲评 + 位置对调（A/B 换序各判一次，仅当两序一致才计胜，抵消位置偏见）+ 坏 JSON 容错。

判定本身仍走 ``provider.complete``；单测注入返回固定 JSON 的假 provider，零成本验证解析 /
位置对调合议 / 容错（见 tests/test_evals_comparison.py），真模型留给 nightly。裁判可信工程
（gold-set + Cohen's kappa 校准、kappa>门 才准上 baseline 门）已落在 ``calibration.py``
（重设计 §五）；本裁判须先过那里的校准门，其 pass_rate 才可信地用于 baseline 回归门。
"""

from __future__ import annotations

import json

from agentcore.evals.types import (
    EvalCase,
    JudgeVerdict,
    MilestoneItemResult,
    MilestoneVerdict,
    PairwiseVerdict,
    TurnOutcome,
)
from agentcore.llm.protocol import LLMMessage, LLMProvider, LLMRequest

# --- L1 结果评分主轴：绝对分裁判 ---------------------------------------------

_ABSOLUTE_SYSTEM_PROMPT = (
    "你是严格的质量评审。给定一个任务、评分准则（rubric）和一份答案，按准则给 1–5 分。\n"
    "评分锚点：1=完全没满足/跑题或编造；2=大体没满足；3=部分满足、有明显缺漏；"
    "4=基本满足准则；5=完全满足且无明显问题。\n"
    "重要原则：简洁正确优于冗长堆砌——绝不因答案更长、更详细、语气更自信就给高分；"
    "惩罚注水、冗余、重复；只看是否真正满足准则。\n"
    "先写一句简短理由，再给分。只输出 JSON，不要其他文字：\n"
    '{"score": <1-5 整数>, "rationale": "简短理由"}'
)


def _parse_score(content: str) -> tuple[float, str]:
    """从裁判输出抽 ``(score∈[0,5], rationale)``；非法 JSON 容错为 0 分（判负）。"""
    try:
        start = content.index("{")
        end = content.rindex("}")
        data = json.loads(content[start : end + 1])
    except (ValueError, json.JSONDecodeError):
        return 0.0, f"裁判输出无法解析为 JSON: {content[:120]!r}"
    try:
        score = float(data.get("score", 0))
    except (TypeError, ValueError):
        score = 0.0
    score = max(0.0, min(5.0, score))
    return score, str(data.get("rationale", ""))


class LLMJudge:
    """绝对分裁判（实现 :class:`~agentcore.evals.types.Judge` 协议）—— L1 结果评分主轴。

    按 ``case.rubric`` 给被评答案 1–5 分，``passed = 均分 ≥ pass_threshold``（pass 阈值留在代码
    里、可审计可调，不让模型自报 pass）。``samples>1`` 时多采样取均分压裁判方差（思考模型不吃
    temperature，靠重采样降噪）。``provider`` 注入便于单测（脚本化假 provider 返回固定 JSON）。
    """

    def __init__(
        self,
        provider: LLMProvider,
        model: str,
        *,
        pass_threshold: float = 4.0,
        samples: int = 1,
        scenario: str = "eval.judge.absolute",
    ) -> None:
        self._provider = provider
        self._model = model
        self._pass_threshold = pass_threshold
        self._samples = max(1, samples)
        self._scenario = scenario

    async def _one(self, rubric: str, user_message: str, answer: str) -> tuple[float, str]:
        user = (
            f"【评分准则】\n{rubric}\n\n"
            f"【任务】\n{user_message}\n\n"
            f"【答案】\n{answer}\n\n"
            "请只输出 JSON。"
        )
        request = LLMRequest(
            messages=[
                LLMMessage(role="system", content=_ABSOLUTE_SYSTEM_PROMPT),
                LLMMessage(role="user", content=user),
            ],
            model=self._model,
            temperature=0.0,
            stream=False,
            thinking=True,
            scenario=self._scenario,
        )
        response = await self._provider.complete(request)
        return _parse_score(response.content or "")

    async def score(self, case: EvalCase, outcome: TurnOutcome) -> JudgeVerdict:
        scores: list[float] = []
        rationales: list[str] = []
        for _ in range(self._samples):
            s, r = await self._one(case.rubric or "", case.user_message, outcome.content or "")
            scores.append(s)
            rationales.append(r)
        avg = sum(scores) / len(scores) if scores else 0.0
        passed = avg >= self._pass_threshold
        if len(rationales) == 1:
            rationale = rationales[0]
        else:
            rationale = f"均分 {avg:.1f}/5（{len(scores)} 采样）：" + " || ".join(rationales)
        return JudgeVerdict(score=round(avg, 2), passed=passed, rationale=rationale)


def _eval_provider_and_model(mode: str) -> tuple[LLMProvider, str]:
    """构造接真实 DeepSeek 的裁判 (provider, model)：默认 Pro 档（Pro 评 Flash，压同家族自偏好）。

    裁判模型优先读 ``EVAL_JUDGE_MODEL``，否则回落 ``mode`` 档（默认 quality → Pro）的 chat 档；
    凭据复用 harness 的 eval 专用 key。绝对分裁判与 milestone 裁判共用本解析，避免「同一根因改两
    处」。函数内惰性 import 重依赖，保持本模块对 runtime/factory 零顶层耦合。
    """
    import os

    from agentcore.evals.harness import _EVAL_CEILING, _eval_credentials
    from agentcore.llm.factory import build_provider
    from agentcore.llm.modes import resolve_profile_set

    provider = build_provider(_eval_credentials())
    model = os.environ.get("EVAL_JUDGE_MODEL", "").strip()
    if not model:
        profiles = resolve_profile_set(mode, custom_modes={}, ceiling=_EVAL_CEILING)
        model = profiles.get("chat").model
    return provider, model


def build_default_judge(mode: str = "quality") -> LLMJudge:
    """构造接真实 DeepSeek 的绝对分裁判（Pro 评 Flash）。仅 CLI/nightly 真跑调用——单测注入假
    provider。模型/凭据解析见 :func:`_eval_provider_and_model`。"""
    provider, model = _eval_provider_and_model(mode)
    return LLMJudge(provider, model)


# --- L1 结果评分主轴：milestone 覆盖裁判 -------------------------------------

_MILESTONE_SYSTEM_PROMPT = (
    "你是严格的交付物评审。给定一个任务、一组『子目标(milestone)』和一份答案，逐条判断答案是否"
    "**确实覆盖**了每个子目标——只看交付内容，不看过程、不看谁写的、不看走了什么流程。\n"
    "判定原则：真正满足才算覆盖；含糊带过、跑题、编造均不算覆盖；简洁正确优于冗长堆砌，绝不因"
    "答案更长更详细就判覆盖。\n"
    "对给定的每个 id 都要给出 true/false。只输出 JSON，不要其他文字：\n"
    '{"items": [{"id": "<子目标id>", "covered": true}], "rationale": "简短整体理由"}'
)


def _parse_milestones(content: str, valid_ids: set[str]) -> tuple[dict[str, bool], str]:
    """从裁判输出抽 ``({id: covered}, rationale)``；非法 JSON → 空 dict（逐项保守按未覆盖计）。

    只采纳 ``valid_ids`` 内的 id（裁判幻觉出的多余 id 直接忽略），漏判的 id 由调用方按未覆盖兜底。
    """
    try:
        start = content.index("{")
        end = content.rindex("}")
        data = json.loads(content[start : end + 1])
    except (ValueError, json.JSONDecodeError):
        return {}, f"裁判输出无法解析为 JSON: {content[:120]!r}"
    covered: dict[str, bool] = {}
    for item in data.get("items", []) or []:
        if isinstance(item, dict) and str(item.get("id")) in valid_ids:
            covered[str(item["id"])] = bool(item.get("covered", False))
    return covered, str(data.get("rationale", ""))


class LLMMilestoneJudge:
    """milestone 覆盖裁判（实现 :class:`~agentcore.evals.types.MilestoneJudge` 协议）.

    一次调用让裁判对 ``case.milestones`` 逐条判 covered 布尔；覆盖率 = **加权命中比**，
    ``passed = 覆盖率 >= case.milestone_threshold``。漏判 / 解析失败的子目标**保守按未覆盖**计
    （绝不无据放过——这是结果断言，宁可判负也不放水）。``provider`` 注入便于单测。
    """

    def __init__(
        self,
        provider: LLMProvider,
        model: str,
        *,
        scenario: str = "eval.judge.milestone",
    ) -> None:
        self._provider = provider
        self._model = model
        self._scenario = scenario

    async def score_milestones(self, case: EvalCase, outcome: TurnOutcome) -> MilestoneVerdict:
        milestones = case.milestones or []
        threshold = case.milestone_threshold
        if not milestones:
            return MilestoneVerdict(1.0, True, threshold, [], "无 milestone（平凡通过）")

        listing = "\n".join(
            f"- [{m['id']}] {m.get('desc', '')}（权重 {m.get('weight', 1)}）" for m in milestones
        )
        user = (
            f"【任务】\n{case.user_message}\n\n"
            f"【子目标清单】\n{listing}\n\n"
            f"【答案】\n{outcome.content or ''}\n\n"
            "请逐条判定每个子目标是否被覆盖，只输出 JSON。"
        )
        request = LLMRequest(
            messages=[
                LLMMessage(role="system", content=_MILESTONE_SYSTEM_PROMPT),
                LLMMessage(role="user", content=user),
            ],
            model=self._model,
            temperature=0.0,
            stream=False,
            thinking=True,
            scenario=self._scenario,
        )
        response = await self._provider.complete(request)
        valid_ids = {str(m["id"]) for m in milestones}
        covered_map, rationale = _parse_milestones(response.content or "", valid_ids)

        items: list[MilestoneItemResult] = []
        total_w = 0.0
        hit_w = 0.0
        for m in milestones:
            mid = str(m["id"])
            try:
                weight = float(m.get("weight", 1) or 1)
            except (TypeError, ValueError):
                weight = 1.0
            covered = covered_map.get(mid, False)
            total_w += weight
            if covered:
                hit_w += weight
            items.append(
                MilestoneItemResult(
                    id=mid, desc=str(m.get("desc", "")), weight=weight, covered=covered
                )
            )
        coverage = hit_w / total_w if total_w else 0.0
        return MilestoneVerdict(
            coverage=round(coverage, 4),
            passed=coverage >= threshold,
            threshold=threshold,
            items=items,
            rationale=rationale,
        )


def build_default_milestone_judge(mode: str = "quality") -> LLMMilestoneJudge:
    """构造接真实 DeepSeek 的 milestone 覆盖裁判（Pro 评 Flash）。模型/凭据解析见
    :func:`_eval_provider_and_model`（与绝对分裁判同源）。仅 CLI/nightly 真跑调用。"""
    provider, model = _eval_provider_and_model(mode)
    return LLMMilestoneJudge(provider, model)


_SYSTEM_PROMPT = (
    "你是严格的成对评审。给定一个任务和两份答案（答案X、答案Y），依据评分准则判断哪份更好。\n"
    "重要原则：简洁正确优于冗长堆砌；不要因为答案更长、更啰嗦就偏向它；只看是否真正满足准则。\n"
    "先给一句简短理由，再给结论。只输出 JSON，不要其他文字：\n"
    '{"winner": "X" | "Y" | "tie", "rationale": "简短理由", "margin": 0}\n'
    "其中 margin 是优势强度 0–3（0=几乎打平，3=明显更好）。"
)


def _parse_pairwise(content: str) -> tuple[str, str, int]:
    """从裁判输出抽 ``(winner∈{X,Y,tie}, rationale, margin)``；非法 JSON 容错为 tie。"""
    try:
        start = content.index("{")
        end = content.rindex("}")
        data = json.loads(content[start : end + 1])
    except (ValueError, json.JSONDecodeError):
        return "tie", f"裁判输出无法解析为 JSON: {content[:120]!r}", 0
    raw = str(data.get("winner", "")).strip().upper()
    winner = "X" if raw == "X" else "Y" if raw == "Y" else "tie"
    rationale = str(data.get("rationale", ""))
    try:
        margin = max(0, min(3, int(data.get("margin", 0))))
    except (TypeError, ValueError):
        margin = 0
    return winner, rationale, margin


class LLMPairwiseJudge:
    """成对偏好裁判（实现 :class:`~agentcore.evals.types.PairwiseJudge` 协议）。

    ``swap=True`` 时对每对答案正反各判一次，**仅当两序判给同一臂才计该臂胜**，否则记 tie
    ——这把「位置偏见」（裁判总偏向某个位置）直接抵消掉。``provider`` 注入便于单测。
    """

    def __init__(
        self,
        provider: LLMProvider,
        model: str,
        *,
        swap: bool = True,
        scenario: str = "eval.judge.pairwise",
    ) -> None:
        self._provider = provider
        self._model = model
        self._swap = swap
        self._scenario = scenario

    async def _one(self, rubric: str, user_message: str, x: str, y: str) -> tuple[str, str, int]:
        """单方向判一次（X / Y 为位置标签，与臂无关）。"""
        user = (
            f"【评分准则】\n{rubric}\n\n"
            f"【任务】\n{user_message}\n\n"
            f"【答案X】\n{x}\n\n"
            f"【答案Y】\n{y}\n\n"
            "请只输出 JSON。"
        )
        request = LLMRequest(
            messages=[
                LLMMessage(role="system", content=_SYSTEM_PROMPT),
                LLMMessage(role="user", content=user),
            ],
            model=self._model,
            temperature=0.0,
            stream=False,
            thinking=True,
            scenario=self._scenario,
        )
        response = await self._provider.complete(request)
        return _parse_pairwise(response.content or "")

    async def compare(
        self,
        *,
        rubric: str,
        user_message: str,
        subject_arm: str,
        subject_content: str,
        baseline_arm: str,
        baseline_content: str,
    ) -> PairwiseVerdict:
        # 正序：X=主臂、Y=基准臂
        w1, r1, m1 = await self._one(rubric, user_message, subject_content, baseline_content)
        if not self._swap:
            winner = subject_arm if w1 == "X" else baseline_arm if w1 == "Y" else "tie"
            return PairwiseVerdict(winner=winner, rationale=r1, margin=m1)

        # 反序：X=基准臂、Y=主臂
        w2, r2, m2 = await self._one(rubric, user_message, baseline_content, subject_content)
        a1 = subject_arm if w1 == "X" else baseline_arm if w1 == "Y" else "tie"
        a2 = baseline_arm if w2 == "X" else subject_arm if w2 == "Y" else "tie"

        # 仅当两序判给同一臂才计胜，否则（含位置翻转 / 任一 tie）记 tie
        winner = a1 if (a1 != "tie" and a1 == a2) else "tie"
        rationale = f"[正序] {r1} || [反序] {r2}"
        return PairwiseVerdict(winner=winner, rationale=rationale, margin=max(m1, m2))
