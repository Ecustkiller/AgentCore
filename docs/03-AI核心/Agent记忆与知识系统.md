---
status: landed
code: apps/server/agentcore/memory/
related:
  - docs/03-AI核心/上下文传递可视化.md
  - docs/02-架构/双模式工作区.md
skip_if:
  - 只改 World A/B 提示词架构或 World B 内部工具提示词（读执行引擎 §七）
---

# Agent 记忆与知识系统

> **边界**：记忆分层 / 注入 / 约定目录 = **本文**；通道可视化 → [上下文传递可视化](/docs/03-AI核心/上下文传递可视化.md)；是否统一 ContextProvider → [上下文工程](/docs/03-AI核心/上下文工程.md)；云/本地 Backend → [双模式工作区](/docs/02-架构/双模式工作区.md)。
>
> → 见代码：`apps/server/agentcore/memory/`、`workspace/indexing/`

### Cursor 从哪进

| 要改… | 去哪 | 勿当记忆入口 |
|---|---|---|
| 记忆/规则内容、落盘、巩固、探索画像、`remember` | `agentcore/memory/`（包 facade 已 re-export） | — |
| 注入段序 / `ContextAssembler` / 工作区概览 | `runtime/context/` + 回合拼装 `runtime/resolve/`（含 `prompt/memory_rules.py`） | 勿在 assembler 写记忆策略或落盘 |
| Run / delegate 执行 | `runtime/runs/` → [执行引擎](/docs/03-AI核心/执行引擎架构设计.md) | **不是**记忆域 |

---

## 目标形态 · 统一 md 条目基座（⏳ 已确认 · 未落地）

「记忆 / 规则 / 文档」三分**取消**（连 UI 一起）。基座里只有一种东西：**带 frontmatter 的 md 条目**——人和 AI 写同一种东西，模型读到的是一堆平等的 md。参照 Cursor rules 模型减去 globs；本节以下为目标，代码现状见 §一 起。

**条目形态**：正文 md + frontmatter 两个字段——生效（`常驻` | `按需`）、`description`（一行摘要，AI 写、用户可改）。没有类型、没有权威档、没有来源标记。作用域不是字段，是「挂在全局还是某个项目」这个挂载关系。frontmatter 而非 DB 列承载语义，使条目导出 / 合回本机时不丢语义。

**`description` 是枢纽**：读时模型按它决定拉哪条，写时 AI 按它决定新事实归到哪条——同一动作的两面。取消固定文件名后的语义分区由它承担，故不再需要「系统槽位」。

**`ai_maintained` 留 DB、不进 prompt**：读侧完全平权；该字段只服务两件事——写侧防护（巩固不得静默重写用户手写的条目）与 UI 审查（标出「这条是 AI 记的」供用户撤销）。

**注入三态**：

- **常驻** → 全部条目拼成**一个块**，不再有「用户规则硬 / AI 记忆软」分节与权威说明文字
- **按需** → **一个**目录（名字 + `description`）+ **一个** consult 工具；现有 `<能力目录>` / `<记忆主题目录>` / `<规则目录>` 三套目录三个工具收敛成一套
- **`@` 提及** = 运行时把一条按需条目临时当常驻用；不是 frontmatter 的第三个取值。@ 工作区文件 / 图片 / 对话仍走附件体系，按被 @ 的东西分流

**合并 consult 的两处定案**：单工具 audience = **CEO + worker**（Skill 由 CEO-only 放开——worker 同样需要「怎么写调研报告」这类 HOW；代价是 worker 常驻目录多几行）。门控随之简化为单一 `has_entries`，取代现在「skill 永远 wire、memory/rule 空则不 wire」的两套。拉不到统一为**软 miss**（`success=True` + 「没有这条」，名字拼错不该炸回合）——`consult_skill` 的硬失败与「撞 playbook 名则提示去 `delegate`」特判一并取消，playbook 入口靠 `delegate` 工具 schema 自身可见；三套 `consult_*.{hit,miss}` 观测事件合一。

**基座边界**：进基座 = 会被注入的条目（纯 DB 正文）。不进 = 运行产物（`research` / `debate` / `reviews`）、代码、附件、用户仓库自带 md → 盘上文件 + `file_read`。情景摘要与 `_memory_meta.json` 降级为巩固管线内部状态、移出基座。`文档/` 退化成纯产物目录。

**配额可见不管理**：取消固定文件名（`偏好.md` / `画像.md` / `导航.md`）后常驻集合失去天然上限，故常驻用量必须对用户可见、超限**报出来**；引擎不替用户挤（无分池、无自动淘汰、无 AI 溢出决策）。现状「超预算静默整条丢弃 + `keep_rank` 全局>项目·用户>AI」随权威档一并撤销——排序失去依据，且静默消失与「配额可见」不相容。

**治理靠可见性**：AI 每次写条目仍推记忆卡片（`memory_updates`）供查看撤销——这是取代「权威分档」的机制。AI 无法自我提权，因为已无权威可提。

**必须守住**：AI 沉淀出的核心画像 / 偏好**默认常驻**，不得因扁平化滑成按需（否决表「偏好/画像改 on_demand」仍成立）。

**分四步**（前后依赖，按风险面分层）：

| 步 | 内容 | 风险面 |
|---|---|---|
| 1 | 按需三合一：三目录三工具 → 一套（含 audience 放开、软 miss 统一） | **不动数据**但触点广（见先决）；eval baseline 在此 A/B |
| 2 | 条目化：frontmatter、取消类型、生效两档、常驻用量可见 | DB 内迁移 |
| 3 | `文档/项目/` 迁进基座；`文档/` 退化成产物目录 | **跨存储**（盘 → DB），本机传统模式需处理手改冲突 |
| 4 | Skill 条目化（代码 → DB） | 与市场 Skill ⏳ 合流 |

需接受的中间态：步 1–4 之间，按需目录同时含「代码来源的 Skill」与「DB 条目」。

**先决**：目录合一（步 1）与去分节（步 2）都是**行为改动**而非重构，落地前须有 eval baseline（量三件事：该拉不拉 / 拉错条目 / 明示约束还遵不遵守）。目前**无真实数据**，样本以 `evals/` 合成场景为准。

- **eval 覆盖是空的**：`evals/` 基建可用（真跑 `react_loop` / `run_chat_pipeline`，确定性 Check + rubric judge + `--update-baseline` 对照，nightly 软门），但 `consult_rule` / `consult_memory` 在全部用例 JSON 中零出现；`product_rules` 4 例测的是产品知识落点，不是规则遵守。**这块覆盖与本次合并无关也该有**——否则改注入即盲飞。
- **卡点在 harness 不在用例**：它跑固定隔离 `_EVAL_USER_ID`，用例现场只能靠 `workspace_fixture` 拷工作区目录，**没有 per-case 预置 DB `documents` 条目的机制**；固定 user_id 共享，还需用例间清理。
- **A/B 无需动 `prompt_profile`**（其可覆盖键不含按需目录）：加 flag 切新旧形态、同 suite 跑两遍比 baseline JSON 即可。
- **步 2 会正面撞一条护栏**：无用户规则时 `<rules>` 须与旧 memory-only 块**逐字节一致**以护 prefix cache（有专测钉着）。步 1 不碰常驻块，故不撞。
- **步 1 不是纯内部小改**：直接钉三目录标签 / 三工具 / 二分节的测试与 fixture 约 80–120 触点；`protocol-conformance` 向量钉了 `consult_memory` / `consult_skill` 的工具名与 display 形状，改后须重导 golden 并跑 `pnpm conformance`。

→ [上下文工程 · 扳机](/docs/03-AI核心/上下文工程.md)

**本次推翻的旧定案**（代码现状仍为旧行为）：

| 旧定案 | 改为 · 因 |
|---|---|
| 记忆与规则同载体同注入、靠 `ai_maintained` 区分注入措辞 | 读侧无区分；因类型与权威一并取消，该字段只剩写侧与 UI 用途 |
| 用户硬规则恒胜 | 读侧平权；因治理挪到记忆卡片可见可撤销，不再靠 prompt 措辞分权 |
| 规则按需 ≠ 记忆主题（两个目录两个工具） | 同一按需目录；因「约束 vs 事实」的差别由 `description` 承载即可，不必两套机制 |
| `文档/` 永不进 `<rules>` | `文档/项目/` 厚约定迁为按需条目；因它与记忆主题无本质差别，在盘上只是旧目录划分的产物 |
| `AgentCore/` 下三类子目录分置 | 子目录取消；可见约定根保留（隐藏点目录仍否决） |

---

## 一、分层

> 以下为**代码现状 ✅**；三分取消后的目标形态见上节 ⏳。

| 层级 | 载体 | 生命周期 | 状态 |
|------|------|----------|------|
| **工作记忆** | 对话历史 + worker 产物 | 会话内 | ✅ |
| **用户长期记忆** | 文件树 `rule` + `ai_maintained=true` | 持久、可演进 | ✅ |
| 项目知识库 / 跨 Agent 共享 | — | — | ❌ 延后 |

记忆与规则**同载体、同注入**，仅靠 `ai_maintained` 区分谁可静默改写。作用域靠**位置**（全局 = 云端根；项目 = Folder 下同名夹），不另立开关。

```
AgentCore/
├── 规则/                 用户硬规则（ai_maintained=false）
│   ├── *.md              always（默认）→ 共享 <rules>；或 on_demand → 目录 + consult_rule ✅
│   └── （conditional）    DB 枚举 reserved · **不对外** · 无触发底（否决 Cursor globs / 意图预筛）
├── 记忆/                 AI 维护（ai_maintained=true）
│   ├── 偏好.md           always · 仅全局 · 沟通/习惯
│   ├── 画像.md           always · 技术栈/事实（可全局可项目）
│   ├── 导航.md           always · 仅项目 · 短入口（一句话定位 + 任务路由）✅
│   └── 主题/<slug>.md    on_demand · consult_memory（单次软顶 5；总数≤memory_max_topic_files）✅
└── 文档/                 工作区盘 · 永不进 <rules> · 按需 file_read
    └── 项目/…            厚约定文档（探索 pending 不写；闸清后/普通回合）✅
```

- 叠加注入：绑定文件夹的对话 = 全局 + 该项目；预算紧张时**全局优先**；项目层无 `偏好.md`。
- **用户规则加载（定案 B）**：对外仅 `always` | `on_demand`；新建/存量默认 always。短硬约束常驻；长条文/偶发场景标按需，相关回合由模型 `consult_rule` 自取（谁来拉 = 模型自选）。`remember` 仍只写规范 `用户规则.md`（always）；按需仅文件页 / documents API 配置，防对话误标。
- **规则按需 ≠ 记忆主题**：on_demand 规则 = 约束/合规附录（应遵守）；主题 = 事实/厚知识（供查阅）。勿把百科塞进规则凑按需。
- **双层项目知识**：短入口 = `导航.md`（always，只指路、不塞长文）；厚内容 = `主题/` + `文档/项目/`（按需查）。不写用户仓库根 `AGENTS.md` / `docs/`。
- 导航用户可改：文件页记忆轨在画像与主题之间露出该叶子，读写走 `MemoryKind=navigation`（**强制 `folder_id`**，全局作用域 422——导航只存在于项目层）。AI 记错路由时用户就地改，不必等下次探索。
- 冲突：靠措辞 + 就近相关性；用户硬规则恒胜。
- `文档/` 与同树旁路 `AgentCore/index/`（code_search；系统噪音）正交：索引管符号检索；导航/主题管叙事路由。勿与 `~/Documents/AgentCore/` 工作区容器混淆。
- 主题继续 `name=主题/<slug>.md`（非真实嵌套 folder）——有意设计。
- **约定常量**：`AgentCore/文档/项目/` → 代码 `workspace/stage_dirs.py`（`PROJECT_DOCS_DIR`）；约定文档子目录 `research`/`debate`/`reviews` 同文件。

→ 见代码：`memory/document_store.py`、`memory/migrate_agentcore.py`

---

## 二、注入

> 现状 ✅。目标形态（常驻拼成单块、按需收敛为单目录单工具、预算超限可见）见开头「目标形态」节 ⏳。

1. 工作记忆经 `load_recent_history` 进窗口（CEO / worker 共用）。
2. 长期记忆折叠进共享 `<rules>` 基座：用户规则在前（权威）、AI 记忆在后（软措辞）；无用户规则时与旧 memory-only 块逐字节一致（护前缀缓存）。桌面 sidecar **有 account 票**时：prepare/resume 对 always 规则 / AI 记忆正文 / on_demand 规则目录 / memory topics **只读进程快照缓存**（miss → 空注入、不 await 云 HTTP）；assemble 的 explore/画像/meta 经 `prepare_reads_cache_only` 同样只读快照（warm 含 `_memory_meta.json`）；非回合 `warmAccountRulesMemory` 并行拉取并 seed（`/rules/list` 一次供 always+on_demand）。**无票**仍走本地 DB。
3. always 序：**全局偏好 → 全局画像 → 项目画像 → 项目导航**（缺文件跳过）；用户 always 规则进共享 `<rules>` 前半。on_demand **主题**只列目录 → `consult_memory`；on_demand **用户规则**只列目录 → `consult_rule`（均项目优先、全局兜底；仅当本回合已 wire 对应工具才露目录）。
4. **项目清单**（✅ · 派生，**非记忆**）：CEO prompt 独立 `<项目清单>` 段，回合准备时由 Folder 列表 + 各项目 `画像.md` 首句实时拼装（一行一项：名称 + 一句话），按最近活跃排序、`project_catalog_max_entries` 截断、无项目则不注入。派生而非落盘，故无需巩固、不会过期、改名即时反映。**不进** `<rules>`、不吃 `max_instruction_*` 预算——它服务「跨项目找项目」，不得挤掉 always 记忆。已知降级：account 票 + `prepare_reads_cache_only` 时 warm 快照只含当前 folder 画像，其余项目可能只有名称。
5. **当前课题认定**（✅）：「继续做项目 / 汇报现状」且用户未点名时，**工作区（及已绑工程）近况 ＞ 全局画像「正在做 X」**——全局仅软参考，不得压过工作区，也不得把旧项目名写进默认提问套用户。偏好/文风等仍可用全局记忆。
6. 注入前剥人面 chrome（H1 + 说明引用块），文件本身不动。
7. 装配顺序权威 → [执行引擎 §七](/docs/03-AI核心/执行引擎架构设计.md) / `runtime/context/`（`SectionOrder`）。

→ 见代码：`memory/rules_injection.py` · `memory/account_prepare_cache.py` · `runtime/context/project_catalog.py` · sidecar `warmAccountRulesMemory`

---

## 三、维护协议（情景沉淀 → 语义巩固）

> 现状 ✅。条目化后（⏳）巩固由「重写固定文件的固定章节」改为「按 `description` 归位的增删改，受常驻配额约束」——是**重写**不是改造；`remember` 与巩固合流成同一条「写条目」路径，无理由留两套。冷启动第一条条目无模板可依，只能靠沉淀 prompt 给「好条目长什么样」的示例约束，**不得预置空条目**（等同系统槽位复辟）。

| 层 | 触发 | 行为 | 前端 |
|---|---|---|---|
| **情景沉淀** | 每场收尾 | ≤200 字摘要 + 可选「本场证实的项目事实」；输入含 turn_journal 动作清单（路径/命令/搜索，命令先脱敏）；**不注入 prompt** | 轻提示 |
| **语义巩固** | ≥3 场未消化 **或** ≥24h | 整文件重写偏好/画像；**项目导航增量合并**（一行一条路由；路径/命令须本批动作清单实证，超硬上限合并）；主题保留 ops | diff 卡片 |

- 异常回合（cancelled / interrupted / error）跳过沉淀仍推进 watermark。
- 偏好只能来自用户**明示或纠正**，禁止从任务题材推断。
- 空重写 / 保留率 <50% → 拒落盘；巩固失败不标记已消化。
- 导航写入判据：一条有用 ⟺ 下次能省掉一个动作；闲聊/纯偏好场导航零变化；探索幕仍是导航首建者，巩固只做增量。
- 用户明示指令 → `remember` 直写**用户规则**（`ai_maintained=false`）✅：支持**追加 / 替换 / 删除 / 列出**；改删在对话内真生效。文件页仍可人手改删（与对话内操作双轨，非互斥）。冲突：同 key 归一化去重；「改为」走替换去掉旧条，不以矛盾并存 + 措辞碰运气为主路径。**内容完整性**：半截/`…` 收尾或中段残缺标记 → 拒写入（与 [工具参数契约](/docs/03-AI核心/工具与能力系统.md) 同纪律）。
- 记忆能力**产品层恒开**（无用户总闸）；内容由对话内 `remember` 与文件页编辑/清空双轨控制。异常回合仍跳过沉淀并推进 watermark。

### 两种「冷启动」（正交、禁混名）

| | **巩固冷启动** `_is_cold_start` | **冷启动探索幕**（含指纹脏标记 / 旁路重探） |
|---|---|---|
| 闸看 | **全局** `偏好.md`+`画像.md` 皆空 | 见下表「探索触发」 |
| 行为 | 巩固抽取降门槛 | CEO 组队探索 → 合并写项目画像 + **导航** + 主题；禁经 `remember` 落规则 |

#### 探索触发与挡请求（✅ 软硬分层）

| 触发 | 信号 | 与当前用户请求 |
|---|---|---|
| 仅空画像 | 项目 `画像.md` 空（无换绑、无点名、无工程点名短语） | **不挡（软幕）**：软提示可摸仓；域外调研可直接开跑 |
| 空画像 + 工程信号 | 空画像且命中「继续开发 / 改本仓」等**允许表短语**（不扫长文猜意图） | **挡** |
| 换绑 | `explore_workspace_key` ≠ 当前绑定 | **挡** |
| 指纹漂移 | 顶层树 + 关键清单指纹相对上次探索写入已变（README / package·锁文件 / pyproject / 顶层目录名等；**不做**纯天数、**不以** commit 为唯一闸） | **不挡**。一期（R2）✅：脏标记 + 软提示「项目结构已变，可点名刷新」。二期（R1）✅：`schedule_explore_refresh` 旁路静默合并更新（无 team_preview、不占当前对话） |
| 用户点名 | 「先了解 / 重新了解 / 刷新项目记忆」 | **挡**（强制开幕、合并更新；点名硬闸与 pending 同级 ✅） |

**产物谁写（D1）✅**：硬挡 pending 时 worker 可用 `form=files`，但 `write_scope≤explore_memory`（只写 `AgentCore/` 约定记忆/探索笔记；越权在写工具层拒）。画像 / 导航 / 主题收尾仍经 CEO `update_project_profile`（及同族工具）。`文档/项目/` 厚约定文档只在探索闸清除后、或普通回合按需落盘——**不**在 pending 探索批内写。R1 旁路亦不经 worker 写用户工程树。**否决**再用禁 `form=files` 代理本约束。

**主题上限（T2）✅**：取消单次硬顶 3；单次探索/更新 **软顶 5**（超额截断+warning）；仓库主题总数仍受 `memory_max_topic_files`（现状 24）约束；多轮探索可累加主题。

**二期 ✅（已落地）**：
- **点名硬闸**：用户原文命中「先了解 / 重新了解 / 刷新项目记忆」等允许短语 → `explore_reason=refresh`，与 rebind /（空画像+工程信号）同级置 pending + `<cold_start_explore>`（合并更新文案）；非意图分类器。
- **R1 旁路**：指纹脏时 `schedule_explore_refresh`（consolidation 同级：debounce、per-folder 互斥、不挡当前回合、无 team_preview）。执行面 = 工作区快照 → memory 档 LLM → 合并写导航/画像（可选主题）→ 更新指纹并清脏；**不是**后台再跑一整场 CEO+delegate 探索幕。
- **`文档/项目/`**：约定目录入权威源（`stage_dirs.PROJECT_DOCS_DIR`）；探索 pending 仍不写；闸清后/普通回合可按需落盘。

**否决仍成立**：不写用户仓根文档；不做向量 chunk 自动灌 prompt；不新建独立 `知识/` 注入层。指纹与「仅空画像」**不**注入 `<cold_start_explore>` 硬挡块（漂移用 `<project_nav_stale>`；仅空画像用软提示）。旧「不做指纹自动重探」改为：一期脏标记、二期旁路（因短入口会过时）。

→ 见代码：`memory/episodic.py`、`memory/explore_profile.py`、`memory/explore_refresh.py`；编排 → [编排器 · 冷启动探索幕](/docs/03-AI核心/编排器与CEO主Agent.md)

---

## 四、跨会话对话日志

Worker 经 `search_conversations` / `read_conversation` 按需检索本账号历史原文（messages + turn_journal）；CEO **只 `delegate` 查阅员**。`search_conversations` 支持 `updated_within_hours`（日复盘等）。用户 `@` 对话附件走服务端 `log_export` 深读。能力**产品层恒开**（无独立隐私闸）；控制面为编辑/清空长期记忆与删除对话，而非总开关。

**系统模板 · 每日对话复盘** ✅：站立任务 `template_key=daily_conversation_review`（引导开、默认日跑）。作用域可配（全局裸聊 / 多云项目 / 回看小时）。**无新料硬闸**：作用域内无近期对话则收件箱直接「今日无新料」、不跑 LLM。有料时代跑 brief 要求 `ask_user card=daily_review`；用户勾选确认后**服务端直接**写记忆 / 用户规则 / `AgentCore/文档/reviews/`（不再依赖 LLM 再调 remember）。与语义巩固并存。→ `standing_tasks/templates.py` · `review_apply.py` · `review_preflight.py`；桌面 Toolbox → 自动化。

**对外口径**（CEO 对用户说话）：白话三层——当前会话 / 偏好与笔记 / 点名可派队员查旧场；不报工具名与内部角色；手头无原文时说明「需要派人去查」再行动，禁止装不知道或空口编造。→ 见代码：`runtime/resolve/prompt/`（【记忆/历史·对外口径】【跨会话原文】）

→ 见代码：`conversation/log_export.py`、`tools/builtin/search_conversations.py`

---

## 五、其它要点

- **自动标题**：侧边栏 UX，非记忆层；不进 Agent 上下文。云/本地均在首条用户消息可用后并行铸题（只用用户首句，`assistant_reply=""`）。云走 `schedule_title_generation` + SSE `title_generated`；本地 sidecar 无云 SSE，桌面首发并行 `POST …/auto-title`，回合回写仅空标题兜底（`_title_inflight` 时跳过）。禁止首轮后再补铸。
- **会话摘要记忆层已移除**：跨会话情景对 CEO 分工帮助有限；可复用信号由长期记忆承载。两层协议的「情景沉淀」不注入——与本否决不冲突。
- **搜索**：取消向量 RAG 作 prompt 自动注入；agentic 检索（`file_read`/`grep`/`code_search`）为主路。`code_search` = 工具后端（**只查**当前已提交 BM25 快照）；索引由打开本机项目 / 写后 / 非 ready 的 `code_search` 后台 `IndexMaintainer` 维护（不挡回合准备）。状态两轴：`building` = 尚无可用快照（首次构建）；`stale` = 有快照但已知落后（`index_meta.dirty` / truncated；无 meta 的旧库/半成品亦按 dirty 处理）；有快照时后台增量刷新不改报 `building`。`building`/`stale` 时模型改用 `grep` 核对关键结论。非 RAG 层。落盘 `index_meta`（generation / last_complete_at / truncated / dirty）跨回合 hydrate。Local 过桥建索：`index_files` 带本机 `mtime_ms`/`size_bytes` 指纹，与库中一致则**跳过**整文 `READ` 过桥（仅变更文件再读）。→ 见代码：`workspace/indexing/manager.py` · 桌面 `opIndexFiles`
- **远期**：TWM / recall / 委派预算等延后到窗口不足时（DeepSeek 1M 远大于 MVP 用量）。

---

## 六、否决项

| 方案 | 理由 |
|---|---|
| 独立 `user_memory` 表 / `preference` 角色 | 与文件树重叠、对用户黑盒 |
| 单层巩固 + 冷却/门槛 | 只抑症状，不解「单场判断持久性」 |
| 首轮后再补铸标题 | 收益小、二次覆盖复杂 |
| globs / 自动附着触发（Cursor 的 Auto Attached） | 对话产品无 globs 附着物；大众不手写规则文件。**其余** Cursor rules 形态（一夹 md + frontmatter + 常驻/按需）正是目标形态的参照 |
| 用户规则三态对外（含 conditional） | 无诚实触发底；完整能力 = 常驻 + 按需 + consult（定案 B）。DB `conditional` 枚举随条目化 ⏳ 清理 |
| 再造与条目平级的新类型（如独立 `AgentCore/知识/`） | 类型维度本身已取消——厚知识就是一条按需条目；新增类型是回潮 |
| 偏好/画像改 on_demand；隐藏点目录替代可见 `AgentCore/` | 规则缺了模型不会主动查；产品心智要可见约定根 |
| 向量 chunk 自动灌进 prompt | 与「文件随时变」不合；agentic 自取永远新鲜 |
| 用户可关的记忆/历史查阅总闸（设置页） | 默认常开 + 对话内 `remember` / 文件页编辑清空已够；总闸难懂且历史检索与记忆正交却同页堆开关；定案 A 恒开并删页 |
| 意图分类器扫长文猜是否改规则 | 只认用户明示指令；禁扫自由文猜「改/删规则」再分叉 |
| 权威分档（硬 / 软）进 prompt | 治理已挪到记忆卡片可见可撤销；分档换不来服从度，却要一整套属性与锁 |
| 常驻分池 / 自动淘汰 / 系统槽位 / AI 溢出决策 | 这些机制的收益都是限流，而可见配额已经限流；配额只做可见不做管理 |
| 超预算静默整条丢弃 | 与「配额可见」不相容——条目无声消失，用户无从感知 |
| 「仅手动」第三档生效方式 | 省下的只是目录里一行 token；`@` 已能把按需条目临时提升 |
| 条目正文指向盘上路径（挂牌用户仓库 md） | 第一版不做：模型本就能 `file_read`，增量收益仅一行 `description`；疼了再加 |

查看/编辑：对话内 `remember`（增改删列）与文件页 `AgentCore/{规则,记忆}/` + CAS 双轨；semantic diff 可搬层纠错。→ 见代码：`fileWorkbench/AgentCoreSection.tsx`

条目化后（⏳）文件页不再有「记忆 / 规则 / 文档」三夹：按全局 / 各项目分区列条目，每条露生效徽章与 `description`，并显示常驻用量。
