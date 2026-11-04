"""Lifecycle hook runner (生成 / 最后修订 2026-11-04).

**只从服务端环境变量读命令**，不是用户可配、更不是模型可调用的工具。
外部命令通过 ``create_subprocess_exec``（无 shell）执行，stdin 收一条 JSON，
stdout 读一条 JSON 判定；硬超时、失败 / 非 JSON 一律 fail-open 记 warning，
**只有明确拿到 deny 才拒绝工具调用**。

pre hook 的 allow 一律忽略：`tool_exec_gates.py` 是「这次调用要不要人批」的
唯一收口点，钩子只能收窄，绝不短路 ApprovalGate / always_confirm /
boundary_block_message。post hook 只观测，拿不到也改不了 ``ToolResult``。
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import re
from dataclasses import dataclass
from typing import Any

from agentcore.config import settings
from agentcore.core.logging import get_logger

logger = get_logger(__name__)

EVENT_PRE = "pre_tool_use"
EVENT_POST = "post_tool_use"
_ALLOWED_EVENTS = frozenset({EVENT_PRE, EVENT_POST})
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")
MAX_HOOKS = 16
MAX_COMMAND_PARTS = 8
MAX_PART_LENGTH = 512
MAX_MATCHER_LENGTH = 200
MAX_STDOUT_BYTES = 65_536
MAX_PAYLOAD_BYTES = 65_536
MAX_REASON_LENGTH = 500

# 如实声明 v1 没做的事。
HOOK_CAPABILITIES = {
    "enabled_by_default": False,
    "events": (EVENT_PRE, EVENT_POST),
    "stop_or_session_events": False,
    "user_configurable_commands": False,
    "model_callable_hook_tool": False,
    "pre_hook_allow_can_bypass_approval": False,
    "post_hook_can_modify_result": False,
    "external_command_sandboxed": False,
    "post_hook_delivery": "fire-and-forget with hard timeout",
}


@dataclass(frozen=True, slots=True)
class HookSpec:
    event: str
    matcher: re.Pattern[str]
    command: tuple[str, ...]
    timeout_seconds: float


@dataclass(frozen=True, slots=True)
class HookVerdict:
    """只用来表达「拒绝」；返回 None 表示没有钩子要拒（allow 被忽略）。"""

    decision: str
    reason: str


_SPEC_CACHE: dict[str, tuple[HookSpec, ...]] = {}


def _clamp_timeout(raw: Any) -> float:
    try:
        value = float(raw)
    except (TypeError, ValueError):
        value = settings.runtime_hooks_default_timeout_seconds
    return max(1.0, min(value, 30.0))


def parse_hook_spec(raw: str) -> tuple[HookSpec, ...]:
    """解析 JSON 声明；坏形状跳过坏项，整体坏形状返回空（fail closed）。"""
    text = (raw or "").strip()
    if not text:
        return ()
    if text in _SPEC_CACHE:
        return _SPEC_CACHE[text]
    try:
        payload = json.loads(text)
    except (ValueError, TypeError):
        return ()
    if not isinstance(payload, list):
        return ()
    specs: list[HookSpec] = []
    for item in payload:
        if len(specs) >= MAX_HOOKS:
            break
        if not isinstance(item, dict):
            continue
        event = item.get("event")
        if event not in _ALLOWED_EVENTS:
            continue
        matcher_raw = item.get("matcher", ".*")
        if not isinstance(matcher_raw, str) or len(matcher_raw) > MAX_MATCHER_LENGTH:
            continue
        try:
            matcher = re.compile(matcher_raw)
        except re.error:
            continue
        command = item.get("command")
        if not isinstance(command, list) or not 1 <= len(command) <= MAX_COMMAND_PARTS:
            continue
        parts: list[str] = []
        valid = True
        for part in command:
            if (
                not isinstance(part, str)
                or not part
                or len(part) > MAX_PART_LENGTH
                or _CONTROL_RE.search(part)
            ):
                valid = False
                break
            parts.append(part)
        if not valid:
            continue
        specs.append(
            HookSpec(
                event=event,
                matcher=matcher,
                command=tuple(parts),
                timeout_seconds=_clamp_timeout(
                    item.get("timeout_seconds", settings.runtime_hooks_default_timeout_seconds)
                ),
            )
        )
    parsed = tuple(specs)
    if len(_SPEC_CACHE) > 8:
        _SPEC_CACHE.clear()
    _SPEC_CACHE[text] = parsed
    return parsed


def _matching(event: str, tool_name: str, raw_spec: str) -> tuple[HookSpec, ...]:
    return tuple(
        spec
        for spec in parse_hook_spec(raw_spec)
        if spec.event == event and spec.matcher.search(tool_name)
    )


def tool_hook_payload(
    *,
    event: str,
    tool_name: str,
    args: Any,
    tc_id: str,
    context: Any,
    success: bool | None = None,
) -> dict[str, Any]:
    """交给外部命令的一次调用快照；不含凭据，工具入参按原样带出并限长。"""
    tool_input = args if isinstance(args, dict) else {}
    payload: dict[str, Any] = {
        "event": event,
        "tool_name": tool_name,
        "tool_input": tool_input,
        "tool_call_id": tc_id,
        "run_id": str(getattr(context, "run_id", "") or ""),
        "conversation_id": str(getattr(context, "conversation_id", "") or ""),
        "user_id": str(getattr(context, "user_id", "") or ""),
        "agent_id": str(getattr(context, "agent_id", "") or ""),
    }
    if success is not None:
        payload["success"] = bool(success)
    if len(json.dumps(payload, ensure_ascii=False, default=str).encode()) > MAX_PAYLOAD_BYTES:
        payload["tool_input"] = {"_truncated": True, "reason": "payload_too_large"}
    return payload


async def _run_one(
    spec: HookSpec, payload: dict[str, Any], tool_name: str
) -> str | None:
    """返回拒绝原因；``None`` = 放行。除明确 deny 外一律 fail-open。"""
    body = json.dumps(payload, ensure_ascii=False, default=str).encode()
    try:
        proc = await asyncio.create_subprocess_exec(
            *spec.command,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except (OSError, ValueError) as exc:
        logger.warning(
            "hook.failed",
            hook_event=spec.event,
            tool=tool_name,
            reason="spawn_failed",
            error=str(exc)[:MAX_REASON_LENGTH],
        )
        return None
    try:
        stdout, _stderr = await asyncio.wait_for(
            proc.communicate(body), timeout=spec.timeout_seconds
        )
    except TimeoutError:
        with contextlib.suppress(ProcessLookupError):
            proc.kill()
        with contextlib.suppress(Exception):
            await proc.wait()
        logger.warning(
            "hook.failed",
            hook_event=spec.event,
            tool=tool_name,
            reason="timeout",
            error="",
        )
        return None
    except Exception as exc:  # noqa: BLE001 — 外部命令绝不能拖垮回合
        logger.warning(
            "hook.failed",
            hook_event=spec.event,
            tool=tool_name,
            reason="io_failed",
            error=str(exc)[:MAX_REASON_LENGTH],
        )
        return None

    text = stdout[:MAX_STDOUT_BYTES].decode("utf-8", "replace").strip()
    parsed: Any = None
    if text:
        try:
            parsed = json.loads(text)
        except ValueError:
            parsed = None
    reason = ""
    if isinstance(parsed, dict) and isinstance(parsed.get("reason"), str):
        reason = parsed["reason"][:MAX_REASON_LENGTH]
    denied = proc.returncode == 2 or (
        isinstance(parsed, dict) and parsed.get("decision") == "deny"
    )
    if not denied:
        return None
    return reason or "hook denied the tool call"


async def run_pre_tool_hooks(*, tool_name: str, payload: dict[str, Any]) -> HookVerdict | None:
    """默认关 / 无匹配钩子时零开销；只有明确的 deny 才返回 verdict。"""
    if not settings.runtime_hooks_enabled:
        return None
    hooks = _matching(EVENT_PRE, tool_name, settings.runtime_hooks_spec)
    if not hooks:
        return None
    for spec in hooks:
        reason = await _run_one(spec, payload, tool_name)
        logger.info(
            "hook.invoked",
            hook_event=EVENT_PRE,
            tool=tool_name,
            decision="deny" if reason is not None else "allow",
        )
        if reason is not None:
            logger.info("hook.denied", hook_event=EVENT_PRE, tool=tool_name, reason=reason)
            return HookVerdict(decision="deny", reason=reason)
    return None


_POST_TASKS: set[asyncio.Task[None]] = set()


async def run_post_tool_hooks(*, tool_name: str, payload: dict[str, Any]) -> None:
    if not settings.runtime_hooks_enabled:
        return
    for spec in _matching(EVENT_POST, tool_name, settings.runtime_hooks_spec):
        await _run_one(spec, payload, tool_name)
        logger.info(
            "hook.invoked", hook_event=EVENT_POST, tool=tool_name, decision="observe"
        )
    return None


def schedule_post_tool_hooks(*, tool_name: str, payload: dict[str, Any]) -> None:
    """只观测、fire-and-forget；排不上任务也只记 warning，不影响工具结果。"""
    try:
        if not settings.runtime_hooks_enabled:
            return
        if not _matching(EVENT_POST, tool_name, settings.runtime_hooks_spec):
            return
        task = asyncio.create_task(run_post_tool_hooks(tool_name=tool_name, payload=payload))
        _POST_TASKS.add(task)
        task.add_done_callback(_POST_TASKS.discard)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "hook.failed",
            hook_event=EVENT_POST,
            tool=tool_name,
            reason="schedule_failed",
            error=str(exc)[:MAX_REASON_LENGTH],
        )


async def drain_post_hooks() -> None:
    """测试 / 收尾用：等待已排队的 post hook 跑完（生产路径不会调它）。"""
    if _POST_TASKS:
        await asyncio.gather(*tuple(_POST_TASKS), return_exceptions=True)
