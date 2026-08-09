"""代码审计 playbook：``code_audit``（报告纪律内建；正交于 research_report 成篇审校）。"""

from __future__ import annotations

from typing import Any

from agentcore.runtime.runs.playbooks._common import (
    CODE_AUDIT_FANOUT,
    clean_str,
    clean_str_list,
    fold_fanout_slots,
)
from agentcore.workspace.stage_dirs import REVIEWS_DIR

# 与规划定案一致：每工人模块 Phase B 最多定案条数。
_DEFAULT_K = 8

_REQUIRED_SECTIONS = [
    "〇、人审速览",
    "一、属实缺陷",
    "二、已撤销",
    "三、观察与工程债",
]

# 嵌套子任务继承父审计语境时注入（不重跑整本 playbook；防「再确认」空转）。
_NESTED_AUDIT_HANDOFF_SUPPLEMENT = """\
【嵌套审计·收工】父任务属代码审计。证据够定案条数后立即 file_write 报告终稿并一次 handoff；\
禁止以「再多读一点 / 再确认」无限扩读。先落盘再 handoff；handoff 后勿改同一报告再交。\
summary/key_points 须可执行，禁空话「审计完成」。"""


def companion_audit_json_path(artifact: str) -> str:
    """Markdown 报告路径 → 配套 ``*.audit.json`` 路径。"""
    if artifact.endswith(".md"):
        return artifact[:-3] + ".audit.json"
    return f"{artifact}.audit.json"


def apply_inherited_code_audit_discipline(tasks: list[Any]) -> list[dict[str, Any]]:
    """父 worker 带 ``code_audit_gate`` 时，给手写嵌套 tasks 盖同等收工戳。

    - 未显式设置时盖 ``code_audit_gate=True``
    - Markdown 产物补配套 ``*.audit.json``（若尚无）
    - 追加一次交接短纪律到 ``system_prompt_supplement``（不覆盖已有补充）
    不重跑 ``code_audit`` playbook，避免把单点子审扩成整团多模块图。
    """
    out: list[dict[str, Any]] = []
    for raw in tasks:
        if not isinstance(raw, dict):
            continue
        task = dict(raw)
        d_raw = task.get("deliverable")
        deliverable: dict[str, Any] = dict(d_raw) if isinstance(d_raw, dict) else {}
        if "code_audit_gate" not in deliverable:
            deliverable["code_audit_gate"] = True
        arts = deliverable.get("artifacts")
        if isinstance(arts, list):
            paths = [str(p).strip() for p in arts if str(p).strip()]
            existing = {p.replace("\\", "/") for p in paths}
            extra: list[str] = []
            for p in paths:
                if not p.endswith(".md"):
                    continue
                twin = companion_audit_json_path(p)
                if twin.replace("\\", "/") not in existing:
                    extra.append(twin)
                    existing.add(twin.replace("\\", "/"))
            if extra:
                deliverable["artifacts"] = [*paths, *extra]
        if deliverable:
            task["deliverable"] = deliverable
        prior = clean_str(task.get("system_prompt_supplement"))
        if _NESTED_AUDIT_HANDOFF_SUPPLEMENT not in (prior or ""):
            task["system_prompt_supplement"] = (
                f"{prior}\n\n{_NESTED_AUDIT_HANDOFF_SUPPLEMENT}".strip()
                if prior
                else _NESTED_AUDIT_HANDOFF_SUPPLEMENT
            )
        out.append(task)
    return out


_AUDIT_DISCIPLINE = """
【两阶段·强制】先 A 宽扫只出候选（严重度上限低/观察），
再 B 定案（读全函数体、追上游、查根+包内配置）。
向用户「共 N 条缺陷」只计 B 定案属实且落入「一、属实缺陷」者；A 候选未进 B 不进 N。
预算不够则少报：本模块 Phase B 最多定案 K={k} 条；未覆盖面最多一行「未覆盖缺口」。

【每条发现强制字段】验证方式∈全文精读|运行验证|静态推断·未读全|待核实；
定案∈属实|误报|部分属实|待核实（亦接受常见英文同义如
confirmed/false_positive/pending，结构闸归一；禁「属实（不进 N）」等带括号后缀的复合写法）；
证据指针=文件:行或命令+退出码（JSON ``evidence``：非空 string，或同构 string[] /
path+line 对象；结构闸归一，勿交空数组）。
安全/路径/注入类必写可达性（输入是否用户可控+调用链一句话）；其它中+建议写。
硬规则：验证方式为未读全或定案为待核实 → 不得标中及以上。
硬规则：验证方式为「静态推断·未读全」且未做运行验证时，失败模式类断言
（如「某 API 会抛 X 导致挂起」）默认不得标属实中+——标待核实/观察，或补跑验证后再升。

【路径找错禁令】报「模块/目录不存在」前须 Glob/`apps/*` 与 import 路径解析；
`file_list`/列目录失败或「不是目录」≠ 模块不存在（常见误报：promo/website 实际在 apps/ 下）。

【严重度】高|中|低|观察·工程（落盘/汇总以中文为权威；亦接受 P0–P3 与常见英文同义
P0/critical/high→高，P1/medium→中，P2/low→低，P3/info/observation→观察·工程，
结构闸归一；禁带括号后缀的复合写法）。
高=明确利用/注入路径，或静默丢数据/错归属且用户可感知；
中=可达安全削弱/错配即挂/工具误伤本机其它工程；产品语义错默认中；
低=纵深缺失/不可达/探针质量/属实可修的小工程卫生（低进 N）；
观察·工程=超时/未读全/纯慢（不进 N）。禁止把全量 tsc/pytest 超时写成中+缺陷。

【Phase B checklist·中+属实前必过】①cleanup/定义须读全或全文 grep 证缺；
②标识符未定义须全文搜；③ignore/配置查根+包内，能跑则 git check-ignore / git ls-files；
④「不存在」按 import 路径解析；⑤穿越/注入追生成源头；⑥范本对比先确认对照有、本处无；
⑦标高必须写出谁在什么输入下触发。

【交付骨架·唯一】报告须含且仅以这些大节组织：
〇、人审速览（仍成立中+ / 已撤销 / 待核实与缺口）→ 一、属实缺陷 → 二、已撤销 → 三、观察与工程债。
正向确认默认不写。禁止套 research_report 学术审校环；质量靠 A/B+本契约。
""".strip()


# 产物路径权威（约定文档命名公约）：``code-audit-{slot}-{slug}.md``；
# slot = 0/1/2…（勿把 run id ``audit_0`` 叠进文件名）；汇总 ``code-audit-summary.md``。
# 长模块作文只进 task【module】正文；禁止把整段描述当文件名再硬截断（易截断扩展名/括弧）。
_SLUG_MAX = 40
_SLUG_HEAD_SEPS = ("：", ":", "（", "(", "—", "–", " - ", " — ")
_CODE_AUDIT_SUMMARY_ARTIFACT = f"{REVIEWS_DIR}/code-audit-summary.md"


def _module_slug(hint: str) -> str:
    """Short filename token from a module hint (head before descriptive tail)."""
    s = hint.strip()
    for sep in _SLUG_HEAD_SEPS:
        if sep in s:
            s = s.split(sep, 1)[0].strip()
            break
    s = s.replace("\\", "_").replace("/", "_").replace("..", "_")
    s = "_".join(s.split())  # collapse whitespace
    return (s[:_SLUG_MAX] or "scope")


def _report_artifact(slot: int, hint: str) -> str:
    """Stable short path: numeric slot disambiguates; slug is human skim only."""
    return f"{REVIEWS_DIR}/code-audit-{slot}-{_module_slug(hint)}.md"


def _auditor_task_body(
    *,
    scope: str,
    module: str,
    focus: str,
    k: int,
    artifact: str,
) -> str:
    focus_line = f"侧重：{focus}。" if focus else "全类问题均可报，按 rubric 定严重度。"
    json_artifact = companion_audit_json_path(artifact)
    return (
        f"对范围【{scope}】中的模块【{module}】做代码审计（只读调查：默认不改业务源码；"
        f"允许 file_write/str_replace 写入约定文档报告，除此以外勿改工程）。{focus_line}"
        f"{_AUDIT_DISCIPLINE.format(k=k)}"
        f"完整报告用 file_write 落到 `{artifact}`（Markdown）；"
        f"另交配套 `{json_artifact}`（findings：severity/verification/verdict/"
        f'evidence 等；evidence 例 `"a.ts:10"` 或 `["a.ts:10","b.ts:20"]`）。'
        "handoff 人审速览（可执行摘要，不代落盘）："
        "【一次交接】先把 Markdown + .audit.json 终稿 file_write 定稿，再调用一次 handoff；"
        "handoff 后勿再改同一报告并二次 handoff（除非主管续派）。"
        "summary 写共 N 条属实（只计「一、属实缺陷」）与报告完整相对路径"
        f"（须含约定文档前缀，如 `{artifact}`，禁裸 reviews/…）；禁空话「审计完成」。"
        "key_points 须覆盖属实缺陷——每条格式 `缺陷id|严重度|一句话`，"
        "另含完整报告路径一条；空话不够。"
        "本轮正文可短/空（详情在文件），但 summary + key_points 不得空泛。"
        "受 handoff 条数上限时中+优先，并写「另有 n 条见报告」。"
        "不得以 handoff 替代落盘（Markdown 与 .audit.json 仍须 file_write）。"
        "【收口口径】向用户/主管交接时写「报告已落盘、未改业务源码」；"
        "禁止「通过验收 / 全程只读 / 未使用写工具」。"
        "短命令优先：rg/grep、定点 read、git check-ignore、git ls-files；"
        "禁止把全量 typecheck/全量 pytest 超时当作中+缺陷证据。"
    )


def _auditor_deliverable(artifact: str, name: str) -> dict[str, Any]:
    json_artifact = companion_audit_json_path(artifact)
    return {
        "form": "files",
        "name": name,
        "artifacts": [artifact, json_artifact],
        "required_sections": list(_REQUIRED_SECTIONS),
        "must_contain": ["验证方式", "定案"],
        "strict": True,
        "code_audit_gate": True,
    }


def code_audit(args: dict[str, Any]) -> tuple[list[dict[str, Any]], list[str]]:
    """代码审计：1 人两阶段 A→B；多模块则并行审计员 + 主管跨模块速览。

    与 ``parallel_brief``（摸底对齐）、``research_report``（成文+学术审校）、
    ``repair_code``（按症状修）划界：本形状专产纪律化审计报告。
    """
    scope = clean_str(args.get("scope") or args.get("topic") or args.get("target"))
    if not scope:
        return [], [
            "code_audit 需要 slot『scope』（审计范围：路径/模块/子系统；"
            "亦接受 topic/target）"
        ]

    focus = clean_str(args.get("focus"))
    k_raw = args.get("k")
    try:
        k = int(k_raw) if k_raw is not None and str(k_raw).strip() != "" else _DEFAULT_K
    except (TypeError, ValueError):
        return [], ["code_audit slot『k』须为正整数（每模块 Phase B 定案上限）"]
    if k < 1 or k > 40:
        return [], ["code_audit slot『k』须在 1–40（默认 8）"]

    modules = clean_str_list(
        args.get("modules") or args.get("angles") or args.get("areas"),
        cap=None,
    )
    out_override = clean_str(args.get("output_path"))

    if not modules:
        label = clean_str(args.get("label")) or "main"
        artifact = out_override or _report_artifact(0, label)
        return [
            {
                "id": "audit_0",
                "role": "代码审计员",
                "task": _auditor_task_body(
                    scope=scope, module=scope, focus=focus, k=k, artifact=artifact
                ),
                "deliverable": _auditor_deliverable(
                    artifact, f"代码审计报告（已落盘 {artifact}）"
                ),
            }
        ], []

    if len(modules) < 2:
        return [], [
            "code_audit 若传 modules/angles，须 ≥2 个模块（单模块请省略 modules，"
            "只用 scope）"
        ]

    slots, fold_note = fold_fanout_slots(
        modules, label="审计模块", limit=CODE_AUDIT_FANOUT
    )
    fold_hint = f" {fold_note}" if fold_note else ""
    tasks: list[dict[str, Any]] = []
    audit_ids: list[str] = []

    for i, parts in enumerate(slots):
        merged = len(parts) > 1
        label = " + ".join(parts)
        tid = f"audit_{i}"
        # 路径用短 slug；完整 modules 文案只进 module_desc / deliverable 展示名。
        path_hint = parts[0] if not merged else f"merged-{i}"
        artifact = _report_artifact(i, path_hint)
        module_desc = (
            f"合并模块：{'、'.join(f'【{p}】' for p in parts)}（须全部覆盖）"
            if merged
            else parts[0]
        )
        audit_ids.append(tid)
        body: dict[str, Any] = {
            "id": tid,
            "role": "代码审计员",
            "task": (
                _auditor_task_body(
                    scope=scope, module=module_desc, focus=focus, k=k, artifact=artifact
                )
                + fold_hint
            ),
            "deliverable": _auditor_deliverable(
                artifact, f"【{label}】审计报告（已落盘 {artifact}）"
            ),
        }
        if fold_note and merged:
            body["playbook_note"] = fold_note
        tasks.append(body)

    synth_path = out_override or _CODE_AUDIT_SUMMARY_ARTIFACT
    tasks.append(
        {
            "id": "audit_synth",
            "role": "审计主管",
            "depends_on": list(audit_ids),
            "task": (
                f"汇总主题【{scope}】下各路代码审计报告，产出**跨模块人审速览**（一页内）："
                "仍成立的中+（去重）/ 已撤销 / 待核实与未覆盖缺口；"
                "N 只计各路「一、属实缺陷」合并去重后的条数。"
                "速览须显著短于交接/合成上限，细节只进落盘文件、勿把分册全文塞进汇总或 handoff。"
                "【合并硬规则】同模块多份报告必须去重；条目冲突标「冲突·未定案」且不得进 N；"
                "某路称「模块/目录未检出」时，主管须对照 apps/* 核实后再写缺口。"
                f"先 file_read 各审计员落盘报告，再 file_write 到 `{synth_path}`。"
                "【一次交接】汇总定稿后再 handoff 一次；禁先交再改再交。"
                "handoff 人审速览同审计员：key_points 覆盖属实（`缺陷id|严重度|一句话`）"
                f"+ 汇总路径 `{synth_path}`；summary 须含结论+路径；"
                "空话不够；不得以 handoff 代落盘。"
                "【收口口径】写「汇总已落盘、未改业务源码」；禁「通过验收 / 全程只读」。"
                "不要重做全量审计；不要套 research_report 审校环。"
                "正向确认默认不写。"
            ),
            "deliverable": {
                "form": "files",
                "name": f"跨模块审计人审速览（已落盘 {synth_path}）",
                "artifacts": [synth_path],
                "required_sections": ["人审速览", "属实中+", "缺口"],
                "must_contain": ["属实", "撤销"],
            },
        }
    )
    return tasks, []
