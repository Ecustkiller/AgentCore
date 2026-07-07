# 规划索引（`docs/06-规划`）

> **定位**：`docs/06-规划/` = 提案、讨论记录。**AI 默认不读本目录**——改代码优先读 [`01`–`05` 任务路由](/docs/索引.md#任务路由ai-优先)；只需知道产品方向时读 [产品路线图摘要](/docs/01-产品/产品路线图摘要.md)。
>
> **治理**：本目录仅放 🗂️ 讨论提案与远期 backlog；决策通过、开始落地后结论迁入 `01`–`05` 对应现状文档，原文删除。变更历史以 git 为准。

## 活跃文档

| 文档 | 定位 |
|---|---|
| [远期规划](远期规划.md) | 放量 backlog + 发布后演进（收口 hub） |
| [共享工作区 Phase 2](共享工作区-Phase2.md) | 文件夹级可选共享目录 |
| [上下文注入统一性讨论](上下文注入统一性讨论.md) | ContextProvider / Assembler 扳机 |
| [产品 AI 协作优化复盘](产品AI协作优化复盘.md) | 元讨论锚点 |
| [法律垂直场景设计](法律垂直场景设计.md) | 首个行业垂直 |
| [真多模型辩论与视频](真多模型辩论与谁更聪明视频.md) | 跨模型辩手 + 内容 |
| [聊天页面体验优化](聊天页面体验优化.md) | 聊天 UI 六个优化方向 |
| [多 Agent 协作审计功能](多Agent协作审计功能.md) | Phase 1 ✅ 已落地（→ [安全权限与治理 §八](/docs/05-平台与运维/安全权限与治理.md)）；Phase 2–3 待定 |
| [AgentTown 客户端规格](AgentTown客户端规格.md) | Unreal Engine 5.5 独立观测客户端（路线 B）；复用 Python 模拟后端，退役 Desktop R3F |

## 已退役系列

| 文档 | 退役结论去向 |
|---|---|
| **辩论室赛事页重设计**（2026-07-06） | 赛事页三层（记分牌 + 剧本主列 + 终审舞台）→ [前端 UX §四](/docs/04-前端/前端UX设计.md)；前端落点段 → [辩论编排设计 §四之二/§六](/docs/03-AI核心/辩论编排设计.md)。右坞裁判台解散；并排对照后改为可选布局（仅正反 · 默认并排可切单栏，2026-07-07）。 |
| **多 Agent 编排优化（参考 Cursor Multitask）**（2026-07） | 已落地决策（两档路由、默认不拆、complexity_hint、委派后不重复调查、Worker 三档自主度）→ [编排器 §协调者工具边界](/docs/03-AI核心/编排器与CEO主Agent.md)、[协作模式 §二](/docs/03-AI核心/Agent协作模式.md)；暂缓项与已否决方案 → [编排器 §未来优化方向](/docs/03-AI核心/编排器与CEO主Agent.md)。 |
| **Turn Journal 持久化重构**（2026-07） | Append-on-emit 持久化模型 + delete cascade 联动清理 → [执行引擎 §8.3 Turn Journal](/docs/03-AI核心/执行引擎架构设计.md)。否决旧 batch snapshot；`TurnJournalWriter` contextvar per-turn、DB barrier 在 SSE emit 前；删消息联动清 `paused_turns`。 |
| **代码能力增强 Phase 2**（2026-07） | 语义搜索 `code_search` → [记忆 §5.6](/docs/03-AI核心/Agent记忆与知识系统.md)；工具 backlog → [工具与能力](/docs/03-AI核心/工具与能力系统.md)；沙箱 → [远期 §2.1](/docs/06-规划/远期规划.md) + [安全 §五](/docs/05-平台与运维/安全权限与治理.md)；测试循环 → [执行引擎 §四](/docs/03-AI核心/执行引擎架构设计.md)；`file_append` / MCP / Tier 3 → [远期 §三](/docs/06-规划/远期规划.md)。行业调研正文不保留，见 git 历史。 |
| **重试机制重设计**（2026-07） | retry-failed API + `seed_completed` 补跑 → [执行引擎 §retry-failed](/docs/03-AI核心/执行引擎架构设计.md)；救火行双按钮 → [前端 UX §三](/docs/04-前端/前端UX设计.md)。余项（重试目标取 `ExecutionScope`、忽略后端感知）留在上述两文档 ⏳ 段。正文不保留，见 git 历史。 |
| **开放主流 AI 模型接入**（2026-07） | 泛化 BYOK（key + base_url + model）+ 用户统一 model + 砍质量档 + supports_tools soft gate + 后台 one-shot platform key 优先 → [编排器 §2.1](/docs/03-AI核心/编排器与CEO主Agent.md)；BYOK 计费（cost=0、token 记）→ [成本配额 §〇·五](/docs/05-平台与运维/成本配额与计费.md)；前端模型配置 + BYOK 用量 → [前端 UX §十三](/docs/04-前端/前端UX设计.md)、[前端成本 §7.4](/docs/04-前端/前端成本呈现.md)。⏳ Phase 3（原生 Claude/Gemini、thinking 适配、多模型辩手）留远期。正文不保留，见 git 历史。 |
| **Sub2API 平台模型集成**（2026-07） | Sub2API 网关路径已退役；平台 LLM 改经本地 `scripts/codex_chat_proxy.py` 直连 ChatGPT Codex 后端（`PLATFORM_BASE_URL=http://localhost:9090/v1`）。Phase 0 接缝结论（`PLATFORM_*` 凭据、`OpenAICompatibleProvider`、模型徽章修复）已体现在代码与 [部署与运维](/docs/05-平台与运维/部署与运维.md)。正文不保留，见 git 历史。 |
