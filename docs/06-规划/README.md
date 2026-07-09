# 规划索引（`docs/06-规划`）

> **定位**：`docs/06-规划/` = 提案、讨论记录。**AI 默认不读本目录**——改代码优先读 [`01`–`05` 任务路由](/docs/索引.md#任务路由ai-优先)；只需知道产品方向时读 [产品路线图摘要](/docs/01-产品/产品路线图摘要.md)。
>
> **治理**：本目录仅放 🗂️ 讨论提案与远期 backlog；决策通过、开始落地后结论迁入 `01`–`05` 对应现状文档，原文删除。变更历史以 git 为准。

## 活跃文档

| 文档 | 定位 |
|---|---|
| [远期规划](远期规划.md) | 放量 backlog + 发布后演进（收口 hub） |
| [产品 AI 协作优化复盘](产品AI协作优化复盘.md) | 元讨论锚点 |
| [多 AI 模拟愿景](multi-ai-simulation-vision.md) | 🗂️ 战略蓝图：任务型 → 通用多 AI 模拟平台（第二增长曲线） |
| [AI 小镇 MVP 开发计划](AI小镇MVP开发计划.md) | 多 AI 模拟 Phase 1 MVP 落地计划（对齐愿景 Phase 1） |
| [AgentTown 客户端规格](AgentTown客户端规格.md) | Unity 6 LTS + URP + C# 独立观测客户端；复用 Python 模拟后端；退役 Desktop R3F / UE 参照实现 |

## 已退役系列

| 文档 | 退役结论去向 |
|---|---|
| **真·多模型辩论与「谁更聪明」视频**（2026-07-08） | 真·多模型辩手 as-built（`sides[].model` 跨厂商路由）+ 辩手设计否决 → [辩论编排设计 §7.5 / §八](/docs/03-AI核心/辩论编排设计.md)；运行配方（方舟接入 / model 串 / BYOK key / 真跑配方）→ [平台LLM接入](/docs/05-平台与运维/平台LLM接入.md)；LLM provider 否决 + Phase 2（定价 / 选模型 / 计费）→ [远期 §2.2](远期规划.md)；「谁更聪明」视频 + 竖屏否 + 3+方圆桌 / 锦标赛 → [远期 §4.3](远期规划.md)。正文不保留，见 git 历史。 |
| **法律垂直场景设计**（2026-07-08） | 首个行业垂直「法律」：hero 对方律师作战室（`legal_answer_brief`）+ 第二支三方视角案情研判（`legal_case_analysis`）M1–M3 已落地（opt-in `legal_vertical_enabled`，代码 `runtime/legal_skills.py` / `conformance/vectors/legal.py` / `tests/test_legal_skills.py`）；来源卡台账方案① 机制现状 → [核心接口定义](/docs/02-架构/核心接口定义.md)、系统 Skill opt-in 垂直包 → [工具与能力系统 §二](/docs/03-AI核心/工具与能力系统.md)；open backlog（库接入本地检索 Tool + 方案② / 第二 skill M2 真跑 / 待议）→ [远期规划 §4.5](远期规划.md)。行业调研正文 + M1–M3 as-built 见 git 历史。 |
| **辩论室赛事页重设计**（2026-07-06） | 赛事页三层（记分牌 + 剧本主列 + 终审舞台）→ [前端 UX §四](/docs/04-前端/前端UX设计.md)；前端落点段 → [辩论编排设计 §四之二/§六](/docs/03-AI核心/辩论编排设计.md)。右坞裁判台解散；并排对照后改为可选布局（仅正反 · 默认并排可切单栏，2026-07-07）。 |
| **多 Agent 编排优化（参考 Cursor Multitask）**（2026-07） | 已落地决策（两档路由、默认不拆、complexity_hint、委派后不重复调查、Worker 三档自主度）→ [编排器 §协调者工具边界](/docs/03-AI核心/编排器与CEO主Agent.md)、[协作模式 §二](/docs/03-AI核心/Agent协作模式.md)；暂缓项与已否决方案 → [编排器 §未来优化方向](/docs/03-AI核心/编排器与CEO主Agent.md)。 |
| **Turn Journal 持久化重构**（2026-07） | Append-on-emit 持久化模型 + delete cascade 联动清理 → [执行引擎 §8.3 Turn Journal](/docs/03-AI核心/执行引擎架构设计.md)。否决旧 batch snapshot；`TurnJournalWriter` contextvar per-turn、DB barrier 在 SSE emit 前；删消息联动清 `paused_turns`。 |
| **代码能力增强 Phase 2**（2026-07） | 语义搜索 `code_search` → [记忆 §5.6](/docs/03-AI核心/Agent记忆与知识系统.md)；工具 backlog → [工具与能力](/docs/03-AI核心/工具与能力系统.md)；沙箱 → [远期 §2.1](/docs/06-规划/远期规划.md) + [安全 §五](/docs/05-平台与运维/安全权限与治理.md)；测试循环 → [执行引擎 §四](/docs/03-AI核心/执行引擎架构设计.md)；`file_append` / MCP / Tier 3 → [远期 §三](/docs/06-规划/远期规划.md)。行业调研正文不保留，见 git 历史。 |
| **重试机制重设计**（2026-07） | retry-failed API + `seed_completed` 补跑 → [执行引擎 §retry-failed](/docs/03-AI核心/执行引擎架构设计.md)；救火行双按钮 → [前端 UX §三](/docs/04-前端/前端UX设计.md)。余项（重试目标取 `ExecutionScope`、忽略后端感知）留在上述两文档 ⏳ 段。正文不保留，见 git 历史。 |
| **开放主流 AI 模型接入**（2026-07） | 泛化 BYOK（key + base_url + model）+ 用户统一 model + 砍质量档 + supports_tools soft gate + 后台 one-shot platform key 优先 → [编排器 §2.1](/docs/03-AI核心/编排器与CEO主Agent.md)；BYOK 计费（cost=0、token 记）→ [成本配额 §〇·五](/docs/05-平台与运维/成本配额与计费.md)；前端模型配置 + BYOK 用量 → [前端 UX §十三](/docs/04-前端/前端UX设计.md)、[前端成本 §7.4](/docs/04-前端/前端成本呈现.md)。⏳ Phase 3（原生 Claude/Gemini、thinking 适配、多模型辩手）留远期。正文不保留，见 git 历史。 |
| **Sub2API 平台模型集成**（2026-07） | Sub2API 网关路径已退役；平台 LLM 改经本地 `scripts/codex_chat_proxy.py` 直连 ChatGPT Codex 后端（`PLATFORM_BASE_URL=http://localhost:9090/v1`）。Phase 0 接缝结论（`PLATFORM_*` 凭据、`OpenAICompatibleProvider`、模型徽章修复）已体现在代码与 [部署与运维](/docs/05-平台与运维/部署与运维.md)。正文不保留，见 git 历史。 |
| **项目审计**（系列 · 均已结案 · 全程见 git） | 全栈健康体检（首轮）+ 9 个专项轮次，整体零未决 P0/P1；工作稿全部退役删除、逐轮结论见 git 历史。结论去向：持久安全不变量 → [安全权限与治理 §十](/docs/05-平台与运维/安全权限与治理.md)；仍 OPEN 的 deferred / 独立项 → [远期规划 §3.3](远期规划.md)；可复用接缝排查配方 → [`seam-audit.mdc`](/.cursor/rules/seam-audit.mdc)。 |
| **聊天页面体验优化**（2026-07-08） | 六方向拆解归位。**P0 已落地→现状**：消息密度分层（完成态过程折叠 → [前端 UX §一B](/docs/04-前端/前端UX设计.md)、团队图完成态收起 → [§三](/docs/04-前端/前端UX设计.md)）、全局协作感知（侧栏活动横幅 + 跨对话完成通知 → [§一](/docs/04-前端/前端UX设计.md) + [UI-Pattern L3](/docs/04-前端/UI-Pattern索引.md)）。**未落地→backlog**：输入区/动画/检索微调 → [前端 UX §十五](/docs/04-前端/前端UX设计.md)；对话内协作（决策聚合驾驶舱 / 轮次摘要卡）→ [远期 §4.4](远期规划.md)。**已否决**：Agent 产出选中评注（Figma 式）。正文不保留，见 git 历史。 |
| **多 Agent 协作审计功能**（2026-07） | Phase 1–2 后端 + **桌面因果图 UI** 全落地（采集偏序 / 因果图 API / run 详情「数据从哪来」/ GraphView inject 聚焦高亮 / 文件反查 / TTL sweep / admin 看板）→ [安全 §八](/docs/05-平台与运维/安全权限与治理.md) · [前端 UX §五·§十](/docs/04-前端/前端UX设计.md)。Phase 3 合规尾巴 → [远期 §2.8](远期规划.md)；接缝修复记录 → [因果图可视化规划](因果图可视化规划.md)（Phase 3 备忘）。 |
| **因果图可视化规划**（2026-07-09） | Phase 1–2 已落地并迁入上述 as-built 文档；本稿缩为 **Phase 3 备忘**（手机 / 合规导出 / 人工验收清单 / 2026-07-09 projector 接缝记录）。讨论稿全文见 git 历史。 |
| **共享工作区 Phase 2**（2026-07-08） | 人决定暂缓（重心在多 AI 模拟主线、开发期无真实数据、无用户在等），浓缩为远期 backlog → [远期规划 §2.7](远期规划.md)；现状指针 → [双模式工作区 §六](/docs/02-架构/双模式工作区.md)、[产品路线图摘要](/docs/01-产品/产品路线图摘要.md)。详细实施清单（数据模型 / 后端逐文件 / 前端 / 迁移）退役删除，正文见 git 历史。 |
| **上下文注入统一性讨论**（2026-07-08） | 结论迁为现状文档 → [上下文工程](/docs/03-AI核心/上下文工程.md)（认知模型 + 五杠杆 map + 「现在不建统一 ContextProvider」决策 + 扳机 A/B）。正文不保留，见 git 历史。 |
