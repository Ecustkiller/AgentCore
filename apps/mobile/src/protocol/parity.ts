// 对等对账门禁 (parity gate) · 登记表 —— 桌面/协议新增「该上手机」的交互面时，漏改手机 →
// 门禁自动响，而非悄悄漂回去 (cross-platform-frontend.mdc:「手机 = 桌面 − 物理做不到的能力」)。
//
// 三锚（数据在此，校验在 parity.check.ts，挂在现有 mobile conformance / CI job 上）：
//   锚 A · 协议事件（编译期响）：{@link EVENT_PARITY} 是 Record<SSEEventType, ParityEntry>。
//     SSEEventType 是后端单一源自动生成的穷尽联合 (eventTypes.generated.ts)、两端 fold 已
//     `assertNever` 它。再做成 Record → 后端加新事件、`pnpm gen:types` 重生成联合后，缺键即
//     `tsc` 失败（CI mobile typecheck 门禁），直到你给出手机对等裁决。与 fold 的 assertNever 同
//     款棘轮。
//   锚 B · 桌面交互面（测试期响）：{@link DESKTOP_CHAT_PARITY} 列举 apps/desktop/.../components/
//     chat 下每个 .tsx 组件的对等裁决；parity.check.ts 扫该目录、断言每个 .tsx 都在表里有键
//     （桌面新建一面 → conformance 失败直到分类）。捕获非事件通道喂的面（如 ③ 记忆卡走 REST、
//     后台任务卡、@提及…）。
//   锚 C · 桌面页面（测试期响）：{@link DESKTOP_PAGE_PARITY} 列举 apps/desktop/.../pages 下每个
//     .tsx 页面（含子目录）的对等裁决；parity.check.ts 递归扫该目录、断言每个 .tsx 都在表里有键
//     （桌面新建一页 → conformance 失败直到分类）。接住整页 / route 级漂移（白板/工具箱/手册/成员…）。
//
// 边界（诚实）：门禁强制的是「有没有给出对等裁决」，不验证手机实现是否正确/已接线——那是
// typecheck（死/没接线代码）、conformance（fold 漂移）、可视化自检的活。三层分层互补，本表只补
// 「整面漏掉/没分类」这一段。符合 protocol-conformance.mdc「组件/chrome 不进巡检」：此处不巡检
// 实现，只强制一条裁决记录存在，两端 chrome 仍自由分叉。

import type { SSEEventType } from "@agentcore/contract-types";

/** 一条对等裁决。
 *  - `ported`：手机已覆盖（`surface` 给出手机落点：组件/位置）。
 *  - `simplified`：手机有意精简（`reason` 说明精简了什么/为何）。
 *  - `impossible`：手机物理做不到（`reason` 说明绑了哪种本地/桌面专属能力）。
 *  - `internal`：非用户面（纯协议管线/派生/渲染叶，`reason` 一句点明）。 */
export type ParityVerdict = "ported" | "simplified" | "impossible" | "internal";

export interface ParityEntry {
  verdict: ParityVerdict;
  /** 手机落点（ported 必填；simplified 视情可填）：组件名或位置。 */
  surface?: string;
  /** 理由（simplified / impossible / internal 必填；ported 可省，surface 已自证）。 */
  reason?: string;
}

/** 锚 A · 协议事件 → 手机对等裁决。`Record<SSEEventType, …>` 强制穷尽：缺键 = tsc 失败。 */
export const EVENT_PARITY: Record<SSEEventType, ParityEntry> = {
  // —— CEO 内联时间线：正文 / 思考 / 工具 / 引用 ——
  content_delta: { verdict: "ported", surface: "AssistantView 时间线 · 正文" },
  content_reset: {
    verdict: "ported",
    surface: "fold · finish_guard 回炉清正文",
  },
  reasoning_delta: { verdict: "ported", surface: "AssistantView · 思考块" },
  tool_use_start: { verdict: "ported", surface: "AssistantView · 工具步" },
  tool_use_end: { verdict: "ported", surface: "AssistantView · 工具步" },
  tool_use_progress: {
    verdict: "ported",
    surface:
      "AssistantView · 工具步执行阶段 (正在检索/排队中/改用备用引擎，extractToolPhases)",
  },
  citations: { verdict: "ported", surface: "AssistantView · 来源" },

  // —— 多 Agent 团队 ——
  run_plan: { verdict: "ported", surface: "TeamView" },
  run_started: { verdict: "ported", surface: "TeamView" },
  run_context: { verdict: "ported", surface: "AssistantView · 收到的上下文" },
  run_output_delta: { verdict: "ported", surface: "TeamView · 队员输出预览" },
  run_output_reset: {
    verdict: "ported",
    surface: "fold · worker finish_guard 回炉",
  },
  run_reasoning_delta: { verdict: "ported", surface: "TeamView · 队员思考" },
  run_tool_progress: { verdict: "ported", surface: "TeamView · 队员工具进度" },
  run_completed: { verdict: "ported", surface: "TeamView" },
  run_failed: { verdict: "ported", surface: "TeamView" },
  run_progress: {
    verdict: "internal",
    reason: "进度由 run 状态派生（仅时间线计数标记），无独立面",
  },
  plan_revised: { verdict: "ported", surface: "TeamView · 计划已调整 痕迹" },
  run_escalation: {
    verdict: "ported",
    surface: "TeamView · 上报提示 (非阻塞)",
  },
  escalation_required: {
    verdict: "ported",
    surface: "TeamView · EscalationAnswer 待你拍板卡 (②)",
  },
  escalation_resolved: { verdict: "ported", surface: "TeamView · 升级收束" },

  // —— 辩论 ——
  debate_result: { verdict: "ported", surface: "DebateView" },
  debate_round_started: { verdict: "ported", surface: "LiveDebateNarrative" },
  debate_round: {
    verdict: "ported",
    surface: "LiveDebateNarrative / DebateView",
  },
  debate_round_decision_required: {
    verdict: "simplified",
    reason:
      "手机无逐轮辩论决策 UI；收场叙事由 debate_round/result 承载 (fold no-op)",
  },
  debate_round_decision_resolved: {
    verdict: "simplified",
    reason: "同上 · 逐轮续辩/收场决策仅桌面",
  },

  // —— 团队便签墙 ——
  team_note_posted: { verdict: "ported", surface: "TeamView · 团队便签" },

  // —— 阻塞交互（统一 PauseCard / ResumeCard）——
  approval_required: { verdict: "ported", surface: "PauseCard" },
  approval_resolved: { verdict: "ported", surface: "PauseCard" },
  checkpoint_required: { verdict: "ported", surface: "PauseCard / ResumeCard" },
  checkpoint_resolved: { verdict: "ported", surface: "PauseCard" },
  plan_review_required: { verdict: "ported", surface: "PauseCard" },
  plan_review_resolved: { verdict: "ported", surface: "PauseCard" },

  // —— 非阻塞提问 (①) ——
  question_posted: { verdict: "ported", surface: "NonBlockingAskCard (①)" },

  // —— 跟进推荐 ——
  followups_generated: {
    verdict: "ported",
    surface: "ChatPage · 下一步 chips",
  },

  // —— 收尾 / 错误 ——
  error: { verdict: "ported", surface: "ChatPage · 错误条" },
  message_start: {
    verdict: "internal",
    reason:
      "服务端 message_id 开泡标记，fold no-op；手机流式 UI 不依赖此事件投影",
  },
  message_end: { verdict: "ported", surface: "ChatPage · 收尾 + 回合总账" },

  // —— 纯管线 / 派生（非用户面）——
  turn_warning: { verdict: "ported", surface: "ChatPage · 预检警告条" },
  turn_saved: { verdict: "internal", reason: "落库标记，无 UI" },
  title_generated: {
    verdict: "internal",
    reason: "标题经 REST/会话列表呈现，非回合流面",
  },
  tool_progress: {
    verdict: "internal",
    reason: "粗粒度旧进度事件，fold no-op",
  },

  // —— 诊断（桌面 power-user 面）——
  batch_metrics: {
    verdict: "simplified",
    reason: "调度埋点量化仅桌面诊断模式面板；手机无诊断面板 (fold no-op)",
  },

  // —— AI 协作白板（桌面画布面，手机无板）——
  board_op_required: {
    verdict: "impossible",
    reason: "AI 协作白板为桌面画布面，手机无板 (fold no-op)",
  },
  board_read_required: {
    verdict: "impossible",
    reason: "同上 · 读板为桌面画布面",
  },

  // —— 草稿工作区（本地文件夹）/ 本地↔云交接（物理做不到）——
  workspace_op_required: {
    verdict: "impossible",
    reason: "工作区操作绑本地文件夹；纯云瘦客户端无本地侧",
  },
  handoff_snapshot_done: {
    verdict: "impossible",
    reason: "本地↔云交接（后台任务桥）的本地侧，手机无本地",
  },
  handoff_job_started: {
    verdict: "impossible",
    reason: "同上 · 后台任务桥本地侧",
  },
  handoff_apply_done: {
    verdict: "impossible",
    reason: "同上 · 把云端改动合并回本地磁盘，手机无本地",
  },

  // —— AI 小镇模拟（桌面 MVP，手机无模拟面）——
  "sim.agent_action": {
    verdict: "impossible",
    reason: "AI 小镇模拟仅桌面 MVP，手机无模拟面 (fold no-op)",
  },
  "sim.agent_state": {
    verdict: "impossible",
    reason: "同上 · 居民状态同步",
  },
  "sim.interaction": {
    verdict: "impossible",
    reason: "同上 · 居民交互气泡/交易",
  },
  "sim.tick_started": {
    verdict: "impossible",
    reason: "同上 · 模拟 tick 开始",
  },
  "sim.tick_ended": {
    verdict: "impossible",
    reason: "同上 · 模拟 tick 结束",
  },
  "sim.tick_frame": {
    verdict: "impossible",
    reason: "同上 · 模拟 tick 帧快照",
  },
  "sim.world_event": {
    verdict: "impossible",
    reason: "同上 · 世界事件",
  },
};

/** 锚 B · 桌面交互面（apps/desktop/src/renderer/components/chat 下每个 .tsx）→ 手机对等裁决。
 *  key = 组件文件名（无扩展名）。parity.check.ts 扫该目录断言每个 .tsx 都在此有键，并报告指向
 *  已不存在文件的陈旧键。infra / 渲染叶子记 `internal`（仍要求一句 reason，强制是有意分类而非
 *  遗漏）。 */
export const DESKTOP_CHAT_PARITY: Record<string, ParityEntry> = {
  // —— 互动卡：已上手机 ——
  NonBlockingAskCard: { verdict: "ported", surface: "NonBlockingAskCard (①)" },
  EscalationCard: {
    verdict: "ported",
    surface: "TeamView · EscalationAnswer (②)",
  },
  MemoryUpdateCard: { verdict: "ported", surface: "MemoryUpdateCard (③)" },
  CheckpointCard: { verdict: "ported", surface: "PauseCard / ResumeCard" },
  PlanReviewCard: { verdict: "ported", surface: "PauseCard" },
  ApprovalPrompt: { verdict: "ported", surface: "PauseCard" },
  ResumePrompt: { verdict: "ported", surface: "ResumeCard" },
  FileArtifactsCard: { verdict: "ported", surface: "FileArtifactsCard" },
  FollowupChips: { verdict: "ported", surface: "ChatPage · 下一步 chips" },
  ConversationOutline: {
    verdict: "simplified",
    reason: "对话大纲/回合导航，手机暂不做（小屏以滚动代）",
  },
  FindBar: {
    verdict: "simplified",
    reason: "会话内查找，手机暂不做（无 Cmd+F 快捷键）",
  },
  ReceivedContext: {
    verdict: "ported",
    surface: "AssistantView · 收到的上下文",
  },
  TeamNotesPanel: { verdict: "ported", surface: "TeamView · 团队便签" },
  SourceCards: { verdict: "ported", surface: "AssistantView · 来源" },
  StatusStrip: { verdict: "ported", surface: "ChatPage · 状态 meta 行" },
  StreamingIndicator: {
    verdict: "ported",
    surface: "ChatPage · 流式状态条",
  },
  TurnWarningBanner: {
    verdict: "ported",
    surface: "ChatPage · 预检警告条",
  },
  ParallelTimeline: {
    verdict: "ported",
    surface: "AssistantView · ProcessTimeline",
  },

  // —— 有意精简 ——
  InlineTeamGraph: {
    verdict: "simplified",
    reason: "手机用竖排 TeamView 代 React-Flow 画布（小屏合理）",
  },
  MentionMenu: {
    verdict: "simplified",
    reason: "手机 composer 不带 @ 提及菜单 (niche)",
  },
  RetryBanner: {
    verdict: "simplified",
    reason: "手机走更强的实时重连续看 + reconnect 条代替失败重试",
  },
  SourcePreview: {
    verdict: "simplified",
    reason: "手机来源为纯链接，无悬浮预览（桌面 affordance）",
  },

  // —— 物理做不到 ——
  BackgroundTaskCard: {
    verdict: "impossible",
    reason: "本地↔云后台任务桥，手机无本地侧 (④)",
  },
  BackgroundTaskReview: {
    verdict: "impossible",
    reason: "同上 · 评审并把云端改动合并回本地磁盘",
  },
  DraftWorkspacePicker: {
    verdict: "impossible",
    reason: "选本地文件夹，纯云瘦客户端无本地",
  },
  DraftWorkspaceAssignPrompt: {
    verdict: "impossible",
    reason: "指派本地工作区，手机无本地",
  },

  // —— infra / 渲染叶子（非交互-对等面）——
  ChatView: { verdict: "internal", reason: "对话容器" },
  ConversationRoute: { verdict: "internal", reason: "路由壳" },
  MessageList: { verdict: "internal", reason: "消息列表容器" },
  MessageBubble: { verdict: "internal", reason: "气泡容器" },
  MessageInput: { verdict: "internal", reason: "composer 输入" },
  ToolLine: {
    verdict: "internal",
    reason: "工具行渲染叶（手机自有 ToolStep）",
  },
  Markdown: { verdict: "internal", reason: "共享渲染叶" },
  CodeBlock: { verdict: "internal", reason: "代码块渲染叶" },
  Diagram: { verdict: "internal", reason: "mermaid 渲染叶" },
  Favicon: { verdict: "internal", reason: "站点图标叶" },
  EvidenceBadge: {
    verdict: "internal",
    reason:
      "辩论发言举证标记渲染叶（remarkEvidence 把【已核实/待核实】渲成徽章）；非交互面，手机 markdown 叶自渲、标记信息随发言全文透传",
  },
};

/** 锚 C · 桌面页面（apps/desktop/src/renderer/pages 下每个 .tsx，含子目录）→ 手机对等裁决。
 *  key = 相对 pages 根的路径（正斜杠、去 .tsx），子目录区分同名页（桶文件 ConversationsPage vs
 *  实体 conversations/ConversationsPage）。parity.check.ts 递归扫该目录断言每个 .tsx 都有键、并报
 *  陈旧键。接住整页 / route 级漂移：桌面新增一页 → conformance 失败直到给出手机对等裁决。 */
export const DESKTOP_PAGE_PARITY: Record<string, ParityEntry> = {
  // —— 已上手机（路由对齐）——
  ConversationPage: { verdict: "ported", surface: "ChatPage（对话）" },
  "conversations/ConversationsPage": {
    verdict: "ported",
    surface: "ChatPage · 会话列表（抽屉）",
  },
  MorePage: { verdict: "ported", surface: "MorePage（设置中心）" },
  LoginPage: { verdict: "ported", surface: "LoginPage" },
  FilesPage: { verdict: "ported", surface: "FilesPage / WorkspacesPage" },
  MessagesPage: { verdict: "ported", surface: "MessagesPage（IM）+ im/*" },
  ServiceUnavailablePage: {
    verdict: "ported",
    surface: "ServiceUnavailablePage",
  },
  "more/UsageSettings": { verdict: "ported", surface: "more/UsageSettings" },
  "more/ModelSettings": { verdict: "ported", surface: "more/ModelSettings" },
  "more/AboutSettings": { verdict: "ported", surface: "more/AboutSettings" },
  "more/AccountSettings": {
    verdict: "ported",
    surface: "more/AccountSettings",
  },
  "more/ImPrivacySettings": {
    verdict: "ported",
    surface: "MessagesPage · 消息隐私（IM 设置）",
  },
  "more/FeedbackSettings": {
    verdict: "simplified",
    reason: "反馈设置页，手机暂不做",
  },
  "more/MemorySettings": {
    verdict: "ported",
    surface: "MemoryPage（手机独立记忆页）",
  },

  // —— 有意精简 / 保持不做（⑥ 精简陪伴定位 & 明确决策）——
  ToolboxPage: { verdict: "simplified", reason: "工具箱保持不做（⑥）" },
  "toolbox/ToolsPage": {
    verdict: "simplified",
    reason: "工具创作保持不做（⑥）",
  },
  "toolbox/GuidelinesPage": {
    verdict: "simplified",
    reason: "工具箱·指南保持不做（⑥）",
  },
  "toolbox/manual/ManualShell": {
    verdict: "simplified",
    reason: "产品手册归工具箱保持不做（本轮决策）",
  },
  "toolbox/manual/ManualIntro": {
    verdict: "simplified",
    reason: "产品手册保持不做（本轮决策）",
  },
  "toolbox/manual/ManualMechanism": {
    verdict: "simplified",
    reason: "产品手册保持不做（本轮决策）",
  },
  "toolbox/manual/ManualCollaboration": {
    verdict: "simplified",
    reason: "产品手册保持不做（本轮决策）",
  },
  "toolbox/manual/ManualReference": {
    verdict: "simplified",
    reason: "产品手册保持不做（本轮决策）",
  },
  ExplorePage: {
    verdict: "simplified",
    reason: "探索/公共市场桌面尚为占位（Day 2），手机暂不做",
  },
  "more/AppearanceSettings": {
    verdict: "simplified",
    reason: "手机不提供外观/暗色切换（明确决策）",
  },

  // —— 物理做不到（绑桌面画布 / 硬件）——
  WhiteboardPage: {
    verdict: "impossible",
    reason: "协作白板入口，手机无板（与 board_* 事件同裁）",
  },
  WhiteboardCanvasPage: {
    verdict: "impossible",
    reason: "协作白板画布，手机无板",
  },
  WhiteboardPreviewPage: {
    verdict: "internal",
    reason:
      "桌面白板离线自检回放（#/preview/whiteboard 开发工具），非用户产品面",
  },
  "simulation/TownSimulationPage": {
    verdict: "impossible",
    reason: "AI 小镇模拟仅桌面 MVP，手机无模拟面",
  },
  "more/ShortcutsSettings": {
    verdict: "impossible",
    reason: "手机无物理键盘，快捷键设置无意义",
  },

  // —— infra / 渲染叶 / 桶文件 / 开发自检（非用户-对等面）——
  ConversationsPage: {
    verdict: "internal",
    reason: "桶文件 re-export ./conversations/ConversationsPage",
  },
  "more/SettingsHeader": {
    verdict: "internal",
    reason: "设置页共享头部渲染叶（非独立面）",
  },
  "toolbox/manual/primitives": {
    verdict: "internal",
    reason: "产品手册渲染基件（非独立面）",
  },
  PreviewPage: {
    verdict: "internal",
    reason: "桌面渲染层离线自检回放（#/preview 开发工具），非用户产品面",
  },
};
