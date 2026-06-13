# Agent 记忆与知识系统

> **状态**：MVP 方案已确定（存储基础、分层策略、注入流程）；高级特性待定
> **创建时间**：2026-06-13
> **更新时间**：2026-06-14（新增 §五 工作区上下文模型）

---

## 核心问题

在 Multi-Agent First 产品中，每个 Agent 如何持有和管理记忆？多个 Agent 之间如何共享上下文和知识？

---

## 一、MVP 记忆分层 ✅ 已确定

MVP 阶段实现三层记忆，覆盖最核心的用户体验需求。

### 1.1 分层总览

| 层级 | 存储 | 生命周期 | MVP 状态 |
|------|------|----------|----------|
| **工作记忆** | 内存（对话历史 + TaskWorkspace） | 会话内 | ✅ 必须 |
| **会话摘要** | PostgreSQL `conversations` 表 | 持久化 | ✅ Day 1 必须 |
| **用户偏好** | PostgreSQL `user_memory` 表 | 持久化，可演进 | ✅ Day 1 必须 |
| 项目知识库 | pgvector 语义检索 | 跟随项目 | ❌ 延后 |
| 跨 Agent 共享记忆 | — | — | ❌ 延后 |

### 1.2 工作记忆（会话内）

当前会话中的即时上下文，无需额外存储，已有组件直接提供：

| 来源 | 内容 | 已有设计 |
|------|------|----------|
| 对话历史 | 用户消息 + Agent 回复 | Zustand `useSessionStore` |
| TaskWorkspace | Agent 步骤输出 + 产物 | [执行引擎 §十一](执行引擎架构设计.md) |
| Agent 消息历史 | Agent 实例的 LLM 对话上下文 | `AgentInstance.message_history` |

工作记忆**不需要额外设计**，它就是现有运行时数据。

### 1.3 会话摘要（跨会话）

会话结束时自动生成摘要，供后续会话的编排器使用。

```python
@dataclass
class SessionSummary:
    conversation_id: str
    user_id: str
    title: str                      # LLM 自动生成的一句话标题
    summary: str                    # ≤500 字的会话摘要
    key_decisions: list[str]        # 本次会话做出的关键决策
    tools_used: list[str]           # 使用过的工具
    agent_count: int                # 使用了几个 Agent
    created_at: datetime
    updated_at: datetime
```

**摘要生成时机**：会话结束时（用户关闭 / 超时 / 新开会话），后台用 flash 模型生成。

**摘要生成 prompt**（简化）：
```
根据以下对话历史，生成一份摘要（≤500字），包括：
1. 用户要做什么
2. 最终完成了什么
3. 做出了哪些关键决策
4. 还有什么未完成的

对话历史：
{messages}
```

### 1.4 用户偏好（长期记忆）

从用户的修正和反馈中积累偏好，影响编排器和 Agent 的行为。

```python
@dataclass
class UserMemory:
    user_id: str
    preferences: dict[str, str]     # 结构化偏好，如 {"code_style": "type hints always"}
    facts: list[MemoryFact]         # 学习到的事实
    updated_at: datetime

@dataclass
class MemoryFact:
    content: str                    # 如 "用户偏好 Python type hints"
    source_conversation: str         # 来源对话 ID
    confidence: float               # 0.0-1.0
    created_at: datetime
```

**偏好提取时机**：与会话摘要同时，用 LLM 从对话中提取新偏好。

**提取 prompt**（简化）：
```
分析以下对话，提取用户的偏好和特征（如技术栈偏好、沟通风格、工作习惯等）。
只输出新发现的、高置信度的事实，不要重复已知的。

已知偏好：
{existing_facts}

本次对话：
{messages}
```

---

## 二、记忆注入流程 ✅ 已确定

记忆通过编排器输入的 `context` 字段注入到系统中。

```
用户发消息
  │
  ├── 1. 工作记忆 → 当前对话历史（直接可用）
  │
  ├── 2. 会话摘要 → 最近 5 个会话的 summary
  │        SQL: SELECT title, summary FROM conversations
  │             WHERE user_id = ? ORDER BY updated_at DESC LIMIT 5
  │
  ├── 3. 用户偏好 → preferences + facts
  │        SQL: SELECT preferences, facts FROM user_memory WHERE user_id = ?
  │
  └── 4. 组装编排器输入
         context.session_history_summary = 拼接最近 5 个会话摘要
         context.user_preferences = preferences JSON + facts 列表
         context.project_context = null (MVP 不做)
```

与编排器输入结构的对应关系（见 [`编排器Prompt与输出结构.md` §一](编排器Prompt与输出结构.md)）：

| 编排器 context 字段 | 记忆来源 | MVP 实现 |
|---------------------|---------|----------|
| `session_history_summary` | 会话摘要 | ✅ 最近 5 个 SessionSummary |
| `user_preferences` | 用户偏好 | ✅ UserMemory.preferences + facts |
| `project_context` | 项目知识库 | ❌ 空（MVP 不做） |

---

## 三、记忆生命周期

```
会话开始
  │
  ├── 加载 UserMemory → 注入编排器 context.user_preferences
  ├── 加载最近 SessionSummary → 注入编排器 context.session_history_summary
  │
  ▼
会话进行中
  │
  ├── 对话消息累积（工作记忆）
  ├── TaskWorkspace 存储 Agent 输出
  ├── 多轮对话中编排器每次都能读到完整工作记忆
  │
  ▼
会话结束
  │
  ├── LLM 生成会话摘要 → INSERT INTO conversations
  ├── LLM 提取用户偏好 → UPDATE user_memory（合并新 facts）
  └── TaskWorkspace 归档到 PostgreSQL
```

---

## 四、运行时上下文管理 ✅ 已确定

> 多 Agent 长任务的上下文管理机制。补充 §一的「存储层」，本节定义「运行时如何装配和传递上下文」。

### 4.1 上下文全景：8 类 × 5 种边界

上下文不是一个东西，而是 8 类不同的内容跨 5 种边界传递：

**8 类上下文：**

| 类 | 内容 | 说明 |
|---|---|---|
| 行为层 | system_prompt + 技能 + 规则 | 定义 Agent「是什么」 |
| 参考层 | 工作区文档 + 文件清单 | Agent「能看到什么」 |
| 历史层 | 对话消息历史 | 已经聊过什么 |
| 任务工作记忆 TWM | goal/plan/findings/open_questions | 当前任务的结构化状态 |
| 寻回 Recall | 裁剪丢弃的内容，可按 ID 精确取回 | 超窗口但仍可访问的知识 |
| 委派层 | 父→子上下文（摘要 + 增量） | 跨 Agent 传递 |
| 产物层 | 对话工作区中的文件产物 | 跨步骤传递（见 §六 Agent协作模式.md） |
| 运行时身份 | user/conv/turn/run/folder | 系统元信息 |

**5 种传递边界：**

| 边界 | 机制 | 关键约束 |
|------|------|---------|
| 轮内（单次 LLM 窗口） | Segment 声明式装配 + 预算分配器 | 易变块后置保护缓存命中 |
| 跨轮（暂停/恢复） | 状态快照序列化 | 新增持久态不进快照即丢 |
| 跨 turn | 只回放 user/assistant text | 工具调用 I/O 是遥测，不入记忆 |
| 跨 Agent（委派） | 基底摘要 + 增量 + 契约裁剪 | 约束 4：上下文最小传递 |
| 跨进程（异步） | NATS payload 携带必要上下文 | trace_id 串起全链路 |

### 4.2 任务工作记忆（TWM）

长任务中 Agent 主动维护的结构化状态，与对话历史正交：

```
<task_working_memory>
  goal: "用户的顶层目标"
  plan:
    - step_1: "..." [done]
    - step_2: "..." [in_progress]
    - step_3: "..." [pending]
  findings:
    - "关键发现 1"
    - "关键发现 2"
  open_questions:
    - "待确认问题"
</task_working_memory>
```

**特性**：
- Agent 通过 `update_task_state` 工具主动更新
- 作为"钉住块"永不被窗口裁剪丢弃
- 跨压缩与暂停存活
- 快照随消息持久化，冷启动可恢复

### 4.3 可寻回归档（Agentic Recall）

窗口裁剪不等于丢失——被裁剪的内容自动归档为可寻址 artifact：

```
裁剪丢弃组 → artifact_store 归档（按 turn:round:kind:key 可寻址）
                              ↓
                Agent 需要时调 recall(artifact_id) 精确取回
```

Agent 拥有 `recall` 工具，可列出归档目录并按需取回完整内容。这让 Agent 能处理超窗口的长任务——窗口是"桌面"，recall 是"文件柜"。

### 4.4 窗口布局原则（缓存友好）

```
┌── LLM 窗口 ──────────────────────────────────────┐
│  system_prompt（静态前缀，命中 provider 缓存）     │  ← STABLE_FRONT
│  [Earlier conversation summary]                    │
│  …近期 history（append-only）…                     │  ← APPEND_ONLY
│  <task_working_memory>（钉住块）                   │  ← VOLATILE_TAIL
│  [Archived materials] 索引                         │
│  [最近取回] recall 全文                            │
└──────────────────────────────────────────────────┘
```

**关键原则**：易变块后置——TWM 和归档索引每轮都变，放在 append-only history 之后，避免变动废掉 history 的 provider 前缀缓存。

### 4.5 预算参考值

| 维度 | 参考值 | 说明 |
|------|--------|------|
| 跨 turn 历史 | 40% 窗口容量 | 给补全和实时内容留空间 |
| 补全预留 | 20% 窗口容量 | LLM 生成用 |
| 安全缓冲 | 12% | token 估算误差缓冲 |
| 工具结果压缩 | soft 1500 / hard 4000 字符 | 大工具输出自动压缩 |
| 委派基底摘要 | 2500 字符 / 最多 10 条 / 每条 500 字符 | 父对话传递给子 Agent 的预算 |
| 委派链合成上限 | 6000 字符 | why-chain 逐层累积上限 |
| 委派深度 | 最大 3 层 | 防递归爆炸 |
| 并行委派 | 最大 10 个 | 并发预算 |

---

## 五、工作区上下文模型 ✅ 已确定

> 统一到文件系统：用文件替代独立 Memory 模块，参考 Cursor 的工作区模型——rules 是文件、docs 是文件、AI 上下文就是文件。

### 5.1 文件夹 = 对话的上下文边界

不引入新实体。**任何文件夹天然就是对话的上下文边界**，对话关联到哪个文件夹，那个文件夹的文档就是该对话的上下文。类比 Cursor：打开项目目录 = 进入该项目的上下文。

- 对话创建时可选文件夹，也可不选
- 已绑定的对话不可解绑、不可迁移（`folder_id` 一旦设置即为终态）
- 无文件夹的对话仍受账号级全局规则约束

### 5.2 文件角色模型

| role | 含义 | 谁写 | 注入行为 |
|---|---|---|---|
| `instruction` | 用户指令文档 | 用户 | 按 `apply_mode` 进入统一 `<rules>` |
| `preference` | AI 维护的偏好文档 | AI | 恒为 `always` 合成规则 |
| `general` | 普通文件/文档 | 用户/AI | 经 RAG top-K 进入 `<workspace_context>` |

用户视角：`instruction` 属"规则"族，`preference` 显示为"记忆"（AI 维护），`general` 是普通文档。

### 5.3 位置即作用域

全局规则不靠标记位，而靠**位置**：放在云端根（`parent_id IS NULL`）的 `instruction` 文档注入所有对话。子文件夹的 `instruction` 只对该文件夹上下文内的对话生效。

- 全局规则与文件夹规则共享同一注入预算口径（`MAX_INSTRUCTION_*`），不各自一份
- 累积合并时**全局优先**（始终生效基线，预算紧张时优先存活）
- 委派子 Agent 继承用户全局规则，避免父子行为约束分裂

### 5.4 注入模式

`instruction` 文档支持三种 `apply_mode`：

| 模式 | 行为 | 字符预算 |
|---|---|---|
| `always`（默认） | 全文注入 `<rules>` | 计入 `MAX_INSTRUCTION_CHARS` |
| `conditional` | 按 globs 匹配场景注入 | 计入 |
| `on_demand` | `<rules>` 仅列名，Agent 经 `consult_rule` 按需拉取全文 | 不计入 |

### 5.5 上下文装配顺序

```
Agent system_prompt → Marketplace Rules → Skills → Workspace Context → 用户附件
```

### 5.6 搜索范围设计

限制发生在**内容量层面**（多少 token 进 prompt），而非结构层面（多少层文件夹）：

| 机制 | 范围 | 限制手段 |
|---|---|---|
| instruction/preference 注入 | 仅关联文件夹的 **direct children** | `MAX_INSTRUCTION_DOCS` / `MAX_INSTRUCTION_CHARS` |
| RAG 知识检索 | **整棵子树**，无深度限制 | chunk 上限 + top-K + 相关度阈值 |

instruction 不递归是因为规则按层级生效（子文件夹有自己的指令）；RAG 不限深度是因为用户心智是"文件夹里的东西 AI 都能看到"。

---

## 六、与 LLM 上下文窗口的关系

DeepSeek V4 有 1M token 上下文窗口，这极大简化了记忆设计：

| 内容 | 估算 token 数 | 说明 |
|------|-------------|------|
| 当前对话历史 | 5K-50K | 大多数对话 |
| 会话摘要（5 个 × 500 字） | ~3K | 很小 |
| 用户偏好 | ~1K | 很小 |
| Agent system prompt | ~2K | 每个 Agent |
| 依赖注入（前置步骤输出） | 5K-20K | 来自 TaskWorkspace |
| **合计** | ~15K-75K | 远小于 1M 窗口 |

**MVP 阶段利用 1M token 窗口优势，仅实现基础上下文管理（工作记忆 + 会话摘要 + 用户偏好），复杂压缩/裁剪策略留待窗口不足时实现**。1M 窗口足够容纳 MVP 所有记忆内容。

---

## 七、与竞品的对比

| 产品 | 记忆能力 | 我们的优势 |
|------|----------|-----------|
| ChatGPT Memory | 跨会话记忆事实 | 类似能力（用户偏好），但我们的记忆服务多 Agent |
| Cursor | .cursor/rules + 上下文窗口 | 跨会话摘要让编排器了解历史上下文 |
| Claude Projects | 项目级知识库 | MVP 同等（都不做深度项目索引），但我们有多 Agent 协作记忆 |

---

## 八、MVP 范围 vs 未来

| 能力 | MVP | 未来 |
|------|-----|------|
| 工作记忆（当前会话） | ✅ 已有设计 | ✅ |
| 会话摘要（跨会话） | ✅ Day 1 必须（PostgreSQL + LLM 摘要） | 向量检索相关会话 |
| 用户偏好（长期） | ✅ Day 1 必须（基础 KV + facts） | 自动学习 + 置信度衰减 |
| 项目知识库 | ❌ | pgvector 语义检索 |
| 跨 Agent 共享记忆 | ❌ | 共享知识图 |
| 记忆编辑 UI | ❌ | 用户查看/编辑/删除记忆 |
| 遗忘机制 | ❌ | 基于访问频率和时间衰减 |
| 记忆导入/导出 | ❌ | 用户迁移支持 |

---

## 九、开放问题

- [x] 记忆分层策略 → 三层：工作记忆 / 会话摘要 / 用户偏好
- [x] 记忆检索方式 → MVP 用 SQL 时间序列查询，不做语义检索
- [x] MVP 最小可行版本 → 自动摘要 + 偏好提取 + 编排器注入
- [x] 记忆与上下文窗口 → 1M token 窗口足够，MVP 仅基础上下文管理，复杂压缩留待窗口不足时实现
- [x] 记忆粒度 → 用户级（非 Agent 级），所有 Agent 共享同一用户的记忆
- [ ] 会话摘要的质量评估（如何验证 LLM 生成的摘要是否有用）
- [ ] 用户偏好 facts 的去重和冲突解决策略
