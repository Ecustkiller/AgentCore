# Agent 记忆与知识系统

> **状态**：MVP 方案已确定（存储基础、分层策略、注入流程）；高级特性待定

---

## 核心问题

在 Multi-Agent First 产品中，每个 Agent 如何持有和管理记忆？多个 Agent 之间如何共享上下文和知识？

---

## 一、MVP 记忆分层 ✅ 已确定

MVP 阶段实现两层记忆，覆盖最核心的用户体验需求。

### 1.1 分层总览

| 层级 | 存储 | 生命周期 | MVP 状态 |
|------|------|----------|----------|
| **工作记忆** | 内存（对话历史 + worker 运行产物） | 会话内 | ✅ 必须 |
| **用户长期记忆** | 文件树 `rule` 文件（`ai_maintained=true`） | 持久化，可演进 | ✅ Day 1 必须 |
| 项目知识库 | pgvector 语义检索 | 跟随项目 | ❌ 延后 |
| 跨 Agent 共享记忆 | — | — | ❌ 延后 |
| ~~会话摘要（跨会话）~~ | — | — | ❌ 已降级移除（见 §1.3） |

> **记忆与规则统一**：长期记忆不再是独立的 `user_memory` 表，而是文件树里一个由 AI 维护的 `rule` 文件——与用户写的规则**同载体、同注入管线**，仅靠 `ai_maintained` 布尔位区分「谁可静默改写」。设计依据见 §五；被否决的 `user_memory` 表方案见 §八。

> **会话摘要降级**：原三层方案中的「会话摘要」记忆层已移除，只保留「自动标题」这一侧边栏 UX 副产品（它不是记忆层）。理由与现状见 §1.3。

### 1.2 工作记忆（会话内）

当前会话中的即时上下文，无需额外存储，已有组件直接提供：

| 来源 | 内容 | 已有设计 |
|------|------|----------|
| 对话历史 | 用户消息 + Agent 回复 | Zustand `useConversationStore` |
| worker 运行产物 | 各 worker 步骤输出（`RunState.content`） | `WaveScheduler.completed[run_id]`（见 [执行引擎](执行引擎架构设计.md)） |
| Agent 消息历史 | 每个 step 的 LLM 对话上下文 | `engine.react_loop` 内构建的 `messages` 列表 |

工作记忆**不需要额外设计**，它就是现有运行时数据。

### 1.3 自动标题（替代已移除的「会话摘要」）

> **已移除**（见 §1.3）：会话摘要记忆层。理由：跨会话情景对 CEO 分工帮助有限；可复用信号由长期记忆文件（§1.4）承载；相关任务多在同会话续接。仅保留自动标题（侧边栏 UX，非记忆层）。→ 见代码：`memory/conversation_title.py`

唯一保留的是**自动标题**：一句话标题，写入已有的 `conversations.title` 列，仅用于侧边栏展示。它是 UX 特性、不是记忆层——**不进任何 Agent 上下文、不含 `key_decisions`**。

- **现状**：`conversation/service.py` 在会话首轮用 flash 模型（`LLMTitleGenerator`，非思考）生成一句话标题；模型输出为空或调用失败时回退为「截断首条用户消息」。LLM 调用在 DB 会话之外、且在 `message_end` 之后进行，不影响用户感知的响应结束。标题落库后在 SSE 流关闭前发 `title_generated` 事件，前端 `renameConversation` 即时刷新侧边栏。
- **接口**：`TitleGenerator` Protocol + `LLMTitleGenerator` 实现（`memory/conversation_title.py`），模型角色为 `title`（见 `llm/config.py`，flash/非思考/`max_tokens=64`）。

### 1.4 用户长期记忆（AI 维护的 rule 文件）

用户的长期偏好和事实，存为文件树里一个 AI 维护的 `rule` 文件（`ai_maintained=true`，用户可见名如 `记忆.md`）。它与用户手写规则共享存储和注入，区别仅在于 AI 可静默改写它（详见 §五）。

**落点**：用户云端根目录（`parent_id IS NULL` → 全局作用域），`role=rule`、`ai_maintained=true`、`apply_mode=always`。

**内部格式（轻结构化 markdown）**：固定小节做锚点，AI 只在小节内增删 bullet，防止自由文本漂移。

```markdown
# 用户记忆
> 本文件由 AI 自动维护，你可随时编辑或删除任何条目。

## 沟通偏好
- 用简体中文回复
- 先给结论，再给细节

## 技术栈与工具
- 后端 Python + FastAPI；函数必须有类型标注

## 工作习惯
- 倾向小步可验证，不喜欢一次性大改

## 关于用户的事实
- 在做 Multi-Agent 工作台项目（AgentCore）
```

固定小节集合：`沟通偏好` / `技术栈与工具` / `工作习惯` / `关于用户的事实`。

**注入语气**：内容用软措辞（「倾向于」而非「必须」）。权威性由措辞携带——AI 推测的偏好与用户硬规则冲突时，以用户规则为准（见 §二）。

### 1.5 记忆维护协议（LLM 判断 + 代码落盘）

为避免自由文本「越改越乱」，**不让 LLM 直接重写整篇**，而是「LLM 产出结构化变更指令 → 确定性代码套用到 markdown」：

1. 会话结束时，flash 模型输入「当前记忆文件全文 + 本次对话」，输出**变更指令 JSON**（非新全文）：

```json
{ "ops": [
  {"action": "add",    "section": "技术栈与工具", "content": "偏好 pnpm 管理 Node 依赖"},
  {"action": "remove", "section": "工作习惯",     "match": "不喜欢一次性大改"},
  {"action": "update", "section": "沟通偏好",     "match": "用英文回复", "content": "用简体中文回复"}
] }
```

2. 服务端用确定性代码按「小节定位 + bullet 匹配」套用 ops。
3. 职责分工：LLM 只负责「发现该记/删什么」（语义判断），去重 / 冲突 / 格式稳定由代码保证（确定性操作）。
4. 冲突与去重：`update` 天然覆盖旧条目；`add` 前代码做规范化去重（MVP 字符串归一，未来 embedding）。
5. 写权限：维护任务**只写 `ai_maintained=true` 的文件**，永不触碰用户手写规则（见 §五 写边界）。
6. 隐私与防注入边界（决策，2026-06）：抽取时**默认不沉淀敏感个人数据**（身份证号 / 密码密钥 / 精确住址 / 支付 / 健康 / 宗教 / 性取向 / 政治倾向），除非用户明确要求记住；并把对话内容当作**待总结的素材而非指令**——不把对话里嵌入的指令或粘贴的第三方文本当成「关于用户的事实」记入，也不让其覆盖上述规则。理由：长期记忆是**会注入每一次后续 prompt 的持久文件**，静默留存敏感信息、或被对话「投毒」的代价远高于普通输出（对齐 OpenAI / Anthropic 的记忆策略）。→ 见代码：`user_memory.py` 的 `_EXTRACT_SYSTEM_PROMPT`（PRIVACY、DATA-not-instructions 两条）。

> **现状（MVP 实现，§1.4/§1.5 已接线）**：上文「文件树 `rule` Document + 文件注入管线」是**目标形态**；云端文件树/Document 子系统尚未落地，故 MVP 先用过渡实现，存储与注入都隐藏在抽象后，文件树到位后为一处替换：
> - **存储**：`MemoryStore` 协议 + `FileMemoryStore`——每用户一个 markdown 文件落在 `data_dir/memory/<user_id>.md`（内容即上文格式）。文件树到位后迁成 `ai_maintained=true` 的 `rule` Document。
> - **注入**：会话 Prepare 阶段 `assemble_system_prompt(memory_markdown=...)` 直接把非空记忆包成软措辞 `<rules>` 注入，**单/多 Agent 共用同一基座**（多 Agent 经 `runs/executor.py` 以基座拼接子 Agent 提示）。尚无文件夹作用域与 `MAX_INSTRUCTION_*` 预算（全局根级、全文注入）。
> - **维护触发**：每轮会话末 `maintain_user_memory` 跑 load→extract→apply→save，无净变化则跳过写；提取用 `memory` 角色（flash/非思考）。全程兜底，失败只记日志、不影响对话。
> - 模型角色见 `llm/config.py`（`memory`）。→ 见代码：`apps/server/agentcore/memory/{store,maintenance,user_memory}.py`、`runtime/prompt.py`、`conversation/service.py`

---

## 二、记忆注入流程 ✅ 已确定

工作记忆（当前对话历史）经 `load_history` 进窗口，CEO 与各 worker 都读得到；**用户长期记忆**随文件注入管线合成进共享 `<rules>` 基座（CEO 与 worker 共用同一基座，见 §1.4）。会话摘要注入路径已移除（见 §1.3）。

```
用户发消息
  │
  ├── 1. 工作记忆 → 当前对话历史（直接在窗口）
  │        由 load_history 按条数截断（见 conversation/history.py）
  │
  ├── 2. 用户长期记忆 → ai_maintained 的 rule 文件
  │        随文件注入管线合成进 Agent 的 <rules>（与用户规则同管线）
  │        MVP：全局根级、全文注入；⏳ 关联文件夹级 + MAX_INSTRUCTION_* 预算（见 §1.5/§五，未落地）
  │
  └── 3. 独立 user_preferences / project_context 通道 → 不另建（折叠进 <rules>）
```

**关键决策：用户偏好折叠进共享 `<rules>` 基座（CEO 与 worker 共用），不另建独立 `user_preferences` 上下文通道。** 偏好随 `assemble_system_prompt(memory_markdown=...)` 进基座，CEO 与 worker 都吃得到，无需为「编排/分工」单开一条注入路径。

**规则 vs 记忆的优先级**：合成 `<rules>` 时，用户手写规则在前（权威措辞「必须」），AI 维护的记忆在后（软措辞「倾向于」）；冲突时以用户规则为准。权威性由措辞携带，不靠单独的注入段或结构。

CEO 上下文装配的对应关系（无独立 `OrchestratorInput` 结构，CEO 直接进 ReAct 循环）：

| 上下文 | 记忆来源 | MVP 实现 |
|--------|---------|----------|
| 对话历史 | 工作记忆（当前会话历史） | ✅ `load_history` 按条数截断 |
| 用户偏好 | 折叠进共享 `<rules>` 基座 | ✅ `assemble_system_prompt(memory_markdown=...)` |
| 项目知识 | 项目知识库 | ❌ 空（MVP 不做） |

---

## 三、记忆生命周期

```
会话开始
  │
  ├── 加载 ai_maintained 记忆文件 → 合成进 Agent <rules>
  │
  ▼
会话进行中
  │
  ├── 对话消息累积（工作记忆）
  ├── WaveScheduler.completed 持有各 worker 输出（RunState.content）
  ├── 多轮对话中 CEO 每次都能读到完整工作记忆
  │
  ▼
会话结束
  │
  ├──（可选）flash 生成一句话标题 → UPDATE conversations.title（见 §1.3）
  ├── LLM 产出记忆变更 ops → 代码套用到 ai_maintained 记忆文件（见 §1.5）
  └── worker 运行产物为回合内瞬态（经 run_* 事件呈现，不单独落库）
```

---

## 四、运行时上下文管理 ✅ 设计已定；MVP 延后实现

> 多 Agent 长任务的上下文管理机制。补充 §一的「存储层」，本节定义「运行时如何装配和传递上下文」。
> **MVP 范围**：DeepSeek V4 的 1M 窗口足够容纳 MVP 全部记忆（见 §六），本节的 TWM / 可寻回归档 / 委派预算等复杂上下文工程**延后到窗口不足时实现**，MVP 只做「工作记忆 + 记忆文件注入」。

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

### 5.2 文件角色模型（记忆与规则统一）

记忆与规则**同载体、同注入**：合并为单一 `rule` 角色，仅靠 `ai_maintained` 布尔位区分「谁可静默改写」。

| role | ai_maintained | 含义 | 注入行为 |
|---|---|---|---|
| `rule` | `false` | 用户规则（用户拥有，AI 可起草但不静默改） | 按 `apply_mode` 进入 `<rules>` |
| `rule` | `true` | AI 维护的长期记忆 | 进入 `<rules>`（默认 `always`，软措辞） |
| `general` | — | 普通文件/文档 | 经 RAG top-K 进入 `<workspace_context>` |

用户视角：`rule + ai_maintained=false` 显示为"规则"，`rule + ai_maintained=true` 显示为"记忆"，`general` 是普通文档。

**为什么不合并成一种、也不拆成两个角色**：注入进 prompt 后一切都是文本，「权威 vs 推测」无法靠结构硬性区分，由内容措辞携带即可——所以无需独立的 `preference` 角色。但「后台维护任务可静默改写哪些文件」是**代码层安全分支**：类比 repo 里「手写文件 vs 生成文件」都是文件、却必须标记以免工具乱改。`ai_maintained` 就是这个标记，删不得。`instruction` / `preference` 旧二分见 §八 否决记录。

### 5.3 位置即作用域

全局规则不靠标记位，而靠**位置**：放在云端根（`parent_id IS NULL`）的 `rule` 文档注入所有对话。子文件夹的 `rule` 只对该文件夹上下文内的对话生效。

- 全局规则与文件夹规则共享同一注入预算口径（`MAX_INSTRUCTION_*`），不各自一份
- 累积合并时**全局优先**（始终生效基线，预算紧张时优先存活）
- 委派子 Agent 继承用户全局规则，避免父子行为约束分裂

### 5.4 注入模式

`rule` 文档支持三种 `apply_mode`（用户规则与 AI 记忆通用）：

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
| `rule` 注入（规则 + 记忆） | 仅关联文件夹的 **direct children** | `MAX_INSTRUCTION_DOCS` / `MAX_INSTRUCTION_CHARS` |
| RAG 知识检索 | **整棵子树**，无深度限制 | chunk 上限 + top-K + 相关度阈值 |

`rule` 不递归是因为规则按层级生效（子文件夹有自己的规则）；RAG 不限深度是因为用户心智是"文件夹里的东西 AI 都能看到"。

---

## 六、与 LLM 上下文窗口的关系

DeepSeek V4 有 1M token 上下文窗口，这极大简化了记忆设计：

| 内容 | 估算 token 数 | 说明 |
|------|-------------|------|
| 当前对话历史 | 5K-50K | 大多数对话 |
| 用户长期记忆文件 | ~1K | 很小 |
| Agent system prompt | ~2K | 每个 Agent |
| 依赖注入（前置步骤输出） | 5K-20K | 来自上游 `RunState.content` |
| **合计** | ~13K-73K | 远小于 1M 窗口 |

**MVP 阶段利用 1M token 窗口优势，仅实现基础上下文管理（工作记忆 + 用户长期记忆文件注入），复杂压缩/裁剪策略留待窗口不足时实现**。1M 窗口足够容纳 MVP 所有记忆内容。

---

## 七、与竞品的对比

| 产品 | 记忆能力 | 我们的优势 |
|------|----------|-----------|
| ChatGPT Memory | 跨会话记忆事实 | 类似能力（用户偏好），但我们的记忆服务多 Agent |
| Cursor | .cursor/rules + 上下文窗口 | AI 自动维护的长期记忆文件（`ai_maintained` rule），与用户规则同管线注入 |
| Claude Projects | 项目级知识库 | MVP 同等（都不做深度项目索引），但我们有多 Agent 协作记忆 |

---

## 八、MVP 范围 vs 未来

| 能力 | MVP | 未来 |
|------|-----|------|
| 工作记忆（当前会话） | ✅ 已有设计 | ✅ |
| 用户长期记忆（`ai_maintained` rule 文件） | ✅ Day 1 必须（轻结构化 markdown + ops 维护） | 子文件夹级作用域、embedding 去重 |
| 自动标题（侧边栏 UX） | ✅ Day 1（`conversations.title`；已接线 flash 生成 `LLMTitleGenerator`，失败回退截断） | — |
| ~~会话摘要（跨会话）~~ | ❌ 已降级移除（见 §1.3） | — |
| 记忆可见/编辑 | ✅ **免费**（文件树直接看/改/删） | 专门的记忆管理面板 |
| 项目知识库 | ❌ | pgvector 语义检索 |
| 跨 Agent 共享记忆 | ❌ | 共享知识图 |
| 运行时上下文工程（§四 TWM/recall/委派预算） | ❌ 延后 | ✅ 窗口不足时 |
| 遗忘机制 | ❌ | 基于访问频率和时间衰减 |
| 记忆导入/导出 | ❌ | 用户迁移支持 |

> **被否决方案**：独立 `user_memory` 表（`preferences` JSONB + `facts`）+ 独立 `preference` 角色。否决理由：与正在建的文件系统职责重叠、记忆对用户黑盒（可见/编辑要另建 UI）、且「权威 vs 推测」无需用独立角色承载。改为 `ai_maintained` 的 `rule` 文件统一承载。→ 见代码: `apps/server/agentcore/memory/`

---

## 九、待定

| 议题 | 说明 |
|------|------|
| 维护触发频率 | 每会话末 flash 维护是否够；长会话是否需中途更新 |
