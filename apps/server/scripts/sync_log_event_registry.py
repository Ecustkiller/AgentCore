"""Scan logger.* call sites and regenerate agentcore/observability/catalog.py.

Also pair with ``gen_log_event_docs.py`` to refresh the markdown event table::

    uv run python scripts/sync_log_event_registry.py
    uv run python scripts/gen_log_event_docs.py
"""

from __future__ import annotations

import ast
import re
import unicodedata
from pathlib import Path

# Match ruff E501: East-Asian wide chars count as 2 columns.
_LINE_LIMIT = 100

ROOT = Path(__file__).resolve().parents[1]
AGENTCORE = ROOT / "agentcore"
OUT = AGENTCORE / "observability" / "catalog.py"
LEVELS = {"info", "warning", "error", "debug", "exception", "critical"}
NAME_RE = re.compile(r"^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$")

# Lightweight field schemas for high-value events (docs / debugging).
KEY_FIELDS: dict[str, dict[str, str]] = {
    "chat.turn_start": {
        "preview": "str",
        "chars": "int",
        "history": "int",
        "location": "str",
        "via": "str",
    },
    "chat.turn_complete": {
        "finish_reason": "str",
        "rounds": "int",
        "input_tokens": "int",
        "output_tokens": "int",
        "reply_preview": "str",
        "delegated": "bool",
        "workers": "int",
        "duration_ms": "int",
        "boundary_yields": "int",
        "scope_signals": "int",
        "revises": "int",
        "escalations": "int",
        "prepare_ms": "int",
        "assemble_ms": "int",
        "ttft_reasoning_ms": "int",
        "ttft_content_ms": "int",
        "model": "str",
        "credential_source": "str",
        "provider_id": "str",
    },
    "chat.resume_complete": {
        "finish_reason": "str",
        "delegated": "bool",
        "duration_ms": "int",
        "boundary_yields": "int",
        "scope_signals": "int",
        "revises": "int",
        "escalations": "int",
    },
    "chat.regenerate_rejected": {
        "conversation_id": "str",
        "message_id": "str",
        "user_id": "str",
        "reason": "str",
        "found_role": "str",
    },
    "chat.prepare_phase": {
        "phase": "str",
        "ms": "int",
    },
    "desktop.mcp_list_ok": {
        "duration_ms": "int",
        "tool_count": "int",
        "ready_servers": "int",
        "failed_servers": "int",
    },
    "desktop.mcp_list_degraded": {
        "detail": "str",
        "duration_ms": "int",
        "tool_count": "int",
        "failed_servers": "int",
    },
    "desktop.mcp_list_cache_hit": {
        "conversation_id": "str",
        "cache_scope": "str",
        "degraded": "bool",
        "tool_count": "int",
        "duration_ms": "int",
    },
    "desktop.mcp_list_cache_miss": {
        "conversation_id": "str",
        "cache_scope": "str",
        "detail": "str",
        "duration_ms": "int",
        "tool_count": "int",
    },
    "desktop.mcp_list_cache_seed": {
        "conversation_id": "str",
        "cache_scope": "str",
        "degraded": "bool",
        "tool_count": "int",
    },
    "account.rules_memory_cache_hit": {
        "user_id": "str",
        "folder_id": "str",
        "degraded": "bool",
        "topic_count": "int",
    },
    "account.rules_memory_cache_miss": {
        "user_id": "str",
        "folder_id": "str",
    },
    "account.rules_memory_cache_seed": {
        "user_id": "str",
        "folder_id": "str",
        "degraded": "bool",
        "topic_count": "int",
        "memory_file_count": "int",
        "ttl_seconds": "float",
    },
    "account.rules_memory_warm_failed": {
        "user_id": "str",
        "folder_id": "str",
        "part": "str",
        "error": "str",
    },
    "sidecar.warm_account_rules_memory": {
        "user_id": "str",
        "folder_id": "str",
        "degraded": "bool",
        "topic_count": "int",
        "memory_file_count": "int",
    },
    "sidecar.warm_account_rules_memory_failed": {
        "user_id": "str",
        "folder_id": "str",
        "error": "str",
    },
    "delegate.started": {
        "nodes": "int",
        "call": "str",
        "parallel": "int",
        "agents": "list",
        "plan": "list",
        "waves": "list",
    },
    "delegate.completed": {
        "escalations": "int",
        "scope": "int",
        "scope_ratio": "float",
    },
    "delegate.yielded": {"reason": "str"},
    "delegate.continuation_ok": {"run_id": "str"},
    "delegate.continuation_rejected": {
        "run_id": "str",
        "reason": "str",
        "cause": "str",
    },
    "roster.session_evicted": {
        "run_id": "str",
        "reason": "str",
        "bytes": "int",
        "total_bytes": "int",
        "max_bytes": "int",
        "n_sessions": "int",
    },
    "session_roster.wired": {
        "persist": "bool",
        "loader": "bool",
        "conversation_id": "str",
    },
    "delegate.run_redirect_hot": {
        "execution_id": "str",
        "cancelled_run_id": "str",
        "continuation_run_id": "str",
        "recall_count": "int",
    },
    "delegate.delivery_status_empty": {
        "execution_id": "str",
        "delivered_count": "int",
        "gaps_count": "int",
        "rejected_count": "int",
    },
    "delegate.delivery_status_emitted": {
        "execution_id": "str",
        "state": "str",
        "artifacts_count": "int",
        "accepted_count": "int",
        "rejected_count": "int",
        "gaps_count": "int",
    },
    "worker.escalate": {
        "kind": "str",
        "blocking": "bool",
        "question": "str",
        "assumption": "str",
    },
    "tool.execute_start": {"tool": "str"},
    "tool.execute_end": {
        "tool": "str",
        "status": "str",
        "duration_ms": "int",
        "reason": "str",
        "index_status": "str",
    },
    "tool.args_parse_failed": {
        "pos": "int",
        "msg": "str",
        "args_preview": "str",
        "parse_class": "str",
    },
    "tool.args_salvaged": {"args_preview": "str"},
    "tool.web_search": {"query": "str", "hosts": "list"},
    "worker.handoff": {
        "run_id": "str",
        "has_summary": "bool",
        "chars": "int",
        "body_chars": "int",
        "has_motion_card": "bool",
    },
    "react.round_start": {"round": "int"},
    "react.round_end": {
        "round": "int",
        "tools": "int",
        "input_tokens": "int",
        "output_tokens": "int",
        "reasoning_tokens": "int",
        "done": "bool",
    },
    "engine.loop_nudge": {},
    "engine.loop_finalize": {},
    "engine.ceiling_finalize": {
        "reason": "str",
        "thrashing": "bool",
        "rounds": "int",
        "tokens": "int",
        "token_budget": "int",
    },
    "llm.call": {
        "scenario": "str",
        "model": "str",
        "latency_ms": "int",
        "finish_reason": "str",
        "input_tokens": "int",
        "output_tokens": "int",
        "reasoning_tokens": "int",
        "stream": "bool",
        "cost_nano": "int",
    },
    "llm.request": {"scenario": "str", "model": "str"},
    "llm.response": {"scenario": "str", "model": "str"},
    "llm.call_failed": {
        "error": "str",
        "scenario": "str",
        "model": "str",
        "credential_source": "str",
        "provider_id": "str",
    },
    "llm.stream_stalled": {
        "model": "str",
        "credential_source": "str",
        "provider_id": "str",
        "scenario": "str",
        "committed": "bool",
    },
    "contract.retry": {},
    "contract.failed": {},
    "run.failed": {"error": "str"},
    "run.captain_failed": {"error": "str"},
    "cost.recorded": {
        "runs": "int",
        "total_nano": "int",
        "total_usd": "float",
        "models": "list",
        "by_role": "dict",
    },
    "cost.prompt_assembled": {
        "scope": "str",
        "total_chars": "int",
        "sections": "dict",
        "assembly_hash": "str",
        "over_soft_cap": "bool",
        "soft_cap": "int",
    },
    "cost.ledger_write_failed": {"error": "str"},
    "cost.ledger_drain_before_reconcile_failed": {},
    "workspace.snapshot_created": {},
    "workspace.snapshot_failed": {"error": "str"},
    "workspace.system_snapshot_prune_failed": {"error": "str"},
    "workspace.index_build_start": {
        "force": "bool",
    },
    "workspace.index_build_complete": {
        "force": "bool",
        "updated": "bool",
        "duration_ms": "int",
        "generation": "int",
        "truncated": "bool",
        "files": "int",
    },
    "workspace.index_skip_channel_busy": {
        "force": "bool",
        "wait_ms": "int",
        "inflight": "int",
    },
    "workspace.index_failed": {
        "force": "bool",
        "duration_ms": "int",
        "error": "str",
    },
    "pipeline.error": {"error": "str"},
    "http.unhandled_error": {"method": "str", "path": "str", "error": "str"},
    "http.db_pool_exhausted": {"method": "str", "path": "str", "error": "str"},
    "db.pool_exhausted_snapshot": {
        "pool": "str",
        "checked_out": "int",
        "capacity": "int",
        "holders": "list",
    },
    "db.pool_checkout_slow": {
        "pool": "str",
        "held_s": "float",
        "task_name": "str",
        "stack": "list",
        "trace_id": "str",
        "conversation_id": "str",
        "run_id": "str",
        "agent_id": "str",
    },
    "approval.sandbox_auto_pass": {"tool": "str"},
    "approval.timeout": {"tool": "str"},
    "firehose.backpressure_drop": {},
    "auth.login_failed": {
        "reason": "str",
        "user_id": "str",
        "subject": "str",
        "platform": "str",
        "method": "str",
    },
    "auth.mfa_enrolled": {"user_id": "str"},
    "auth.mfa_recovery_used": {"user_id": "str"},
    "llm_provider.key_updated": {"user_id": "str", "provider_id": "str"},
    "llm_provider.deleted": {"user_id": "str", "provider_id": "str"},
    "sidecar.turn_cancel_requested": {
        "turn_id": "str",
        "reason": "str",
        "coordination_cascaded": "bool",
        "task_cancelled": "bool",
    },
    "sidecar.turn_cancelled": {
        "turn_id": "str",
        "reason": "str",
        "salvaged": "bool",
    },
    "compaction.done": {
        "conversation_id": "str",
        "folded": "int",
        "kept": "int",
        "summary_chars": "int",
        "trigger_input_tokens": "int",
    },
    "compaction.failed": {
        "conversation_id": "str",
        "error": "str",
    },
    "compaction.timeout": {
        "conversation_id": "str",
    },
    "compaction.schedule_failed": {
        "conversation_id": "str",
        "error": "str",
    },
    "billing.background_byok_provider_error": {
        "user_id": "str",
        "purpose": "str",
        "provider_id": "str",
        "reason": "str",
        "error": "str",
    },
    "memory.consolidation_window_dropped": {
        "conversation_id": "str",
        "error": "str",
        "error_type": "str",
        "reason": "str",
        "window_through": "str",
    },
    "rate_limit.redis_fail_open": {
        "prefix": "str",
        "error": "str",
        "count": "int",
    },
    "event_sink.detach": {
        "reason": "str",
        "conversation_id": "str",
        "message_id": "str",
        "already_detached": "bool",
    },
    "event_sink.close": {
        "reason": "str",
        "conversation_id": "str",
        "message_id": "str",
        "was_detached": "bool",
    },
}

# S3-retired names: no emit site, kept so old JSONL still validates against the registry.
# Descriptions must say 历史兼容 — do not present as current contract.
HISTORICAL_COMPAT: dict[str, str] = {
    "delegate.completion_criteria_hoisted": (
        "历史兼容（S3 前）：criteria hoist；现行不发"
    ),
    "delegate.completion_criteria_unmet": (
        "历史兼容（S3 前）：按 kind 硬判未满足；现行不发"
    ),
}

KEY_DESC: dict[str, str] = {
    "chat.turn_start": "回合起点（preview/chars/history）",
    "chat.turn_complete": "回合收尾（含 Phase-0 延迟：prepare/assemble/ttft_*；model/credential_source）",
    "chat.resume_complete": "暂停恢复回合收尾（终态带协作计数；STOP 终结不带）",
    "chat.regenerate_rejected": (
        "regenerate 早退拒绝（会话不存在 / 目标非用户消息或已删除）；排前端传错 id"
    ),
    "chat.prepare_phase": "prepare/assemble 分段耗时（phase + ms；每 phase 一行）",
    "desktop.mcp_list_ok": "MCP list 成功（duration_ms / tool_count）",
    "desktop.mcp_list_degraded": "MCP list 超时或降级（带 duration_ms）",
    "desktop.mcp_list_cache_hit": "MCP list 命中进程内缓存（含 cache_scope / duration_ms）",
    "desktop.mcp_list_cache_miss": "MCP list 只读缓存未命中（prepare/resume；不发 ClientTool）",
    "desktop.mcp_list_cache_seed": "MCP list 结果写入进程内缓存（非回合暖）",
    "delegate.started": "编排委派开始（agents/plan/waves）",
    "delegate.completed": "委派批次完成（escalations/scope）",
    "delegate.yielded": "委派中途让出（replan 边界）",
    "delegate.completion_criteria_ignored": (
        "S3：CEO 误传已删 completion_criteria 时打点（忽略字段，非硬闸）"
    ),
    "delegate.run_redirect_hot": "redirect 热修续派（revise 重算桶，与 continuation_ok 同义）",
    "delegate.delivery_status_empty": (
        "交付卡判定无物质不发（delivered/gaps/rejected 计数；巡检可证静默原因）"
    ),
    "delegate.delivery_status_emitted": (
        "交付卡已发射（state + artifacts/accepted/rejected/gaps 计数）"
    ),
    "worker.escalate": "worker 升级求决策",
    "tool.execute_end": "工具执行结束（status/duration_ms；error 时带 reason）",
    "tool.args_salvaged": "handoff 参数 JSON 窄 salvage 成功（裸字符串字段 / 截断闭合）",
    "worker.handoff": "worker 交接（chars=summary 长；body_chars=交付正文长）",
    "react.round_end": "ReAct 轮结束（reasoning_tokens/tools）",
    "engine.loop_nudge": "收敛治理：循环提醒",
    "engine.loop_finalize": "收敛治理：强制收尾",
    "engine.ceiling_finalize": "收敛治理：硬顶强制收尾（reason=max_rounds 轮预算耗尽 / token_budget）",
    "llm.call": "单次 LLM 调用（latency/tokens/cost_nano）",
    "llm.request": "LLM prompt 截断脱敏（需 LOG_LLM_BODIES）",
    "llm.response": "LLM 回复截断脱敏（需 LOG_LLM_BODIES）",
    "llm.call_failed": "LLM 调用失败（model/credential_source；可取则带 provider_id）",
    "llm.stream_stalled": "LLM 流式空闲超时（model/credential_source；可取则带 provider_id）",
    "cost.recorded": "回合落账成功（含 by_role 角色拆解）",
    "cost.prompt_assembled": "系统提示装配观测（段 chars + assembly_hash；零行为副作用）",
    "pipeline.error": "回合管线未捕获异常",
    "http.unhandled_error": "HTTP 层未捕获异常",
    "http.db_pool_exhausted": "主库连接池耗尽（快失败 503，非 PG 宕机）",
    "db.pool_exhausted_snapshot": (
        "连接池枯竭快照：当前持有者上下文/已持时长（非 readiness）"
    ),
    "db.pool_checkout_slow": "连接归还过慢（持有超过阈值；含 checkout 时上下文）",
    "auth.login_failed": "敏感操作审计：登录失败（password/unknown/locked/mfa/role；无明文凭据）",
    "auth.mfa_enrolled": "敏感操作审计：Admin MFA 绑定确认成功",
    "auth.mfa_recovery_used": "敏感操作审计：Admin MFA 恢复码成功消费",
    "llm_provider.key_updated": "敏感操作审计：BYOK API Key 轮换保存（无明文）",
    "llm_provider.deleted": "敏感操作审计：BYOK 服务商（含密钥）删除",
    "sidecar.turn_cancel_requested": (
        "桌面 cancel RPC 到达 sidecar（solo blocking 无 coordination.user_stop_* 时的指纹）"
    ),
    "sidecar.turn_cancelled": (
        "本地回合 CancelledError salvage；reason=cancelled_without_rpc 表示非 RPC cancel"
    ),
    "billing.background_byok_provider_error": (
        "后台 chrome 因非重试配置形失败将用户 BYOK 服务商标为 error"
        "（设置页红色徽章；error 字段表示写库失败）"
    ),
    "billing.background_platform_auth_fallback": (
        "后台 chrome 平台 key 被上游 auth 拒绝后一次回落用户 BYOK"
    ),
    "compaction.done": "长对话压缩成功（folded/kept/summary_chars）",
    "compaction.failed": "长对话压缩失败（顶层异常；不推水位）",
    "compaction.timeout": "长对话压缩 LLM 超时（空摘要；不推水位）",
    "compaction.schedule_failed": "压缩调度 due 判定异常",
    "memory.consolidation_window_dropped": (
        "不可重试 consolidation 失败：推进水位并丢弃本窗口（防 sweeper 无限重选）"
    ),
    "rate_limit.redis_fail_open": (
        "Redis 限流请求中途失败 → fail-open 放行本请求（可告警；与 construct 期 "
        "security.rate_limit_redis_fallback 对偶）"
    ),
    "event_sink.detach": (
        "SSE 消费者 detach（断线/排队无 waiter 等）；already_detached 区分幂等再 detach"
    ),
    "event_sink.close": (
        "EventSink 真 close（开→关仅一条）；was_detached 区分先前仅断线 vs 仍附着收口"
    ),
    "workspace.index_build_start": "后台代码索引 ensure 开始（IndexMaintainer）",
    "workspace.index_build_complete": (
        "后台代码索引 ensure 完成（duration_ms；可取则带 generation/truncated/files）"
    ),
    "workspace.index_skip_channel_busy": (
        "Local channel 仍忙，跳过本轮索引并 coalesce 重试"
    ),
    "workspace.index_failed": "后台代码索引 ensure 失败（带 error/duration_ms）",
    "sidecar.warm_code_index": "静默暖代码索引（initialize / warmCodeIndex RPC schedule）",
    "sidecar.warm_mcp_discover": "静默暖 MCP 列表进进程缓存（warmMcpDiscover RPC seed）",
    "sidecar.warm_account_rules_memory": (
        "静默暖账户 rules/memory 进 prepare 快照缓存（warmAccountRulesMemory）"
    ),
    "sidecar.warm_account_rules_memory_failed": "warmAccountRulesMemory 拉取失败",
    "account.rules_memory_cache_hit": "prepare rules/memory 命中进程快照缓存",
    "account.rules_memory_cache_miss": (
        "prepare rules/memory 只读缓存未命中（空注入；不 await 云）"
    ),
    "account.rules_memory_cache_seed": "账户 rules/memory 快照写入进程缓存（非回合暖）",
    "account.rules_memory_warm_failed": "warm 拉取 rules/memory 部分失败（degraded seed）",
}


def scan_events() -> set[str]:
    events: set[str] = set()
    for path in AGENTCORE.rglob("*.py"):
        if "observability" in path.parts and path.name in {"catalog.py", "events.py"}:
            continue
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        except SyntaxError:
            continue
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            if not isinstance(func, ast.Attribute) or func.attr not in LEVELS:
                continue
            if not node.args:
                continue
            arg0 = node.args[0]
            if isinstance(arg0, ast.Constant) and isinstance(arg0.value, str):
                name = arg0.value
                if NAME_RE.fullmatch(name):
                    events.add(name)
    return events


def _display_width(s: str) -> int:
    return sum(2 if unicodedata.east_asian_width(c) in ("F", "W") else 1 for c in s)


def _format_description_arg(indent: str, desc: str) -> list[str]:
    """Emit ``description=...`` lines, each ≤ ``_LINE_LIMIT`` display cols."""
    single = f"{indent}description={desc!r},"
    if _display_width(single) <= _LINE_LIMIT:
        return [single]
    # Parenthesized implicit string concat so long CJK desc stays under limit.
    inner = indent + "    "
    lines = [f"{indent}description=("]
    remaining = desc
    while remaining:
        lo, hi, best = 1, len(remaining), 1
        while lo <= hi:
            mid = (lo + hi) // 2
            candidate = f"{inner}{remaining[:mid]!r}"
            if _display_width(candidate) <= _LINE_LIMIT:
                best = mid
                lo = mid + 1
            else:
                hi = mid - 1
        lines.append(f"{inner}{remaining[:best]!r}")
        remaining = remaining[best:]
    lines.append(f"{indent}),")
    return lines


def _format_spec(name: str) -> list[str]:
    """Emit one EventSpec as one or more lines (keep ≤100 cols)."""
    desc = KEY_DESC.get(name, "")
    fields = KEY_FIELDS.get(name, {})
    if not fields and not desc:
        return [f"    EventSpec(name={name!r}),"]
    if not fields:
        one = f"    EventSpec(name={name!r}, description={desc!r}),"
        if _display_width(one) <= _LINE_LIMIT:
            return [one]
        out = ["    EventSpec(", f"        name={name!r},"]
        out.extend(_format_description_arg("        ", desc))
        out.append("    ),")
        return out
    out = ["    EventSpec(", f"        name={name!r},"]
    if desc:
        out.extend(_format_description_arg("        ", desc))
    out.append("        fields={")
    for k, v in sorted(fields.items()):
        out.append(f"            {k!r}: FieldType({v!r}),")
    out.append("        },")
    out.append("    ),")
    return out


def write_catalog(events: list[str]) -> None:
    lines = [
        '"""Auto-maintained event catalog for product AI logs.',
        "",
        "Source of truth for event *names* currently emitted via ``logger.*``.",
        "Regenerate with::",
        "",
        "    uv run python scripts/sync_log_event_registry.py",
        "",
        "Do not hand-edit the ``EVENTS`` list — add field/description enrichments",
        "via ``KEY_FIELDS`` / ``KEY_DESC`` in the sync script, then re-run.",
        '"""',
        "",
        "from __future__ import annotations",
        "",
        "from agentcore.observability.events import EventSpec, FieldType",
        "",
        "# fields empty means name-only registration.",
        "EVENTS: list[EventSpec] = [",
    ]
    for name in events:
        lines.extend(_format_spec(name))
    lines.append("]")
    lines.append("")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    scanned = scan_events()
    events = sorted(scanned | set(HISTORICAL_COMPAT))
    # Guard against dead names lingering in the enrichment maps (an event name
    # with no emit site never enters the catalog, so its enrichment is a zombie).
    # HISTORICAL_COMPAT names are intentionally emit-less — exclude from dead check.
    known = scanned | set(HISTORICAL_COMPAT)
    dead = sorted((set(KEY_FIELDS) | set(KEY_DESC)) - known)
    for name in dead:
        print(f"WARNING: enrichment for {name!r} has no emit site (dead name?)")
    # Merge historical descriptions into KEY_DESC for catalog emit.
    for name, desc in HISTORICAL_COMPAT.items():
        KEY_DESC.setdefault(name, desc)
    write_catalog(events)
    print(f"wrote {OUT} ({len(events)} events; {len(HISTORICAL_COMPAT)} historical-compat)")
    if dead:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
