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


def resolve_completion_criteria(
    raw: Any,
    plan: RunPlan | None = None,
) -> CompletionCriteria | None:
    """Parse explicit criteria, or infer ``code_verified`` from delegate task text."""
    if raw is not None:
        return parse_completion_criteria(raw)
    if plan is not None and plan_suggests_code_verification(plan):
        return CompletionCriteria(kind="code_verified")
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
    """Return ``(ok, gaps)`` after all workers in a delegate batch finish."""
    if criteria is None:
        return True, []

    completed = [
        s
        for s in results.values()
        if s.phase is RunPhase.COMPLETED and s.content.strip()
    ]
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
        if criteria.description.strip():
            gaps.append(f"自定义完成条件未验证：{criteria.description.strip()}")
        else:
            gaps.append("自定义完成条件未声明具体描述，无法机械校验")

    return (not gaps, gaps)


def format_completion_gap_message(gaps: list[str]) -> str:
    return "[系统提示] 完成条件未满足：" + "；".join(gaps)
