"""拆·playbook 固化 (docs/03-AI核心/编排器与CEO主Agent.md §playbook): a tiny registry of
high-frequency, high-variance team SHAPES promoted from prose guidance to instantiable
deterministic DAG skeletons — the CEO names one + fills a few slots instead of
hand-crafting the ``tasks`` array every time
(像 `debate` 的确定性骨架, [辩论编排设计](docs/03-AI核心/辩论编排设计.md)).

Each playbook is a PURE ``slots -> (tasks, errors)`` builder whose output is exactly the
``tasks`` dict-list :func:`agentcore.runtime.runs.builder.build_run_plan` already consumes, so an
instantiated playbook flows through the SAME pipeline (build_run_plan → drive → executor →
ceo_format) as a hand-written delegation — 纯加法、不加新子系统、零行为变化（不传 playbook 即如常）.

Deliberately SMALL (3 shapes). A playbook 固化 is for the few recurring, worth-codifying shapes,
NOT a general template engine (守 [dev-process](.cursor/rules/dev-process.mdc) 防僵化绊线): the
moment a "playbook" needs branching / conditionals / per-call structural choices it is no longer a
固定形状 and should stay a hand-written ``tasks`` array.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

# Cap the slot-driven fan-out (调研子方向 / 待比较选项) so a playbook can't silently balloon a
# batch;
# build_run_plan still enforces the global MAX_DELEGATION_TASKS on the expanded result as the real
# net. Kept modest because a playbook is a STANDARD shape, not a place to launch a huge swarm.
MAX_PLAYBOOK_FANOUT = 6

PlaybookBuilder = Callable[[dict[str, Any]], "tuple[list[dict[str, Any]], list[str]]"]


@dataclass(frozen=True)
class Playbook:
    """One named, instantiable team shape: ``build(slots) -> (tasks, errors)``.

    ``summary`` / ``slots`` are the human-facing one-liners surfaced in the ``delegate`` schema
    and the ``team_orchestration_advanced`` skill so the CEO knows the shape exists and what to
    pass; ``build`` is the pure expander.
    """

    name: str
    summary: str
    slots: str
    build: PlaybookBuilder


def _clean_str(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _clean_str_list(value: Any, *, cap: int) -> list[str]:
    """Normalise a slot to a deduped list of non-empty strings, capped at ``cap`` (preserves
    order, drops non-strings / blanks). A non-list slot → ``[]`` so the builder's own
    required-slot check produces the user-facing error rather than a type crash."""
    if not isinstance(value, list):
        return []
    out: list[str] = []
    for item in value:
        s = item.strip() if isinstance(item, str) else ""
        if s and s not in out:
            out.append(s)
        if len(out) >= cap:
            break
    return out


def _research_report(args: dict[str, Any]) -> tuple[list[dict[str, Any]], list[str]]:
    """N×并行调研 → 提纲（依赖调研，可选 checkpoint 让用户过目）→ 写作（依赖提纲）.

    The doc's own named example (调研→提纲→checkpoint→写作); mirrors the 进阶 skill「调研驱动的
    大型交付，让结构跟着证据走」as a one-call shape."""
    topic = _clean_str(args.get("topic"))
    if not topic:
        return [], ["research_report 需要 slot『topic』（要调研并成文的主题）"]
    angles = _clean_str_list(args.get("angles"), cap=MAX_PLAYBOOK_FANOUT)
    checkpoint = bool(args.get("checkpoint"))
    audience = _clean_str(args.get("audience"))
    deliverable = _clean_str(args.get("deliverable")) or f"一篇关于【{topic}】的完整报告"

    tasks: list[dict[str, Any]] = []
    if angles:
        research_ids = [f"research_{i}" for i in range(len(angles))]
        for rid, angle in zip(research_ids, angles, strict=True):
            tasks.append(
                {
                    "id": rid,
                    "role": "调研员",
                    "task": (
                        f"围绕主题【{topic}】，专门调研这一个子方向：{angle}。"
                        "给出该子方向的关键事实 / 现状 / 证据，附来源（文件:行 或 链接）；"
                        "聚焦本子方向、回报精炼结论而非整段原文，别铺开到其它角度。"
                    ),
                    "expected_output": f"【{angle}】方向的调研要点 + 来源",
                }
            )
    else:
        research_ids = ["research_0"]
        tasks.append(
            {
                "id": "research_0",
                "role": "调研员",
                "task": (
                    f"调研主题【{topic}】：覆盖关键事实 / 现状 / 主要观点与证据，附来源；"
                    "回报精炼结论 + 关键证据指引，别回贴整段原文。"
                ),
                "expected_output": f"【{topic}】的调研要点 + 来源",
            }
        )

    aud = f"，面向读者：{audience}" if audience else ""
    tasks.append(
        {
            "id": "outline",
            "role": "提纲编辑",
            "task": (
                f"综合上游各路调研，为主题【{topic}】拟一份报告提纲{aud}：列出章节结构与每节要点。"
                "据证据定结构（别凭空先写死），确保覆盖各调研方向、无重复无缺口。"
            ),
            "depends_on": research_ids,
            "expected_output": "一份结构化报告提纲（章节 + 每节要点）",
            "checkpoint_after": checkpoint,
        }
    )
    tasks.append(
        {
            "id": "write",
            "role": "撰稿人",
            "task": (
                f"严格按上游定稿的提纲、结合各路调研，写成{deliverable}。忠于调研事实与来源、不杜撰；"
                "成篇文字交付写成 .md 并用 file_write 落盘工作区。"
            ),
            "depends_on": ["outline"],
            "expected_output": deliverable,
            "contract": {"requires_files": True},
        }
    )
    return tasks, []


def _build_feature(args: dict[str, Any]) -> tuple[list[dict[str, Any]], list[str]]:
    """后端接口 →（前端页面 ‖ 测试）并行依赖接口；接口契约经便签墙对齐.

    The doc's recurring 登录 example, and a direct consumer of the just-shipped 4b 拼图边对账 —
    the parallel 页面 / 测试 share the api's broadcast interface contract."""
    feature = _clean_str(args.get("feature"))
    if not feature:
        return [], ["build_feature 需要 slot『feature』（要实现的功能）"]
    stack = _clean_str(args.get("stack"))
    stack_hint = f"（技术栈：{stack}）" if stack else ""
    include = _clean_str_list(args.get("include"), cap=2)
    want_ui = (not include) or ("ui" in include)
    want_test = (not include) or ("test" in include)

    tasks: list[dict[str, Any]] = [
        {
            "id": "api",
            "role": "后端工程师",
            "task": (
                f"实现【{feature}】的后端接口{stack_hint}。先把接口契约（路径 / 方法 / 入参 / "
                "返回结构 / 错误形状）用 post_note(kind=decision) 广播到团队便签墙，再实现；"
                "务必用 file_write 把代码写进工作区。"
            ),
            "expected_output": "可用的后端接口 + 已广播的接口契约",
            "contract": {"requires_files": True},
        }
    ]
    if want_ui:
        tasks.append(
            {
                "id": "ui",
                "role": "前端工程师",
                "task": (
                    f"实现【{feature}】的前端页面{stack_hint}，严格对接 api 步骤广播的接口契约"
                    "（路径 / 字段 / 返回）。发现契约对不上就按最新契约对齐、"
                    "必要时 post_note 提醒；"
                    "务必用 file_write 把代码写进工作区。"
                ),
                "depends_on": ["api"],
                "expected_output": "可用的前端页面，对接后端接口",
                "contract": {"requires_files": True},
            }
        )
    if want_test:
        tasks.append(
            {
                "id": "test",
                "role": "测试工程师",
                "task": (
                    f"为【{feature}】写测试，按便签墙上 api 广播的接口契约"
                    "覆盖正常 + 边界 + 错误形状；"
                    "务必用 file_write 把测试文件写进工作区。"
                ),
                "depends_on": ["api"],
                "expected_output": "覆盖接口契约的测试",
                "contract": {"requires_files": True},
            }
        )
    return tasks, []


def _compare_options(args: dict[str, Any]) -> tuple[list[dict[str, Any]], list[str]]:
    """N×并行评估各选项 → 汇总对比 + 推荐（依赖全部评估）.

    The decision-support shape: one evaluator per option (each stays objective on its own one),
    then a synthesiser produces the cross-option comparison the CEO relays."""
    question = _clean_str(args.get("question"))
    options = _clean_str_list(args.get("options"), cap=MAX_PLAYBOOK_FANOUT)
    errors: list[str] = []
    if not question:
        errors.append("compare_options 需要 slot『question』（要决策的问题）")
    if len(options) < 2:
        errors.append("compare_options 需要 slot『options』（>=2 个待比较选项）")
    if errors:
        return [], errors
    criteria = _clean_str_list(args.get("criteria"), cap=8)
    crit_eval = ("，按这些维度评估：" + "、".join(criteria)) if criteria else ""
    crit_sum = (f"（维度：{'、'.join(criteria)}）") if criteria else ""

    eval_ids = [f"eval_{i}" for i in range(len(options))]
    tasks: list[dict[str, Any]] = []
    for eid, opt in zip(eval_ids, options, strict=True):
        tasks.append(
            {
                "id": eid,
                "role": "评估员",
                "task": (
                    f"针对决策问题【{question}】，深入评估这一个选项：{opt}{crit_eval}。"
                    "给出它的优点 / 缺点 / 适用与不适用场景，只评这一个、保持客观。"
                ),
                "expected_output": f"对选项【{opt}】的评估",
            }
        )
    tasks.append(
        {
            "id": "summary",
            "role": "汇总分析师",
            "task": (
                f"对照上游对各选项的评估，针对【{question}】给出横向对比{crit_sum}："
                "一张对比表 + 明确推荐及理由；若各选项各有适用场景，说清分别何时选谁。"
            ),
            "depends_on": eval_ids,
            "expected_output": "对比表 + 推荐结论",
        }
    )
    return tasks, []


PLAYBOOKS: dict[str, Playbook] = {
    "research_report": Playbook(
        name="research_report",
        summary="调研→提纲→写作的报告流水线（N 路并行调研，汇拢成纲再成文）",
        slots=(
            "topic(必填,主题) / angles(可选,调研子方向数组,各派一名调研员) / "
            "checkpoint(可选,成纲后写作前暂停过目) / audience(可选,读者) / "
            "deliverable(可选,产出形态)"
        ),
        build=_research_report,
    ),
    "build_feature": Playbook(
        name="build_feature",
        summary="后端接口→（前端页面 ‖ 测试）并行的功能交付（接口契约经便签墙对齐）",
        slots=(
            "feature(必填,要实现的功能) / stack(可选,技术栈) / "
            "include(可选,['ui','test'] 子集,默认两者都要)"
        ),
        build=_build_feature,
    ),
    "compare_options": Playbook(
        name="compare_options",
        summary="N 路并行评估各选项→汇总对比推荐的决策支持",
        slots=(
            "question(必填,要决策的问题) / options(必填,>=2 个待比较选项) / "
            "criteria(可选,评估维度数组)"
        ),
        build=_compare_options,
    ),
}


def available_playbooks() -> str:
    """One-line ``name（summary）`` listing for schema / skill / error messages — single source so
    the available set never drifts between the registry and what the CEO is told."""
    return "；".join(f"{p.name}（{p.summary}）" for p in PLAYBOOKS.values())


def expand_playbook(
    name: str, args: dict[str, Any] | None
) -> tuple[list[dict[str, Any]], list[str]]:
    """Expand a named playbook + slot args into a ``tasks`` dict-list for ``build_run_plan``.

    Returns ``(tasks, errors)``; a non-empty ``errors`` means the instantiation is rejected (unknown
    name, bad args type, or a missing required slot) and the caller must NOT run it — mirroring
    ``build_run_plan``'s reject-on-error contract so the delegate entry handles both the same
    way."""
    pb = PLAYBOOKS.get(name)
    if pb is None:
        return [], [f"未知 playbook『{name}』；可用：{available_playbooks()}"]
    if args is not None and not isinstance(args, dict):
        return [], [f"playbook_args 必须是对象；{pb.name} 槽位：{pb.slots}"]
    return pb.build(args or {})
