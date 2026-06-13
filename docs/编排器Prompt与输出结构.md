# 编排器 Prompt 工程与输出结构设计

> **状态**：已确定方向（输出结构和流式策略）；system prompt 细节待迭代
> **创建时间**：2026-06-14

---

## 核心定位

编排器是 AgentCore 的中枢大脑。它接收用户请求，输出结构化协作计划，驱动执行引擎调度多个 Agent 并行/串行工作。

### 职责边界

```
✅ 理解用户意图
✅ 分解任务为可执行步骤
✅ 决定 Agent 数量与角色
✅ 分配工具集
✅ 定义步骤间依赖关系（驱动并行/串行）
✅ 设定检查点位置
✅ 在检查点审视中间结果并调整计划
❌ 不做任何内容生产
❌ 不调用任何工具
❌ 不直接与用户对话（通过 UI 层转发）
```

---

## 一、编排器输入结构

```json
{
  "user_request": "帮我实现一个用户登录模块，支持 JWT 和 OAuth",
  
  "context": {
    "session_history_summary": "之前已讨论过数据库 schema 设计...",
    "project_context": "Python FastAPI 项目，已有 user model...",
    "user_preferences": null
  },
  
  "available_tools": [
    { "name": "file_read", "description": "读取文件内容", "category": "filesystem" },
    { "name": "file_write", "description": "写入文件", "category": "filesystem" },
    { "name": "web_search", "description": "搜索互联网", "category": "research" },
    { "name": "code_execute", "description": "在沙箱中执行代码", "category": "sandbox" }
  ],

  "constraints": {
    "max_agents": 5,
    "max_parallel": 10,
    "user_behavior_template": null
  }
}
```

### 字段说明

| 字段 | 来源 | 作用 |
|------|------|------|
| `user_request` | 用户原文 | 编排器理解意图的基础 |
| `context.session_history_summary` | 系统自动生成 | 避免编排器失去对话上下文 |
| `context.project_context` | 项目索引/摘要 | 让编排器了解当前工作环境 |
| `available_tools` | 工具注册表 | 编排器只能分配已有工具 |
| `constraints` | 系统配置/用户设置 | 硬性限制 |

---

## 二、编排器输出结构

编排器的输出是一个结构化协作计划，直接驱动执行引擎。

### 完整 Schema

```json
{
  "plan_type": "multi_agent | single_agent",
  "task_summary": "string — 一句话任务摘要（展示给用户）",
  
  "agents": [
    {
      "id": "string — 唯一标识",
      "role": "string — 角色名称（展示给用户）",
      "objective": "string — 该 Agent 的目标描述",
      "system_prompt_supplement": "string | null — 补充到 Agent 基础 prompt 后的角色指令",
      "tools": ["string — 分配给该 Agent 的工具列表"],
      "model_preference": "fast | standard | strong"
    }
  ],

  "steps": [
    {
      "id": "string — 步骤唯一标识",
      "agent_id": "string — 执行该步骤的 Agent",
      "task": "string — 该步骤的具体任务描述（作为 Agent 的用户 prompt）",
      "depends_on": ["string — 依赖的步骤 ID 列表"],
      "expected_output": "string — 预期产出描述"
    }
  ],

  "checkpoints": [
    {
      "after_step": "string — 在哪个步骤后触发",
      "reason": "string — 为什么需要检查（展示给用户）",
      "review_focus": "string — 审视时关注什么（指导编排器自己的审视）"
    }
  ],

  "output_strategy": {
    "merge_type": "direct | sequential | merge | compare",
    "final_summary": "boolean — 是否需要最终汇总"
  },

  "constraints": {
    "max_parallel": 10
  }
}
```

### 简单任务示例

```json
{
  "plan_type": "single_agent",
  "task_summary": "回答用户关于 JWT 的问题",
  
  "agents": [
    {
      "id": "agent_1",
      "role": "通用助手",
      "objective": "直接回答用户问题",
      "system_prompt_supplement": null,
      "tools": ["web_search"],
      "model_preference": "standard"
    }
  ],

  "steps": [
    {
      "id": "step_1",
      "agent_id": "agent_1",
      "task": "回答用户关于 JWT token 的问题",
      "depends_on": [],
      "expected_output": "清晰的解答"
    }
  ],

  "checkpoints": [],

  "output_strategy": {
    "merge_type": "direct",
    "final_summary": false
  }
}
```

### 复杂任务示例

```json
{
  "plan_type": "multi_agent",
  "task_summary": "实现用户登录模块，支持 JWT 和 OAuth",
  
  "agents": [
    {
      "id": "agent_1",
      "role": "架构师",
      "objective": "设计认证模块的 API 接口和数据模型",
      "system_prompt_supplement": "你是一个后端架构师，专注于 RESTful API 设计和安全认证方案。输出应包含完整的端点列表、请求/响应格式、以及安全考虑。",
      "tools": ["file_read", "file_write", "web_search"],
      "model_preference": "strong"
    },
    {
      "id": "agent_2",
      "role": "开发者",
      "objective": "根据架构师的设计实现登录逻辑",
      "system_prompt_supplement": "你是一个 Python 开发者，擅长 FastAPI 和安全认证。写出生产级质量的代码，包含异常处理和输入验证。",
      "tools": ["file_read", "file_write", "code_execute"],
      "model_preference": "strong"
    },
    {
      "id": "agent_3",
      "role": "测试工程师",
      "objective": "编写单元测试和集成测试",
      "system_prompt_supplement": "你是一个测试工程师，使用 pytest 编写全面的测试用例。覆盖正常路径和异常路径。",
      "tools": ["file_read", "file_write", "code_execute"],
      "model_preference": "standard"
    }
  ],

  "steps": [
    {
      "id": "step_1",
      "agent_id": "agent_1",
      "task": "分析现有 user model，设计认证相关的 API 端点（login/register/refresh/oauth）和数据结构",
      "depends_on": [],
      "expected_output": "API 设计文档（端点列表、请求/响应格式、认证流程图）"
    },
    {
      "id": "step_2",
      "agent_id": "agent_2",
      "task": "根据架构师的 API 设计实现 JWT 登录和 OAuth 集成",
      "depends_on": ["step_1"],
      "expected_output": "可运行的认证模块代码"
    },
    {
      "id": "step_3",
      "agent_id": "agent_3",
      "task": "为认证模块编写单元测试和集成测试",
      "depends_on": ["step_2"],
      "expected_output": "测试文件 + 测试通过报告"
    }
  ],

  "checkpoints": [
    {
      "after_step": "step_1",
      "reason": "API 设计是后续实现的基础，需确认方向正确",
      "review_focus": "API 端点是否完整，OAuth 流程是否合理，是否与现有系统兼容"
    }
  ],

  "output_strategy": {
    "merge_type": "sequential",
    "final_summary": true
  }
}
```

---

## 三、关键字段设计决策

### 3.1 `plan_type` — 计划类型

| 值 | 含义 | UI 行为 |
|---|---|---|
| `single_agent` | 单 Agent 直接处理 | 不显示任务卡片，类 ChatGPT 体验 |
| `multi_agent` | 多 Agent 协作 | 显示任务卡片 + 图视图可用 |

### 3.2 `agents[].model_preference` — 模型偏好

编排器不指定具体模型，只表达能力需求，由运行时映射到具体模型（此处使用 fast/standard/strong 抽象，运行时映射为 DeepSeek V4）：

| 值 | 含义 | 运行时映射示例 |
|---|---|---|
| `fast` | 速度优先，简单任务 | DeepSeek V4 Flash |
| `standard` | 平衡质量和成本 | DeepSeek V4 Flash（thinking） |
| `strong` | 质量优先，复杂任务 | DeepSeek V4 Pro（thinking） |

设计理由：
1. 解耦编排器与具体模型，模型更新不需改编排逻辑
2. 用户可覆盖映射（如全部用 strong）
3. 未来可做智能路由（根据负载、成本、性能自动选择）

### 3.3 `steps[].depends_on` — 依赖关系

这是实现串行/并行的关键：

- `depends_on: []` → 可立即启动（与其他无依赖步骤并行）
- `depends_on: ["step_1"]` → 等 step_1 完成后才启动
- `depends_on: ["step_1", "step_2"]` → 等两个都完成

执行引擎通过解析依赖关系自动确定并行度，无需编排器显式声明"这是并行的"。

### 3.4 `checkpoints` — 检查点设置原则

编排器根据以下启发式决定是否设置检查点：

| 条件 | 设检查点 | 不设 |
|------|---------|------|
| 后续步骤强依赖前序输出 | ✅ | |
| 决策方向有歧义 | ✅ | |
| 步骤独立且低风险 | | ✅ |
| 简单任务（单 Agent） | | ✅ |

### 3.5 `output_strategy.merge_type` — 输出汇总策略

| 值 | 含义 | 何时使用 |
|---|---|---|
| `direct` | 单 Agent 输出直接展示给用户 | 单 Agent 场景 |
| `sequential` | 按步骤顺序拼接各 Agent 输出 | 串行工作流 |
| `merge` | 需要一个汇总 Agent 合并多路结果 | 并行工作流的最终整合 |
| `compare` | 并列展示多路结果并突出差异 | 辩论/审查范式 |

---

## 四、流式编排实现

根据已确定的「流式编排」策略（DECISIONS §14），编排器输出应可被增量解析。

### 输出字段顺序

编排器被指导按以下顺序输出字段，使解析器能尽早触发动作：

```
1. plan_type          → UI 立即决定是否显示任务卡片
2. task_summary       → UI 显示任务标题
3. agents[]           → UI 逐个显示 Agent 行
4. steps[]            → 执行引擎逐个解析，无依赖的步骤立即启动
5. checkpoints[]      → 注册到执行引擎
6. output_strategy    → 注册到汇总器
7. constraints        → 注册到调度器
```

### 增量解析器行为

```
接收到 plan_type = "single_agent"
    → UI: 不显示任务卡片
    → 执行引擎: 准备单 Agent 模式

接收到 agents[0] 完整
    → UI: 显示第一个 Agent 行（如果是 multi_agent）
    → 执行引擎: 初始化 Agent 实例

接收到 steps[0] 且 depends_on = []
    → 执行引擎: 立即启动该 Agent 执行
    → （不等完整计划生成）
```

### 感知延迟控制

| 阶段 | 目标延迟 | 手段 |
|------|---------|------|
| 用户输入 → 首 token | < 500ms | 编排器用快速模型（fast 档，映射为 DeepSeek V4 Flash） |
| 首 token → UI 响应 | < 100ms | 流式解析 + 增量渲染 |
| 计划完成 → Agent 启动 | < 200ms | 不等完整计划，增量触发 |

---

## 五、检查点审视（Checkpoint Review）

检查点触发时，编排器被再次调用，但输入和输出与初始规划不同。

### 检查点审视输入

```json
{
  "review_type": "checkpoint",
  
  "original_plan": { "...完整的初始计划..." },
  
  "completed_step": {
    "step_id": "step_1",
    "agent_id": "agent_1",
    "output_summary": "设计了 4 个 API 端点：POST /auth/login, POST /auth/register, POST /auth/refresh, GET /auth/oauth/callback。采用 JWT + refresh token 方案。",
    "artifacts": ["docs/api_design.md"],
    "metrics": {
      "duration_ms": 15000,
      "tokens_used": 2300
    }
  },

  "review_focus": "API 端点是否完整，OAuth 流程是否合理",
  
  "remaining_steps": ["step_2", "step_3"]
}
```

### 检查点审视输出

```json
{
  "decision": "continue | adjust | escalate",
  
  "reasoning": "API 设计完整，OAuth 流程合理，可以继续",
  
  "plan_adjustments": null,

  "user_message": null
}
```

#### decision 类型

| 决策 | 含义 | 后续行为 |
|------|------|---------|
| `continue` | 中间结果合格，继续执行 | 自动启动后续步骤 |
| `adjust` | 需要调整计划 | 应用 plan_adjustments，继续执行 |
| `escalate` | 需要用户参与 | UI 展示检查点卡片，等待用户操作 |

#### plan_adjustments 格式（当 decision = "adjust"）

```json
{
  "plan_adjustments": {
    "modify_steps": [
      {
        "step_id": "step_2",
        "new_task": "实现 JWT 登录（暂不做 OAuth，API 设计中 OAuth 方案有待优化）"
      }
    ],
    "add_steps": [
      {
        "id": "step_2b",
        "agent_id": "agent_1",
        "task": "重新设计 OAuth 回调流程，参考 Google OAuth 2.0 最佳实践",
        "depends_on": ["step_2"],
        "expected_output": "修订后的 OAuth 设计"
      }
    ],
    "remove_steps": []
  }
}
```

---

## 六、编排器 System Prompt 结构

### 推荐结构

```
[角色定义]
你是 AgentCore 的任务编排器。你的职责是...

[输出格式]
你必须输出严格符合以下 JSON Schema 的计划：
{schema}

[决策规则]
- 何时使用 single_agent vs multi_agent
- 何时设置检查点
- 如何选择 model_preference
- 工具分配原则

[约束]
- 最多 {max_agents} 个 Agent
- 最多 {max_parallel} 个并行步骤
- 不要过度拆分简单任务

[反例]
- 不要为"今天天气如何"创建 3 个 Agent
- 不要给不需要的 Agent 分配工具
- 不要设置不必要的检查点

[Few-shot 示例]
示例 1: 简单问答 → single_agent
示例 2: 代码实现 → multi_agent (2-3 agents)
示例 3: 研究报告 → multi_agent (3+ agents, parallel)
```

### 关键设计原则

1. **偏向简单**：如果不确定需要多少 Agent，优先用少的
2. **工具最小集**：只给 Agent 它真正需要的工具
3. **检查点克制**：只在高价值决策点设置，不要每步都查
4. **角色清晰**：每个 Agent 的目标应不重叠、不遗漏

---

## 七、编排器失败处理

| 失败场景 | 处理策略 |
|---------|---------|
| 输出不可解析 | 重试 1 次（加强格式约束）→ 仍失败则回退 single_agent |
| 输出不合理（如 10 个 Agent） | 重试 1 次（强调约束）→ 仍不合理则回退 |
| 模型不可用 | fallback 到备选模型 |
| 超时 | 中断，回退 single_agent |

回退到 single_agent 是安全的兜底——用户最差也能得到一个普通聊天体验。

---

## 八、与其他模块的接口

### 编排器 → 执行引擎

```
输入: 结构化计划 JSON
输出: 启动 Agent 实例，建立依赖图，注册检查点
```

### 编排器 → UI 层

```
输入: 流式计划输出
输出: 
  - plan_type → 决定是否显示任务卡片
  - agents → 填充任务卡片的 Agent 列表
  - steps → 填充进度信息
  - checkpoints → 注册用户交互点
```

### 执行引擎 → 编排器（检查点触发时）

```
输入: 检查点审视请求（原计划 + 中间结果）
输出: continue / adjust / escalate
```

---

## 九、待定事项

| 议题 | 说明 |
|------|------|
| System prompt 完整内容 | 需要实际调试迭代，初始版本后根据效果优化 |
| Few-shot 示例库 | 需要收集典型场景，构建示例集 |
| 模型选择 | 编排器本身用什么模型（偏向 fast + structured output 好的） |
| 输出 schema 验证 | 是否用 JSON Schema 严格验证，还是宽松解析 |
| 多轮对话中的编排 | 后续消息是否沿用/修改之前的计划 |

---

## 变更日志

| 日期 | 变更 |
|------|------|
| 2026-06-14 | 初稿：输入/输出结构、流式编排策略、检查点审视、失败处理 |
