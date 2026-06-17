"""对比评估 runner（团队 vs 单体）—— 见 docs/07-规划/评估体系后端落地设计.md 第二部分.

零侵入复用「功能评估」地基：为每个臂合成一个 :class:`EvalCase` 喂现有 :class:`EvalHarness`
（两条运行路径都已存在），再用 :class:`~agentcore.evals.types.PairwiseJudge` 成对裁判主臂
vs 基准臂，最后在「质量·成本·延迟」三轴上聚合，按 archetype 分段。

P0（本阶段）只做 ``single`` vs ``team`` 配对 + 成对裁判 + 三轴报告，全程可用假 provider /
假裁判跑通自测；``matched_single``（等算力单体 best-of-N）+ 预算对齐留给 P1。
"""

from __future__ import annotations

import json
import statistics
from pathlib import Path

from agentcore.core.logging import get_logger
from agentcore.evals.harness import EvalHarness
from agentcore.evals.judge import LLMPairwiseJudge
from agentcore.evals.runner import apply_checks
from agentcore.evals.seed_lint import lint_comparison_suite
from agentcore.evals.types import (
    ArmResult,
    ComparisonCase,
    ComparisonCaseReport,
    ComparisonReport,
    EvalCase,
    EvalConfigError,
    Harness,
    PairwiseJudge,
    PairwiseVerdict,
    TurnOutcome,
)

logger = get_logger(__name__)

_DEFAULT_CASES_DIR = Path(__file__).parent / "cases"

# 臂 → 运行路径。matched_single（P1，best-of-N 单体）仍走 single 路径，预算对齐由 P1 叠加。
_ARM_TO_PATH: dict[str, str] = {
    "single": "single",
    "team": "team",
    "matched_single": "single",
}

_COMPARISON_FIELDS = frozenset(
    {
        "id",
        "archetype",
        "user_message",
        "arms",
        "baseline_arm",
        "mode",
        "toolset",
        "workspace_fixture",
        "history",
        "checks",
        "rubric",
        "samples",
    }
)


# --- 加载 + 解析 -------------------------------------------------------------


def _parse_comparison_case(raw: dict) -> ComparisonCase:
    return ComparisonCase(**{k: v for k, v in raw.items() if k in _COMPARISON_FIELDS})


def load_comparison_cases(
    cases_dir: Path | str | None = None, suite: str = "comparison"
) -> list[ComparisonCase]:
    """加载 + lint + 解析对比套件（lint 不过即 raise，绝不带病开跑）。"""
    base = Path(cases_dir) if cases_dir else _DEFAULT_CASES_DIR
    suite_dir = base / suite
    if not suite_dir.is_dir():
        raise EvalConfigError(f"对比用例套件目录不存在: {suite_dir}")
    raws: list[dict] = []
    for path in sorted(suite_dir.glob("*.json")):
        loaded = json.loads(path.read_text(encoding="utf-8"))
        raws.extend(loaded if isinstance(loaded, list) else [loaded])
    if not raws:
        raise EvalConfigError(f"对比套件 {suite!r} 没有任何用例（{suite_dir}）")
    errors = lint_comparison_suite(raws)
    if errors:
        raise EvalConfigError("对比用例校验失败:\n  " + "\n  ".join(errors))
    return [_parse_comparison_case(r) for r in raws]


# --- 跑一道对比用例 ----------------------------------------------------------


def _arm_case(cc: ComparisonCase, arm: str) -> EvalCase:
    """把对比用例在某个臂上「投影」成一个普通 EvalCase（喂现有 harness）。"""
    path = _ARM_TO_PATH.get(arm, "single")
    return EvalCase(
        id=f"{cc.id}::{arm}",
        category="team" if path == "team" else "qa",
        user_message=cc.user_message,
        path=path,  # type: ignore[arg-type]
        mode=cc.mode,
        toolset=cc.toolset,
        workspace_fixture=cc.workspace_fixture,
        history=list(cc.history),
        checks=list(cc.checks.get(arm, [])),
        samples=1,  # 采样循环由本 runner 控制，harness 每次只跑一遍
    )


def _error_verdict(
    subject_arm: str, baseline_arm: str, s_oc: TurnOutcome, b_oc: TurnOutcome
) -> PairwiseVerdict:
    """任一臂出错时不调裁判：出错方判负，都错记 tie。"""
    s_err, b_err = bool(s_oc.error), bool(b_oc.error)
    if s_err and not b_err:
        return PairwiseVerdict(winner=baseline_arm, rationale=f"主臂出错: {s_oc.error}")
    if b_err and not s_err:
        return PairwiseVerdict(winner=subject_arm, rationale=f"基准臂出错: {b_oc.error}")
    return PairwiseVerdict(winner="tie", rationale="两臂均出错")


async def run_comparison_case(
    cc: ComparisonCase,
    harness: Harness,
    *,
    judge: PairwiseJudge | None = None,
    layer: int = 1,
) -> ComparisonCaseReport:
    """跑一道对比用例：各臂采样 ``samples`` 次 → （layer≥2 且有裁判）主臂逐对 vs 基准臂。"""
    arms: dict[str, ArmResult] = {}
    for arm in cc.arms:
        ac = _arm_case(cc, arm)
        res = ArmResult(arm=arm)
        for _ in range(max(1, cc.samples)):
            outcome = await harness.run_case(ac)
            res.outcomes.append(outcome)
            res.checks.append(apply_checks(ac, outcome))
        arms[arm] = res

    pairwise: dict[str, list[PairwiseVerdict]] = {}
    base = arms.get(cc.baseline_arm)
    if layer >= 2 and judge is not None and cc.rubric and base is not None:
        for arm in (a for a in cc.arms if a != cc.baseline_arm):
            subject = arms[arm]
            verdicts: list[PairwiseVerdict] = []
            n = min(len(subject.outcomes), len(base.outcomes))
            for i in range(n):
                s_oc, b_oc = subject.outcomes[i], base.outcomes[i]
                if s_oc.error or b_oc.error:
                    verdicts.append(_error_verdict(arm, cc.baseline_arm, s_oc, b_oc))
                    continue
                verdicts.append(
                    await judge.compare(
                        rubric=cc.rubric,
                        user_message=cc.user_message,
                        subject_arm=arm,
                        subject_content=s_oc.content,
                        baseline_arm=cc.baseline_arm,
                        baseline_content=b_oc.content,
                    )
                )
            pairwise[arm] = verdicts

    return ComparisonCaseReport(
        case_id=cc.id,
        archetype=cc.archetype,
        baseline_arm=cc.baseline_arm,
        arms=arms,
        pairwise=pairwise,
    )


async def run_comparison_suite(
    cases: list[ComparisonCase],
    harness: Harness | None = None,
    *,
    judge: PairwiseJudge | None = None,
    layer: int = 1,
) -> ComparisonReport:
    """跑整套对比用例，聚合成 :class:`ComparisonReport`。"""
    h: Harness = harness or EvalHarness()
    reports: list[ComparisonCaseReport] = []
    for cc in cases:
        logger.info(
            "evals.comparison_start",
            case=cc.id,
            archetype=cc.archetype,
            arms=cc.arms,
            samples=cc.samples,
        )
        reports.append(await run_comparison_case(cc, h, judge=judge, layer=layer))
    return ComparisonReport(cases=reports)


# --- 度量与报告（三轴 + 按 archetype 分段）----------------------------------


def _median(xs: list[float]) -> float | None:
    vals = [x for x in xs if x is not None]
    return statistics.median(vals) if vals else None


def _ratio(subj: list[float], base: list[float]) -> float | None:
    s, b = _median(subj), _median(base)
    if s is None or b is None or b == 0:
        return None
    return round(s / b, 4)


def _thinking(oc: TurnOutcome) -> float:
    return float(oc.usage.get("reasoning", 0))


def _total_tokens(oc: TurnOutcome) -> float:
    return float(oc.usage.get("input", 0) + oc.usage.get("output", 0))


def case_metrics(rep: ComparisonCaseReport) -> dict:
    """一道对比用例 → 可读/可序列化的度量 dict（各臂统计 + 主臂 vs 基准对比）。"""
    arms_m: dict[str, dict] = {}
    for arm, res in rep.arms.items():
        arms_m[arm] = {
            "samples": len(res.outcomes),
            "errors": sum(1 for o in res.outcomes if o.error),
            "passk": res.passk,
            "cost_usd_median": _median([o.cost_usd for o in res.outcomes]),
            "latency_ms_median": _median([float(o.latency_ms) for o in res.outcomes]),
            "tokens_median": _median([_total_tokens(o) for o in res.outcomes]),
            "thinking_tokens_median": _median([_thinking(o) for o in res.outcomes]),
        }

    comps: dict[str, dict] = {}
    base = rep.arms.get(rep.baseline_arm)
    for arm in rep.subject_arms:
        verdicts = rep.pairwise.get(arm, [])
        wins = sum(1 for v in verdicts if v.winner == arm)
        losses = sum(1 for v in verdicts if v.winner == rep.baseline_arm)
        ties = sum(1 for v in verdicts if v.winner == "tie")
        n = len(verdicts)
        subj = rep.arms[arm]
        comps[arm] = {
            "n": n,
            "wins": wins,
            "ties": ties,
            "losses": losses,
            "win_rate": round((wins + 0.5 * ties) / n, 4) if n else None,
            "cost_ratio": _ratio(
                [o.cost_usd for o in subj.outcomes],
                [o.cost_usd for o in base.outcomes] if base else [],
            ),
            "latency_ratio": _ratio(
                [float(o.latency_ms) for o in subj.outcomes],
                [float(o.latency_ms) for o in base.outcomes] if base else [],
            ),
            "thinking_token_ratio": _ratio(
                [_thinking(o) for o in subj.outcomes],
                [_thinking(o) for o in base.outcomes] if base else [],
            ),
        }

    return {
        "case_id": rep.case_id,
        "archetype": rep.archetype,
        "baseline_arm": rep.baseline_arm,
        "arms": arms_m,
        "comparisons": comps,
    }


def archetype_breakdown(report: ComparisonReport) -> dict[str, dict]:
    """按 archetype 聚合：团队（主臂）均胜率 + 均成本比（**不报全局单一胜率**）。"""
    by: dict[str, dict[str, list[float]]] = {}
    for rep in report.cases:
        m = case_metrics(rep)
        for c in m["comparisons"].values():
            if c["win_rate"] is None:
                continue
            bucket = by.setdefault(rep.archetype, {"win_rates": [], "cost_ratios": []})
            bucket["win_rates"].append(c["win_rate"])
            if c["cost_ratio"] is not None:
                bucket["cost_ratios"].append(c["cost_ratio"])
    out: dict[str, dict] = {}
    for arch, b in by.items():
        wr, cr = b["win_rates"], b["cost_ratios"]
        out[arch] = {
            "avg_win_rate": round(sum(wr) / len(wr), 4) if wr else None,
            "avg_cost_ratio": round(sum(cr) / len(cr), 4) if cr else None,
            "cases": len(wr),
        }
    return out


def comparison_report_to_dict(report: ComparisonReport) -> dict:
    """整套对比报告 → JSON-able dict（汇总 + 逐例），供落盘 / baseline 对比。"""
    return {
        "summary": {
            "total_cases": len(report.cases),
            "by_archetype": archetype_breakdown(report),
        },
        "cases": [case_metrics(r) for r in report.cases],
    }


def format_comparison_report(report: ComparisonReport) -> str:
    """控制台文本报告（逐例三轴 + 按 archetype 分段）。ASCII 标记避免 Windows 控制台乱码。"""
    lines: list[str] = ["=" * 64, "AgentCore 对比评估报告（团队 vs 单体）", "=" * 64]
    for rep in report.cases:
        m = case_metrics(rep)
        lines.append(f"[{rep.case_id}]  ({rep.archetype})  基准={rep.baseline_arm}")
        for arm, c in m["comparisons"].items():
            wr = f"{c['win_rate'] * 100:.0f}%" if c["win_rate"] is not None else "n/a"
            cr = f"{c['cost_ratio']:.2f}x" if c["cost_ratio"] is not None else "n/a"
            lr = f"{c['latency_ratio']:.2f}x" if c["latency_ratio"] is not None else "n/a"
            lines.append(
                f"    {arm} vs {rep.baseline_arm}: 胜率 {wr} "
                f"(W{c['wins']}-T{c['ties']}-L{c['losses']})  成本 {cr}  延迟 {lr}"
            )
        for arm, am in m["arms"].items():
            pk = "n/a" if am["passk"] is None else ("PASS" if am["passk"] else "FAIL")
            cost = am["cost_usd_median"] or 0.0
            lat = int(am["latency_ms_median"] or 0)
            lines.append(f"      - {arm}: pass^k={pk}  cost~${cost:.4f}  lat~{lat}ms")
    lines.append("-" * 64)
    for arch, b in sorted(archetype_breakdown(report).items()):
        awr = f"{b['avg_win_rate'] * 100:.0f}%" if b["avg_win_rate"] is not None else "n/a"
        acr = f"{b['avg_cost_ratio']:.2f}x" if b["avg_cost_ratio"] is not None else "n/a"
        lines.append(f"  {arch:<18} 团队均胜率 {awr}  均成本 {acr}  ({b['cases']} 例)")
    lines.append("=" * 64)
    return "\n".join(lines)


# --- 真模型裁判工厂（CLI/nightly 用；单测走注入的假裁判，不碰这里）-----------


def build_default_pairwise_judge(mode: str = "quality") -> LLMPairwiseJudge:
    """构造接真实 DeepSeek 的成对裁判：固定 Pro 档（§十一）。

    裁判模型优先读 ``EVAL_JUDGE_MODEL``，否则回落 ``mode`` 档（默认 quality）的 chat 档模型。
    凭据复用 harness 的 eval 专用 key 解析。仅 CLI/nightly 真跑调用——单测注入假裁判。
    """
    import os

    from agentcore.evals.harness import _EVAL_CEILING, _eval_credentials
    from agentcore.llm.factory import build_provider
    from agentcore.llm.modes import resolve_profile_set

    provider = build_provider(_eval_credentials())
    model = os.environ.get("EVAL_JUDGE_MODEL", "").strip()
    if not model:
        # Resolve against the FULL eval catalog ceiling (not the user ceiling, which
        # 内测 locked to Flash) so the default ``quality`` judge stays on Pro (§十一).
        profiles = resolve_profile_set(mode, custom_modes={}, ceiling=_EVAL_CEILING)
        model = profiles.get("chat").model
    return LLMPairwiseJudge(provider, model)
