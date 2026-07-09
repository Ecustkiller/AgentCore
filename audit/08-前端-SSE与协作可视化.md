# 08 · 前端 SSE 消费 + 协作可视化

> 波次 P3 · 只读审计。范围：桌面 `services/sse/`（dispatch/handlers/execFrameBuffer/contentBuffer/captainContext）+ `services/api.ts` + `services/streamConversation.ts`（SSE 传输）· 手机 `apps/mobile/src/protocol/fold.ts`（跨端 fold）· 协作可视化 `components/chat/{ParallelTimeline,InlineTeamGraph,TeamNotesPanel}.tsx` · `components/graph/`（projectFlowGraph / agentNode / useGraphDrillIn / CanvasPlaybackControls / GraphView / helpers）。
> 判据：`README.md` Rubric（SEAM/BUG/DRIFT/DESIGN/TEST/SEC × P0–P3）+ 防误报铁律（producer 与 consumer 两端都读到才断言接缝断裂）。
> 现状设计文档基准：`docs/04-前端/前端技术与架构.md §十二/§九`、`docs/03-AI核心/上下文传递可视化.md`、`.cursor/rules/{protocol-conformance,cross-platform-frontend}.mdc`。

## 严重度计数

| 严重度 | 数量 | 摘要 |
|---|---|---|
| P0 | 0 | 无阻断级问题；SSE 分发覆盖完整、协作图数据全部真接后端 |
| P1 | 0 | 无高危 |
| P2 | 3 | ①桌面 SSE 消费**无 `assertNever` 穷尽兜底**（live dispatch + conformanceFold 皆无），与文档「两端编译失败直到处理」的漂移绊线承诺不符——新事件类型桌面**静默丢弃**、零构建信号；②worker 作用域的 `tool_use_progress`（带 run_id）两端都只喂 CEO 时间线、worker 节点取不到 → 并行队列态「排队中/检索中/备用引擎」**发了没人消费**；③手机 `pumpSSE` 缺桌面那条 idle 看门狗 → 静默断连时手机回合可无限期挂「生成中」 |
| P3 | 2 | ④`discardPendingFrames` 定义+导出但**无调用方**（死代码，其孪生 `discardPendingContent` 有用）；⑤设计文档把 SSE 消费入口指向 `services/streamConversation.ts`，实际 dispatch/handlers 已拆到 `services/sse/`（指针陈旧） |
| NEEDS-VERIFY | 1 | `finalizeFold` 仅在 `cancelled` 冻结在飞节点、`failed` 不冻结（两端一致）；若失败回合会遗留无终态帧的 worker run，则失败图 + 重载会显示**永久转圈**节点，待后端错误路径确认 |

**总体结论**：本模块整体**健康**——56 个后端 `EventType` 全部有桌面 live 消费方（分发覆盖无缺口）；协作图/时间轴/便签面板数据**全部真接** `Execution` 的后端派生字段（无 mock/占位）；CEO 进程时间线的 live/reload/golden 三态**共用同一批** `foldMessageLane` 生产折叠器（无双实现漂移）；增量 fold + WeakMap 投影缓存 + rAF 合批正面解决了「长输出白屏卡死」根因。问题集中在**跨端一致性护栏缺位**（桌面无 assertNever）与**两处 transport-only 信号发了没接**，无 P0/P1、无正确性/数据丢失。

---

## P2 发现

### P2-1 · DRIFT/SEAM · 桌面 SSE 消费无 `assertNever` 穷尽兜底，与文档承诺的「漂移绊线」不符

- **证据（护栏应在）**：`.cursor/rules/protocol-conformance.mdc` §三支柱2 明写「fold 用判别联合 switch + assertNever 兜底。后端加事件类型 → 重生成 → **两端编译失败直到处理**」；`.cursor/rules/cross-platform-frontend.mdc` §硬规则4 + `docs/04-前端/前端技术与架构.md §十二 12.2 ②` 同口径（「新事件类型 → 编译失败直到两端处理」）。
- **证据（手机端有）**：`apps/mobile/src/protocol/fold.ts:79-81`（`assertNever`）+ `:733-734`（`default: assertNever(type)`）——手机 fold 确有穷尽兜底。
- **证据（桌面端无，已两端确认）**：全仓 `apps/desktop/src` 搜 `assertNever` **零命中**。桌面 live 分发 `services/sse/dispatch.ts:37-40` 仅顺序跑 handler、无穷尽检查；各 handler 均 `default: return false`（`handlers/execution.ts:244`、`handlers/messageStream.ts:189`、`handlers/meta.ts:46`、`handlers/interaction.ts:116`、`handlers/workspace.ts:17`、`handlers/board.ts:33`）；桌面 `protocol/conformanceFold.ts:326-332` 的 `default:` 也只是 `break`（注释罗列未处理类型，无 assertNever）。`SSEPayloadMap`（`packages/contract-types/src/events.ts:1157`）未 `satisfies Record<SSEEventType,…>`，故连类型层都不强制。
- **一句话影响**：后端新增一类 SSE 事件时，手机被 assertNever 逼停到红转绿，桌面却**编译通过、运行时全 handler 返回 false 后静默丢弃**（无报错/无警告）——正是本次审计要抓的「后端发了、前端丢弃」类接缝，其护栏在桌面侧不存在，且与三处文档/规则的明文承诺漂移。
- **修复方向**：给桌面 live dispatch 与 conformanceFold 各补一个 `default: assertNever(event.type)`（或等价穷尽联合断言），让新事件类型在桌面也编译失败；或修订三处文档口径为「仅手机 fold 穷尽兜底、桌面靠人工 + 覆盖测试」。前者兑现承诺、后者消除漂移，二选一。

### P2-2 · SEAM · worker 作用域 `tool_use_progress`（带 run_id）发了没人消费，队列/检索/备用引擎态在 worker 节点永不显示

- **证据（producer 端）**：`apps/server/agentcore/runtime/engine/tool_exec.py:109-110` 在工具执行期回调 `sink.emit(tool_use_progress(tc.id, name, phase, run_id=run_id))`——`execute_tools` 对 CEO 与 worker 工具**都**跑，故 worker 的 web_search/code_execute 会带**自己的 run_id** 发 `tool_use_progress`；载荷含 run_id 见 `runtime/events/chat.py:51-76`。字段语义 `packages/contract-types/src/events.ts:45-77` 明写 `queued`＝「排队中——parallel-team burst 下被限流器 gate」（即**多 worker 并发 web_search** 场景）。
- **证据（consumer 端，已两端确认）**：桌面 `services/sse/handlers/execution.ts:151-159` 收到 `tool_use_progress` → `setProcessToolPhase(payload)`，**忽略 run_id**；`stores/conversation/store.ts:397-406` 对**CEO 气泡的 message lane** 按 `tool_call_id` 折 phase（`foldToolUsePhase`），worker 的工具调用不在 CEO 进程时间线里（fold 按 run_id/编排工具跳过，见 `apps/mobile/src/protocol/fold.ts:262` 同规则）→ 找不到匹配步 → `lane.process === last.process` → **no-op 丢弃**。手机侧 `apps/mobile/src/protocol/fold.ts:800-811` 的 `extractToolPhases` 按 `tool_call_id` 建表、同样只用于 CEO 进程步 → worker 调用不在其中 → 同样丢弃。两端一致地都不把 worker phase 落到 worker 节点。
- **一句话影响**：为「并行队伍爆发」专门设计的 `queued` 及 `querying/fallback` 诚实等待态，恰好在它最该出现的 worker 并发工具场景**永不可见**——worker 节点只显示笼统「运行中」；属 transport-only 纯呈现，无正确性/数据影响，但设计意图落空。
- **修复方向**：让带 run_id 的 `tool_use_progress` 路由到对应 worker 节点的 live phase（如 `AgentState.toolProgress` 旁挂一个 phase，或投影到 worker run 的运行中工具步）；两端对齐（此事件 transport-only、不进 golden，故不影响 conformance，但两端应同修保持一致）。

### P2-3 · BUG · 手机 `pumpSSE` 缺 idle 看门狗，静默断连时回合可无限期挂起（桌面有、手机无）

- **证据（桌面有）**：`apps/desktop/src/renderer/services/streamConversation.ts:101-118`——`IDLE_TIMEOUT_MS = 60_000`，`readChunk` 用定时器包住 `reader.read()`，60s 无字节即 `reader.cancel()` + `reject(new StreamError("network"))`（可重试）；注释明写「total silence for the timeout means the socket is dead（server/proxy dropped it），so we cancel and raise a retriable network error rather than hang」。
- **证据（手机无，已两端确认）**：`apps/mobile/src/api/stream.ts:33-51` 的 `pumpSSE` 直接 `const { done, value } = await reader.read();` 死循环，**无任何超时**；`streamMessage`/`attachStream`/`resumeStream` 也未见 idle 级 AbortSignal 包裹。后端心跳 15s（`apps/server/agentcore/api/sse.py:19,45` 的 `: ping`）只对**活连接**有意义——静默死连（移动网络切换/无 FIN 的丢包）下后端字节到不了，`reader.read()` 会永久 pending。
- **一句话影响**：手机前台流式回合遇静默断连时，会一直卡「生成中」、无自动恢复（需用户手动切走/后台再回前台触发 attach 才可能续），而桌面 60s 后自动降级为可重试错误——同一主路径的跨端错误处理不对等。
- **修复方向**：手机 `pumpSSE` 补一条与桌面对等的 idle 看门狗（每次 `read()` 竞速一个可重置的超时，任一字节即续期），失败抛可重试错误交由 attach/重连流处理。

---

## P3 发现

### P3-1 · DESIGN · `discardPendingFrames` 死代码：定义+导出但无任何调用方

- **证据**：`services/sse/execFrameBuffer.ts:45-52` 定义 `discardPendingFrames`（注释「硬重置/中断清理用；与 discardPendingContent 对偶」），`services/sse/dispatch.ts:47` 再导出；全仓 `apps/desktop/src` 搜索**仅**命中「定义 + 再导出」两处，**无调用点**。对照其孪生 `discardPendingContent` 在 `handlers/messageStream.ts:91`（`content_reset`）真被调用。中断/abort 路径（`streamConversation.ts:185-187,244-247` 的 finally）走的是 `flushPendingFrames`（落库）而非 discard，故该函数确无使用场景。
- **一句话影响**：无功能影响，纯死代码——暗示「帧缓冲需要丢弃」的场景其实没落地（worker `run_output_reset` 走的是有序缓冲内的 reset 帧、非丢弃），留着易误导后续维护者以为存在对称的丢弃路径。
- **修复方向**：删除 `discardPendingFrames` 及其再导出；若确有「硬重置丢弃在飞帧」需求（如某类中断），补上真实调用点并加注释说明。

### P3-2 · DRIFT · 设计文档把 SSE 消费入口指向 `streamConversation.ts`，实际 dispatch/handlers 已拆到 `services/sse/`

- **证据**：`docs/04-前端/前端技术与架构.md:261`（「桌面 SSE 入口 `apps/desktop/src/renderer/services/streamConversation.ts`」）与 §9.5:196（「见代码：`services/streamConversation.ts`」）把 SSE 事件消费单一指向该文件；实际 `streamConversation.ts` 现仅剩传输层（fetch + `pumpSSE`），事件分发与折叠已拆到 `services/sse/dispatch.ts`（单一分发口）+ `services/sse/handlers/*.ts`（6 类 handler）+ `contentBuffer.ts`/`execFrameBuffer.ts`（rAF 合批）+ `captainContext.ts`。§12.1 亦称「所有 SSE 事件经 `streamConversation.ts` 统一分发」，实为经 `sse/dispatch.ts`。
- **一句话影响**：按文档指针定位 SSE 消费逻辑的 AI/人会落到只剩传输的文件、错过 handler 拆分与合批缓冲，增加冷启动摸索成本（非功能缺陷）。
- **修复方向**：把 §十二/§9.5 的代码指针更新为 `services/sse/`（dispatch + handlers + 两个 buffer），保留 `streamConversation.ts` 为「传输/重连/传输层 flush 兜底」。

---

## NEEDS-VERIFY

- **NV-1（关联 finalizeFold 冻结逻辑）**：桌面 `stores/execution/project.ts:507-518` 与手机 `apps/mobile/src/protocol/fold.ts:738-741` 都**仅在 `status === "cancelled"`** 把在飞节点 `running → cancelled` 冻结，`status === "failed"` 分支不冻结（两端一致，非跨端漂移）。若某回合以 `error` 收尾（→ `failed`）时仍有 worker run **未收到终态帧**（run_completed/run_failed），则该 worker 节点会在失败图上、以及 journal 重载后**永久显示「运行中」转圈**。是否会触发取决于后端错误路径是否为在飞 run 补发终态帧——`runtime/runs/wave.py:470-472`（executor 崩溃→FAILED）等路径的兄弟 run 收尾未在本次前端范围内确认。需读后端 turn 级错误收尾逻辑：若保证所有在飞 run 在 `error` 前都拿到终态帧，则本项不成立；否则 finalizeFold 应对 `failed` 施加与 `cancelled` 同样的冻结。

---

## 健康面（已核验接通，非问题，供主 Agent 判断可信度）

- **SSE 分发覆盖完整**：后端 `runtime/events/types.py` 的 `EventType`（56 值）逐条有桌面 live 消费方——messageStream（8）/interaction（7）/meta（4）/workspace（1）/board（2）/execution（24，含 debate/escalation/note/batch_metrics）/simulation（7，范围外）；三个 `handoff_*` 不走回合 SSE、由**独立通道** `services/handoff.ts` 消费（`grep` 两端确认），非「发了没人消费」。
- **协作图/时间轴/便签数据全真接后端、无 mock**：`ParallelTimeline`/`ParallelGantt` 读 `Execution.batches[].timeline`（源 `batch_metrics` SSE，`ParallelTimeline.tsx:14-18`）；`TeamNotesPanel` 读 `Execution.teamNotes`（源 `team_note_posted` 帧折叠，`TeamNotesPanel.tsx:36`）；`InlineTeamGraph`/`GraphView`/`projectFlowGraph` 读 `Execution.{runs,agents}`（`projectExecution` fold）；空态一律 `return null`（`ParallelTimeline.tsx:19,52`、`TeamNotesPanel.tsx:37`、`InlineTeamGraph.tsx:109-115`），GraphView 空态有「暂无执行任务」占位（`GraphView.tsx:273-284`）。
- **无双实现漂移（CEO 进程时间线单一源）**：live 会话 store（`stores/conversation/store.ts:6-15,302,317,374,389,402,414`）、桌面 `conformanceFold`（`protocol/conformanceFold.ts:17-29`）与 reload 均调用**同一批** `@/lib/foldMessageLane` 生产折叠器（foldContentDelta/Reset/ToolUseStart/End/Phase/Citations/CheckpointMarker/AskMarker/PlanReviewMarker/TeamMarker）——不同于审计 07 P2-2 的 oracle/运行时双实现，此处 live=golden=reload 天然对齐。
- **跨端 fold 对齐、conformance 兜漂移**：手机 `protocol/fold.ts` 与桌面 `projectExecution`（`stores/execution/{project,frames}.ts`）对同一批事件（run_started 续写/run_context 分流 captain/run_output_reset 清草稿/plan_revised bind 胜 steer/team_note supersession/escalation 三态）行为逐条镜像，判别态归一到共享 `ProjectedTurn`（`packages/protocol-conformance/src/projectedTurn.ts`），`debateDecisions`/`outputFiles` 等桌面本地增强正确地排除在 golden 之外。
- **流式性能根因已治**：`stores/execution/hooks.ts:35-99` 增量 fold（`liveFolds` 按 plan 累进 + `projectionCache` 按 rt WeakMap 缓存）把长回合从 O(n²) 降到 O(1)/token；`contentBuffer.ts`/`execFrameBuffer.ts` rAF 合批把每秒上百次 store 写降到 ≤60，结构性帧先 flush 保帧序；`recordFrameNow`/`queueFrameEvent` 的高频/结构帧分流正确（`handlers/execution.ts:31-46,92-130`）。
- **SSE 线格式接缝一致**：后端 `event: <type>\ndata: <json>\n\n` + `: ping` 心跳（`api/sse.py:22-27,45`），桌面按 `\n` 切行取 `data: ` 行（`streamConversation.ts:124-136`）、手机按 `\n\n` 切帧取 `data:` 行 + trim（`stream.ts:38-49`），均忽略心跳与 `event:` 行、从 data JSON 取 type，双端解析对当前格式健壮。
- **captain 上下文重连幂等**：`captainContext.ts` 按会话累加 + 整列 REPLACE，`message_start` 走 `resetCaptainContext`（`handlers/messageStream.ts:79`）清累加器，重连重放不翻倍（对齐 `上下文传递可视化.md §六`）。
- **测试非空壳**：`ParallelTimeline.test.tsx`（甘特 DOM + 串行化 + 失败环 + 批次编号 + 门控）、`contentBuffer.test.ts`（FIFO 到达序 + content_reset 只丢正文保思考）、`messageTimeline.test.ts`（记忆卡锚回合末）均真断言真行为。

## 范围与工具备注

- 本册聚焦「SSE 消费接缝 + 协作可视化」；AI 态卡片渲染（debate arena / CheckpointCard / EscalationCard / ToolLine 等）属 09 册、详情与引用属 10 册，本册不重复判。`handlers/simulation.ts` + `sim.*` 事件按 `README.md` 范围裁剪（AI 小镇模拟不在审计范围）仅核对其为独立 store、不串聊天态。
- 手机 `src/api/stream.ts`（传输）非严格属 `fold.ts` 范围，但作为桌面 SSE 消费的跨端对偶被读入以核 P2-3；结论已两端取证。
- 手机 `escalation_required.questions`（结构化选项）当前 fold 不落、手机端不渲染（契约注释 `contract-types/events.ts:458-461` 明示「mobile ignores them until its escalation answer card lands」）——属**已声明**的跨端渐进差异、非隐性接缝断裂，故不单列为发现。
