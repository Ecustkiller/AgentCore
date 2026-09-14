"""评估体系 CLI：子命令跑合成评测、出报告.

用法::

    python -m agentcore.evals lint
    python -m agentcore.evals run routing          # 派不派 + 派哪本（一张卷）
    python -m agentcore.evals run core             # L0 Check + L1 裁判
    python -m agentcore.evals run compare          # 团队 vs 单体
    python -m agentcore.evals run core --checks    # 仅 L0，无裁判
    python -m agentcore.evals prompt compaction
    python -m agentcore.evals calibrate
    python -m agentcore.evals observe current.json baseline.json

主入口是 ``run routing`` / ``run core`` / ``run compare``。``mast`` / ``probe`` /
``collab_shapes`` / ``product_rules`` / ``rules_memory`` 仍可 ``run``，但是按需，
不是默认该盯的三科。

真跑会调真实模型（``EVAL_DEEPSEEK_*`` 或本地账号 Key）。``lint`` / ``observe`` 零 LLM。
退出码：全过/裁判可信=0；用例未过或 kappa<门=1；配置错误=2。
相对基线观测、playbook 落点、提示词单元都不改退出码。
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from agentcore.core.log_context import bind_log_context
from agentcore.evals.calibration import (
    calibrate,
    calibration_to_dict,
    format_calibration_report,
    load_gold_set,
)
from agentcore.evals.compaction_fidelity import (
    SAMPLES as COMPACTION_FIDELITY_SAMPLES,
)
from agentcore.evals.compaction_fidelity import (
    _fidelity_provider_and_model as _compaction_fidelity_provider_and_model,
)
from agentcore.evals.compaction_fidelity import (
    compaction_fidelity_to_dict,
    format_compaction_fidelity_report,
    run_compaction_fidelity,
)
from agentcore.evals.compaction_fidelity import (
    lint_samples as lint_compaction_fidelity_samples,
)
from agentcore.evals.compaction_fidelity import select_samples as select_compaction_fidelity_samples
from agentcore.evals.comparison import (
    build_default_pairwise_judge,
    comparison_report_to_dict,
    format_comparison_report,
    load_comparison_cases,
    run_comparison_suite,
)
from agentcore.evals.debate_converge import (
    SCENARIOS,
    _debate_provider_and_model,
    debate_converge_to_dict,
    format_debate_converge_report,
    lint_scenarios,
    run_debate_converge,
)
from agentcore.evals.debate_speech_format import (
    SAMPLES as SPEECH_FORMAT_SAMPLES,
)
from agentcore.evals.debate_speech_format import (
    _debate_provider_and_model as _speech_format_provider_and_model,
)
from agentcore.evals.debate_speech_format import (
    debate_speech_format_to_dict,
    format_debate_speech_format_report,
    run_debate_speech_format,
)
from agentcore.evals.debate_speech_format import (
    lint_samples as lint_speech_format_samples,
)
from agentcore.evals.judge import build_default_judge, build_default_milestone_judge
from agentcore.evals.observe import format_observe, observe_report
from agentcore.evals.report import format_report, report_to_dict
from agentcore.evals.routing import (
    format_routing_report,
    routing_metrics,
    routing_metrics_to_dict,
)
from agentcore.evals.runner import load_cases, run_suite
from agentcore.evals.style_lint import (
    format_style_report,
    style_metrics,
    style_metrics_to_dict,
)
from agentcore.evals.types import EvalConfigError

_DEFAULT_EVAL_OUT = Path(__file__).resolve().parents[2] / "eval-out"
_DEFAULT_GOLD_SET = Path(__file__).resolve().parent / "cases" / "gold" / "labels.json"
_LEGACY_PLAYBOOK_BASELINE = _DEFAULT_EVAL_OUT / "playbook-routing-baseline.json"

# 主入口三科。其余 JSON 套件仍可 run，但是按需。
PRIMARY_SUITES: tuple[str, ...] = ("routing", "core", "compare")
JSON_SUITES: tuple[str, ...] = (
    "core",
    "routing",
    "mast",
    "probe",
    "collab_shapes",
    "product_rules",
    "rules_memory",
)
ON_DEMAND_SUITES: tuple[str, ...] = (
    "mast",
    "probe",
    "collab_shapes",
    "product_rules",
    "rules_memory",
)
PROMPT_KINDS: tuple[str, ...] = ("speech-format", "compaction", "converge")
LINT_TARGETS: tuple[str, ...] = JSON_SUITES + ("compare", "prompt", "gold")
_CHECKS_DEFAULT: frozenset[str] = frozenset({"probe", "routing"})


def _write_json(path: Path, payload: dict[str, Any], *, label: str = "report") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n[{label}] 已写出 JSON -> {path}")


def _load_json_object(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    raw = json.loads(path.read_text(encoding="utf-8"))
    return raw if isinstance(raw, dict) else None


def _attach_observe(payload: dict[str, Any], baseline_path: str | None) -> dict[str, Any]:
    if not baseline_path:
        return payload
    bpath = Path(baseline_path)
    baseline = _load_json_object(bpath)
    payload["ratchet"] = observe_report(payload, baseline, baseline_path=str(bpath))
    print(format_observe(payload["ratchet"]))
    return payload


def _layer_for(suite: str, *, checks: bool, judge: bool) -> int:
    if checks:
        return 1
    if judge:
        return 2
    return 1 if suite in _CHECKS_DEFAULT else 2


def _add_shared_run_flags(p: argparse.ArgumentParser) -> None:
    layer = p.add_mutually_exclusive_group()
    layer.add_argument(
        "--checks",
        action="store_true",
        help="只跑 L0 确定性 Check（无裁判）。probe / routing 的委派半默认就是这档",
    )
    layer.add_argument(
        "--judge",
        action="store_true",
        help="L0 + L1 rubric / milestone 裁判。core / compare 默认就是这档",
    )
    p.add_argument("--mode", default=None, help="覆盖用例质量档：economy / quality / 自定义")
    p.add_argument(
        "--judge-mode",
        default="quality",
        help="裁判档（默认 quality→Pro，即 Pro 评 Flash；EVAL_JUDGE_MODEL 可覆盖）",
    )
    p.add_argument("--cases-dir", default=None, help="用例根目录（默认包内 cases/）")
    p.add_argument("--out", default=None, help="把 JSON 报告写到该路径")
    p.add_argument(
        "--baseline",
        default=None,
        help="baseline JSON：存在则做相对基线观测（不卡门禁）；配 --update-baseline 则写入",
    )
    p.add_argument(
        "--update-baseline",
        action="store_true",
        help="把报告写为 baseline 后退出（缺省 eval-out/<suite>-baseline.json）",
    )
    p.add_argument(
        "--plan-only",
        action="store_true",
        help="只规划不执行（跳过 worker/辩论）；报告只看形状。按需套件 collab_shapes 用",
    )
    p.add_argument(
        "--samples",
        type=int,
        default=None,
        help="覆盖采样次数（routing 的 playbook 半 / 用例 JSON）",
    )
    p.add_argument(
        "--style",
        action="store_true",
        help="同一趟结果上跑 anti-slop（不再另起一跑）",
    )
    p.add_argument(
        "--keys",
        default=None,
        help="只跑指定 key（逗号分隔）；routing 的 playbook 半 / prompt compaction",
    )
    p.add_argument(
        "--retries",
        type=int,
        default=0,
        help="routing playbook 半：单样本 ERROR 时额外重试次数（默认 0）",
    )


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="python -m agentcore.evals",
        description=(
            "AgentCore 离线评估。主入口：lint · run routing|core|compare · "
            "prompt · calibrate · observe。"
        ),
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    lint = sub.add_parser("lint", help="零 LLM：校验用例 / 场景 / gold-set 结构")
    lint.add_argument(
        "--suite",
        default=None,
        metavar="TARGET",
        help=f"只校验一项（{', '.join(LINT_TARGETS)}）；缺省=全部",
    )
    lint.add_argument("--cases-dir", default=None)

    run = sub.add_parser("run", help="真跑一套评测（routing / core / compare 为主）")
    run.add_argument(
        "suite",
        help="routing | core | compare，或按需 mast/probe/collab_shapes/product_rules/rules_memory",
    )
    _add_shared_run_flags(run)

    prompt = sub.add_parser("prompt", help="提示词单元：直连 complete()，不跑 Agent 回合")
    prompt.add_argument("kind", choices=PROMPT_KINDS)
    prompt.add_argument("--out", default=None)
    prompt.add_argument("--keys", default=None)
    prompt.add_argument("--judge-mode", default="quality")

    cal = sub.add_parser("calibrate", help="裁判校准：gold-set 判↔人 kappa")
    cal.add_argument("--gold-set", default=None)
    cal.add_argument("--kappa-gate", type=float, default=0.6)
    cal.add_argument("--out", default=None)
    cal.add_argument("--judge-mode", default="quality")

    obs = sub.add_parser("observe", help="零 LLM：对比两份已有报告 JSON")
    obs.add_argument("current")
    obs.add_argument("baseline")
    obs.add_argument("--out", default=None)
    return p


def _lint_json_suite(suite: str, cases_dir: str | None) -> str:
    cases = load_cases(cases_dir, suite=suite)
    return f"[lint] OK — {len(cases)} 个用例（suite={suite}）"


def _lint_compare(cases_dir: str | None) -> str:
    cases = load_comparison_cases(cases_dir, suite="comparison")
    return f"[lint] OK — {len(cases)} 个对比用例（suite=comparison）"


def _lint_playbook() -> str:
    from agentcore.evals.playbook_routing import SCENARIOS, lint_scenarios

    lint_scenarios(SCENARIOS)
    return f"[lint] OK — {len(SCENARIOS)} 个 playbook 路由场景"


def _lint_prompt() -> list[str]:
    from agentcore.evals.debate_speech_format import (
        NOTES_DRAFT_SAMPLES,
        lint_notes_draft_samples,
    )

    lint_speech_format_samples(SPEECH_FORMAT_SAMPLES)
    lint_notes_draft_samples(NOTES_DRAFT_SAMPLES)
    lint_compaction_fidelity_samples(COMPACTION_FIDELITY_SAMPLES)
    lint_scenarios(SCENARIOS)
    return [
        f"[lint] OK — {len(SPEECH_FORMAT_SAMPLES)} 个成稿样本 + "
        f"{len(NOTES_DRAFT_SAMPLES)} 个笔记→成稿样本",
        f"[lint] OK — {len(COMPACTION_FIDELITY_SAMPLES)} 个摘要保真样本",
        f"[lint] OK — {len(SCENARIOS)} 个辩论收敛场景",
    ]


def _lint_gold() -> str:
    labels = load_gold_set(_DEFAULT_GOLD_SET)
    return f"[lint] OK — {len(labels)} 条 gold-set 标注（{_DEFAULT_GOLD_SET}）"


def _run_lint(args: argparse.Namespace) -> int:
    target = args.suite
    if target is not None and target not in LINT_TARGETS:
        raise EvalConfigError(
            f"未知 lint 目标 {target!r}；可选：{', '.join(LINT_TARGETS)}"
        )
    lines: list[str] = []
    wanted = [target] if target else list(LINT_TARGETS)
    for name in wanted:
        if name in JSON_SUITES:
            lines.append(_lint_json_suite(name, args.cases_dir))
            if name == "routing":
                lines.append(_lint_playbook())
        elif name == "compare":
            lines.append(_lint_compare(args.cases_dir))
        elif name == "prompt":
            lines.extend(_lint_prompt())
        elif name == "gold":
            lines.append(_lint_gold())
    print("\n".join(lines))
    return 0


def _run_observe(args: argparse.Namespace) -> int:
    current_path, baseline_path = Path(args.current), Path(args.baseline)
    current = json.loads(current_path.read_text(encoding="utf-8"))
    baseline = json.loads(baseline_path.read_text(encoding="utf-8"))
    if not isinstance(current, dict) or not isinstance(baseline, dict):
        raise EvalConfigError("observe 的两份文件顶层都必须是 JSON 对象")
    src = current.get("delegate") if isinstance(current.get("delegate"), dict) else current
    base = baseline.get("delegate") if isinstance(baseline.get("delegate"), dict) else baseline
    if not isinstance(src, dict) or not isinstance(base, dict):
        src, base = current, baseline
    obs = observe_report(src, base, baseline_path=str(baseline_path))
    print(format_observe(obs))
    if args.out:
        _write_json(Path(args.out), obs)
    return 0


def _default_baseline_path(suite: str) -> Path:
    return _DEFAULT_EVAL_OUT / f"{suite}-baseline.json"


def _maybe_style(payload: dict[str, Any], report: Any, enabled: bool) -> dict[str, Any]:
    if not enabled:
        return payload
    metrics = style_metrics(report.cases)
    print("\n" + format_style_report(metrics))
    payload["style"] = style_metrics_to_dict(metrics)
    return payload


def _playbook_previous(baseline_doc: dict[str, Any] | None) -> dict[str, Any] | None:
    if not baseline_doc:
        return None
    playbook = baseline_doc.get("playbook")
    if isinstance(playbook, dict):
        return playbook
    if "scenarios" in baseline_doc:
        return baseline_doc
    return None


def _delegate_baseline(baseline_doc: dict[str, Any] | None) -> dict[str, Any] | None:
    if not baseline_doc:
        return None
    delegate = baseline_doc.get("delegate")
    if isinstance(delegate, dict):
        return delegate
    routing = baseline_doc.get("routing")
    if isinstance(routing, dict) and ("accuracy" in routing or "confusion" in routing):
        return baseline_doc
    return None


async def _run_routing(args: argparse.Namespace) -> int:
    """一张卷：委派准确率（cases/routing）+ playbook 落点（口语/教科书）。"""
    from agentcore.evals.playbook_routing import (
        DEFAULT_ROUNDS,
        DEFAULT_SAMPLES,
        SCENARIOS,
        PlaybookRoutingRunConfig,
        format_playbook_routing_report,
        lint_scenarios,
        slim_baseline,
    )
    from agentcore.evals.playbook_routing_loop import run_playbook_routing

    cases = load_cases(args.cases_dir, suite="routing")
    if args.mode:
        cases = [replace(c, mode=args.mode) for c in cases]
    lint_scenarios(SCENARIOS)

    layer = _layer_for("routing", checks=args.checks, judge=args.judge)
    judge = None if layer < 2 else build_default_judge(mode=args.judge_mode)
    milestone_judge = None if layer < 2 else build_default_milestone_judge(mode=args.judge_mode)
    report = await run_suite(
        cases, judge=judge, milestone_judge=milestone_judge, layer=layer
    )
    print(format_report(report))
    metrics = routing_metrics(report.cases)
    print("\n" + format_routing_report(metrics))
    delegate_payload: dict[str, Any] = {
        "report": report_to_dict(report),
        "routing": routing_metrics_to_dict(metrics),
    }
    delegate_payload = _maybe_style(delegate_payload, report, bool(args.style))

    samples = args.samples if args.samples is not None else DEFAULT_SAMPLES
    cfg = PlaybookRoutingRunConfig(
        samples=samples,
        rounds=DEFAULT_ROUNDS,
        retries=int(args.retries or 0),
        mode=args.mode or "economy",
        quiet=False,
    )
    baseline_path = Path(args.baseline) if args.baseline else _default_baseline_path("routing")
    baseline_doc = _load_json_object(baseline_path)
    if baseline_doc is None and not args.baseline:
        baseline_doc = _load_json_object(_LEGACY_PLAYBOOK_BASELINE)

    playbook_report = await run_playbook_routing(
        config=cfg,
        previous_baseline=_playbook_previous(baseline_doc),
        keys=args.keys,
    )
    print(format_playbook_routing_report(playbook_report))

    if not args.update_baseline:
        dbase = _delegate_baseline(baseline_doc)
        if dbase is not None:
            tmp = Path(args.baseline) if args.baseline else baseline_path
            delegate_payload["ratchet"] = observe_report(
                delegate_payload, dbase, baseline_path=str(tmp)
            )
            print(format_observe(delegate_payload["ratchet"]))

    payload = {"delegate": delegate_payload, "playbook": playbook_report}
    ts = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
    out = Path(args.out) if args.out else _DEFAULT_EVAL_OUT / f"routing-{ts}.json"
    _write_json(out, payload)

    if args.update_baseline:
        slim = {"delegate": delegate_payload, "playbook": slim_baseline(playbook_report)}
        # 观测基线不嵌套昨夜 ratchet
        slim["delegate"] = {k: v for k, v in delegate_payload.items() if k != "ratchet"}
        dest = Path(args.baseline) if args.baseline else _default_baseline_path("routing")
        _write_json(dest, slim, label="baseline")
        return 0

    return 0 if report.passed == report.total else 1


async def _run_comparison(args: argparse.Namespace) -> int:
    cases = load_comparison_cases(args.cases_dir, suite="comparison")
    if args.mode:
        cases = [replace(c, mode=args.mode) for c in cases]
    if args.style:
        print("[style] compare 没有聊天正文列表，--style 已忽略", file=sys.stderr)

    judge = build_default_pairwise_judge()
    report = await run_comparison_suite(cases, judge=judge, layer=2)
    print(format_comparison_report(report))
    payload = comparison_report_to_dict(report)
    if not args.update_baseline:
        payload = _attach_observe(payload, args.baseline)
    if args.out:
        _write_json(Path(args.out), payload)
    if args.update_baseline:
        dest = Path(args.baseline) if args.baseline else _default_baseline_path("comparison")
        _write_json(dest, comparison_report_to_dict(report), label="baseline")
        return 0
    return 0


async def _run_json_suite(args: argparse.Namespace) -> int:
    suite = args.suite
    if suite not in JSON_SUITES:
        raise EvalConfigError(
            f"未知套件 {suite!r}；主入口：{', '.join(PRIMARY_SUITES)}；"
            f"按需：{', '.join(ON_DEMAND_SUITES)}"
        )
    cases = load_cases(args.cases_dir, suite=suite)
    if args.mode:
        cases = [replace(c, mode=args.mode) for c in cases]
    if args.samples is not None:
        if args.samples < 1:
            raise EvalConfigError("--samples 须 >= 1")
        cases = [replace(c, samples=args.samples) for c in cases]

    plan_only = bool(args.plan_only)
    layer = 1 if plan_only else _layer_for(suite, checks=args.checks, judge=args.judge)
    judge = (
        None
        if plan_only
        else (build_default_judge(mode=args.judge_mode) if layer >= 2 else None)
    )
    milestone_judge = (
        None
        if plan_only
        else (build_default_milestone_judge(mode=args.judge_mode) if layer >= 2 else None)
    )
    report = await run_suite(
        cases,
        judge=judge,
        milestone_judge=milestone_judge,
        layer=layer,
        plan_only=plan_only,
    )
    if plan_only:
        print("[plan-only] 形状评测（内容 Check / 裁判均为 n/a）")
    print(format_report(report))
    payload: dict[str, Any] = report_to_dict(report)
    payload = _maybe_style(payload, report, bool(args.style))
    exit_code = 0 if report.passed == report.total else 1
    if not args.update_baseline:
        payload = _attach_observe(payload, args.baseline)
    if args.out:
        _write_json(Path(args.out), payload)
    if args.update_baseline:
        dest = Path(args.baseline) if args.baseline else _default_baseline_path(suite)
        slim = report_to_dict(report)
        if "style" in payload:
            slim["style"] = payload["style"]
        _write_json(dest, slim, label="baseline")
        return 0
    return exit_code


async def _run_calibrate(args: argparse.Namespace) -> int:
    path = Path(args.gold_set) if args.gold_set else _DEFAULT_GOLD_SET
    labels = load_gold_set(path)
    judge = build_default_judge(mode=args.judge_mode)
    result = await calibrate(judge, labels, kappa_gate=args.kappa_gate)
    print(format_calibration_report(result))
    if args.out:
        _write_json(Path(args.out), calibration_to_dict(result))
    return 0 if result.trustworthy else 1


async def _run_prompt(args: argparse.Namespace) -> int:
    kind = args.kind
    if kind == "speech-format":
        from agentcore.evals.debate_speech_format import (
            NOTES_DRAFT_SAMPLES,
            lint_notes_draft_samples,
        )

        lint_speech_format_samples(SPEECH_FORMAT_SAMPLES)
        lint_notes_draft_samples(NOTES_DRAFT_SAMPLES)
        provider, model = _speech_format_provider_and_model(args.judge_mode)
        result = await run_debate_speech_format(provider, model, SPEECH_FORMAT_SAMPLES)
        print(format_debate_speech_format_report(result))
        if args.out:
            _write_json(Path(args.out), debate_speech_format_to_dict(result))
        return 0
    if kind == "compaction":
        samples = select_compaction_fidelity_samples(COMPACTION_FIDELITY_SAMPLES, args.keys)
        lint_compaction_fidelity_samples(COMPACTION_FIDELITY_SAMPLES)
        provider, model = _compaction_fidelity_provider_and_model(args.judge_mode)
        result = await run_compaction_fidelity(provider, model, samples)
        print(format_compaction_fidelity_report(result))
        if args.out:
            _write_json(Path(args.out), compaction_fidelity_to_dict(result))
        return 0
    lint_scenarios(SCENARIOS)
    provider, model = _debate_provider_and_model(args.judge_mode)
    result = await run_debate_converge(provider, model, SCENARIOS)
    print(format_debate_converge_report(result))
    if args.out:
        _write_json(Path(args.out), debate_converge_to_dict(result))
    return 0


async def _run(args: argparse.Namespace) -> int:
    cmd = args.cmd
    if cmd == "lint":
        return _run_lint(args)
    if cmd == "observe":
        return _run_observe(args)
    if cmd == "calibrate":
        return await _run_calibrate(args)
    if cmd == "prompt":
        return await _run_prompt(args)
    if cmd == "run":
        suite = args.suite
        if suite == "routing":
            return await _run_routing(args)
        if suite == "compare":
            return await _run_comparison(args)
        if suite == "comparison":
            return await _run_comparison(args)
        return await _run_json_suite(args)
    raise EvalConfigError(f"未知子命令 {cmd!r}")


def main(argv: list[str] | None = None) -> int:
    bind_log_context(traffic="eval")
    args = _build_parser().parse_args(argv)
    try:
        return asyncio.run(_run(args))
    except EvalConfigError as e:
        print(f"[error] {e}", file=sys.stderr)
        return 2
