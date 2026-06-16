"""runner：加载用例 → 跑真实路径 → 确定性 Check（+可选裁判）→ 聚合 :class:`EvalReport`（§二）.

用例形态 = 数据（JSON）：``cases/<suite>/*.json``，每个文件是一个用例对象或对象列表。加载先经
:func:`agentcore.evals.seed_lint.lint_suite` 静态校验（用例写错立刻挂，per-PR 硬门禁复用此早
失败）。``samples>1`` 对「跑 Agent(+裁判)」整体重复，治非确定性（报告里同 case_id 多条）。
"""

from __future__ import annotations

import json
from pathlib import Path

from agentcore.core.logging import get_logger
from agentcore.evals.checks import build_check
from agentcore.evals.harness import EvalHarness
from agentcore.evals.seed_lint import lint_suite
from agentcore.evals.types import (
    CaseReport,
    CheckOutcome,
    EvalCase,
    EvalConfigError,
    EvalReport,
    Harness,
    Judge,
    TurnOutcome,
)

logger = get_logger(__name__)

_DEFAULT_CASES_DIR = Path(__file__).parent / "cases"

# EvalCase 接受的字段（用例 JSON 里多出的键被忽略，便于加注释字段如 ``_note``）。
_CASE_FIELDS = frozenset(
    {
        "id",
        "category",
        "user_message",
        "path",
        "mode",
        "toolset",
        "workspace_fixture",
        "history",
        "checks",
        "rubric",
        "samples",
    }
)


def _parse_case(raw: dict) -> EvalCase:
    return EvalCase(**{k: v for k, v in raw.items() if k in _CASE_FIELDS})


def load_raw_cases(cases_dir: Path, suite: str = "core") -> list[dict]:
    """读 ``cases_dir/suite/*.json`` 为原始 dict 列表（未 lint、未解析）。"""
    suite_dir = Path(cases_dir) / suite
    if not suite_dir.is_dir():
        raise EvalConfigError(f"用例套件目录不存在: {suite_dir}")
    raws: list[dict] = []
    for path in sorted(suite_dir.glob("*.json")):
        loaded = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(loaded, list):
            raws.extend(loaded)
        else:
            raws.append(loaded)
    return raws


def load_cases(cases_dir: Path | str | None = None, suite: str = "core") -> list[EvalCase]:
    """加载 + lint + 解析一个套件的全部用例（lint 不过即 raise，绝不带病开跑）。"""
    base = Path(cases_dir) if cases_dir else _DEFAULT_CASES_DIR
    raws = load_raw_cases(base, suite)
    if not raws:
        raise EvalConfigError(f"套件 {suite!r} 没有任何用例（{base / suite}）")
    errors = lint_suite(raws)
    if errors:
        raise EvalConfigError("用例校验失败:\n  " + "\n  ".join(errors))
    return [_parse_case(r) for r in raws]


def apply_checks(case: EvalCase, outcome: TurnOutcome) -> list[CheckOutcome]:
    """对一次运行结果跑该用例声明的全部确定性 Check（判定零 LLM）。"""
    results: list[CheckOutcome] = []
    for spec in case.checks:
        try:
            check = build_check(spec)
        except KeyError as e:  # 已被 lint 拦住；此处兜底，绝不让单个坏 check 炸整套
            results.append(CheckOutcome(str(spec.get("name", "?")), False, f"未注册 check: {e}"))
            continue
        results.append(check.run(case, outcome))
    return results


async def run_case_report(
    case: EvalCase,
    harness: Harness,
    *,
    judge: Judge | None = None,
    layer: int = 1,
) -> list[CaseReport]:
    """跑一个用例 ``samples`` 次，每次产一条 :class:`CaseReport`（确定性 Check + 可选裁判）。"""
    reports: list[CaseReport] = []
    for _ in range(max(1, case.samples)):
        outcome = await harness.run_case(case)
        checks = apply_checks(case, outcome)
        verdict = None
        if layer >= 2 and judge is not None and case.rubric and outcome.error is None:
            verdict = await judge.score(case, outcome)
        reports.append(
            CaseReport(
                case_id=case.id,
                category=case.category,
                outcome=outcome,
                checks=checks,
                judge=verdict,
            )
        )
    return reports


async def run_suite(
    cases: list[EvalCase],
    harness: Harness | None = None,
    *,
    judge: Judge | None = None,
    layer: int = 1,
) -> EvalReport:
    """跑整套用例，聚合成 :class:`EvalReport`（一个用例 samples>1 时贡献多条）。"""
    runner_harness: Harness = harness or EvalHarness()
    all_reports: list[CaseReport] = []
    for case in cases:
        logger.info(
            "evals.case_start",
            case=case.id,
            category=case.category,
            path=case.path,
            samples=case.samples,
        )
        all_reports.extend(
            await run_case_report(case, runner_harness, judge=judge, layer=layer)
        )
    return EvalReport(cases=all_reports)
