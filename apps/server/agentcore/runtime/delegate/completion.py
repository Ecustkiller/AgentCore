"""Delegate completion criteria: verify delivery before CEO can treat delegate as done."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal

from agentcore.llm.provider.protocol import LLMMessage
from agentcore.runtime.runs.types import RunPhase, RunState

if TYPE_CHECKING:
    from agentcore.runtime.runs.plan import RunPlan

CompletionCriteriaKind = Literal["files_written", "code_verified", "custom"]
DEFAULT_COMPLETION_CRITERIA: CompletionCriteriaKind = "files_written"

# Task text hints that imply run/open/install acceptance — engine auto-applies
# ``code_verified`` when the CEO omits ``completion_criteria`` (Phase 1 自动验证).
_EXECUTION_TASK_HINTS = re.compile(
    r"(运行|启动|打开|安装|跑通|联调|验收|测试通过|"
    r"npm\s+(run|start)|pnpm\s+(run|start)|yarn\s+(run|start|dev)|"
    r"python\s+-m|uv\s+run|pip\s+run|cargo\s+run|go\s+run|进程)",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class CompletionCriteria:
    kind: CompletionCriteriaKind
    description: str = ""


def parse_completion_criteria(raw: Any) -> CompletionCriteria | None:
    """Parse delegate ``completion_criteria``; ``None`` means no explicit enforcement."""
    if raw is None:
        return None
    if isinstance(raw, str):
        if raw in ("files_written", "code_verified", "custom"):
            return CompletionCriteria(kind=raw)  # type: ignore[arg-type]
        return CompletionCriteria(kind=DEFAULT_COMPLETION_CRITERIA)
    if isinstance(raw, dict):
        kind = raw.get("type") or raw.get("kind") or DEFAULT_COMPLETION_CRITERIA
        if kind not in ("files_written", "code_verified", "custom"):
            kind = DEFAULT_COMPLETION_CRITERIA
        desc = str(raw.get("description") or "")
        return CompletionCriteria(kind=kind, description=desc)  # type: ignore[arg-type]
    return CompletionCriteria(kind=DEFAULT_COMPLETION_CRITERIA)


def plan_suggests_code_verification(plan: RunPlan) -> bool:
    """True when any worker task/objective reads like run/open/install acceptance."""
    for node in plan.nodes:
        text = f"{node.task}\n{node.objective}".strip()
        if text and _EXECUTION_TASK_HINTS.search(text):
            return True
    return False


def plan_declares_artifacts(plan: RunPlan) -> bool:
    """True when any worker deliverable declares a non-empty ``artifacts`` list."""
    for node in plan.nodes:
        d = node.deliverable
        if d is not None and d.artifacts:
            return True
    return False


def plan_declares_files_form(plan: RunPlan) -> bool:
    """True when any worker deliverable declares ``form=files``."""
    for node in plan.nodes:
        d = node.deliverable
        if d is not None and d.form == "files":
            return True
    return False


def plan_all_workers_prose(plan: RunPlan) -> bool:
    """True when every worker explicitly declares ``form=prose`` (non-empty plan)."""
    if not plan.nodes:
        return False
    for node in plan.nodes:
        d = node.deliverable
        if d is None or d.form != "prose":
            return False
    return True


def validate_completion_against_forms(
    raw: Any,
    plan: RunPlan,
) -> str | None:
    """Reject ``files_written`` when every worker is ``form=prose`` (契约矛盾).

    Returns an error message for the CEO, or ``None`` when the combination is fine.
    """
    if raw is None:
        return None
    criteria = parse_completion_criteria(raw)
    if criteria is None or criteria.kind != "files_written":
        return None
    if not plan_all_workers_prose(plan):
        return None
    return (
        "契约矛盾：completion_criteria=files_written 要求至少一名 worker 落盘，"
        "但本批全部 worker 均为 deliverable.form=prose（纯文字、不授写文件工具）。"
        "改法：① 纯文字交付请省略 completion_criteria，或改用 code_verified（若需跑通验证）；"
        "② 若确需落盘，把对应 worker 的 deliverable.form 改为 files。"
    )


def resolve_completion_criteria(
    raw: Any,
    plan: RunPlan | None = None,
) -> CompletionCriteria | None:
    """Parse explicit criteria, or infer from task text / declared artifacts / form=files.

    Omitted criteria stay unenforced unless (a) task text implies run/open/install
    → ``code_verified``, or (b) any worker declared ``artifacts`` or ``form=files``
    → ``files_written``. Never auto-infers ``files_written`` for an all-prose batch.
    """
    if raw is not None:
        return parse_completion_criteria(raw)
    if plan is not None and plan_suggests_code_verification(plan):
        return CompletionCriteria(kind="code_verified")
    if plan is not None and plan_all_workers_prose(plan):
        return None
    if plan is not None and (plan_declares_artifacts(plan) or plan_declares_files_form(plan)):
        return CompletionCriteria(kind="files_written")
    return None


def _code_execute_succeeded_in_transcript(transcript: list[LLMMessage]) -> bool:
    """True when at least one ``code_execute`` call completed without a non-zero exit."""
    call_names: dict[str, str] = {}
    for msg in transcript:
        if msg.role != "assistant" or not msg.tool_calls:
            continue
        for tc in msg.tool_calls:
            call_names[tc.id] = tc.function.name
    for msg in transcript:
        if msg.role != "tool" or not msg.tool_call_id:
            continue
        if call_names.get(msg.tool_call_id) != "code_execute":
            continue
        content = msg.content or ""
        if "退出码" not in content:
            return True
    return False


def _test_run_succeeded_in_transcript(transcript: list[LLMMessage]) -> bool:
    """True when at least one ``test_run`` completed with zero failures/errors."""
    call_names: dict[str, str] = {}
    for msg in transcript:
        if msg.role != "assistant" or not msg.tool_calls:
            continue
        for tc in msg.tool_calls:
            call_names[tc.id] = tc.function.name
    for msg in transcript:
        if msg.role != "tool" or not msg.tool_call_id:
            continue
        if call_names.get(msg.tool_call_id) != "test_run":
            continue
        content = msg.content or ""
        if "测试未通过" in content:
            continue
        fail_m = re.search(r"失败：(\d+)", content)
        err_m = re.search(r"错误：(\d+)", content)
        if fail_m and int(fail_m.group(1)) > 0:
            continue
        if err_m and int(err_m.group(1)) > 0:
            continue
        if "通过：" in content:
            return True
    return False


def _run_verified_in_transcript(transcript: list[LLMMessage]) -> bool:
    return _code_execute_succeeded_in_transcript(
        transcript,
    ) or _test_run_succeeded_in_transcript(transcript)


def _worker_files_written(state: RunState) -> bool:
    if state.files_touched:
        return True
    return bool(state.transcript and _files_from_transcript(state.transcript))


def _files_from_transcript(transcript: list[LLMMessage]) -> list[str]:
    from agentcore.runtime.runs.serialize import files_touched_from_transcript

    return files_touched_from_transcript(transcript)


def check_delegate_completion(
    criteria: CompletionCriteria | None,
    results: dict[str, RunState],
) -> tuple[bool, list[str]]:
    """Return ``(ok, gaps)`` after all workers in a delegate batch finish.

    Explicit ``criteria`` is evaluated against every COMPLETED worker's real
    signals (``files_touched``, transcript tool results, handoff ``debrief``,
    prose ``content``)—not only workers with non-empty body text. A pure
    file_write / handoff finish with empty streamed content must still be
    checked; with no matching evidence the result is a gap, never a vacuous
    pass. ``criteria is None`` (omitted) remains unenforced.
    """
    if criteria is None:
        return True, []

    # Include all COMPLETED workers — empty body is a valid finish mode
    # (落盘 / handoff-only). Filtering on content.strip() used to drop them
    # and vacuous-pass when the filtered set was empty.
    completed = [s for s in results.values() if s.phase is RunPhase.COMPLETED]
    if not completed:
        return True, []

    gaps: list[str] = []
    if criteria.kind == "files_written":
        if not any(_worker_files_written(s) for s in completed):
            gaps.append("尚无 worker 将产物写入工作区（需要 file_write / str_replace 落盘）")
    elif criteria.kind == "code_verified":
        if not any(_run_verified_in_transcript(s.transcript) for s in completed):
            gaps.append(
                "尚无 worker 成功运行 code_execute / test_run 验证代码",
            )
    elif criteria.kind == "custom":
        # custom is intentionally not engine-verified. Never block completion on it —
        # a gap here used to mark successful delegates as unfinished. Prefer
        # files_written / code_verified / deliverable.artifacts instead.
        return True, []

    return (not gaps, gaps)


def format_completion_gap_message(gaps: list[str]) -> str:
    return "[系统提示] 完成条件未满足：" + "；".join(gaps)


def collect_worker_gaps(
    plan: RunPlan,
    results: dict[str, RunState],
) -> list[tuple[str, list[str]]]:
    """Per-worker structured gaps for CEO synthesis (warnings + degraded handoff).

    Returns ``[(role_label, gap_lines), ...]`` only for workers that still carry
    contract / handoff shortfalls after soft-accept — so forced convergence finalize
    (write tools withheld) still surfaces what was never delivered.
    """
    out: list[tuple[str, list[str]]] = []
    for node in plan.nodes:
        state = results.get(node.run_id)
        if state is None or state.phase is not RunPhase.COMPLETED:
            continue
        gaps: list[str] = []
        if state.warnings:
            gaps.extend(str(w) for w in state.warnings if str(w).strip())
        debrief = state.debrief if isinstance(state.debrief, dict) else None
        if debrief and debrief.get("degraded"):
            gaps.append("交接简报由引擎降级合成（worker 未提交合格 handoff）")
        if gaps:
            label = node.role or node.run_id
            out.append((label, gaps))
    return out


def format_worker_gaps_block(gaps_by_worker: list[tuple[str, list[str]]]) -> str:
    """CEO-facing「契约缺口」section, or "" when nobody has residual gaps."""
    if not gaps_by_worker:
        return ""
    lines = [
        "\n### ⚠️ 契约缺口（请据缺口补派 / continue_from_run_id 续派，勿靠自觉扫清单）\n"
        "以下是各队员收尾后仍未对齐的声明交付物 / 交接缺口（含收敛强制收尾后无法再写文件"
        "留下的缺口）。用 delegate / continue_from_run_id 补齐，别假装收工。\n"
    ]
    for label, gaps in gaps_by_worker:
        joined = "；".join(gaps)
        lines.append(f"- **{label}**：{joined}")
    return "\n".join(lines)
