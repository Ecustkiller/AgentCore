"""build_run_plan — raw delegate args → RunPlan (第一阶段：内联角色版).

Single / parallel / DAG stop being distinct *modes* and become one RunPlan whose
shape falls out of the ``depends_on`` edges (no deps + 1 task = single; no deps +
N = parallel; any deps = a DAG). Pure and dict-based.

第一阶段：每个 task 自带「内联角色」（role / objective / tools / model_preference /
…），无独立 Agent 实体与 allow-list。``agent_id`` 铸成 == ``run_id``，``agent_name``
取 ``role``，仅供 ``run_*`` 事件与图展示。

Run-id minting preserves two schemes: a no-deps batch numbers nodes
``{prefix}_{n}`` so a re-delegate in the same turn never reuses an id, while a
DAG namespaces each declared id ``{prefix}_{raw}`` and rewrites every
``depends_on`` ref the same way, so intra-DAG edges survive.

→ 见设计: docs/03-AI核心/执行引擎架构设计.md §八（Run 模型）
"""

from __future__ import annotations

import re
import time
from typing import Any

from agentcore.core.logging import get_logger
from agentcore.core.types import new_id
from agentcore.runtime.runs.constants import (
    DEFAULT_ON_FAILURE,
    MAX_DELEGATION_TASKS,
    MAX_RUN_RETRIES,
    VALID_ON_FAILURE,
)
from agentcore.runtime.runs.plan import RunPlan, RunPlanError
from agentcore.runtime.runs.types import Deliverable, RunKind, RunOrigin, RunPolicy, RunSpec

_VALID_TIERS = frozenset({"fast", "strong"})
_VALID_EFFORTS = frozenset({"high", "max"})
# Debate/review opposition markers (前端UX设计.md §四): a display-only side tag the
# frontend pairs into a side-by-side comparison; anything else is dropped (lenient,
# mirroring tier/effort) so a stray value never leaks onto the graph.
_VALID_STANCES = frozenset({"pro", "con"})
_VALID_OUTPUT_FORMATS = frozenset({"text", "json"})
_DEFAULT_TIMEOUT_MS = 120_000
_DEFAULT_RETRY_DELAY_MS = 2_000
# Per-sibling excerpt caps in a fan-out awareness summary: a scope line (责任/任务)
# plus a shorter deliverable note (预期产出), kept tight so a wide fan-out's
# awareness block stays scannable and can't blow up a worker's context.
_SIBLING_TASK_CHARS = 150
_SIBLING_OUTPUT_CHARS = 80
_UPSTREAM_HINTS = re.compile(
    r"上游|基于.*(?:产出|结果|输出)|见上游|前置|依赖.*(?:结果|产出)|"
    r"读取.*(?:产出|结果)|upstream|based on|depends on",
    re.IGNORECASE,
)

logger = get_logger(__name__)


def build_run_plan(
    tasks_raw: list[dict[str, Any]],
    *,
    valid_tools: set[str] | None = None,
    id_prefix: str = "",
    counter_start: int = 0,
    max_tasks: int = MAX_DELEGATION_TASKS,
    parent_run_id: str | None = None,
    depth: int = 1,
) -> tuple[RunPlan, list[str]]:
    """Build a RunPlan from raw delegate-tool task args.

    ``valid_tools`` (when given) is the allow-list each task's ``tools`` is
    intersected against — an unknown tool name is dropped silently, mirroring the
    old planner. Returns the plan plus a list of validation errors; a non-empty
    error list means the batch is rejected and the plan must not be run
    (reject-on-error for both flat and DAG batches).

    ``parent_run_id`` / ``depth`` stamp every node with its place in the turn's Run
    tree (阶段2 嵌套子任务): the CEO's direct workers are ``depth=1`` parented to the
    captain root; a worker that re-delegates passes its own run id + depth so its
    sub-workers come out one level deeper. The executor reads ``depth`` to enforce
    the nesting cap.
    """
    if not tasks_raw:
        return RunPlan(), ["'tasks' array is required and cannot be empty"]
    for item in tasks_raw:
        deps = item.get("depends_on")
        if deps is not None:
            item["depends_on"] = [d for d in deps if d and isinstance(d, str) and d.strip()]
    prefix = id_prefix or f"del_{int(time.time() * 1000)}"
    if any(item.get("depends_on") for item in tasks_raw):
        plan, errors = _dag_plan(tasks_raw, valid_tools, prefix, max_tasks, parent_run_id, depth)
    else:
        plan, errors = _flat_plan(
            tasks_raw, valid_tools, prefix, counter_start, max_tasks, parent_run_id, depth
        )
    # Fan-out awareness is computed ONCE here, after the shape-specific build, so a
    # flat batch and a DAG share one definition of「sibling」= nodes that fanned out
    # from the same point (same depends_on). The DAG case is the fix: its parallel
    # nodes (e.g. the 调研 workers a「research → writer」fan-out spawns) used to get
    # nothing and ran blind/overlapping. Skipped for a rejected plan (nodes may be
    # partial).
    if not errors:
        _apply_sibling_summaries(plan)
    return plan, errors


def build_added_nodes(
    adds: list[dict[str, Any]],
    plan: RunPlan,
    *,
    valid_tools: set[str] | None = None,
    parent_run_id: str | None = None,
    depth: int = 1,
    max_tasks: int = MAX_DELEGATION_TASKS,
) -> tuple[list[RunSpec], list[str]]:
    """Build the RunSpecs for a ``replan(add=[…])`` batch the CEO appends to a paused
    ``plan`` at a wave boundary (受监督的波循环 §7.1 续跑入口).

    Returns ``(specs, errors)``. A non-empty ``errors`` means the whole replan is
    rejected (all-or-nothing) and the caller must NOT mutate the plan; this function is
    pure (it never touches ``plan``) so rejection leaves no trace. On success the caller
    appends each spec via :meth:`RunPlan.add`.

    id 生成 + 依赖接线 (the bit that made ``add`` its own phase):
    - each added node gets a fresh collision-free id ``{add_<uuid>}_{raw}`` (a brand-new
      prefix per batch, so re-adds across multiple boundary yields never reuse an id);
    - each ``depends_on`` ref resolves against BOTH the existing plan nodes (a cross-edge
      onto already-declared / completed work) AND the other raw ids in THIS batch
      (intra-edge), so the CEO can append a mini-DAG that hangs off the live graph;
    - role/task are required (like a DAG node); an unknown ``depends_on`` ref, a dup id,
      an over-cap batch, or a cycle introduced among the new nodes is a rejected error.
    """
    if not adds:
        return [], []
    if len(adds) > max_tasks:
        return [], [f"add 一次最多追加 {max_tasks} 个节点（收到 {len(adds)}）"]

    prefix = f"add_{new_id()}"
    existing_ids = {n.run_id for n in plan.nodes}
    # First pass: assign each item a raw id + mint its namespaced run_id, catching dup
    # raw ids up front (two added nodes can't share an id, and a mint must not collide
    # with an existing node — impossible given the fresh prefix, but checked anyway).
    raw_to_minted: dict[str, str] = {}
    minted_ids: list[str] = []
    errors: list[str] = []
    for i, item in enumerate(adds):
        if not isinstance(item, dict):
            errors.append(f"add[{i}] 必须是对象")
            minted_ids.append("")
            continue
        raw = (str(item.get("id")).strip() if item.get("id") is not None else "") or f"n{i}"
        if raw in raw_to_minted:
            errors.append(f"add[{i}]: 重复的 id `{raw}`")
            minted_ids.append("")
            continue
        minted = f"{prefix}_{raw}"
        if minted in existing_ids:
            errors.append(f"add[{i}]: 生成的 run_id `{minted}` 与现有节点冲突")
            minted_ids.append("")
            continue
        raw_to_minted[raw] = minted
        minted_ids.append(minted)
    if errors:
        return [], errors

    # Second pass: validate fields + resolve each depends_on ref (existing node id OR a
    # raw id in this batch). Build the specs reusing the same _inline_spec / _dag_policy
    # the up-front builder uses, so an added node is byte-for-byte a normal worker spec.
    specs: list[RunSpec] = []
    for i, item in enumerate(adds):
        minted = minted_ids[i]
        role = item.get("role")
        task = item.get("task")
        if not (isinstance(role, str) and role.strip()):
            errors.append(f"add[{i}]: 缺少 role")
            continue
        if not (isinstance(task, str) and task.strip()):
            errors.append(f"add[{i}]: 缺少 task")
            continue
        resolved_deps: list[str] = []
        dep_ok = True
        for dep in item.get("depends_on") or []:
            dep_id = str(dep).strip()
            if dep_id in raw_to_minted:
                resolved_deps.append(raw_to_minted[dep_id])
            elif dep_id in existing_ids:
                resolved_deps.append(dep_id)
            else:
                errors.append(f"add[{i}]: depends_on `{dep_id}` 不在当前计划，也不是本次新增节点")
                dep_ok = False
        if not dep_ok:
            continue
        specs.append(
            _inline_spec(
                {**item, "role": role.strip(), "task": task.strip()},
                run_id=minted,
                depends_on=resolved_deps,
                policy=_dag_policy(item),
                valid_tools=valid_tools,
                parent_run_id=parent_run_id,
                depth=depth,
            )
        )
    if errors:
        return [], errors

    # Topology pre-check on the combined graph: existing nodes never gain edges and the
    # existing plan is already acyclic, so the only new cycle risk is among the added
    # nodes — a throwaway combined RunPlan.waves() surfaces it without mutating `plan`.
    try:
        RunPlan(nodes=[*plan.nodes, *specs], origin=plan.origin).waves()
    except RunPlanError as e:
        return [], [f"add 拓扑无效：{e}"]
    return specs, []


def _flat_plan(
    tasks_raw: list[dict[str, Any]],
    valid_tools: set[str] | None,
    prefix: str,
    counter_start: int,
    max_tasks: int,
    parent_run_id: str | None,
    depth: int,
) -> tuple[RunPlan, list[str]]:
    """Single / parallel batch (no deps). Invalid items (missing role or task)
    or an over-cap batch reject the whole plan."""
    if len(tasks_raw) > max_tasks:
        return RunPlan(), [f"任务数 {len(tasks_raw)} 超过上限 {max_tasks}"]
    errors: list[str] = []
    for i, item in enumerate(tasks_raw):
        role = item.get("role")
        task = item.get("task")
        if not (isinstance(role, str) and role.strip()) or not (
            isinstance(task, str) and task.strip()
        ):
            errors.append(f"tasks[{i}]: 'role' 和 'task' 字段必填")
    if errors:
        return RunPlan(), errors
    plan = RunPlan()
    counter = counter_start
    for item in tasks_raw:
        counter += 1
        run_id = f"{prefix}_{counter}"
        plan.add(
            _inline_spec(
                item,
                run_id=run_id,
                policy=RunPolicy(
                    result_handling=item.get("result_handling") or "pass_through",
                ),
                valid_tools=valid_tools,
                parent_run_id=parent_run_id,
                depth=depth,
            )
        )
    return plan, []


def _dag_plan(
    tasks_raw: list[dict[str, Any]],
    valid_tools: set[str] | None,
    prefix: str,
    max_tasks: int,
    parent_run_id: str | None,
    depth: int,
) -> tuple[RunPlan, list[str]]:
    """DAG batch (has deps). Per-run validation collects errors; topology
    (cycle / unknown edge) is checked via ``RunPlan.waves``."""
    if len(tasks_raw) > max_tasks:
        return RunPlan(), [f"任务数 {len(tasks_raw)} 超过上限 {max_tasks}"]
    errors: list[str] = []
    seen_ids: set[str] = set()
    for i, item in enumerate(tasks_raw):
        raw_id = str(item.get("id", "")).strip() or f"n{i}"
        if raw_id in seen_ids:
            errors.append(f"tasks[{i}]: 重复的 id '{raw_id}'")
        seen_ids.add(raw_id)
    if errors:
        return RunPlan(), errors

    plan = RunPlan(origin=RunOrigin.TEMPLATE)
    errors = []

    def _nsid(raw: str) -> str:
        return f"{prefix}_{raw}"

    for i, item in enumerate(tasks_raw):
        raw_id = item.get("id", f"run_{i}")
        role = item.get("role", "")
        task = item.get("task", "")
        if not role:
            errors.append(f"Run '{raw_id}': missing role")
            continue
        if not task:
            errors.append(f"Run '{raw_id}': missing task")
            continue
        plan.add(
            _inline_spec(
                item,
                run_id=_nsid(raw_id),
                depends_on=[_nsid(d) for d in item.get("depends_on", [])],
                policy=_dag_policy(item),
                valid_tools=valid_tools,
                parent_run_id=parent_run_id,
                depth=depth,
            )
        )

    if errors:
        return plan, errors
    try:
        plan.waves()
    except RunPlanError as e:
        return plan, [str(e)]
    for node in plan.nodes:
        if not node.depends_on and node.task and _UPSTREAM_HINTS.search(node.task):
            logger.warning(
                "builder.suspect_missing_dep",
                run_id=node.run_id,
                role=node.role,
                hint="task 提及上游产出但 depends_on 为空",
            )
    return plan, []


def _inline_spec(
    item: dict[str, Any],
    *,
    run_id: str,
    depends_on: list[str] | None = None,
    policy: RunPolicy,
    valid_tools: set[str] | None = None,
    parent_run_id: str | None = None,
    depth: int = 1,
) -> RunSpec:
    """Assemble one RunSpec from a task item's inline-role fields (阶段1)."""
    role = item["role"]
    thinking_raw = item.get("thinking")
    effort_raw = item.get("reasoning_effort")
    pref = item.get("model_preference", "strong")
    model_raw = item.get("model")
    stance_raw = item.get("stance")
    group_raw = item.get("group")
    round_raw = item.get("round")
    return RunSpec(
        run_id=run_id,
        agent_id=run_id,
        agent_name=role,
        kind=RunKind.AGENT,
        task=item["task"],
        role=role,
        objective=item.get("objective", "") or "",
        system_prompt_supplement=item.get("system_prompt_supplement") or None,
        tools=_tools(item.get("tools"), valid_tools),
        model_preference=pref if pref in _VALID_TIERS else "strong",
        # Explicit model override (真·多模型辩手)：宽松解析（仅收非空字符串，否则空=按 tier
        # 解析），由执行器覆写 profile.model 并经路由器分发。普通 worker 不带此字段 → 空。
        model=model_raw.strip() if isinstance(model_raw, str) else "",
        thinking=thinking_raw if isinstance(thinking_raw, bool) else None,
        reasoning_effort=effort_raw if effort_raw in _VALID_EFFORTS else None,
        deliverable=_parse_deliverable(item),
        # 辩论/审查 呈现标记（display-only）：宽松解析，非法 stance 丢弃、group 取整后
        # 字符串、round 仅收正整数（bool 不算，否则 0）。执行器从不读它们，仅透传给
        # run_plan 供前端识别辩论 → 并排渲染 / 按轮次分层。
        stance=stance_raw if stance_raw in _VALID_STANCES else "",
        group=group_raw.strip() if isinstance(group_raw, str) else "",
        round=(
            round_raw
            if isinstance(round_raw, int) and not isinstance(round_raw, bool) and round_raw > 0
            else 0
        ),
        depends_on=depends_on or [],
        # 结构化挂起 2a：计划期挂起标记，宽松读取（非真值即 False），WaveScheduler
        # 在该节点完成后、其下游运行前挂起请用户 plan_review。schema 入口待激活层
        # 接入前，CEO 无从设置此字段，故此处恒为 False、完全 inert。
        checkpoint_after=bool(item.get("checkpoint_after")),
        # 晚绑定标记（受监督的波循环）：宽松读取（非真值即 False），同 checkpoint_after。
        # schema 入口 / 续跑工具（replan）接入前 CEO 无从设置，故恒为 False、完全 inert。
        bind_after_deps=bool(item.get("bind_after_deps")),
        parent_run_id=parent_run_id,
        depth=depth,
        can_delegate=_parse_can_delegate(item.get("can_delegate")),
        policy=policy,
    )


def _parse_can_delegate(raw: Any) -> bool | str:
    """Normalise a task's ``can_delegate`` knob → ``False``, ``True``, or ``"auto"``."""
    if raw == "auto":
        return "auto"
    if raw is True:
        return True
    if raw is False:
        return False
    return False


def _tools(declared: Any, valid_tools: set[str] | None) -> list[str] | None:
    """Normalise a task's declared tool names → an allowed-tools restriction, or
    ``None`` for *no restriction* (the worker is offered all team tools).

    ``None`` is the fail-safe default and is returned whenever a task omits ``tools``
    or names only unknown tools. We never return ``[]``: the engine reads an empty
    allow-list as "offer no tools", which strands a worker that has a file/exec
    deliverable as a text-only agent (it dumps the file content into chat and the
    workspace stays empty). A non-empty list still restricts to the named
    (allow-list-intersected) tools so the CEO can opt into least-privilege.
    """
    if not isinstance(declared, list):
        return None
    names = [t for t in declared if isinstance(t, str) and t]
    if valid_tools is not None:
        names = [t for t in names if t in valid_tools]
    return names or None


def _apply_sibling_summaries(plan: RunPlan) -> None:
    """Populate each node's ``sibling_summary`` with its fan-out siblings — the
    *other* nodes that fanned out from the SAME point (share the exact same
    ``depends_on`` set), so they run in parallel toward the same juncture.

    This is the precise「parallel sibling」notion: a「research → writer」fan-out's
    researchers share their dependency set (both have no deps, or both wait on the
    same upstream) and so see each other — the gap this fixes (a DAG used to give its
    parallel nodes nothing, so they ran blind/overlapping). It is deliberately
    NARROWER than「same wave」: two *independent* chains can land in one topological
    wave by coincidence (``s2`` deps ``[s1]`` and ``u2`` deps ``[u1]``) yet are not
    siblings — coupling those would bloat a worker's context with unrelated
    concurrent work and blur branch independence (cf. the checkpoint-steer isolation
    guarantee). A flat parallel batch is the degenerate case (every node shares the
    empty dep set → all siblings, unchanged); a node with no same-fan-out peer (a
    pipeline link, a lone writer) stays blank. A node never lists its own
    upstream/downstream — those arrive separately via ``depends_on``.

    Mutates specs in place; reads only ``depends_on`` so it is safe on any plan."""
    groups: dict[frozenset[str], list[RunSpec]] = {}
    for spec in plan.nodes:
        groups.setdefault(frozenset(spec.depends_on), []).append(spec)
    for group in groups.values():
        if len(group) < 2:
            continue
        for spec in group:
            spec.sibling_summary = _sibling_summary(group, spec)


def _sibling_summary(group: list[RunSpec], me: RunSpec) -> str:
    """Fan-out awareness body for ``me``: one bullet per *other* node in its
    fan-out group, carrying enough for a peer to draw its own boundary —

      ``- {role}：{scope}（预期产出：{expected_output}）``

    ``scope`` is the sibling's ``objective`` (its declared 责任/负责的部分) when the
    CEO set one, else the ``task`` instruction (always present) so a peer is never
    blank; ``expected_output`` (its declared 产出) is appended only when given. This
    enriches the bare role+task list so parallel peers see *who owns what* and *what
    each will hand back* — and can avoid both overlapping the same ground and leaving
    a seam uncovered. Excerpts are capped (:func:`_excerpt`). Assumes
    ``len(group) >= 2`` (caller skips a lone node)."""
    lines: list[str] = []
    for other in group:
        if other.run_id == me.run_id:
            continue
        scope = _excerpt(other.objective or other.task, _SIBLING_TASK_CHARS)
        line = f"- {other.role}：{scope}"
        if other.deliverable and other.deliverable.name:
            line += f"（预期产出：{_excerpt(other.deliverable.name, _SIBLING_OUTPUT_CHARS)}）"
        lines.append(line)
    return "\n".join(lines)


def _excerpt(text: str, limit: int) -> str:
    """Head excerpt of ``text`` capped at ``limit`` chars (ellipsis when over) — a
    sibling overview only needs the gist, not the tail."""
    text = text.strip()
    return text if len(text) <= limit else text[:limit] + "…"


def _dag_policy(item: dict[str, Any]) -> RunPolicy:
    """Map a DAG node's declarative knobs onto a RunPolicy (the WaveScheduler
    reads on_failure / retries; result_handling feeds the dep-context size)."""
    raw_on_failure = item.get("on_failure", DEFAULT_ON_FAILURE)
    on_failure = raw_on_failure if raw_on_failure in VALID_ON_FAILURE else DEFAULT_ON_FAILURE
    timeout_ms = item.get("timeout_ms", _DEFAULT_TIMEOUT_MS)
    return RunPolicy(
        on_failure=on_failure,  # type: ignore[arg-type]
        max_retries=min(item.get("max_retries", 1), MAX_RUN_RETRIES),
        retry_delay_ms=item.get("retry_delay_ms", _DEFAULT_RETRY_DELAY_MS),
        timeout_s=max(1, timeout_ms // 1000) if timeout_ms else None,
        result_handling=item.get("result_handling") or "pass_through",
    )


def _parse_deliverable(item: dict[str, Any]) -> Deliverable | None:
    """Parse a task's deliverable, compatible with legacy ``expected_output`` / ``contract`` keys.

    Returns None when no name and no enforceable rule is declared — the executor still
    enforces the non-empty baseline regardless. Invalid knob values are dropped (mirroring
    the lenient tier/effort handling)."""
    name = ""
    expected = item.get("expected_output")
    if isinstance(expected, str) and expected.strip():
        name = expected.strip()

    source: dict[str, Any] | None = None
    raw_deliverable = item.get("deliverable")
    if isinstance(raw_deliverable, dict):
        source = raw_deliverable
    elif isinstance(item.get("contract"), dict):
        source = item.get("contract")

    if source:
        if isinstance(source.get("name"), str) and source["name"].strip():
            name = source["name"].strip()
        deliverable = _deliverable_from_dict(source, name=name)
        return deliverable if _deliverable_has_content(deliverable) else None

    if name:
        return Deliverable(name=name)
    return None


def _deliverable_from_dict(raw: dict[str, Any], *, name: str = "") -> Deliverable:
    required_sections = _str_list(raw.get("required_sections"))
    must_contain = _str_list(raw.get("must_contain"))
    min_length = raw.get("min_length")
    max_length = raw.get("max_length")
    min_length = min_length if isinstance(min_length, int) and min_length > 0 else 0
    max_length = max_length if isinstance(max_length, int) and max_length > 0 else 0
    fmt = raw.get("output_format")
    output_format = fmt if fmt in _VALID_OUTPUT_FORMATS else "text"
    output_schema = raw.get("output_schema")
    if output_schema is not None and not isinstance(output_schema, dict):
        output_schema = None
    return Deliverable(
        name=name,
        output_format=output_format,
        required_sections=required_sections,
        output_schema=output_schema,
        must_contain=must_contain,
        min_length=min_length,
        max_length=max_length,
        requires_files=bool(raw.get("requires_files", False)),
        strict=bool(raw.get("strict", False)),
    )


def _deliverable_has_content(deliverable: Deliverable) -> bool:
    return bool(
        deliverable.name.strip()
        or deliverable.required_sections
        or deliverable.must_contain
        or deliverable.min_length
        or deliverable.max_length
        or deliverable.output_format == "json"
        or deliverable.requires_files
        or deliverable.output_schema
    )


def _str_list(value: Any) -> list[str]:
    """Normalise a declared list field to non-empty trimmed strings."""
    if not isinstance(value, list):
        return []
    return [s.strip() for s in value if isinstance(s, str) and s.strip()]
