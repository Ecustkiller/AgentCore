# 产品 AI 功能全面审计

> 工作产物（非设计文档）。跨多次「审计波次」累积。单一真相源为各分册 `audit/NN-*.md`；本页只做索引 + 严重度汇总。

## 审计目标

对 AgentCore **产品 AI 功能**（多 Agent 对话编排运行时）做全面审计，逐模块过、不漏内容。审计=只读核查，**不改代码**；发现问题记录到分册，由主 Agent 汇总后交人决策。

> 范围裁剪：AI 小镇模拟（`simulation/` + `apps/town` Unreal 客户端）**不在本次审计范围**（人已确认排除）。

## 审计维度（Rubric）

每条发现须标：**严重度** + **类别** + **证据（文件:行）** + **一句话影响** + **修复方向（不写代码）**。

| 类别 | 含义 |
|---|---|
| `SEAM` | 接缝断裂：producer↔consumer / 后端↔前端 / 字段·事件·路由未真正接通（发了没人消费、写了没人读、声明了没实现）|
| `BUG` | 正确性：逻辑错误、边界、竞态、错误处理缺口、资源泄漏 |
| `DRIFT` | 文档-代码漂移：`docs/` 声明与代码不符（含 ⏳/✅ 标记错误）|
| `DESIGN` | 设计纪律：补丁堆叠、兜底/对账/自愈/特例逻辑、实现冒充需求、跨层重复 |
| `TEST` | 测试覆盖缺口：核心路径无测试 / 测试是空壳 / 只测 happy path |
| `SEC` | 安全：越权、注入、密钥、沙箱逃逸、审批可绕过 |

严重度：
- **P0** 阻断级：功能完全不通 / 数据丢失 / 安全漏洞 / 核心接缝断裂
- **P1** 高：显著 bug / 主路径缺错误处理 / 重大漂移
- **P2** 中：边界 bug / 次要漂移 / 缺测试 / 设计异味
- **P3** 低：nit / 文档笔误 / 小改进

> 防误报铁律：**先证伪再上报**。断言「接缝断裂/未实现」前，必须已读到 producer 与 consumer 两端代码确认；只读到一端不足以下结论。拿不准标 `NEEDS-VERIFY` 而非直接判 P0。

## 波次与分册

| 波次 | 分册 | 覆盖范围 | 状态 |
|---|---|---|---|
| P1 | [01-LLM网关](01-llm网关.md) | `llm/`（provider/factory/profiles/resolve/errors/pricing）+ `api/routes/inference/` + `conversation/`（quota/rate_limit）| ✅ |
| P1 | [02-执行引擎](02-执行引擎.md) | `runtime/engine/` + `runtime/pipeline/` + `runtime/events/` + `api/sse.py` + Run/Journal/Interaction 三模型 | ✅ |
| P1 | [03-编排原语](03-编排原语.md) | `runtime/runs/`（builder/executor_*/notewall/types）+ `tools/builtin/delegate/` + `request_delegate.py` + `pipeline/resume/`（delegate/replan/revise/escalate/ask_user/检查点/便签墙）| ✅ |
| P1 | [04-上下文与记忆](04-上下文与记忆.md) | `runtime/context/` + `runtime/resolve/prompt.py` + `runtime/facts.py` + `memory/` + 提示词装配/缓存/压缩 | ✅ |
| P2 | [05-工具与能力](05-工具与能力.md) | `tools/`（registry + builtin 除 delegate/debate）+ 审批门 + 沙箱/安全 | ✅ |
| P2 | [06-辩论编排](06-辩论编排.md) | `runtime/debate/` + `tools/builtin/debate/` + `evals/debate_converge.py` | ✅ |
| P2 | [07-审计评测一致性](07-审计评测一致性.md) | `runtime/audit/` + `evals/` + `conformance/` | ✅ |
| P3 | [08-前端-SSE与协作可视化](08-前端-SSE与协作可视化.md) | `services/sse/` + `services/api.ts` + ParallelTimeline/InlineTeamGraph/TeamNotesPanel + `graph/` | ✅ |
| P3 | [09-前端-AI态卡片](09-前端-AI态卡片.md) | debate arena + CheckpointCard/PlanReviewCard/ResumePrompt + escalations + ToolLine/toolResult | ✅ |
| P3 | [10-前端-详情与引用](10-前端-详情与引用.md) | detail/sections/ + EvidenceBadge/remarkEvidence + Markdown/Diagram | ✅ |

状态：⏳ 未开始 · 🔄 进行中 · ✅ 完成

## 严重度汇总

> 每波次完成后由主 Agent 更新。

| 分册 | P0 | P1 | P2 | P3 | 备注 |
|---|---|---|---|---|---|
| 01-LLM网关 | ~~1~~ 0 | 0 | ~~5~~ 3 | 6 | ~~P0~~ 已修复；~~P2~~ F3/F4 **已修复**（platform 定价表 + 代理落账 message_id）|
| 02-执行引擎 | 0 | ~~1~~ 0 | ~~2~~ 0 | 3 | ~~P1~~ **已修复**（fallback 文档对账 + 死码清理）；+2 NEEDS-VERIFY |
| 03-编排原语 | 0 | 0 | ~~3~~ 2 | 4 | ~~P2~~ F2 **已修复**（finalize_stopped 补 absorb_children）；核心接缝均接通有测试 |
| 04-上下文与记忆 | 0 | 0 | 1 | 4 | 接缝密实、测试充分、无 P0/P1；集中于文档漂移 |
| **P1 小计** | ~~**1**~~ **0** | ~~**1**~~ **0** | ~~**11**~~ **9** | **17** | 共 30 条（另 3 条 NEEDS-VERIFY）|
| 05-工具与能力 | ~~1~~ 0 | 0 | ~~3~~ 2 | 4 | ~~P0~~ test_run 已修复；~~P2~~ execute_tools 异常防火墙 **已修复** |
| 06-辩论编排 | 0 | ~~1~~ 0 | 2 | 3 | ~~P1~~ **已修复**（per-side model MVP 未启用；文档/schema/前端徽章对齐）|
| 07-审计评测一致性 | 0 | 0 | ~~2~~ 1 | 2 | ~~P2 oracle 8KB 截断漂移~~ **已修复**；P2=因果图 UI ⏳（见规划稿）|
| **P2 小计** | ~~**1**~~ **0** | ~~**1**~~ **0** | ~~**7**~~ **1** | **9** | 共 18 条（另 4 条 NEEDS-VERIFY）|
| 08-前端-SSE与协作可视化 | 0 | 0 | ~~1~~ 0 | 2 | ~~P2-1/P2-2/P2-3~~ **已修复**（assertNever + worker tool_use_progress + 手机 idle）|
| 09-前端-AI态卡片 | 0 | 0 | ~~2~~ 1 | 3 | +1 NEEDS-VERIFY；~~P2 辩手模型徽章说谎~~ **已修复**（#4）|
| 10-前端-详情与引用 | 0 | 0 | ~~2~~ 0 | 6 | ~~P2 reviewConcern 误报~~ **已修复**（仅审校角色 + 评分语境）；+1 NEEDS-VERIFY |
| **P3 小计** | **0** | **0** | ~~**7**~~ **5** | **11** | 共 18 条（另 3 条 NEEDS-VERIFY）|
| **总计** | ~~**2**~~ **0** | ~~**2**~~ **0** | ~~**25**~~ **13** | **37** | **共 66 条** |

## 已修复（2026-07-09）

| # | 事项 | 改动要点 | 测试 |
|---|---|---|---|
| 1 | 推理代理工具字段保真 | `proxy.py`：`_llm_request_from_payload` 保真 tool_calls/tool_call_id/reasoning_content；`_forward_stream` 中继 delta_tool_calls；unary 补 reasoning_content | `test_inference_proxy.py` 工具轮回环 + build_payload 逆映射棘轮 |
| 2 | test_run 审批治理 | `test_run.py`→`GRANTABLE`；`per_call_tool_names()`=`GRANTABLE∩EXECUTION`；`code_execution_enabled_for()` 统一门控 | `test_approvals.py` + `test_tools_catalog.py` |
| 3 | 计费漏算三件套 | ① `pricing.py` 补 gpt-4o/5.4/5.5 ② `INFERENCE_MESSAGE_HEADER` + proxy 落账带 message_id ③ `finalize_stopped` 补 `absorb_children` | `test_pricing.py` + `test_inference_proxy.py` + `test_sidecar.py` + `test_nesting.py` |
| 4 | 桌面 SSE assertNever | `lib/assertNever.ts` + `dispatch.ts` + `conformanceFold.ts` | `pnpm conformance` 47/47 |
| 5 | 手机 SSE idle 看门狗 | `api/stream.ts` 60s 静默超时 + `StreamNetworkError`（对齐桌面）| `streamIdle.test.ts` |
| 6 | Fallback 文档对账 + 死码清理 | `执行引擎架构设计.md` + 移除 SwitchModel/FALLBACK/`engine_fallback_enabled` | governance + loop_controller 75 passed |
| 7 | 多模型辩手口径对齐 | 辩论文档 §7.5 + schema + `to_event_payload` 不发 model + 前端徽章 | debate pytest 112 + conformance 47/47 |
| 8 | reasoning_effort 展示诚实化 | delegate schema/skills + RunResources/TeamView | `test_runs_builder` 51 + execution 85 |
| 9 | worker 工具阶段接到队员节点 | SSE 按 run_id 分流 + 协作图/TeamView | execution 87 + conformance 47/47 |
| 10 | reviewConcern 误报收口 | 仅审校角色 + 评分语境 N/10 | `reviewConcern.test.ts` |
| 11 | execute_tools 异常防火墙 | `_run_one` 捕 Exception + SandboxError→ToolResult | `test_tool_exec.py` 5 passed |
| 12 | process 8KB 截断对齐 | `cap_process_result` 共享 sink + oracle | `test_conformance_projection` 28 passed |

---

## 全局结论

**核心运行机制健康**——DAG 波调度 / ReAct 收敛 / 三模型韧性、编排原语接缝（delegate/replan/revise/escalate/便签墙/检查点）、上下文 8 通道装配、工具注册↔装配↔执行、运行时审计 11 hook、56 个 SSE 事件桌面消费、前端动作回路、辩论 arena 数据源——**均经两端核对接通且多有测试，无一处核心链路断裂**。66 条发现高度集中在**四个可治理主题**，而非零散 bug。

### 主题 A · Headline 能力静默失效、文档仍标「已落地」（信任风险）— **已按「文档/UI 对齐现状」修复 #3–5**
- ~~**Fallback 模型阶梯**~~ **已修复**：文档改同模型重试→DEGRADED，死码清理
- ~~**真·多模型辩手**~~ **已修复**：§7.5/schema/前端不再谎称 per-side model 已生效
- ~~**reasoning_effort/max 旋钮**~~ **已修复**：CEO 面与 RunResources 不再宣称 high/max 已下发（RunSpec 字段保留供远期）

### 主题 B · 账目/计费系统性漏算（收入与配额风险）
- platform 默认模型（gpt-4o/gpt-5.5）不在定价表 → 全量按 Flash 兜底计价、月成本配额系统性低估（01 F3）。
- sidecar 回合 message_id=NULL → 绕过「日请求数」配额（01 F4）。
- `finalize_stopped` 漏 `absorb_children` → 嵌套子队 token/成本/来源永不入总账（03 F2）。
- `audit_drops` 在 journal-drain 前定格 → admin 遥测轻微偏低（07 P3）。
→ 「不漏算」是明确不变量，计费是收入基线，这批建议尽快修（多为纯修复）。

### 主题 C · 安全审批一致性（P0）
- `test_run` 等同 `code_execute` 执行力却完全绕过审批门 + 生产安全校验 → 本地无审批跑码、云端默认 subprocess RCE（05 P0）。
- 配套：`grep` 用户正则同步 ReDoS 阻塞事件循环（05 P2）、`git` 命令缺 `--` 分隔符（05 P3）、`markmap` 无 JS 层 XSS 防线（10 P3，仅非生产 CSP 语境）。
→ `test_run` 应立即纳入与 `code_execute` 同一审批 + 沙箱治理。

### 主题 D · 休眠接缝 + 韧性缺口（体验风险）
- ~~休眠接缝：worker `tool_use_progress`~~ **已修复**（#8a，队员节点显示排队/检索态）
- ~~休眠接缝：因果图~~ **文档已对齐**（#8b，API 就绪·产品 UI ⏳ → 远期 §2.8）
- 韧性缺口：~~手机 idle 看门狗~~ **已修复**（#8-2）；失败回合遗留无终态帧的 worker → 失败图+重载永久转圈（08 NEEDS-VERIFY）；`execute_tools` 只捕 TimeoutError（05 P2）

## 优先修复清单（交人决策）

| # | 优先 | 事项 | 分册 | 决策点 |
|---|---|---|---|---|
| 1 | ~~**P0**~~ ✅ | 推理代理转发保留 tool_calls/tool_call_id/reasoning_content + 补工具轮回环测试 | 01 | **已修复** |
| 2 | ~~**P0**~~ ✅ | test_run 纳入审批门 + 生产安全校验 | 05 | **已修复** |
| 3 | ~~P1~~ ✅ | Fallback 阶梯：文档改现状+清死码（不恢复实现）| 02 | **已修复** |
| 4 | ~~P1~~ ✅ | 多模型辩手：文档+schema+前端徽章对齐 MVP 未启用 | 06/09 | **已修复** |
| 5 | ~~P1*~~ ✅ | reasoning_effort：展示诚实化，暂不接 provider | 01/03/10 | **已修复** |
| 6 | ~~P2~~ ✅ | 计费漏算三件套（定价表 / 日请求配额 / absorb_children）| 01/03 | **已修复** |
| 7 | ~~P2~~ ✅ | 桌面 SSE 加 assertNever 穷尽兜底（dispatch + conformanceFold）| 08 | **已修复** |
| 8-2 | ~~P2~~ ✅ | 手机 `pumpSSE` 60s idle 看门狗 | 08 | **已修复** |
| 8a | ~~P2~~ ✅ | worker `tool_use_progress` 接到队员节点（桌面+手机）| 08 | **已修复** |
| 8b | ~~P2~~ 📄 | 因果图：文档改 API 就绪·UI ⏳ | 07 | **文档已对齐** → [`因果图可视化规划.md`](/docs/06-规划/因果图可视化规划.md) |
| 8 | — | 因果图可视化 UI（`include_causal` 渲染）| 07 | ⏳ 远期 §2.8 |

> `#5` 单条 P2，但四模块叠加 + 触及付费解锁点，实际影响接近 P1。

## 治理建议
主题 A/B 反复出现「文档标 ✅、代码是 ⏳/已移除」，非孤例而是一轮系统性文档滞后。建议在修复后对 `docs/03-AI核心` 做一次**漂移对账专项**（fallback / 多模型辩手 / reasoning_effort / 记忆预算口径 / 工作区标签 等），把 ✅↔⏳ 校准回现状。

## NEEDS-VERIFY（需产品意图/环境确认，非直接判 bug）
约 10 条，主要：云端 server 是否面向不可信多租（定 test_run 云端危害面）· 8KB 工具结果截断是否用户可见 · 因果图/worker 态是「后端先行」还是漏接 · 失败回合 worker 终态 · 辩论 side.key 空间 · checkpoint 关闸是否有意 · 长对话压缩「连续同角色」边界。
