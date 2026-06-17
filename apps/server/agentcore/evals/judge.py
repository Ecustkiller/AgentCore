"""LLM 裁判（对比评估 §六 / 评估体系 P1）.

本文件容纳两类裁判，共用一个 :class:`~agentcore.llm.protocol.LLMProvider`：

- :class:`LLMPairwiseJudge`（已落地，本文件）：**成对偏好**裁判，判「主臂 vs 基准臂」
  哪个更好——盲评（隐去谁是团队）+ 位置对调（A/B 顺序换一遍各判一次，仅当两序一致才
  计胜，抵消位置偏见）+ 坏 JSON 容错。现状见 ``docs/02-架构/后端架构.md`` §五。
- ``LLMJudge``（绝对分裁判，⏳ P1）：按 rubric 给 1–5 分，见
  ``docs/07-规划/远期规划.md`` §2.4 支一；落地后并入本文件。

判定本身仍走 ``provider.complete``；单测注入返回固定 JSON 的假 provider，零成本验证
解析 / 位置对调合议 / 容错（见 tests/test_evals_comparison.py），真模型留给 nightly。
"""

from __future__ import annotations

import json

from agentcore.evals.types import PairwiseVerdict
from agentcore.llm.protocol import LLMMessage, LLMProvider, LLMRequest

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
