---
status: blueprint
code: apps/server/agentcore/memory/
related:
  - docs/03-AI核心/上下文传递可视化.md
  - docs/02-架构/双模式工作区.md
skip_if:
  - 只改 World A/B 提示词架构或 World B 内部工具提示词（读执行引擎 §七）
---

# Agent 记忆与知识系统

> **状态**：MVP 方案已确定（存储基础、分层策略、注入流程）；作用域分层（全局/项目）+ 偏好/画像二分**后端已落地**（§1.4 / §二），项目层双栏画像编辑器 + 主题树浏览·编辑·删除**前端已落地**（§1.6）；embedding 去重等高级特性待定
>
> → 见代码：`apps/server/agentcore/memory/`

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

> **记忆与规则统一**：长期记忆不再是独立的 `user_memory` 表，而是文件树里一个由 AI 维护的 `rule` 文件——与用户写的规则**同载体、同注入管线**，仅靠 `ai_maintained` 布尔位区分「谁可静默改写」。设计依据见 §五；被否决的 `user_memory` 表方案见 §八。

### 1.2 工作记忆（会话内）

当前会话中的即时上下文，即现有运行时数据（对话历史 + worker 产物），无需额外设计层。

### 1.3 自动标题（替代已移除的「会话摘要」）

> **会话摘要记忆层已移除**。理由：跨会话情景对 CEO 分工帮助有限；可复用信号由长期记忆文件（§1.4）承载；相关任务多在同会话续接。仅保留自动标题（侧边栏 UX，非记忆层）。

唯一保留的是**自动标题**：一句话标题，写入已有的 `conversations.title` 列，仅用于侧边栏展示。它是 UX 特性、不是记忆层——**不进任何 Agent 上下文、不含 `key_decisions`**。

### 1.4 用户长期记忆（AI 维护的记忆文件夹）

用户的长期记忆是文件树里一个 AI 维护的**文件夹** `记忆/`（其内每个 `.md` 都是 `role=rule`、`ai_maintained=true`；与用户手写规则同载体、同注入，区别仅在 AI 可静默改写，详见 §五）。**记忆按位置分两个作用域**（位置即作用域，[§5.3](#53-位置即作用域)——不另立标记位、不给用户手动开关）：用户云端根（`parent_id IS NULL`）下是**全局**（注入每次对话），项目文件夹下是**项目级**（仅绑定该文件夹的对话才注入）。`apply_mode` 由位置约定派生（无 manifest）：

```
（全局：用户云端根下，注入所有对话）
记忆/
├── 偏好.md       always       沟通偏好 + 工作习惯（软、普适、仅全局）
├── 画像.md       always       技术栈 + 关于用户的事实（全局事实）
└── 主题/<slug>.md on_demand   全局话题 / 经验 / 流程（按需查阅）

（项目级：folder_id = F 的文件夹下，仅 F 内对话注入）
记忆/
├── 画像.md       always       本项目事实 / 技术栈（在 F 内常注入；项目层无偏好）
└── 主题/<slug>.md on_demand   本项目话题 / 经验 / 流程（按需查阅）
```

**为什么是文件夹而非单文件**（驱动是产品 / 架构、**不是** token——1M 窗口装得下，见 §六）：① **作用域**——`记忆/` 可落到项目文件夹下，[§5.3 位置即作用域](#53-位置即作用域)天然分「全局 / 项目」两层 ✅；② **记忆类型**——文件夹装得下 episodic（"试过 X、因 Y 失败"）/ procedural（"本项目部署流程"）/ 项目知识，不再只有「偏好 / 事实」；③ **通往文件树的桥**——目标本就是「记忆进文件树」，直接落成「`记忆/` 一组 `ai_maintained` rule 文件」、迁移即终点。行业坐标：Anthropic Memory Tool（`/memories` 一个文件夹、反向量、整文件读）、Letta/MemGPT（分层 + 后台整理）佐证「记忆 = 文件夹 + agentic 自取」这一路线（与 §5.6 反向量决策一致）。

**always 核心 = `偏好.md` + `画像.md`（按「怎么对我 vs 关于我」二分）** ✅：常注入核心是两个文件——`偏好.md` 收 `沟通偏好`/`工作习惯`（软、普适、**仅全局**），`画像.md` 收 `技术栈与工具`/`关于用户的事实`（较硬、可全局可项目）。两者都沿用「固定小节锚点 + 确定性 ops」纪律（AI 只在小节内增删 bullet，防自由文本漂移），只是 ops 多带「**作用域 + 文件**」两维路由。**为何拆、为何此时拆**：阶段一曾否决二分（无第二作用域时纯属预支复杂度）；其价值由作用域解锁——有了项目层才出现「偏好天生全局、不该复制进每个项目；只有事实/知识按项目变」这条真实分界，故 A（作用域）、B（偏好/画像）同期落地。分文件 = 分 CAS、分变更原因，整理边界清爽。

**作用域规则与关键决策（现状）**：

- **叠加注入，不替换**：绑定文件夹的对话注入「全局 + 该项目」两层；与全局规则共享同一 `MAX_INSTRUCTION_*` 口径，紧张时**全局优先存活**（§5.3）。裸聊（无文件夹）只有全局；委派 worker 继承两层。
- **项目层只放事实/知识、不放偏好**：偏好（怎么跟我沟通）天生普适，故项目 `记忆/` 无 `偏好.md`——避免把全局偏好复制进每个项目（这是 B 由 A 解锁的核心断言）。
- **冲突不做硬覆盖结构**：同一事实全局 vs 项目相左（如全局「我用 Python」/ 本项目「这仓用 Rust」），靠措辞 + 就近相关性化解，注入时项目段带「仅本项目适用」标签；用户手写硬规则恒胜（§二）。
- **作用域靠位置、不靠开关**：跟着对话的 `folder_id` 走，**不**给用户手动「这条记哪」开关（对齐 [`双模式工作区.md`](/docs/02-架构/双模式工作区.md)「模式跟着文件走」）。暂不做「按项目关记忆」的细粒度开关，沿用全局 `memory_enabled`（无第二需求不抽象）。
- **过渡 vs 终点**：云端文件树未落地，故现以 `FileMemoryStore` 加 `scope` 维度过渡（全局落 `<base>/<user>/`、项目落 `<base>/<user>/_folders/<folder_id>/`，`scope=None` 保持阶段一行为 → **零迁移**）；文件树到位后折叠到终点形态（项目记忆 = 树内 `ai_maintained` rule 文件），一处替换收口 ⏳。

**on_demand 主题（`主题/<slug>.md`）**：`<记忆主题目录>` 列**主题名＋一行摘要**（摘要＝主题文件首行，由 `topic_summary_line` 在 render 时带出并截断以护前缀缓存；空/仅 chrome 的笔记只列名），CEO 按需用 `consult_memory(name)` 把全文拉回（注入分层见 §二）——文件夹解锁的新记忆类型靠这条按需通道承载，正文不挤常驻前缀。

**注入语气**：内容用软措辞（「倾向于」而非「必须」）。权威性由措辞携带——AI 推测的偏好与用户硬规则冲突时，以用户规则为准（见 §二）。

**迁移（一次性、幂等）**：旧单文件 `<user_id>.md` → `记忆/画像.md`，best-effort、失败保留旧文件不丢数据。→ 见代码：`memory/store.py`（`FileMemoryStore` 落 `<data_dir>/memory/<user_id>/`，每文件 CAS = 单文件 sha256）。

### 1.5 记忆维护协议（LLM 判断 + 代码落盘）

会话结束时由 flash 模型产出结构化变更 ops（`MemoryOp`），确定性代码套用——**按「作用域 + 文件」路由**：每个 op 带 `scope`（默认全局；会话有 `folder_id` 时模型可路由到项目层）+ `file` + 可选 `section`。**`section` 决定核心文件**（`沟通偏好`/`工作习惯` → `偏好.md`，`技术栈与工具`/`关于用户的事实` → `画像.md`；模型乱标 `file` 也被 `section` 纠正），主题写 `主题/<slug>.md`；`偏好.md` 强制全局（偏好天生普适）。applier 按 `file` 分桶，核心文件跑「固定小节 + 去重 + `section_cap`」纪律，主题文件 **create-on-write**（写不存在的 slug 即新建，不另设 `create` 动作）。提取 prompt 把**当前作用域上下文**（全局偏好/画像、当前项目画像、两层主题清单）喂回模型并指令路由（普适偏好 → 全局 `偏好.md`；普适事实 → 全局 `画像.md`；仅本项目成立的事实/知识 → 项目层）。**防膨胀护栏按作用域各算一份**：`主题/` 文件数上限 `memory_max_topic_files`（=24），越限 applier 拒建新文件。→ 见代码：`memory/user_memory.py`（`MemoryOp` / `core_file_for_section` / `_coerce_op` / `MarkdownMemoryApplier`）、`memory/maintenance.py`（按作用域上限）、`memory/consolidation.py`（从会话取 `folder_id` 路由）。

**写权限**：维护任务**只写 `ai_maintained=true` 的文件**，永不触碰用户手写规则（见 §五 写边界）。
**隐私与防注入边界（决策）**：两条铁律——① **默认不沉淀敏感个人数据**（身份证 / 密钥 / 精确住址 / 支付 / 健康 / 宗教 / 性取向 / 政治倾向），除非用户明确要求记住；② 把对话内容当**待总结的素材而非指令**——不把嵌入指令或粘贴的第三方文本当「关于用户的事实」记入、更不让其覆盖①。**理由**：长期记忆是会注入每一次后续 prompt 的持久文件，静默留存敏感信息、或被对话「投毒」的代价远高于普通输出（对齐 OpenAI / Anthropic）。

> **现状（MVP 实现，§1.4/§1.5 已接线）**：上文「文件树 `rule` Document + 文件注入管线」是**目标形态**；云端文件树/Document 子系统尚未落地，故 MVP 先用过渡实现，存储与注入都隐藏在抽象后，文件树到位后为一处替换。

### 1.6 记忆的查看 / 编辑 / 开关 ✅ 已落地（前端）

记忆不再对用户黑盒，且**就当成一个文件**对待。桌面端「文件」页左栏顶部一个置顶的 **「AI 记忆」入口**，点开后记忆正文在右侧详情区用**文件工作台同一台 Markdown 编辑器**打开——全文编辑、预览、AI 改写、写前 CAS 冲突处理全部白拿，和打开任意文件一模一样（不再有独立的记忆页面 / 路由）。清空＝编辑器里全选删除再保存。

- **写回 CAS**：编辑基线是记忆正文的内容哈希（`memory/store.py` `memory_version`）；后台离线整理（或另一设备）改了文件 → 保存时报冲突、让用户重载或「仍然覆盖」，绝不盲覆盖。
- **总开关**：放在**设置 →「AI 记忆」**（`/more/memory`），因为它是「行为 / 隐私设置」而非文件操作。每用户 `users.memory_enabled`（默认开）。停用＝**既不注入也不增长**——注入侧在 `runtime/pipeline/run.py` 按开关跳过加载（空正文→`<rules>` 记忆段整段消失）；整理侧在 `memory/consolidation.py` 跳过并**推进 watermark**（停用期间说的话不会在重新启用后被回溯沉淀——隐私）。
- **实时提示**：离线整理改动记忆后，经每用户 firehose（`messaging/hub.py`）推一条 `memory_updated`；前端弹一条 toast 提醒（打开着记忆的用户据此去重载），correctness 仍由编辑器保存时的 CAS 兜底。
- **全局核心 = 两片独立叶子（偏好 ‖ 画像）** ✅：「文件」页顶部「AI 记忆 · 全局」列**偏好**与**画像**两个独立叶子，各按 per-(kind,scope) API（`GET/PUT /users/me/memory/files/{kind}`）当普通文件打开——读写 / CAS / 写前冲突 / AI 改写全部复用同一 Markdown 编辑器。`偏好` 恒全局（不可项目化），`画像` 可全局可项目。（旧「合一文档」端点 `GET/PUT /users/me/memory` 仍在，专职承载总开关载荷与 `split_global_core` **有机迁移**：老 `画像.md` 里残留的偏好小节经它首次保存时搬进 `偏好.md`。）
- **项目层双栏画像编辑器** ✅：有「本项目记忆」的云项目在其工作区段下挂一个节点（靠 `GET …/projects` 列出非空项目，**无则不挂**）；点开**不是单文件而是同屏两栏** `MemoryProfileSplitEditor`——左「全局画像 · 所有对话共享」、右「本项目画像 · 仅「<项目名>」」，各是一例 `MarkdownFileEditor`（指向不同 (kind,scope) 叶子、各自独立 CAS、互不串扰），顶部标「注入时叠加」。让用户一眼分清「哪条所有对话都记得 / 哪条只此项目记得」，并能就地把放错层的事实搬层。全局叶子仍走单文件 `FileDetail`，**仅项目画像叶子**路由到双栏（`parseProjectProfilePath` 判定）。
- **主题树浏览·编辑·删除** ✅：「全局」段与每个「本项目记忆」段都升成可折叠小树——核心叶子（偏好 ‖ 画像）之外多一个**默认折叠**的 `主题/` 子夹，展开时经 `GET …/topics`（按 `folder_id` 分作用域）懒列该作用域的主题名；点开任一主题用同一 Markdown 编辑器读写（`GET/PUT …/topics/{slug}`，空正文＝删除、CAS 一致），右键「删除主题」整段删（核心叶子不可删——故未走通用 `FileTree`，而是 `MemorySection` 薄树只给「打开 +（主题）删除」，避免 source 级 caps 表达不了的逐行差异）。`主题/*.md` 至此第一次在 UI 里可看 / 编 / 删。
- → 见代码：`api/routes/memory.py`（per-leaf `…/files/{kind}` + `…/topics`(列) + `…/topics/{slug}`(读写) + `…/projects` + 旧合一 `…/memory` + `…/enabled`）、桌面端 `components/files/fileWorkbench/MemorySection.tsx`（折叠树：偏好/画像 + 主题子夹 + 右键删）、`components/files/FileWorkbench.tsx`（全局段）、`components/files/fileWorkbench/WorkspaceSection.tsx`（项目段）、`components/files/MemoryProfileSplitEditor.tsx`（双栏壳）、`services/sources/memorySource.ts`（path-aware 叶子源，含主题路径）、`services/memory.ts`（`listMemoryTopics` / `getMemoryTopic` / `writeMemoryTopic`）、`pages/more/MemorySettings.tsx`（开关）。

---

## 二、记忆注入流程 ✅ 已确定

工作记忆（当前对话历史）经 `load_recent_history`（取最近 N 条、按时序）进窗口，CEO 与各 worker 都读得到；**用户长期记忆**随文件注入管线合成进共享 `<rules>` 基座（CEO 与 worker 共用同一基座，见 §1.4）。会话摘要注入路径已移除（见 §1.3）。

**关键决策：用户偏好折叠进共享 `<rules>` 基座（CEO 与 worker 共用），不另建独立 `user_preferences` 上下文通道。** 偏好随 `assemble_system_prompt(memory_markdown=...)` 进基座，CEO 与 worker 都吃得到，无需为「编排/分工」单开一条注入路径。

**规则 vs 记忆的优先级**：合成 `<rules>` 时，用户手写规则在前（权威措辞「必须」），AI 维护的记忆在后（软措辞「倾向于」）；冲突时以用户规则为准。权威性由措辞携带，不靠单独的注入段或结构。

**注入前裁剪「人面 chrome」**：磁盘上的记忆文件顶部带的是给**人**看的标题（`# 用户记忆`）和说明（「本文件由 AI 自动维护，你可随时编辑或删除…」）；这段对模型是噪音——标题 `<rules>` 包装语已给，说明是写给用户的，混进 prompt 没有意义。故注入投影 `strip_memory_chrome`（`memory/user_memory.py`，**逐文件**调用）在合成 `<rules>` 时剥掉每个文件开头的 H1 标题 + 紧随的引用块，只注入实质小节 / 条目。**文件本身不动**——用户打开记忆文件仍看得到说明（参考 Cursor：规则正文才入 prompt，元信息留 UI）。

**记忆分层注入（作用域 + 偏好/画像）**：always 核心逐文件 chrome-strip 后**全文**进 `<rules>`，顺序为 **全局 `偏好.md` → 全局 `画像.md` →（会话在项目里时）项目 `画像.md`**——全局在前坐稳定前缀护 DeepSeek 缓存，项目段后置并带「仅本项目适用」标签（冲突靠措辞 + 就近相关性，§1.4）；整体计入 `MAX_INSTRUCTION_CHARS`、全局优先存活。on_demand `主题/*.md` 把**主题名＋一行摘要**（摘要＝主题文件首行）列进 CEO 提示词的 `<记忆主题目录>`（全局 + 项目主题名合并去重、同名以全局摘要为准，装配序 `MEMORY_TOPICS`，见 §5.5），CEO 判断相关再用 `consult_memory(name)` 把全文拉回 ReAct 循环（**跨作用域查找：项目优先、全局兜底**；与 `consult_skill` 同形的渐进披露原语，正文走工具结果、不进常驻前缀 → 不破缓存）。目录↔工具受 `memory_enabled` 总开关**同闸**：关 → 既不列目录也不挂工具，零记忆面（与 §1.6 注入侧同一隐私 off-ramp）。→ 见代码：`memory/injection.py`（`load_injected_memory` / `load_memory_topics`）、`tools/builtin/consult_memory.py`、`runtime/resolve/prompt.py`（`render_memory_topic_directory`）。

**挂起→恢复的记忆接线一致性 ✅**：`plan_review` / `ask_user` 挂起可能**跨进程**恢复，恢复时 `consult_memory` 必须与原回合**同样接线**——故两个回合级状态随挂起帧持久化：**项目作用域 `folder_id`** 与**记忆总开关 `memory_enabled`**。缺任一都会让续跑退化：丢 `folder_id` → 记忆退回全局-only（项目主题召不回）；丢 `memory_enabled` → 用户关了记忆的回合 resume 后又接回 `consult_memory`（隐私回退）。旧帧（无此字段）安全兜底为**作用域=全局 / 记忆=开**，绝不因缺值静默剥夺原回合已有的记忆面。→ 见代码：`runtime/suspension.py`（`TurnSuspension.folder_id` / `.memory_enabled` 随 `to_json`↔`suspension_from_json` 往返）、`runtime/pipeline/resume/pipeline.py`（恢复时把两者回喂 `_assemble_ceo_toolset`，与首跑同源装配）。

---

## 三、记忆生命周期

**触发点**：会话开始加载 `ai_maintained` 记忆 → 进行中累积工作记忆 → 会话结束可选生成标题 + flash 维护记忆 ops。→ 见代码：`memory/`、`runtime/pipeline/`。

---

## 四、运行时上下文管理 ⏳ 远期上下文工程

> **MVP 范围**：DeepSeek V4 的 1M 窗口足够容纳 MVP 全部记忆（见 §六），本节 TWM / recall / 委派预算等**延后到窗口不足时实现**。MVP 只做「工作记忆 + 记忆文件注入」。

上下文分 8 类（行为 / 参考 / 历史 / TWM / recall / 委派 / 产物 / 运行时身份）跨 5 种边界传递（轮内装配、跨轮快照、跨 turn、跨 Agent 委派、跨进程）。核心远期机制：

- **TWM**：Agent 经 `update_task_state` 维护 goal/plan/findings 结构化状态，作钉住块不被裁剪。
- **Agentic Recall**：窗口裁剪内容归档为可寻址 artifact，Agent 经 `recall(id)` 精确取回。
- **布局原则**：易变块（TWM、归档索引）后置，保护 history 前缀缓存命中。
- **跨 turn 历史**：只回放 user/assistant 文本——见 [`执行引擎架构设计.md` §三](/docs/03-AI核心/执行引擎架构设计.md) 历史重建原则。
- **委派预算（参考）**：基底摘要 ~2500 字符、链合成上限 ~6000 字符；**深度 `depth ≤ 2`**（`MAX_DELEGATION_DEPTH`）；单次 `delegate` 最多 10 个子任务（`MAX_DELEGATION_TASKS`，超额丢弃）、树内并发上限 8（`MAX_PARALLEL_DELEGATIONS` / `DEFAULT_MAX_PARALLEL`，超额排队）。

详述与预算表见 [`../06-规划/远期规划.md`](/docs/06-规划/远期规划.md)。

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
| `general` | — | 普通文件/文档 | 列入 `<workspace_context>` 概览，Agent 按需 `file_read`/`grep` 取正文（见 §5.6） |

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
| `on_demand` | `<rules>` 仅列名，Agent 经 consult 工具按需拉全文 | 不计入 |

> **on_demand 现状**：今日唯一接线的 on_demand 消费者是**记忆主题**（`主题/*.md`，经 `consult_memory`，见 §1.4 / §二）。面向**用户手写规则**的通用 `consult_rule` 尚未实现——按「第 3 次真重复才抽象」留到出现第二类 on_demand 消费者时再建（扳机 A，见 [上下文工程](/docs/03-AI核心/上下文工程.md)）。

### 5.5 上下文装配顺序

> 本节为「上下文装配顺序」**单一权威**（[执行引擎 §七 提示词架构](/docs/03-AI核心/执行引擎架构设计.md) 指此取顺序细节）。

每个常驻上下文源都是一个 `PromptContributor` 小插件（`key` + 正文 `text` + 渲染序 `order` + 预留 `budget`），由 `runtime/context/assembler.py`（`ContextAssembler`）统一收集，按 `order` **稳定排序**后以 `\n` 拼接；正文为空的源该回合自动丢弃（不留空行）。渲染序由 `SectionOrder` 单一枚举声明（**非**各调用点 `.add()` 的书写次序），间隔 100 留插槽：

```
BASE 100 → RUNTIME_CONTEXT 200 → MEMORY 300 → CEO_CORE 400
→ SKILL_DIRECTORY 500 → MEMORY_TOPICS 550 → CITATION 600 → WORKSPACE_OVERVIEW 800 → ATTACHMENT 900
```

这是**一套**排序坐标系；并非每条路径都用满全部档位（worker 走 `BASE`/`RUNTIME_CONTEXT`/`MEMORY`/`ATTACHMENT`，CEO 聊天走 `BASE`/`CEO_CORE`/`SKILL_DIRECTORY`/`MEMORY_TOPICS`/`CITATION`，再叠 `WORKSPACE_OVERVIEW`/`ATTACHMENT`），但两路径对相对顺序的认知永远一致。`MEMORY_TOPICS`（记忆主题目录，CEO-only）紧挨 `SKILL_DIRECTORY`：二者同形——都是「列个目录、按名拉全文」的按需块（见 §二）。

> **决策：常驻源统一为 contributor 插件、顺序声明化。** 理由：① 新增常驻源只需声明一个 `order` 即落位，无需在某个拼接点插队、改动多处调用；② 渲染序与贡献次序解耦——各调用点本就按升序贡献，稳定排序复现原内联顺序、原 `\n` 拼接，**与统一前逐字节一致**（稳定前缀不变，DeepSeek 前缀缓存不破）；③ 稳定前缀（base + hints）在前、概览 / 附件置尾，护前缀缓存（概览 / 附件都空时与原 CEO 提示词逐字节一致）；④ `budget` 字段为「扳机 B」（预算 / 裁剪 / 降级）预留**唯一读取点**——今天不强制裁剪，按需才长（触发条件见 [上下文工程](/docs/03-AI核心/上下文工程.md) 扳机 B）。→ 见代码：`runtime/context/`（`contributor.py` 定义形状 + `assembler.py` 收集排序）。

**Workspace Context（CEO）= 实时工作区概览 + 项目画像** ✅：每回合 `build_workspace_overview(backend)` 先 best-effort 检测项目画像（`detect_project_profile`：语言/框架/包管理器/monorepo 工具/VCS 分支/常用命令/`AGENTS.md` 摘录；**只读清单文件、不执行命令**；画像 ≤600 字符；失败不阻塞），再拉「最近更新在前」的文件清单（文件数 + 字符预算双重封顶），一并注入 `<workspace_context>`（`WORKSPACE_OVERVIEW` 档）。**项目感知是上下文注入增强、不是新工具**；延续 agentic 检索路线，不上向量 RAG。worker 不走此块——它们已有更丰富的逐运行 manifest。→ 见代码：`runtime/context/workspace_overview.py`、`runtime/context/project_profile.py`。

⏳ **Marketplace Rules**：市场 Rules 绑定待能力域落地后接入装配链。

### 5.6 搜索范围设计

限制发生在**内容量层面**（多少 token 进 prompt），而非结构层面（多少层文件夹）：

| 机制 | 范围 | 限制手段 |
|---|---|---|
| `rule` 注入（规则 + 记忆） | 仅关联文件夹的 **direct children** | `MAX_INSTRUCTION_DOCS` / `MAX_INSTRUCTION_CHARS` |
| 工作区概览（`<workspace_context>`） | 项目画像 + 关联文件夹文件清单（**整棵子树**，最近更新在前） | 画像 ≤600 字符；文件数 + 字符预算双重封顶；只列路径与元数据、正文不进概览 |
| Agentic 检索（`file_read` / `grep` / `file_list` / `git`） | **整棵子树**（`file_list` 递归树有 `max_depth`/条目上限） | Agent 自取正文；`file_read` 支持 `offset`/`limit` 行号范围；单次工具输出截断 |

`rule` 不递归是因为规则按层级生效（子文件夹有自己的规则）；工作区不限深度是因为用户心智是"文件夹里的东西 AI 都能看到"——但**不预建向量索引**：概览给方位、Agent 用文件工具取正文（agentic 检索为主路）。

> **决策：取消向量 RAG（pgvector / embedding）作为近期工作区检索方案，改用「实时概览 + agentic 检索」。** 理由：① 向量索引一改文件就失效，需 embedder + pgvector + 重建管线，与"文件随时变"的工作区天然不合；② 关键词 `grep` + Agent 自取，在工作区规模（数十～数百文件）下召回足够、永远新鲜、零新依赖；③ 语义检索**降为扳机后手**——待工作区涨到关键词 + agentic 明显召回不足时再引入（即 §七「项目知识库 / pgvector 语义检索」未来项，触发条件见 [上下文工程](/docs/03-AI核心/上下文工程.md) 扳机 A）。

⏳ **扳机后手·`code_search` 工具**（低优先级 backlog）：索引是工具后端、**不是** prompt 自动 RAG 层——与上条决策兼容。形态：tree-sitter 分块 + BM25 混合检索工具（2a 无嵌入先行；2b 再加本地静态嵌入 + RRF）；与 `grep` **并存**（grep 精确正则、`code_search` 意图入口），命中后仍用 `file_read` offset/limit 精读。索引存工作区旁 `.agentcore/index/`（gitignore）；sidecar 与云端各算各的。嵌入 + 调用图为可选后手。**否决**：纯向量 chunk 注入 prompt。→ 工具契约见 [工具与能力系统](/docs/03-AI核心/工具与能力系统.md)；前端 CommandPalette Tier 3 语义检索为另一层（见 [远期规划 §三](/docs/06-规划/远期规划.md)）。

---

## 六、与 LLM 上下文窗口的关系

DeepSeek V4 有 1M token 上下文窗口，MVP 合计约 13K–73K，远小于窗口——**仅实现基础上下文管理（工作记忆 + 用户长期记忆文件注入）**，复杂压缩/裁剪留待窗口不足时实现。

---

## 七、MVP 范围 vs 未来

| 能力 | MVP | 未来 |
|------|-----|------|
| 工作记忆（当前会话） | ✅ | — |
| 用户长期记忆（`ai_maintained` rule 文件） | ✅ Day 1（轻结构化 markdown + ops 维护）；✅ 项目级作用域 + 偏好/画像二分（后端，见 §1.4 / §二）；✅ 项目层双栏画像编辑器 + 主题树浏览·编辑·删除（前端，见 §1.6） | embedding 去重 |
| 自动标题（侧边栏 UX） | ✅ Day 1 | — |
| 记忆可见/编辑 | ✅ 文件页顶部「AI 记忆」→ 全局偏好/画像两叶 + 项目双栏画像，当成文件用同一编辑器查看/编辑/清空（见 §1.6） | 云端文件树到位后并入树内为真节点 |
| 记忆总开关（启用/停用） | ✅ 设置→「AI 记忆」，每用户 `memory_enabled`（停用＝不注入＋不增长，见 §1.6） | — |
| 项目知识库 | ❌ | pgvector 语义检索 |
| 跨 Agent 共享记忆 | ❌ | 共享知识图 |
| 运行时上下文工程（§四 TWM/recall/委派预算） | ❌ 延后 | 窗口不足时 |
| 遗忘机制 / 导入导出 | ❌ | 基于访问频率衰减、用户迁移 |

> **被否决方案**：独立 `user_memory` 表 + 独立 `preference` 角色——与文件系统职责重叠、记忆对用户黑盒。改为 `ai_maintained` 的 `rule` 文件统一承载。

---

## 八、待定

| 议题 | 说明 |
|------|------|
| 维护触发频率 | 每会话末 flash 维护是否够；长会话是否需中途更新 |
