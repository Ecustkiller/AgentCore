"""把一轮已跑完的多队员协作固化成用户工作流（画布归一）。

一轮协作的完整任务树落在 ``turn_journal`` 的 ``plan_snapshot`` fact 里，折回来就是
执行时那张 :class:`~agentcore.runtime.runs.plan.RunPlan`（中途 ``adjust`` 天然被最后
一条快照吃掉）。但 :class:`~agentcore.runtime.runs.types.RunSpec` 与画布定义
（``tasks_to_workflow_definition`` 期望的 playbook task dict）**不同构**：主键是铸过
前缀的 ``run_id``（``del_<uuid>_writer``）、``depends_on`` 引用同样铸过前缀、字段约 40
vs 8。直接喂进去边会全断、降级字段列表会变成噪音。

本模块就是那层归一，四件事：

- **拓扑清洗**：只留顶层 worker。嵌套子团队自成一张 plan（``depth>=2``），续跑 / 接手
  节点折进被它续的那个节点，折叠数量写进降级说明。
- **id 反解**：``del_<uuid>_writer`` → ``writer``，并同步重写 ``depends_on``，边不断。
- **steer 保真**：画布没有操舵字段，用户中途对某队员追加的口头指令并入该步骤的任务
  描述——复跑时仍然生效，而不是静默丢掉这轮跑得好的原因。
- **降级诚实**：``model`` / ``thinking`` 等带不进画布的执行细项写进说明，**不拦保存**
  （`intercept-discipline.mdc`：诚实告知优先于硬拒）。

``deliverable`` 反过来整份带走：验收标准变了复跑就不是同一件事，画布拿它当不透明快照。

**辩论不在快照内**：能折的只有 ``plan_snapshot``，而这条 fact 只有 delegate 会写——辩论
走自己那套主持人 / 正反方机制，一条都不写。于是「先派人调研、再拉一场辩论」的混合回合折
出来只剩调研那半：那不是降级，是**静默变质**。所以这里另外从 journal 的 ``debate_*``
事实判定本轮跑没跑过辩论（:func:`turn_ran_debate`），跑过就把「辩论环节不在快照内」写进
降级说明；整轮只有辩论时连折都折不出来，报错也要说清是这个原因，而不是含糊的「没有多队员
协作」。
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any

from agentcore.runtime.runs.builder import recoverable_raw_id
from agentcore.runtime.runs.plan import RunPlan
from agentcore.runtime.runs.types import RunKind, RunSpec
from agentcore.workflows.definition import (
    WorkflowDefinitionError,
    tasks_to_workflow_definition,
)
from agentcore.workflows.source import turn_source

# A CEO-dispatched worker is depth 1 (hand-built / test plans leave the default 0);
# anything deeper came from a worker that re-delegated a sub-team.
TOP_LEVEL_DEPTH = 1

# 少于两个节点算不上「多队员协作」——一个人干完的活没有拆法可固化。
MIN_CANVAS_NODES = 2

# Canvas name / description are stored in ``user_workflows`` (String(200) / Text with a
# 4000-char API ceiling).
_MAX_NAME_CHARS = 200
_MAX_DESCRIPTION_CHARS = 4000

_STEER_HEADING = "## 上轮中途追加的指令（用户操舵，已并入任务）"

# 本轮跑过辩论的判据：辩论机制唯一会留在 journal 里的痕迹。开庭即有 ``debate_round_started``
# （庭前取证还会更早留下 ``debate_pretrial_*``），收口留 ``debate_result``——任一在就算跑过。
# 用前缀而不是逐个列举：新增的 ``debate_*`` DURABLE 事件天然被覆盖，漏一个就等于漏一句实话。
_DEBATE_FACT_PREFIX = "debate_"

_DEBATE_NOTE = "本轮的辩论环节不在快照内（辩论不写计划快照），固化的只有派单出去的那部分步骤"


class TurnWorkflowError(ValueError):
    """这一轮没有可固化的协作（无计划快照 / 有效节点不足 / 拓扑无法落到画布）。"""


@dataclass(frozen=True, slots=True)
class TurnPlanFold:
    """一轮的计划快照折叠结果：顶层那张图 + 被排除的嵌套子团队数。"""

    plan: RunPlan | None
    nested_teams: int


@dataclass(frozen=True, slots=True)
class TurnWorkflowDraft:
    """``UserWorkflowRepository.create`` 可直接消费的固化草稿。

    ``source`` 与 ``definition`` 分开：来源是服务端权威元数据，落在自己的列上而不是画布
    里（:mod:`agentcore.workflows.source`）。
    """

    name: str
    description: str
    definition: dict[str, Any]
    source: dict[str, str]
    node_count: int


def fold_turn_plan(entries: list[dict[str, Any]] | None) -> TurnPlanFold:
    """折出这一轮**顶层**的最后一条 ``plan_snapshot``。

    ``plan_from_journal`` 取最后一条即可——那是 resume 的正确姿势，但在这里不够：一个
    再派单的 worker 会把它自己的子团队计划记进**同一条** turn journal，于是最后一条可能
    是嵌套子图。嵌套节点的 ``depth>=2``（CEO 直属 worker 为 1，手工/测试 plan 为 0）是
    唯一的结构判据，所以这里取「最后一条仍含顶层节点的快照」，并顺手数出嵌套子团队个数
    （按发起它们的父 run 去重）供降级说明使用。
    """
    from agentcore.runtime.facts import FactKind
    from agentcore.runtime.runs.serialize import plan_from_json

    top_level: RunPlan | None = None
    nested_parents: set[str] = set()
    for entry in entries or []:
        if (entry.get("kind") or "") != FactKind.PLAN_SNAPSHOT.value:
            continue
        plan = plan_from_json(entry.get("payload") or {})
        if any(n.depth <= TOP_LEVEL_DEPTH for n in plan.nodes):
            top_level = plan
            continue
        for node in plan.nodes:
            nested_parents.add(node.parent_run_id or node.run_id)
    return TurnPlanFold(plan=top_level, nested_teams=len(nested_parents))


def turn_ran_debate(entries: list[dict[str, Any]] | None) -> bool:
    """这一轮跑没跑过辩论——判据是 journal 里有没有 ``debate_*`` 事实。

    辩论不写 ``plan_snapshot``，所以折叠那条路径对它一无所知；混合回合（先派单调研、
    再拉一场辩论）若不另判，保存出来的工作流会**只有调研那半**且降级说明只字不提。
    """
    for entry in entries or []:
        if str(entry.get("kind") or "").startswith(_DEBATE_FACT_PREFIX):
            return True
    return False


def draft_workflow_from_journal(
    entries: list[dict[str, Any]] | None,
    *,
    conversation_id: str,
    message_id: str,
    name: str | None = None,
) -> TurnWorkflowDraft:
    """一轮的 journal facts → 可保存的工作流草稿。

    :raises TurnWorkflowError: 这轮没有多队员协作（无计划快照或有效节点 < 2），或折出的
        拓扑落不到画布上（画布定义自身的校验不通过）。整轮只有辩论时同样落这里，但错误
        文案说明的是「辩论固化不了」而不是「没有多队员协作」——辩论显然是多队员协作。
    """
    fold = fold_turn_plan(entries)
    debated = turn_ran_debate(entries)
    if fold.plan is None:
        raise TurnWorkflowError(
            "这一轮是辩论，辩论过程无法固化为工作流画布"
            if debated
            else "这一轮没有多队员协作，无法固化为工作流"
        )
    return draft_workflow_from_plan(
        fold.plan,
        conversation_id=conversation_id,
        message_id=message_id,
        name=name,
        nested_teams=fold.nested_teams,
        debated=debated,
    )


def draft_workflow_from_plan(
    plan: RunPlan,
    *,
    conversation_id: str,
    message_id: str,
    name: str | None = None,
    nested_teams: int = 0,
    debated: bool = False,
) -> TurnWorkflowDraft:
    """一张顶层 :class:`RunPlan` → 画布定义 + 诚实的降级说明。"""
    topology = _select_canvas_nodes(plan)
    canvas = topology.nodes
    if len(canvas) < MIN_CANVAS_NODES:
        raise TurnWorkflowError(
            f"这一轮只有 {len(canvas)} 个有效队员节点，不足以固化为工作流"
        )

    canvas_ids = _mint_canvas_ids(canvas)
    steers = {node.run_id: topology.steers_for(node) for node in canvas}
    tasks = [
        _canvas_task(node, canvas_ids=canvas_ids, topology=topology, steers=steers[node.run_id])
        for node in canvas
    ]
    try:
        definition = tasks_to_workflow_definition(tasks)
    except WorkflowDefinitionError as e:
        raise TurnWorkflowError(f"这一轮的协作拓扑无法固化为画布：{e}") from e

    return TurnWorkflowDraft(
        name=_resolve_name(name, canvas),
        description=_describe(
            canvas,
            folded=len(topology.folded_into),
            nested_teams=nested_teams,
            steered=sum(1 for lines in steers.values() if lines),
            debated=debated,
        ),
        definition=definition,
        source=turn_source(conversation_id=conversation_id, message_id=message_id),
        node_count=len(canvas),
    )


@dataclass(frozen=True, slots=True)
class _CanvasTopology:
    """清洗后的画布拓扑：留下的节点 + 折叠去向 + 每个去向吸收了哪些节点。"""

    nodes: list[RunSpec]
    folded_into: dict[str, str]
    folded_by_root: dict[str, list[RunSpec]]

    def steers_for(self, node: RunSpec) -> list[str]:
        """本节点自己的操舵 + 折进它的续跑 / 接手节点带的操舵（保序去重）。"""
        lines = _steer_lines(node.steer)
        for folded in self.folded_by_root.get(node.run_id, ()):
            for line in _steer_lines(folded.steer):
                if line not in lines:
                    lines.append(line)
        return lines


def _select_canvas_nodes(plan: RunPlan) -> _CanvasTopology:
    """留顶层 worker 节点，把续跑 / 接手节点折进它们接手的那个。

    折叠的两条链都是「同一个位置接着干 / 换人重来」而不是新步骤：
    ``continue_from_run_id``（同人续派）与 ``replaces_run_id``（回落换人、用户「立即改
    此人」铸出的 ``_redir`` 接手节点）。热路径修订（``continue_run`` 的 ``_rev*``）本就
    不是 plan 节点，无需另外剔除。
    """
    by_id = {n.run_id: n for n in plan.nodes}
    folded_into: dict[str, str] = {}
    folded_by_root: dict[str, list[RunSpec]] = {}
    canvas: list[RunSpec] = []
    for node in plan.nodes:
        if node.kind is not RunKind.AGENT or node.depth > TOP_LEVEL_DEPTH:
            continue
        root = _chain_root(node, by_id)
        if root == node.run_id:
            canvas.append(node)
        else:
            folded_into[node.run_id] = root
            folded_by_root.setdefault(root, []).append(node)
    return _CanvasTopology(
        nodes=canvas, folded_into=folded_into, folded_by_root=folded_by_root
    )


def _chain_root(node: RunSpec, by_id: dict[str, RunSpec]) -> str:
    """沿续跑 / 接手链上溯到最初那个节点（链外引用与自环即止）。"""
    seen = {node.run_id}
    current = node
    while True:
        prior = (current.continue_from_run_id or current.replaces_run_id or "").strip()
        if not prior or prior in seen:
            return current.run_id
        upstream = by_id.get(prior)
        if upstream is None or upstream.depth > TOP_LEVEL_DEPTH:
            return current.run_id
        seen.add(prior)
        current = upstream


def _mint_canvas_ids(canvas: list[RunSpec]) -> dict[str, str]:
    """``run_id`` → 画布 id：反解铸造前缀，撞名时加序号。"""
    ids: dict[str, str] = {}
    used: set[str] = set()
    for i, node in enumerate(canvas):
        raw = recoverable_raw_id(node.run_id) or node.run_id
        base = "_".join(raw.split()) or f"step{i + 1}"
        candidate = base
        n = 2
        while candidate in used:
            candidate = f"{base}_{n}"
            n += 1
        used.add(candidate)
        ids[node.run_id] = candidate
    return ids


def _canvas_task(
    node: RunSpec,
    *,
    canvas_ids: dict[str, str],
    topology: _CanvasTopology,
    steers: list[str],
) -> dict[str, Any]:
    """一个顶层 :class:`RunSpec` → playbook 形状的 task dict（画布可吃的那几个字段）。"""
    task: dict[str, Any] = {
        "id": canvas_ids[node.run_id],
        "role": (node.role or node.agent_name or "").strip(),
        "task": _task_text(node, steers),
    }
    deps = _rewrite_depends_on(
        node, canvas_ids=canvas_ids, folded_into=topology.folded_into
    )
    if deps:
        task["depends_on"] = deps
    if node.checkpoint_after:
        task["checkpoint_after"] = True
    deliverable = _canvas_deliverable(node)
    if deliverable:
        task["deliverable"] = deliverable
    return task


def _rewrite_depends_on(
    node: RunSpec,
    *,
    canvas_ids: dict[str, str],
    folded_into: dict[str, str],
) -> list[str]:
    """依赖引用穿过折叠映射落到画布 id；自环与画布外引用丢弃。"""
    deps: list[str] = []
    for raw in node.depends_on:
        target = folded_into.get(raw, raw)
        canvas_id = canvas_ids.get(target)
        if canvas_id is None or target == node.run_id or canvas_id in deps:
            continue
        deps.append(canvas_id)
    return deps


def _steer_lines(raw: str) -> list[str]:
    """``apply_steer`` 累积的 ``- note`` 块 → 规范化的条目列表。"""
    lines: list[str] = []
    for line in (raw or "").splitlines():
        text = line.strip().lstrip("-").strip()
        if text and text not in lines:
            lines.append(text)
    return lines


def _task_text(node: RunSpec, steers: list[str]) -> str:
    """任务描述；有中途操舵时以带标题的块并入（画布没有 steer 字段可放）。"""
    body = (node.task or "").strip()
    if not steers:
        return body
    block = "\n".join(f"- {s}" for s in steers)
    return f"{body}\n\n{_STEER_HEADING}\n{block}".strip()


def _canvas_deliverable(node: RunSpec) -> dict[str, Any]:
    """整份交付契约逐字带走（画布只编辑 ``form``，其余字段原样存原样写回）。

    这里**不做**「只留声明性字段」的裁剪：引用模式、质量闸、占位符豁免这些恰恰是上一轮
    跑得好的原因，裁掉就等于复跑时悄悄换了验收标准。画布拿它当不透明快照（前端解析保真
    透传），复跑时 ``_deliverable_from_dict`` 按同样的键读回来。
    """
    deliverable = node.deliverable
    return asdict(deliverable) if deliverable is not None else {}


def _resolve_name(name: str | None, canvas: list[RunSpec]) -> str:
    explicit = (name or "").strip()
    if explicit:
        return explicit[:_MAX_NAME_CHARS]
    roles = list(
        dict.fromkeys(
            (n.role or n.agent_name or "").strip()
            for n in canvas
            if (n.role or n.agent_name or "").strip()
        )
    )
    if not roles:
        return f"团队协作 · {len(canvas)} 步"
    if len(roles) <= 2:
        return " · ".join(roles)[:_MAX_NAME_CHARS]
    return f"{roles[0]}等 {len(canvas)} 人协作"[:_MAX_NAME_CHARS]


def _describe(
    canvas: list[RunSpec],
    *,
    folded: int,
    nested_teams: int,
    steered: int,
    debated: bool = False,
) -> str:
    """降级说明：复跑效果会与原轮有哪些出入，逐条说清楚而不是拦下保存。"""
    notes: list[str] = ["由一轮团队协作固化"]

    models = sorted({n.model.strip() for n in canvas if n.model.strip()})
    if models:
        notes.append(
            f"{len(models)} 个指定模型（{'、'.join(models)}）不带入，复跑按账户默认模型"
        )
    if any(n.thinking is not None for n in canvas):
        notes.append("各步骤的思考档设置不带入")
    if debated:
        notes.append(_DEBATE_NOTE)
    if steered:
        notes.append(f"{steered} 个步骤的中途操舵已并入任务描述")
    if folded:
        notes.append(f"已折叠 {folded} 个续跑 / 接手节点")
    if nested_teams:
        notes.append(f"{nested_teams} 个嵌套子团队不进画布")
    notes.append("工具、检索预算、重试等执行细项不带入快照")

    return cap_description("；".join(notes))


def cap_description(description: str) -> str:
    """描述列有 4000 字上限（``user_workflows.description``），超了截断加省略号。"""
    if len(description) <= _MAX_DESCRIPTION_CHARS:
        return description
    return description[: _MAX_DESCRIPTION_CHARS - 1] + "…"


def append_description_note(description: str, note: str) -> str:
    """给已成文的降级说明再追一条（保存后才知道的事，如抽出了几个槽位）。"""
    text = (note or "").strip()
    if not text:
        return description
    return cap_description(f"{description}；{text}" if description else text)
