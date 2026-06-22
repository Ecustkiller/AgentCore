---
status: reference
code: apps/desktop/src/renderer/components/ui/
related:
  - .cursor/rules/color-tokens.mdc
  - docs/04-前端/前端UX设计.md
skip_if:
  - 只改业务逻辑不涉及组件层
---

# UI Pattern 索引

> **状态**：✅ 已落地（primitive 层 + lint 门禁）
>
> 配色与布局硬规则见 `.cursor/rules/color-tokens.mdc`、`desktop-layout.mdc`；产品 IA 见 [`前端UX设计.md`](前端UX设计.md)。

## 三层结构

| 层 | 位置 | 职责 |
|---|---|---|
| **L1 Token** | `packages/design-tokens/src/tokens.css` | OKLCH 语义色、动画、侧栏/身份色板（desktop/mobile 共用包） |
| **L2 Primitive** | `apps/desktop/src/renderer/components/ui/` | Button、Card、Badge 等可复用原子组件 |
| **L3 Pattern** | 组合 primitive 的产品级壳（见下表） | 裁决卡、状态条、列表行等 |

## L2 Primitive 一览

→ 见代码 `components/ui/index.ts`

| 组件 | 用途 |
|---|---|
| `Button` / `IconButton` | CTA、工具栏图标（sm h-7 / md h-8）；`Button` 含 `destructive` 实心变体；`IconButton` 含 `primary` / `destructive` tone |
| `Card` | 面板/卡片容器（`rounded-xl`） |
| `Badge` | 状态 chip、pill 计数 |
| `Input` / `Textarea` | 表单、内联编辑 |
| `SectionLabel` | 分组小标题（工具箱、设置） |
| `DecisionCard` | 裁决类卡片外壳（primary / warning / neutral） |
| `SurfaceRow` / `SurfaceRowButton` | 列表行 chrome（file / sidebar variant） |
| `PatternCardHeader` | 时间线卡片头栏（标签 + badge + 时间戳） |

Radix overlay（dialog / popover / tooltip 等）仍在 `components/ui/`，与 primitive 并列。

## L3 Pattern 映射

| Pattern | 典型场景 | 实现指针 |
|---|---|---|
| **DecisionCard** | ask_user / plan_review / approval / escalation | `DecisionCard` + `Button`；`CheckpointCard` / `PlanReviewCard` / `ApprovalPrompt` / `EscalationCard` |
| **StatusStrip** | 协作图状态条 | `StatusStrip.tsx`（`InlineTeamGraph` 消费） |
| **PatternCardHeader** | 后台任务卡头栏 | `BackgroundTaskCard.tsx` |
| **SurfaceRow** | 侧栏对话项、文件树行 | `ConversationItem.tsx`、`FileTreeRow.tsx` |
| **ToolLine** | 过程时间线工具行 / 组 | `ToolLine.tsx`（`ProcessTimeline` 消费） |
| **FinishReasonChip** | 回合非正常收尾 chip | `finish-reason-chip.tsx` |
| **PanelShell** | 右侧面板、指挥台 | `SidePanel.tsx`、`CanvasDecisionPanel.tsx` |

新交互卡片应优先复用 **DecisionCard + Button**，并确保聊天与画布双视图可共用（见 `CanvasDecisionPanel.tsx`）。

## Lint 门禁

```bash
node scripts/check-ui-tokens.mjs --src apps/desktop/src/renderer
node scripts/check-ui-tokens.mjs --src apps/mobile/src
```

禁止：`rounded-md/sm/2xl`、自定义 px 字号（10/11/13）、Tailwind 调色板类、hex 任意色。已接入两端 `pnpm lint` 与 CI。

## design-tokens 同步清单

变更语义色 / 侧栏 / 身份色 / 语法高亮时：

1. 改 `packages/design-tokens/src/tokens.css`（desktop `:root` + `.dark`）
2. 若 mobile 映射需变 → 改 `mobile-light.css`
3. 跑两端 `check-ui-tokens` + 目视 dark/light
4. 更新 `.cursor/rules/color-tokens.mdc` 若分类或命名变

## 迁移策略

**touch-it-adopt-it 已完成**：renderer 内交互控件已统一为 `Button` / `IconButton` / `SurfaceRowButton` / `Switch`。新代码默认用 primitive。

### 不可改为 `<button>` 的例外（HTML 结构约束）

| 位置 | 原因 |
|---|---|
| `AgentNode` 图节点 | 复合块（icon + 多行 + badge），用 `div role="button"` |
| `ui/button.tsx` 等 | primitive 实现本身 |

`ConversationItem` 已采用方案 B：`SurfaceRow` + 标题区 `role="button"` + 并列 `IconButton`。
