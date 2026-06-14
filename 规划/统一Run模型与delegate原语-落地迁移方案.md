# 统一 Run 模型 + delegate 原语 — Phase 1 落地迁移方案（讨论稿）

> **范围**：仅后端运行时（`apps/server/agentcore/runtime/` 的 `runs.py` / `planner.py` / `plan.py` / `workspace.py` / `events.py` / `pipeline.py` + `tools/builtin/assemble_team.py`）。前端只列契约影响，单独立项。
>
> **目标**：落地 `规划/编排器重定位-讨论与规划.md` 的 **D1′（单一 `delegate` 原语，CEO 自选粒度）/ D2（CEO 可先澄清）/ D3（CEO 自己声音收尾）**，并解掉 O1–O4；工程形态对照 `规划/成熟参考实现借鉴-讨论与规划.md` 的「统一 Run 模型 + WaveScheduler」。
>
> **性质**：行为契约变更（§八）属「AI 提案 → 人确认」。代码未改动；本文是迁移蓝图。
>
> **参考样板**：`C:\Project\1\apps\api-server\src\agentcore\runtime\runs\{types,plan,wave,builder,concurrency,scheduler}.py` 与 `delegation/{manager,handler,runner}.py`。

---

## 〇、迁移总览（old → new 一图）

| 现有文件 | 现状职责 | 迁移后 | 处置 |
|---|---|---|---|
| `runtime/plan.py`（`OrchestratorPlan` 等 + `parse_plan` + `_assert_acyclic`） | 「LLM 一次吐 JSON 计划」的数据模型与容错解析 | `runtime/runs/types.py`（Run 模型）+ `runs/plan.py`（`RunPlan.waves()`）+ `runs/builder.py`（由 delegate 参数建图） | **重写拆分** |
| `runtime/planner.py`（`make_plan` 外部编排器 LLM） | 独立 LLM 产结构化计划 | — | **删除**（被 `delegate` 工具取代） |
| `runtime/runs.py`（`run_multi_agent`：调度 + 检查点 + `_synthesize`） | 调度、检查点审视、合稿全揉在一个函数 | `runs/wave.py`（`WaveScheduler` 纯调度）+ `runs/executor.py`（host 侧 AGENT/合稿执行器） | **拆分重写** |
| `tools/builtin/assemble_team.py`（`AssembleTeamTool`，handoff，调 planner） | 聊天→团队的唯一升级铰链 | `tools/builtin/delegate.py`（`DelegateTool`） | **重写** |
| `runtime/workspace.py`（`TaskWorkspace`/`StepOutput`） | Agent 间共享产物、上游 summary 注入下游 | 由 `WaveScheduler` 的 `completed: dict[run_id,RunState]` + `RunState.content` 取代 | **评估去留**（§八） |
| `runtime/events.py`（`run_*`） | 已有 run_plan/started/output_delta/completed/failed/progress | 扩 `run_started` 加 `parent_run_id`/`kind`；`run_plan` 改为「每次 delegate 批次预声明」 | **增量改** |
| `runtime/engine.py`（`react_loop`） | 已支持 handoff/terminal、`on_content` 重定向 | 不动（executor 与 delegate 都复用它） | **不动** |
| `runtime/pipeline.py` | 装配 chat_tools = worker_tools + team_tool | `team_tool` → `delegate_tool`；CEO hint | **增量改** |
| `runtime/checkpoint_review.py` + 调度器内 plan_review | 调度循环里做 LLM 检查点审视 + 团队预审 | 暂从调度器摘出（Phase 2 以 preflight/contract/ask_user 回归） | **行为变更，需确认（§八）** |

**核心动作两句话**：① 新增一个纯净、可单测、零 infra 依赖的 `runs/` 包当地基（调度/执行分离）；② 把「图怎么来」从「外部 planner LLM 吐 JSON」改为「CEO 在 ReAct 循环里调 `delegate` 工具增量 append」。

---

## 一、新增 `runtime/runs/` 包（地基，纯增量、可先行）

完全可独立先落地、单测，不碰现有路径。从参考样板移植，按 Phase 1 裁剪（保留字段但行为先 inert）。

### `runs/types.py`
移植 `RunKind` / `RunPhase` / `RunOrigin` / `RunContract` / `RunPolicy` / `RunSpec` / `RunState`。Phase 1 裁剪：
- `RunKind`：先只用 `AGENT` 与 `SYNTHESIS`（若取 Option 2）；`ARENA` 字段保留、不激活。
- `RunPolicy`：`on_failure/max_retries/retry_delay_ms/timeout_s/result_handling` 启用；`candidates/selection_criteria/autosave_artifact/preflight/audit/trust/shared_roots` 保留为声明位、Phase 1 不读。
- **关键差异（过渡）**：我们暂无 Agent 实体/`AgentResolver`，故 `RunSpec` 在 Phase 1 **内联承载 worker 定义**（把现有 `PlannedAgent`+`PlannedStep` 折叠进来）：

```python
@dataclass
class RunSpec:
    run_id: str
    task: str
    kind: RunKind = RunKind.AGENT
    depends_on: list[str] = field(default_factory=list)
    parent_run_id: str | None = None
    depth: int = 0
    policy: RunPolicy = field(default_factory=RunPolicy)
    sibling_summary: str = ""
    # —— Phase 1 内联 worker 定义（Phase 2 收敛为 agent_id + AgentResolver）——
    role: str = ""
    objective: str = ""
    system_prompt_supplement: str | None = None
    tools: list[str] = field(default_factory=list)
    model_preference: str = "strong"
    thinking: bool | None = None
    reasoning_effort: str | None = None
    expected_output: str = ""
```
> Phase 2 接入 Agent 实体后，`role/tools/model_preference…` 退到 `agent_id` 背后由 `AgentResolver` 解析——对应参考实现的 `RunSpec(agent_id=...)`。本文把这个过渡点显式标出，避免「为复用旧 PlannedAgent 而裁需求」。

### `runs/plan.py`
移植 `RunPlan`（`nodes` / `origin` / `add()` / `by_id()` / `waves()`）+ `RunPlanError`。`waves()` 用 Kahn 分层，**取代** 现有 `plan.py::_assert_acyclic`（无环校验内含其中）。

### `runs/scheduler.py`
`RunExecutor` 协议（`async (spec, completed) -> RunState`）+ `RunScheduler` 协议。这是「调度/执行分离」的接缝，让 `runs/` 包零 infra 依赖、全分支可 fake 单测。

### `runs/wave.py`
移植 `WaveScheduler.run(plan, executor, *, seed_completed, should_stop, on_progress)`：ready 选择、skip 级联、abort、`max_parallel` 波宽、per-node retry、中途 `add` 拾取。Phase 1 `seed_completed/should_stop` 可不接（留参数，为 Phase 2 暂停/恢复留缝）。

### `runs/concurrency.py`
移植 `gather_bounded` + ContextVar 树级预算。**建议保留**（不简化成裸 semaphore）：CEO 委派的 worker 若自身再委派（嵌套），只有树级预算能防 `max_parallel` 深度相乘爆炸——这正是我们现有 `runs.py` 缺的安全网。

### `runs/builder.py`
移植 `build_run_plan(tasks_raw, *, names?, ...) -> (RunPlan, errors)`：
- 有 `depends_on` → `_dag_plan`（命名空间化 id、严格契约）；无 → `_flat_plan`（并行、`sibling_summary`、`candidates>1`→ARENA Phase 2）。
- Phase 1 因走内联角色，`names` 校验放宽为「结构校验」（有 `task`、`tools⊆已注册`、`model_preference∈{fast,strong}`）。

> 本步产物：6 个新文件 + 单测（`waves()` 分层/环/未知边、skip 级联、builder flat/dag）。**先合并、先测、再接线**——对照参考「Ports DI + 纯 runs 包」。

---

## 二、host 侧执行器 `runtime/runs/executor.py`（把 `run_one`+`_synthesize` 搬过来）

`runs/` 包不碰 LLM/工具/事件；真正「一个节点怎么跑」在这里。把现有 `runs.py::run_one` 与 `_synthesize` 迁移为注入给 `WaveScheduler` 的 `RunExecutor`：

```python
def build_agent_executor(*, llm, tools, sink, base_tool_context, system_prompt,
                         user_message, totals) -> RunExecutor:
    async def execute(spec: RunSpec, completed: Mapping[str, RunState]) -> RunState:
        # 1) system: base + 角色/目标/补充（来自 spec，等价旧 run_one 的 sys_parts）
        # 2) user: 原始请求 + 上游产物（从 completed[dep].content 按 result_handling 取，
        #          取代 workspace.get_output）+ sibling_summary + 本步 task/expected_output
        # 3) profile = apply_overrides(agent_profile(spec.model_preference), thinking, effort)
        # 4) content,... = await react_loop(..., allowed_tool_names=spec.tools,
        #          on_content=lambda d: sink.emit(run_output_delta(spec.run_id, spec.run_id, d)))
        # 5) 累加 totals；返回 RunState(phase=COMPLETED, content=..., duration_ms=..., usage=...)
    return execute
```

要点：
- **上游产物注入**：旧 `run_one` 读 `workspace.get_output(dep_id).summary`；新执行器读 `completed[dep_id].content`，按 `spec.policy.result_handling`（`pass_through` 全文 / `summarize` 摘要）裁剪。→ 这让 `TaskWorkspace` 在 Phase 1 可下线（§八）。
- **并行兄弟感知**：注入 `spec.sibling_summary`（builder 已填），补我们现有实现没有的「分工感知」。
- **事件归属**：`run_output_delta(run_id, agent_id, delta)`——Phase 1 `agent_id` 用 `run_id` 或内联 `role`。
- **合稿**：见 §三的 Option 1/2。

---

## 三、`delegate` 工具（`tools/builtin/delegate.py`，取代 `AssembleTeamTool`）

### Schema（CEO 在 ReAct 循环里调用）
```jsonc
{
  "name": "delegate",
  "description": "把一批子任务委派给专职 worker 并行/串行执行……（仅当确需分工时调用）",
  "parameters": { "type": "object", "properties": { "tasks": { "type": "array", "items": {
    "id": "可选；声明则可被 depends_on 引用（建 DAG）",
    "role": "worker 角色名（展示用）",
    "objective": "该 worker 的目标",
    "task": "交给该 worker 的自包含任务",
    "tools": ["从可用工具名里选，可空"],
    "model_preference": "fast | strong",
    "thinking": "可选 bool", "reasoning_effort": "可选 high|max",
    "depends_on": ["同批其他 task 的 id；无依赖即并行"],
    "expected_output": "可选",
    "result_handling": "pass_through | summarize"
  } } }, "required": ["tasks"] }
}
```
> 一次塞 N 个 = 全景计划（A）；CEO 后续再调一次 `delegate` 追加 = 动态委派（B）——**同一工具/schema/调度**，正是 D1′。这直接消解 O1（边界由 CEO 自选批量大小）与 O3（并行=无 `depends_on` 同波）。

### execute 流程
1. `plan, errors = build_run_plan(tasks)`；`errors` 非空 → 返回错误给 CEO（非终态，CEO 改参数重试）。
2. `sink.emit(run_plan(...))` 预声明本批节点（图即时点亮）。
3. `executor = build_agent_executor(...)`；`results = await WaveScheduler().run(plan, executor, on_progress=lambda c: sink.emit(run_progress(len(c), len(plan.nodes))))`。
4. `format_run_result(plan, results)` 折叠各节点 `RunState.content` 为一段结构化文本。
5. **返回结果给 CEO**（见下 Option）。

### 终态语义：Option 1（推荐，对齐 D3）vs Option 2（小改）
| | Option 1 — CEO 自己合稿（推荐） | Option 2 — SYNTHESIS 节点 |
|---|---|---|
| delegate 返回 | **非终态** ToolResult，`output`=各 worker 结构化结论 | 终态 handoff（同现状 assemble_team） |
| 谁收尾 | CEO 的 ReAct 循环**继续**，用自己声音写最终答案（content_delta） | plan 末尾挂 `RunKind.SYNTHESIS` 节点，CEO 同款模型合稿后 stream |
| 对齐 | **D3（合成器并入 CEO）** + O2 | 接近现状代码、改动小 |
| 代价 | CEO 多读一次 worker 产出（O2 的开销）——靠 `summarize` + 同款模型压低 | 合稿仍是「循环外一趟」，正是 D3 想溶解的形态 |

推荐 **Option 1**：它才是 D1′/D3 的全部意义；`react_loop` 现成支持「工具返回后继续循环」，无需 handoff。Option 2 作为「想要更小首刀」的退路保留。

### 授权/校验
Phase 1 走内联角色 → 结构校验即可（无需 Agent 实体）。Phase 2 接 Agent 实体后改为 `agent_id` + `delegations` 白名单 + `AgentResolver`（对照参考 `delegation/manager.py` 的 `names` 白名单）。

---

## 四、`pipeline.py` 接线（增量）
- `_build_default_tools()` 不变（worker 仍只拿这些）。
- 把 `AssembleTeamTool(...)` 换成 `DelegateTool(...)`（同样 per-turn 注入 llm/sink/system_prompt/worker_tools/base_tool_context/user_message/history）。
- `chat_tools = worker_tools + delegate_tool`；CEO system prompt 的 `CHAT_TEAM_CAPABILITY_HINT` 改为描述 `delegate`（按需委派、可先澄清=D2）。
- 其余（message_start/end、react_loop 调用）不动。

---

## 五、删除 / 退役
- **删** `runtime/planner.py`（外部编排器 LLM 整体退役）。
- **删/清空** `runtime/plan.py` 的 `OrchestratorPlan/PlannedAgent/PlannedStep/OutputStrategy/parse_plan/single_agent_plan/_assert_acyclic`（数据模型迁到 `runs/`）。`PlannedCheckpoint` 随检查点逻辑一起处理（§八）。
- **删** `tools/builtin/assemble_team.py`（被 `delegate.py` 取代）。
- **移出调度器**：`_await_plan_review` / `_apply_review_overrides` / `handle_checkpoint` / `checkpoint_review.py` 调用——Phase 1 调度器（WaveScheduler）不含检查点与预审（见 §八）。

---

## 六、events / 前端契约影响（最小）
- `run_started` 增 `parent_run_id`（嵌套委派用）、`kind`（agent/synthesis）；`step_id` 暂等于 `run_id` 保后向兼容。
- `run_plan` 由「整计划一次」变「每次 `delegate` 批次一次」（增量声明该批节点）。
- Phase 1 **不再 emit** `plan_review_required/resolved`、`checkpoint_review`（前端需容忍其缺席；对应 store 分支暂置灰）。Option 1 下最终答案走 `content_delta`（CEO 声音），worker 过程走 `run_output_delta`。
- 前端 `stores/execution.ts` / `components/graph/` 的对齐单独立项（本方案聚焦后端）。

---

## 七、落地步骤顺序（每步可独立验证 / 单测）
1. **加 `runs/` 包**（types/plan/scheduler/wave/concurrency/builder）+ 单测。纯增量、零接线、不改行为。
2. **加 `runs/executor.py`**（AGENT 执行器包 `react_loop`）+ 用 fake llm 单测一个并行+一个 DAG。
3. **加 `delegate.py`**，接 `WaveScheduler`+executor；可与 `assemble_team` 并存于 flag 后做灰度对比。
4. **切 `pipeline.py`**：chat 工具用 `delegate`；落 Option 1（CEO 合稿）。
5. **删退役件**（planner/plan 旧模型/assemble_team），调度器移除 plan_review+checkpoint。
6. **扩 events**（parent_run_id/kind）+ 前端 store 对齐（单独 PR）。

> 1–2 步零行为变更可安全先合；3–4 步是产品可感知的「编排器→CEO+delegate」切换；5–6 收尾。

---

## 八、风险与需确认（行为契约变更 → 人确认）
1. **D3 收尾形态**：采用 Option 1（delegate 非终态、CEO 自己合稿，多一次 LLM pass=O2）还是 Option 2（SYNTHESIS 节点）？——影响 O2 的延迟/成本权衡。
2. **暂时下线两项现有功能**：调度器内 ① 团队预审 `plan_review`（用户改模型档）② LLM 检查点审视 `checkpoint_review`。Phase 1 砍掉、Phase 2 以 preflight/contract/`ask_user` 回归，是否可接受这段空窗？
3. **Phase 1 内联角色定义**（不依赖 Agent 实体/seeds）作为过渡，Phase 2 收敛到 `agent_id`+`AgentResolver`——确认这个过渡，不在 Phase 1 提前建 Agent 实体。
4. **`workspace.py` 去留**：Phase 1 上游产物改走 `completed[dep].content`，`TaskWorkspace` 可下线；但「对话级共享产物 + 安全网落库」（见 `docs/Agent协作模式.md §六`）是更大的产物模型话题——确认 Phase 1 先用 RunState 传递、产物模型另议。

---

## 九、明确不在 Phase 1（边界）
ARENA/best-of-N 执行、Team 固定编排（`build_team_run_plan`）、Preflight 审计、严格契约闸门、异步 NATS worker、`AgentResolver`/Agent 实体、Turn Journal、暂停/恢复。相关字段在 `runs/types.py` 先留声明位、不读，为后续刀口留缝。
