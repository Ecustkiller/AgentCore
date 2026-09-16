"""On-demand tool roster — listed in ``<按需目录>``, omitted from the
opening OpenAI tool table until ``consult(name)`` (or a family sibling) promotes them.

Not an intent classifier: the builtin split is ``ToolRegistration.resident``
(False = defer), identical for every task. Discovered MCP tools (``mcp_*``)
join the same gate by prefix so their schemas stay off the opening table;
the catalog still lists them.
Tools stay registered (catalog / execute / skill gates / capability lines); only
``ToolRegistry.get_openai_definitions`` withholds them until offered.
"""

from __future__ import annotations

import json
import re
from collections.abc import Collection, Sequence
from functools import lru_cache

# Retired model-facing names → current on-demand tool (consult / window recall /
# offer). Did-you-mean for unknown *calls* lives in ``registry._KNOWN_TOOL_ALIASES``
# (never auto-execute). Keep these two maps in lockstep when retiring a name.
RETIRED_ON_DEMAND_NAMES: dict[str, str] = {
    "md_to_docx": "md_export",
    "md_to_pdf": "md_export",
}

# Consulting any member offers every assembled sibling in the same family.
_FAMILIES: tuple[frozenset[str], ...] = (
    frozenset({"archive_extract", "archive_create"}),
    frozenset({"create_folder", "delete_folder"}),
    frozenset({"file_move", "file_copy", "file_batch"}),
    frozenset({"table_ops", "table_read"}),
    frozenset({"docs_read", "docs_write"}),
    frozenset({"list_folder_dir", "read_folder_file"}),
)

_FAMILY_LABELS: dict[frozenset[str], str] = {
    frozenset({"archive_extract", "archive_create"}): "压缩包",
    frozenset({"create_folder", "delete_folder"}): "文件夹增删",
    frozenset({"file_move", "file_copy", "file_batch"}): "搬移/批量",
    frozenset({"table_ops", "table_read"}): "表格",
    frozenset({"docs_read", "docs_write"}): "创作文档",
    frozenset({"list_folder_dir", "read_folder_file"}): "跨桌只读",
}

# Skill consult → enable the matching on-demand tool (HOW 与按钮同一查阅)。
_SKILL_OFFERS_TOOLS: dict[str, frozenset[str]] = {
    "debate_and_review": frozenset({"debate"}),
}

_CONSULT_TOOL_NAMES = frozenset(
    {"consult", "consult_memory", "consult_skill", "consult_rule"}
)


@lru_cache(maxsize=1)
def _declared_on_demand() -> tuple[frozenset[str], dict[str, str], dict[str, str]]:
    """Builtin names / summaries / faces where ``resident`` is False."""
    from agentcore.tools.registration import (
        declared_tool_name,
        declared_tool_schema,
        declared_tools,
        tool_registration,
    )

    names: set[str] = set()
    summaries: dict[str, str] = {}
    faces: dict[str, str] = {}
    for cls in declared_tools():
        reg = tool_registration(cls)
        if reg.resident:
            continue
        name = declared_tool_name(cls)
        names.add(name)
        summaries[name] = reg.catalog_summary
        faces[name] = declared_tool_schema(cls).face.value
    return frozenset(names), summaries, faces


def on_demand_builtin_names() -> frozenset[str]:
    return _declared_on_demand()[0]


def on_demand_face(name: str) -> str:
    """``ToolFace`` value for a builtin on-demand name; empty if unknown / MCP."""
    return _declared_on_demand()[2].get(name, "")


def is_mcp_tool_name(name: str) -> bool:
    """FC names minted by ``sanitize_mcp_tool_name`` (``mcp_{server}_{tool}``)."""
    return name.startswith("mcp_")


def is_on_demand_tool(name: str) -> bool:
    return name in on_demand_builtin_names() or is_mcp_tool_name(name)


def family_of(name: str, *, registry: object | None = None) -> frozenset[str]:
    """Name plus any family siblings (always includes ``name`` itself).

    Builtin families are the static table. MCP tools share a family per
    assembled Server (``McpDynamicTool.mcp_server_id``); without a registry
    the dynamic siblings are unknown, so the name stands alone.
    """
    for family in _FAMILIES:
        if name in family:
            return family
    if registry is not None and is_mcp_tool_name(name):
        get = getattr(registry, "get_optional", None)
        names = getattr(registry, "names", None)
        if callable(get) and names is not None:
            tool = get(name)
            server_id = getattr(tool, "mcp_server_id", None) if tool is not None else None
            if server_id:
                siblings = [
                    n
                    for n in names
                    if is_mcp_tool_name(n)
                    and getattr(get(n), "mcp_server_id", None) == server_id
                ]
                if siblings:
                    return frozenset(siblings)
    return frozenset({name})


def family_catalog_meta(name: str) -> tuple[str, str]:
    """Catalog group key + label for builtin families. Empty when the tool is solo."""
    for family in _FAMILIES:
        if name in family:
            return "+".join(sorted(family)), _FAMILY_LABELS.get(family, "")
    return "", ""


_ENABLED_SPAN_RE = re.compile(r"已启用工具\s+(.+?)。")
_FAMILY_SPAN_RE = re.compile(r"同族已一并启用：([^。]+)")
_TICK_RE = re.compile(r"`([^`]+)`")


def tools_offered_by_consult_name(name: str) -> frozenset[str]:
    """On-demand tools a catalog consult name should promote (skill or tool)."""
    key = (name or "").strip()
    if not key:
        return frozenset()
    return _SKILL_OFFERS_TOOLS.get(key, frozenset())


def format_enabled_tools_note(names: Sequence[str]) -> str:
    """Stable consult suffix so the next window can re-offer without re-reading the skill."""
    listed = [n.strip() for n in names if str(n).strip()]
    if not listed:
        return ""
    ticks = "、".join(f"`{n}`" for n in listed)
    return (
        f"\n\n已启用工具 {ticks}。"
        "本回合下一模型轮工具表将含完整参数，"
        "可直接调用（不必等用户再发一条）。"
    )


def enabled_tool_names_from_text(text: str) -> tuple[str, ...]:
    """Parse consult enable-ack (and family line) back into tool names."""
    seen: set[str] = set()
    out: list[str] = []

    def add(raw: str) -> None:
        key = raw.strip()
        if not key or key in seen:
            return
        seen.add(key)
        out.append(key)

    blob = text or ""
    for match in _ENABLED_SPAN_RE.finditer(blob):
        span = match.group(1)
        ticks = _TICK_RE.findall(span)
        if ticks:
            for tick in ticks:
                for part in re.split(r"[、,]", tick):
                    add(part)
        else:
            for part in re.split(r"[、,]", span):
                add(part)
    for match in _FAMILY_SPAN_RE.finditer(blob):
        for part in match.group(1).split("、"):
            add(part)
    return tuple(out)


def offer_bound_tools(registry: object, names: Collection[str]) -> list[str]:
    """Enable assembled on-demand tools (and their family). Skip missing / resident names."""
    offer = getattr(registry, "offer", None)
    get = getattr(registry, "get_optional", None)
    if not callable(offer) or not callable(get):
        return []
    enabled: list[str] = []
    seen: set[str] = set()
    for raw in names:
        key = str(raw or "").strip()
        if not key:
            continue
        resolved = resolve_on_demand_name(registry, key)
        if resolved is None or not is_on_demand_tool(resolved):
            continue
        if get(resolved) is None:
            continue
        for member in sorted(family_of(resolved, registry=registry)):
            if member in seen or get(member) is None or not is_on_demand_tool(member):
                continue
            offer(member)
            seen.add(member)
            enabled.append(member)
    return enabled


def offer_skill_promoted_tools(registry: object, skill_name: str) -> list[str]:
    """Enable tools a system skill consult unlocks. Returns newly or already offered names."""
    return offer_bound_tools(registry, tools_offered_by_consult_name(skill_name))


def resolve_on_demand_name(registry: object | None, name: str) -> str | None:
    """Map a catalog / consult name onto a registered on-demand tool.

    Accepts an exact tool name, or an MCP Server id / display name (consult the
    Server → offer the whole assembled family).
    """
    key = (name or "").strip()
    if not key or registry is None:
        return None
    key = RETIRED_ON_DEMAND_NAMES.get(key, key)
    get = getattr(registry, "get_optional", None)
    names = getattr(registry, "names", None)
    if get is not None and callable(get) and get(key) is not None:
        return key
    if not callable(get) or names is None:
        return None
    needle = key.lower()
    for candidate in names:
        if not is_mcp_tool_name(candidate):
            continue
        tool = get(candidate)
        if tool is None:
            continue
        sid = str(getattr(tool, "mcp_server_id", "") or "").strip().lower()
        sname = str(getattr(tool, "mcp_server_name", "") or "").strip().lower()
        if needle in (sid, sname):
            return candidate
    return None


def offer_tools_from_window(registry: object, messages: Sequence[object]) -> int:
    """Re-offer on-demand tools already used or consulted in this conversation window.

    Same-turn resume and the next user message both rebuild the deferred set;
    without this, a tool already enabled in the bubble is missing from the table.
    User-skill bindings ride the consult enable-ack in the tool result, not a static map.
    Returns how many ``offer`` calls changed the deferred set.
    """
    offer = getattr(registry, "offer", None)
    if not callable(offer):
        return 0
    from agentcore.llm.provider.protocol import llm_content_text

    recalled: list[str] = []
    seen: set[str] = set()
    consult_result_ids: set[str] = set()
    for message in messages or ():
        for fname, arguments, call_id in _tool_calls_from_message(message):
            raw = fname.strip()
            if raw in _CONSULT_TOOL_NAMES:
                if call_id:
                    consult_result_ids.add(call_id)
                raw = _consult_name_arg(arguments)
            if not raw or raw in seen:
                continue
            seen.add(raw)
            recalled.append(raw)
        role = getattr(message, "role", None)
        if role is None and isinstance(message, dict):
            role = message.get("role")
        if role != "tool":
            continue
        call_id = str(
            getattr(message, "tool_call_id", None)
            or (message.get("tool_call_id") if isinstance(message, dict) else "")
            or ""
        )
        if consult_result_ids and call_id not in consult_result_ids:
            continue
        payload = (
            message.get("content")
            if isinstance(message, dict)
            else getattr(message, "content", None)
        )
        for name in enabled_tool_names_from_text(llm_content_text(payload)):
            if name in seen:
                continue
            seen.add(name)
            recalled.append(name)

    wanted: list[str] = []
    wanted_seen: set[str] = set()

    def _want(raw: str) -> None:
        key = (raw or "").strip()
        if not key or key in wanted_seen:
            return
        if not is_on_demand_tool(key):
            return
        wanted_seen.add(key)
        wanted.append(key)

    for name in recalled:
        for target in tools_offered_by_consult_name(name):
            _want(target)
            for member in family_of(target, registry=registry):
                _want(member)
        resolved = resolve_on_demand_name(registry, name)
        if resolved:
            _want(resolved)
            for member in family_of(resolved, registry=registry):
                _want(member)
        _want(name)
        for member in family_of(name, registry=registry):
            _want(member)

    changed = 0
    for name in wanted:
        if offer(name):
            changed += 1
    return changed


def _tool_calls_from_message(message: object) -> list[tuple[str, str, str]]:
    if message is None:
        return []
    role = getattr(message, "role", None)
    if role is None and isinstance(message, dict):
        role = message.get("role")
        tcs = message.get("tool_calls") or []
    else:
        if role != "assistant":
            return []
        tcs = getattr(message, "tool_calls", None) or []
    if role != "assistant":
        return []
    out: list[tuple[str, str, str]] = []
    for tc in tcs:
        fn = getattr(tc, "function", None)
        call_id = str(getattr(tc, "id", "") or "")
        if fn is not None:
            out.append(
                (
                    str(getattr(fn, "name", "") or ""),
                    str(getattr(fn, "arguments", "") or ""),
                    call_id,
                )
            )
            continue
        if isinstance(tc, dict):
            nested = tc.get("function")
            call_id = str(tc.get("id") or "")
            if isinstance(nested, dict):
                out.append(
                    (
                        str(nested.get("name") or ""),
                        str(nested.get("arguments") or ""),
                        call_id,
                    )
                )
            else:
                out.append(
                    (str(tc.get("name") or ""), str(tc.get("arguments") or ""), call_id)
                )
    return out


def _consult_name_arg(arguments: str) -> str:
    try:
        data = json.loads(arguments or "")
    except (json.JSONDecodeError, TypeError, ValueError):
        return ""
    if isinstance(data, dict):
        return str(data.get("name") or "").strip()
    return ""


def on_demand_summary(name: str, *, description: str = "") -> str:
    """One-line catalog text. Builtins use registration; MCP uses live schema."""
    static = _declared_on_demand()[1].get(name)
    if static:
        return static
    if is_mcp_tool_name(name):
        desc = " ".join((description or "").split())
        return desc or name
    return name


def render_tool_consult_body(
    name: str,
    *,
    description: str,
    audience: str | None,
    enabled: Sequence[str],
) -> str:
    """Enable-ack + one HOW owner. Full JSON stays on the next FC table.

    CEO + host/terminal/browser/grant: consult HOW only (no schema reprint).
    No HOW: enable-ack only — do not paste the schema description a second time.
    """
    del description
    siblings = [n for n in enabled if n != name]
    lines = [
        (
            f"已启用工具 `{name}`。本回合下一模型轮工具表将含完整参数，"
            "可直接调用（不必等用户再发一条）。"
        ),
    ]
    if siblings:
        lines.append("同族已一并启用：" + "、".join(siblings) + "。")
    how = _ceo_how_for(name) if audience == "ceo" else ""
    if how:
        lines.append("")
        lines.append(how)
    return "\n".join(lines)


def _ceo_how_for(name: str) -> str:
    """CEO routing manuals: unique owner is this consult body, not the frozen core."""
    from agentcore.runtime.resolve.prompt.ceo_core import capability_how_suffix

    return capability_how_suffix({name})


def __getattr__(name: str) -> object:
    """Derived roster aliases for tests (``ON_DEMAND_TOOL_NAMES`` / summaries)."""
    if name == "ON_DEMAND_TOOL_NAMES":
        return on_demand_builtin_names()
    if name == "ON_DEMAND_SUMMARIES":
        return dict(_declared_on_demand()[1])
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
