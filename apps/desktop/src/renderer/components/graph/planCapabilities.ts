/**
 * 协作图「模式能力表」——按 `planType` 声明图上具备哪些能力。
 *
 * 禁止在 GraphView / useCanvasFlow / InlineTeamGraph / RunDetailBody 等处再散落
 * `planType === "multi_agent"` 之类等值判断；一律查本表。辩论回合与 multi_agent
 * 共享审计注入（修历史漏判 bug），其余能力按行差异化。
 *
 * → 设计说明见 `docs/04-前端/前端UX设计.md` §5.1。
 */
import type { Execution } from "@/stores/execution";

export type PlanType = Execution["planType"];

/** 节点修订角标语义（实际文案仍由 run 级 beat / revision 派生）。 */
export type RevisionBadgeStyle = "none" | "hotfix" | "debate";

export interface PlanGraphCapabilities {
  /** 聊天内联 / 画布是否渲染团队协作图（单 Agent 为 false）。 */
  showsTeamGraph: boolean;
  /** 拉取 turn audit 并在图上画 inject 叠加（审计数据流）。 */
  auditInject: boolean;
  /**
   * 辩论主持人子树在 fold 中强制展开（不可收成单节点）。
   * 由 `helpers.computeGraphFold` 的 debateUnits 实现；本字段声明意图。
   */
  forceExpandDebateUnits: boolean;
  /** 内嵌 InlineTeamGraph 默认展开（用户仍可手动收起）。 */
  inlineDefaultExpanded: boolean;
  /** 修订角标风格：热修 vN / 辩论 beat / 无。 */
  revisionBadgeStyle: RevisionBadgeStyle;
  /**
   * 进行中 run 详情「改方向」redirect。辩论明确不开放（产品决策：辩手须独立对抗，
   * 中途「场边教练」会污染胜负参照；理由与扩开前置见 前端UX设计.md §5.1）。
   */
  runRedirect: boolean;
}

export const PLAN_GRAPH_CAPABILITIES: Record<PlanType, PlanGraphCapabilities> =
  {
    single_agent: {
      showsTeamGraph: false,
      auditInject: false,
      forceExpandDebateUnits: false,
      inlineDefaultExpanded: false,
      revisionBadgeStyle: "none",
      runRedirect: false,
    },
    multi_agent: {
      showsTeamGraph: true,
      auditInject: true,
      forceExpandDebateUnits: false,
      inlineDefaultExpanded: true,
      revisionBadgeStyle: "hotfix",
      runRedirect: true,
    },
    debate: {
      showsTeamGraph: true,
      auditInject: true,
      forceExpandDebateUnits: true,
      inlineDefaultExpanded: true,
      revisionBadgeStyle: "debate",
      runRedirect: false,
    },
  };

const IDLE: PlanGraphCapabilities = PLAN_GRAPH_CAPABILITIES.single_agent;

/** 查表；`null`/`undefined` 回落为单 Agent（无图能力）。 */
export function planCapabilities(
  planType: PlanType | null | undefined,
): PlanGraphCapabilities {
  if (planType == null) return IDLE;
  return PLAN_GRAPH_CAPABILITIES[planType];
}
