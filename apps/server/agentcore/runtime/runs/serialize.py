"""JSON (de)serialization for a recoverable RunSession (P3 跨进程落盘).

Kept out of the in-memory types so the roster core stays import-light. The message
shape mirrors the OpenAI / DeepSeek wire form (role / content / tool_calls /
tool_call_id / reasoning_content) and round-trips back into :class:`LLMMessage`, so
``continue_run`` replays the exact context — including a worker's tool-call turns and
tool results — after loading from disk. :class:`RunSpec` is ``asdict``-ed and rebuilt
with its nested :class:`RunPolicy` / :class:`RunContract` (``continue_run`` reads
``spec.policy.contract``), tolerating unknown / missing keys so a later schema tweak
never breaks loading an older row.
"""

from __future__ import annotations

from dataclasses import asdict, fields
from typing import Any

from agentcore.llm.protocol import LLMMessage, ToolCall, ToolCallFunction
from agentcore.runtime.runs.session import RunSession
from agentcore.runtime.runs.types import RunContract, RunKind, RunPolicy, RunSpec


def _tool_call_to_dict(tc: ToolCall) -> dict[str, Any]:
    return {
        "id": tc.id,
        "type": tc.type,
        "function": {"name": tc.function.name, "arguments": tc.function.arguments},
    }


def _tool_call_from_dict(d: dict[str, Any]) -> ToolCall:
    fn = d.get("function") or {}
    return ToolCall(
        id=str(d.get("id", "")),
        type=d.get("type", "function"),
        function=ToolCallFunction(
            name=str(fn.get("name", "")), arguments=str(fn.get("arguments", ""))
        ),
    )


def message_to_dict(m: LLMMessage) -> dict[str, Any]:
    """One transcript message → a compact JSON dict (omitting empty optionals)."""
    out: dict[str, Any] = {"role": m.role}
    if m.content is not None:
        out["content"] = m.content
    if m.tool_calls:
        out["tool_calls"] = [_tool_call_to_dict(tc) for tc in m.tool_calls]
    if m.tool_call_id:
        out["tool_call_id"] = m.tool_call_id
    if m.reasoning_content:
        out["reasoning_content"] = m.reasoning_content
    return out


def message_from_dict(d: dict[str, Any]) -> LLMMessage:
    tcs = d.get("tool_calls")
    return LLMMessage(
        role=d.get("role", "user"),
        content=d.get("content"),
        tool_calls=[_tool_call_from_dict(t) for t in tcs] if tcs else None,
        tool_call_id=d.get("tool_call_id"),
        reasoning_content=d.get("reasoning_content"),
    )


def transcript_to_json(transcript: list[LLMMessage]) -> list[dict[str, Any]]:
    return [message_to_dict(m) for m in transcript]


def transcript_from_json(data: list[dict[str, Any]] | None) -> list[LLMMessage]:
    return [message_from_dict(d) for d in (data or [])]


def _filtered(cls: type, data: dict[str, Any] | None) -> dict[str, Any]:
    """Keep only keys that are real fields of ``cls`` — tolerate schema drift so a
    row written by an older/newer build still loads."""
    names = {f.name for f in fields(cls)}
    return {k: v for k, v in (data or {}).items() if k in names}


def spec_to_json(spec: RunSpec) -> dict[str, Any]:
    """RunSpec → JSON dict. ``asdict`` recurses into RunPolicy / RunContract; the
    StrEnum ``kind`` serializes as its string value through JSONB."""
    return asdict(spec)


def spec_from_json(data: dict[str, Any]) -> RunSpec:
    """Rebuild a RunSpec (with nested RunPolicy / RunContract) from its JSON dict."""
    data = dict(data or {})
    policy_raw = dict(data.pop("policy", None) or {})
    contract_raw = policy_raw.pop("contract", None)
    policy = RunPolicy(**_filtered(RunPolicy, policy_raw))
    if contract_raw:
        policy.contract = RunContract(**_filtered(RunContract, contract_raw))
    kwargs = _filtered(RunSpec, data)
    kwargs["policy"] = policy
    kind = kwargs.get("kind")
    if isinstance(kind, str):
        kwargs["kind"] = RunKind(kind)
    return RunSpec(**kwargs)


def session_to_row(session: RunSession) -> dict[str, Any]:
    """The persisted columns for a RunSession (``conversation_id`` is attached by the
    repository from the turn envelope, not stored on the in-memory session)."""
    return {
        "run_id": session.run_id,
        "spec": spec_to_json(session.spec),
        "transcript": transcript_to_json(session.transcript),
        "content": session.content,
        "recall_count": session.recall_count,
    }


def session_from_row(row: Any) -> RunSession:
    """Rebuild a RunSession from a ``RunSessionRow`` (attribute access)."""
    return RunSession(
        run_id=row.run_id,
        spec=spec_from_json(row.spec),
        transcript=transcript_from_json(row.transcript),
        content=row.content or "",
        recall_count=row.recall_count or 0,
    )
