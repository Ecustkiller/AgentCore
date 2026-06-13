# 用户交互与 UX 设计

> **状态**：早期探索文档（§一~§四）；AG-UI 调研（§五）仍有参考价值
> **创建时间**：2026-06-13
> **更新时间**：2026-06-14
>
> **⚠️ 已确定的 UX 架构设计见 [`前端UX架构设计.md`](前端UX架构设计.md)**（双视图架构、任务卡片、图视图交互规范）。本文 §一~§四 为早期探索记录，结论已融入上述文档。

---

## 核心问题

Multi-Agent First 产品的用户界面应该是什么样的？如何让用户感知到"管理一个团队"而不只是"和一个 AI 对话"，同时避免把界面做成只有专业用户才能操作的后台管理系统？

---

## 一、用户心智模型 ✅ 已确定

> **结论**：采用「团队经理 + 观察者」混合模型。用户心智模型是「管理一个 Agent 团队」，日常操作偏观察者（只在检查点和异常时干预），但保留深度介入能力。详见 [DECISIONS.md §2](DECISIONS.md#2-核心理念)。

### 早期探索的心智模型

| 模型 | 隐喻 | 优点 | 风险 |
|------|------|------|------|
| **团队经理** ✅ | 用户是 PM，Agent 是团队成员 | 直觉、映射真实经验 | 管理负担重 |
| **指挥官** | 用户下达命令，系统自动分配 | 轻量、不需理解内部 | 与单 Agent 差异不明显 |
| **教练** | 用户培养 Agent，Agent 自主协作 | 用户粘性强 | 上手门槛高 |
| **观察者** ✅ | Agent 自主协作，用户在关键节点审批 | 最省心 | 失控感 |

---

## 二、界面形态 ✅ 已确定

> **结论**：采用「增强聊天框」+ 可切换图视图。主界面是聊天优先，简单任务体验同 ChatGPT，多 Agent 时自动出现任务卡片。详见 [`前端UX架构设计.md`](前端UX架构设计.md)。

| 形态 | 结论 |
|------|------|
| **增强聊天框** ✅ | 聊天视图为主交互界面 |
| **工作流画布** ✅ | 图视图为辅助补充（React Flow） |
| 团队仪表盘 | 不采用 |
| CLI | 不做，从 Day 1 就用 Electron GUI |

---

## 三、关键交互场景

### 场景 1：发起一个任务

- 用户如何表达任务？自然语言？表单？模板？
- 用户是否需要选择参与的 Agent？
- 任务的进度如何展示？

### 场景 2：观察 Agent 协作

- 用户能否看到 Agent 之间的对话？
- 是否需要实时展示还是只看结果？
- 信息过载如何处理？

### 场景 3：干预和修正

- 用户如何中断或修正 Agent 的行为？
- 如何回滚到某个节点重新执行？
- 检查点（human-in-the-loop）的触发时机？

### 场景 4：管理 Agent 团队

- 添加/移除/配置 Agent 的界面
- Agent 状态的展示（忙碌/空闲/出错）
- Agent 历史表现的可视化

---

## 四、UX 设计原则 ✅ 已确定

> 最终版原则见 [`前端UX架构设计.md` §六](前端UX架构设计.md#六设计原则总结)。

1. **零门槛入门** — 新用户看到的就是普通聊天
2. **渐进式揭示差异** — 任务卡片 → 图视图
3. **只在关键点求交互** — 检查点和异常时才需要用户操作
4. **视图切换无损** — 切到图视图再回来，对话流状态不变

---

## 五、AG-UI 协议对前端架构的影响

> **⚠️ 本节传输架构已过时**：实时通信已确定为 SSE（详见 [执行引擎架构设计.md §十二](执行引擎架构设计.md)）。

> **基于 2026-06-13 调研更新**

### AG-UI 是什么

AG-UI（Agent-User Interaction Protocol）是 2026 年 Agent 到用户界面的开放标准协议。由 CopilotKit 团队与 LangGraph/CrewAI 合作开发，MIT 许可，12,000+ GitHub stars。

**核心理念**：将 Agent 后端与前端 UI 通过标准化事件流解耦。

```
Agent 后端（LangGraph/CrewAI/自定义）
       │
       │  AG-UI 事件流（SSE / WebSocket）
       │
       ▼
前端应用（React / Vue / Angular / CLI）
```

### AG-UI 事件体系

AG-UI 定义了 ~30 种标准事件，分为 7 类：

| 类别 | 关键事件 | 对我们产品的意义 |
|------|----------|----------------|
| **生命周期** | `RUN_STARTED`, `RUN_FINISHED`, `RUN_ERROR`, `STEP_STARTED`, `STEP_FINISHED` | 展示 Agent 执行进度和步骤 |
| **文本消息** | `TEXT_MESSAGE_START`, `TEXT_MESSAGE_CONTENT`, `TEXT_MESSAGE_END` | 实时流式文本输出 |
| **工具调用** | `TOOL_CALL_START`, `TOOL_CALL_ARGS`, `TOOL_CALL_END`, `TOOL_CALL_RESULT` | 展示 Agent 使用工具的过程 |
| **推理过程** | `REASONING_START`, `REASONING_MESSAGE_CONTENT`, `REASONING_END` | 展示 Agent 的思考过程 |
| **状态管理** | `STATE_SNAPSHOT`, `STATE_DELTA` | 双向状态同步（JSON Patch） |
| **活动状态** | `ACTIVITY_SNAPSHOT`, `ACTIVITY_DELTA` | Agent 当前活动指示器 |
| **特殊事件** | `CUSTOM`, `RAW` | 扩展点，自定义事件 |

### Multi-Agent 场景下的 AG-UI 扩展需求

标准 AG-UI 主要面向单 Agent 场景。我们的 Multi-Agent 产品需要扩展：

1. **Agent 身份标识** — 每个事件需要携带来源 Agent 的 ID 和角色
2. **多 Agent 通道** — 多个 Agent 的事件流如何在 UI 上呈现？
   - 方案 A：单一事件流，用 Agent ID 区分（简单，但 UI 需自行分拆）
   - 方案 B：每个 Agent 独立事件流（清晰，但连接管理复杂）
   - 方案 C：编排器统一事件流 + Agent 子流标识（推荐）
3. **Agent 间交互事件** — 新增事件类型：
   - `AGENT_HANDOFF` — Agent 之间的任务交接
   - `AGENT_DISCUSSION` — Agent 之间的讨论/辩论
   - `AGENT_CONFLICT` — Agent 之间的冲突需要用户裁决
4. **团队级活动视图** — 聚合所有 Agent 的活动状态到团队维度

### CopilotKit 参考实现

CopilotKit 是 AG-UI 的参考前端框架，提供：

- **React 组件**：`CopilotPopup`、`CopilotSidebar`、`CopilotChat`
- **状态同步 Hook**：`useCoAgent` — Agent 与前端双向状态同步
- **Generative UI**：`useCoAgentStateRender` — 根据 Agent 状态动态渲染 UI
- **运行时**：`CopilotRuntime` + `HttpAgent` — 连接 AG-UI 后端

**对我们的启示**（~~已废弃：直接使用 CopilotKit 作为基础组件库~~）：
- ~~可以直接使用 CopilotKit 作为基础组件库，减少前端开发量~~ → **已否决**，见下文 CopilotKit 决策
- 在其基础上扩展 Multi-Agent 专属组件（团队仪表盘、Agent 间通信视图等）
- 或者参考其架构自建，保持更多控制权

### 前端技术架构方案

```
┌─────────────────────────────────────────────────┐
│             AgentCore 前端应用                    │
│  ┌─────────────────────────────────────────────┐│
│  │  Multi-Agent 交互层                          ││
│  │  团队仪表盘 | Agent 对话 | 工作流可视化       ││
│  │  协作视图 | 冲突解决 | 检查点审批            ││
│  └─────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────┐│
│  │  基础 UI 组件层                              ││
│  │  自建组件库（shadcn/ui）                     ││
│  │  Chat | Sidebar | Canvas | Popup            ││
│  └─────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────┐│
│  │  AG-UI 协议层                               ││
│  │  @ag-ui/client | 事件解析 | 状态同步         ││
│  │  多 Agent 事件路由 | Agent 身份管理          ││
│  └─────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────┐│
│  │  传输层                                     ││
│  │  SSE / WebSocket / HTTP                     ││
│  └─────────────────────────────────────────────┘│
└─────────────────────────────────────────────────┘
```

### 关键设计决策

| 决策点 | 选择 | 状态 |
|--------|------|------|
| 基础框架 | React 19 | ✅ 已确定 |
| 组件库 | shadcn/ui（Radix + Tailwind） | ✅ 已确定 |
| 桌面端 | Electron（electron-vite） | ✅ 已确定 |
| 状态管理 | Zustand 5 | ✅ 已确定 |
| 窗口布局 | 三栏布局（Sidebar + Main + Agent Panel） | ✅ 已确定 |
| AG-UI 策略 | 自有协议 + AG-UI 语义对齐（见下文） | ✅ 已确定 |
| CopilotKit | 不使用（见下文） | ✅ 已确定 |

> 前端技术选型详见 [前端技术选型.md](前端技术选型.md)

### AG-UI 扩展策略 ✅ 已确定

**决策：自有事件协议 + AG-UI 语义对齐。不 Fork、不引入 @ag-ui/client。**

#### 策略详情

| 维度 | 选择 | 理由 |
|------|------|------|
| 内部协议 | 自有事件协议（IPC + WebSocket） | Electron IPC 传输层与 AG-UI 的 SSE/WebSocket 假设不兼容 |
| 语义对齐 | 事件类型在语义上对齐 AG-UI 7 大类 | 未来出 Web 版时可用 adapter 转换 |
| Multi-Agent 扩展 | 自有定义：每个事件携带 agent_id + 检查点 + 计划调整 | AG-UI 没有这些概念 |
| @ag-ui/client | **不引入** | 它的传输抽象（HttpAgent/SSE）与 Electron IPC 不匹配 |
| Fork | **不 Fork** | 维护成本高，且我们不需要修改 AG-UI 本身 |
| 上游贡献 | **暂缓** | 等产品验证 Multi-Agent 事件模型后再考虑 |

#### 与 AG-UI 的事件映射

我们的事件（已在 [`执行引擎架构设计.md` §八](执行引擎架构设计.md) 和 [`前端技术选型.md` §四](前端技术选型.md) 定义）与 AG-UI 的语义对应关系：

| 我们的事件 | AG-UI 语义类别 | 差异 |
|-----------|---------------|------|
| `execution.started/completed/failed` | 生命周期 | 语义一致 |
| `step.started/completed` | 生命周期 | 我们额外携带 agent_id |
| `step.output_chunk` | 文本消息 | 按 Agent 分流 |
| `step.tool_call` | 工具调用 | 语义一致 |
| `execution.progress` | 状态管理 | 类似 STATE_DELTA |
| `checkpoint.triggered/resolved` | **无对应** | Multi-Agent 独有 |
| `plan.adjusted` | **无对应** | Multi-Agent 独有 |

#### 多 Agent 事件流策略

采用 **方案 C：编排器统一事件流 + Agent 子流标识**。

```
执行引擎 ──→ 单一 WebSocket 连接 ──→ Electron Main ──→ IPC 按 agent_id 分发
                所有事件携带 agent_id                      Zustand Store 按 agent_id 更新
```

- 一个执行实例只建一个 WebSocket 连接
- 每个事件包含 `agent_id` 字段，前端按需过滤/分流
- UI 层面的 Agent 分流由 Zustand selector 实现（`useAgentsStore(s => s.agents[agentId])`）

### CopilotKit 决策 ✅ 不使用

**不使用 CopilotKit 作为基础组件库。**

| 因素 | 说明 |
|------|------|
| UI 范围不匹配 | CopilotKit 是单 Agent 聊天 UI（Popup/Sidebar/Chat），我们需要双视图 + 任务卡片 + 图视图 |
| 传输层冲突 | CopilotKit 基于 AG-UI SSE 传输，不适配 Electron IPC |
| 扩展成本 | 在 CopilotKit 上扩展 Multi-Agent UI 的成本 ≥ 用 shadcn/ui 从头构建 |
| 参考价值 | 可参考其状态同步 hooks 的设计模式（`useCoAgent` 的思路） |

---

## 六、开放问题

- [x] 目标用户画像 → 全量知识工作者
- [x] 最小可行的界面 → 聊天视图（主）+ 图视图（辅），三栏布局
- [x] 心智模型 → 团队经理 + 观察者混合
- [x] 界面形态 → 增强聊天框 + 可切换图视图
- [x] AG-UI 扩展策略 → 自有协议 + AG-UI 语义对齐，不 Fork、不引入 @ag-ui/client
- [x] CopilotKit → 不使用（UI 范围不匹配）
- [x] Multi-Agent 事件流策略 → 方案 C：统一事件流 + agent_id 标识
