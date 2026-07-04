# 产品 AI 协作优化复盘 🗂️

> **定位**：汇总 2026-07-03 开发者与产品 AI（CEO Agent）的**元讨论**——直接问「有什么要优化」「协作机制怎么测」「上下文怎么传」等，不含纯业务问答。供后续「AI 提案 → 人确认」时对照。
>
> **治理**：本目录仅 `07-规划`；🗂️ = 讨论中、未承诺落地。决策通过、开始落地后，对应条目迁入 `03-AI核心` 等正式文档，本条可退役或改为索引。
>
> **范围**：仅收录 **2026-07-03**（最近 1–2 天窗口内）的会话；更早的优化讨论不纳入。
>
> **数据来源**：`logs/dev.jsonl` 事件 + Postgres `messages` 全文（`apps/server/scripts/log_timeline.py` 可复现）。

---

## 一、会话索引

| 时间 (UTC) | 会话标题 | `conversation_id` | 锚点 `trace_id` | 类型 |
|---|---|---|---|---|
| 15:18 | 辩论工具技术规格 | `b26e34ec-466f-40b8-9d4a-63a0c181a461` | `657bdf62…` | 工具/API 设计 |
| 15:21 | 提示词架构分析与优化建议 | `a0b9e4aa-f324-4434-acaa-ab3494cd391b` | `daefc437…` | CEO 提示词元分析 |
| 16:01 | 多 Agent 协作优化点 | `bcae2d4d-0f83-426d-826e-32a247f3e095` | `f8e0fafd…` / `c43a2f81…` | 协作架构 + 圆桌实测 |
| 18:46 | 子 Worker 上下文传递机制与优化 | `025a8842-769e-4965-843b-a576cc3dbe57` | `4b0e1496…` | 上下文管线 |
| 19:23 | 多 Agent 协作测试的核心维度 | `99bcd6cf-ce15-4b08-b94b-e39ec0d73662` | `e4e50bbc…` / `0d2f4002…` | 测试方法论 |
| 19:28 | 马维斯 AI 助手介绍（含机制实测） | `623b42b3-45c0-4b7d-a57a-713b5cc99e29` | `6e381d5c…`（优化复盘轮） | 对比 + 流水线实测 + **开发者复盘** |

**复现命令**（任选）：

```bash
cd apps/server
uv run python scripts/log_timeline.py <conversation_id>
uv run python scripts/log_timeline.py --trace 6e381d5ca9e340c998c055cf38a3f794
```

---

## 二、实测背景（`623b42b3`）

7/3 晚间用极简任务 **「写四句中英文混合的个人简介」** 跑通完整多 Agent 流水线，刻意测试机制而非任务复杂度：

```
写手产出初稿 → 三路并行审查（语言 / 语法 / 可读性）→ 写手修订 → 汇总落盘
```

该轮之后用户追问「你觉得这次任务有什么需要优化的？」——`trace_id=6e381d5ca9e340c998c055cf38a3f794`，AI 给出最具体、可落地的优先级表（见 §四 P0 锚点）。

**同会话其它事实**（影响优化判断，非建议本身）：

- 首轮「展示比 Marvis 更有优势」的 4 路并行调研**连接中断**，回合未完成。
- 优化复盘轮写入时出现 **SQLAlchemy 连接池未归还** 错误（`chat.local_turn_recorded` 仍成功）；见 §六工程项。

---

## 三、去重后的优化主题图谱

多场对话高度重叠，合并为 8 个主题。括号内标注主要来源会话。

### 3.1 上下文与委派（`a0b9e4aa` · `025a8842` · `bcae2d4d` · `623b42b3`）

| 子问题 | AI 判断 | 与现状关系 |
|---|---|---|
| CEO→Worker 信息衰减 | Worker 只见 `task` + 原始用户消息，不见 CEO 思考与多轮对齐 | 已知痛点；便签墙 / `consult_memory` 引用是部分缓解 |
| 手写 task 成本高 | 5 worker 已占大量上下文；15–20 worker 不可扩展 | **新诉求**：「声明背景材料 X/Y/Z → 系统自动拼装 task」或 shared context 指针 |
| 上游全量灌下游 | `depends_on` 默认 `pass_through` 导致膨胀 | 已有 `summarize`；缺「对下游有用的自动摘要层」 |
| 并行 Worker 孤岛 | 审查官互不知彼此发现 | 便签墙存在但弱；**要横向通道**（并行中发现重大问题可留 note） |

相关规划讨论见 [`上下文注入统一性讨论.md`](./上下文注入统一性讨论.md)——认知层「一切≈注入 token」视角，与本节执行层损耗互补。

### 3.2 结构化契约与质检（`a0b9e4aa` · `bcae2d4d` · `623b42b3`）

- **机械 contract 不够**：`must_contain` / `required_sections` 可通过但逻辑稀烂 → 建议 contract 通过后加 **语义级 AI 评审** Worker。
- **审查输出格式不统一**：实测简介任务中审查官打分维度各异 → CEO 应预置 `contract`（`problems` / `suggestions` / `score`），修订步骤才能字段级自动化。
- **返工无级联**：单 Worker 返工不标记下游 `stale` → 增量破坏风险。
- **软硬质检**：提议渐进式（软检标注风险，高风险才硬退）；`checkpoint_after` 可扩展为自动轻量同行评审。

### 3.3 可见性与调试（`bcae2d4d` · `623b42b3` · `b26e34ec`）

- **CEO 中间可见性（P0 锚点）**：Worker 运行期黑箱；仅有「全跑完」与 `checkpoint_after` 两档 → 要 **流式可见性**（跑一半可扫一眼再调舵）。
- **Worker 执行追踪**：需记录搜索轮次、死胡同、工具调用，供开发者调 prompt（当前偏黑盒）。
- **辩论三形态统一**：`debate` / `red_team` / `roundtable` 可由 `participants` 结构推导，减少 CEO 与维护方认知负担（`b26e34ec` 第二 turn）。

### 3.4 反馈闭环（`bcae2d4d` · `025a8842` · `623b42b3`）

- DAG 单向：下游发现问题无法自动打回上游；`revise` 需 CEO 手动触发。
- **Worker 轻量追问**：修订者无法向下游前任提问消歧（如两位审查官改法矛盾）。
- **延迟定稿**：`bind_after_deps` 已支持「先调研再定下游 spec」；`025a8842` 列为方向二。
- 圆桌结论（`bcae2d4d`）：**双层门控**——规划层前置算 DAG 拓扑；执行层按产出风险动态调阈值，变更仅在 task boundary 触发。

### 3.5 任务分解与编排（`a0b9e4aa` · `bcae2d4d` · `99bcd6cf`）

- **自动分解引擎**：按数据依赖图而非字数扇出。
- **拆活学习曲线**：`team_orchestration_advanced` 需 `consult_skill` → 建议自检清单常驻 prompt。
- **融合层 Worker**：多路并行调研后专用消歧/对比 Worker（`depends_on` 全部调研节点）。
- **模型异构路由**：简介实测 5 worker 均 `strong` → 审查应用 `fast`，CEO 疏忽；辩论多模型已有雏形。

### 3.6 CEO 角色与交互（`a0b9e4aa`）

- **轻量模式**：单行/单文件改动强制 delegate 开销大 → CEO 有限写权限或 fast 下行授权。
- **开工提案卡量化**：按「选错重做代价」过滤低杠杆问题，默认执行不问。
- **交付概览模板**：每 Worker → 关键结论 / 文件路径 / 融合点 / 待确认项。
- **记忆时效**：画像软约束 → 时间戳 + 置信度，过期降权。

### 3.7 安全（`a0b9e4aa`）

- 跨 Worker 传递代码需 **静态安全过滤**（`rm -rf`、`eval(user_input)`、`shell=True` 等 pattern）——防恶意逻辑在链内执行。

### 3.8 测试方法论（`99bcd6cf`）

AI 归纳六维测试矩阵：

| 维度 | 测什么 |
|---|---|
| 任务分解合理性 | 扇出是否稳定、是否过碎/过塌 |
| 上下文传递损耗 | 上游刻意细节下游是否保留 |
| 角色隔离 | 虚假信息是否串扰 |
| 收敛效率 | 辩论/并行汇总是否丢分歧 |
| 异常恢复 | Worker 失败能否 replan |
| 对抗鲁棒性 | 注入指令劫持 |

第二 turn 请求「设计覆盖任务分解 + 上下文损耗的测试用例」时 **`delegate` 报错**（`tool.execute_end status=error`），用例未落盘——属工程接缝，见 §六。

---

## 四、优先级汇总（跨会话合并）

> **前提声明**：以下优先级基于合成测试场景的 AI 自评，不代表真实用户痛点排序。首个真实用户反馈后需重新校准。

以 **`623b42b3` / `trace 6e381d5c…`** 的表为锚点，与其它会话对齐后：

| 优先级 | 改进点 | 主要受益方 | 来源 | 状态 |
|---|---|---|---|---|
| **P0** | 中间可见性（流式 / 跑一半可审视） | CEO + 用户 + 前端 | `623b42b3` | Phase 1 ✅ / Phase 2a Step 1 ✅ / Steps 2–5 ⏳ |
| **P0** | 团队共享上下文 / 便签墙增强（减 task 手写） | CEO + Worker | `a0b9e4aa` · `025a8842` · `623b42b3` | Phase 1-2 ✅ / Phase 3 ⏳ |
| **P0** | 语义级评审（contract 后 AI review） | 质量 | `a0b9e4aa` | 未开始 |
| **P1** | 结构化 `contract` 用于审查/辩论输出 | 下游自动化 | `623b42b3` | 未开始 |
| **P1** | 轻量模式（CEO 小改动免 delegate） | 延迟 | `a0b9e4aa` | 未开始 |
| **P1** | 量化开工问题过滤 | 交互 | `a0b9e4aa` | 未开始 |
| **P2** | 并行 Worker 共用便签墙（横向信号） | 协作质量 | `623b42b3` | Phase 1 prompt 层 ✅（审查官 post_note policy） |
| **P2** | 级联返工 / stale 标记 | 一致性 | `a0b9e4aa` | 未开始 |
| **P2** | 自动任务分解 | 扇出质量 | `bcae2d4d` | 未开始 |
| **P2** | 融合层 Worker | 并行调研消歧 | `025a8842` | 未开始 |
| **P3** | Worker 轻量追问通道 | Worker 间 | `623b42b3` | 未开始 |
| **P3** | 智能模型档位分配 | 成本 | `623b42b3` · `bcae2d4d` | ProviderRouter 已落地（多厂商路由 + 辩论多模型） |
| **P3** | 辩论 API 三形态合一 | 可维护性 | `b26e34ec` | DebateForm enum 统一 schema；路由分叉收口中 |
| **P4** | 自动上下文拼装（声明材料指针） | 规模化 | `623b42b3` | 未开始 |
| **P4** | Worker 执行追踪日志 | 开发者调试 | `bcae2d4d` | Journal 端口已落地（执行级事实） |
| **P4** | 跨 Worker 代码安全过滤 | 安全 | `a0b9e4aa` | 未开始 |

### P0 锚点原文摘要（`6e381d5c…`）

CEO 侧三条：

1. **任务描述全靠手写** → 要自动剪裁层或 shared context 指针。
2. **无中间可见性** → 要流式可见，不只 checkpoint 两档。
3. **审查缺结构化 contract** → CEO 承认「有机制没用」。

Worker 侧三条：

4. **并行审查零通信** → 共用便签墙。
5. **无回溯追问** → 轻量问答原语。
6. **模型档位一刀切** → 审查用 `fast`，写手/修订用 `strong`。

---

## 五、与现有能力 / 文档的对照

| AI 建议 | 代码/文档中是否已有雏形 | 差距 |
|---|---|---|
| 便签墙 / 团队共识 | playbook、`build_feature` 便签 | 非通用；并行审查未接入 |
| `contract` 结构化输出 | `delegate` 参数已有 | CEO 实测未使用；无字段级修订 |
| `bind_after_deps` 延迟定稿 | 已有 | 回流仍要 CEO `replan` 两回合 |
| `checkpoint_after` | 已有 | 结构化挂起已落地（plan_review interaction + paused_turns + POST /resume）；自动同行评审仍未建 |
| `result_handling: summarize` | 已有 | 非「对下游定制摘要」 |
| `revise` 唤回作者 | 已有 | 无自动级联、无 Worker 自发追问 |
| 辩论三形态 | `debate` / `red_team` / `roundtable` | DebateForm enum 已统一 schema + FORM_LABELS 映射；主持人路由分叉已收口 |
| 上下文 Provider 统一抽象 | [`上下文注入统一性讨论.md`](./上下文注入统一性讨论.md) | ContextAssembler + PromptContributor 插件化已落地（runtime/context/assembler.py）；统一 ContextProvider 按扳机留缝、暂不建 |
| 中间可见性 / 流式 Worker 产出 | 前端 execution store、SSE | Phase 1 前端已闭环（reviewConcern + 节点徽章 + 状态条「查看进行中」）；Phase 2a redirect 交互已落地；scheduler 单人取消仍 ⏳ |
| conformance 向量 | `apps/server/agentcore/conformance/vectors/` | debate 向量已丰富（质询 / 记分 / 结辩 P4 端到端），但仍未按 AI 六维系统编排 |

---

## 六、同期工程问题（非产品建议，但影响可信度）

| 现象 | 日志/会话 | 备注 |
|---|---|---|
| SQLAlchemy 连接未归还 | `623b42b3` · `trace 6e381d5c…` | `CancelledError` + GC 警告；消息仍 `local_turn_recorded` |
| `delegate` 立即失败 | `99bcd6cf` 第二 turn · `trace 0d2f4002…` | `duration_ms=0` · `status=error`；测试用例未生成 |
| 连接中断 | `623b42b3` 第四 turn | 4 路并行调研未完成 |
| `read_url` 熔断 | 多场 Marvis 调研 turn | `engine.tool_circuit_breaker` |
| 流式超时重试 | 辩论 worker / CEO | `llm.stream_timeout_retry` |

这些项适合进工程 backlog，与 §四 产品优化分开排期。

---

## 七、建议的下一步（供人决策）

1. **止血**：修复 §六 工程问题（连接池泄漏 + delegate 零耗时失败），这是多 Agent 可信度底线。
2. ~~收割 Phase 1~~ → **Phase 1 已关闭**：中间可见性 Phase 1 + 便签墙 Phase 1-2 均已落地并有 conformance 向量验收。
3. **推进 Phase 2a**：中间可见性 Step 1（redirect 交互）已落地；下一步是 Step 2 scheduler 单人取消 + Step 3 冷重跑（详见 [`05-设计/中间可见性设计.md`](../05-设计/中间可见性设计.md) §9.4）。
4. **真实场景验证**：用比"四句简介"更有代表性的任务检验优化效果；[`法律垂直场景设计.md`](./法律垂直场景设计.md) 提供了多文件法律分析场景可参考。
5. **新方向备忘**：Sidecar 本地引擎已落地后，§3.1 上下文传递与 §3.3 可见性的约束模型已变（进程内 asyncio vs 远程 SSE）；ProviderRouter 多模型路由也已超出原 P3「档位分配」范畴——后续优化需纳入这两个新维度。

---

## 八、附录：各会话用户原问

- `b26e34ec`：「辩论功能向我专业一点介绍、我是开发人员」→「三种形态是否可以收为一种」
- `a0b9e4aa`：「我想了解一下你的提示词或者功能有什么可以优化的、我是开发人员」
- `bcae2d4d`：「你知道 Agent 之间的协作吗？讨论下有什么需要优化的？」→「可以启动 worker 让他们来反馈下」（roundtable 4 轮）
- `025a8842`：「子 worker 的上下文是怎么传递的？…我们来讨论下如何优化」
- `99bcd6cf`：「如何测试多 Agent 的协作能力」→「设计测试用例，覆盖任务分解和上下文传递损耗」
- `623b42b3`：Marvis 对比与机制实测 →「你觉得这次的任务有什么需要优化的？…讨论下后续如何优化你和 worker」

完整 AI 回复见 DB `messages` 或 `log_timeline.py` 输出。

---

## 九、实施切片索引

以下 P0 项已拆为独立设计文档：

- **中间可见性**：→ 见 [`05-设计/中间可见性设计.md`](../05-设计/中间可见性设计.md)
- **共享便签**：→ 见 [`05-设计/共享便签设计.md`](../05-设计/共享便签设计.md)
- **Run Redirect（跑一半改方向）**：→ 见 [`05-设计/中间可见性设计.md` §9.4](../05-设计/中间可见性设计.md)
- **多 Agent 编排参考**：→ 见 [`07-规划/多Agent编排优化-参考Cursor-Multitask.md`](./多Agent编排优化-参考Cursor-Multitask.md)
- **法律垂直场景（验证场景）**：→ 见 [`07-规划/法律垂直场景设计.md`](./法律垂直场景设计.md)
