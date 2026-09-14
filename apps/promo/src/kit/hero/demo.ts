/*
 * Sample hero DAG for promo stills / Studio graph-run. Encoded once: precompute
 * bakes ELK into layout.ts; GraphStage reads node identities + per-node data.
 *
 * Shape (5 layers — 多方圆桌):
 *   L1 并行调研   用户调研 / 竞品分析 / 技术趋势
 *   L2 主持人     主持人（逐轮抛焦点、收敛分歧、裁决交锋）
 *   L3 圆桌交锋   激进增长 / 稳健务实 / 用户价值 / 成本风险（多边碰撞）
 *   L4 裁决       策略定稿
 *   L5 并行产出   产品需求 / 技术方案
 *
 * Node `data` is deliberately typed loosely (Record<string, unknown>) — the same
 * pattern TeamMechanism's PreviewNode uses — so this module carries no `@/`
 * runtime import and stays importable from a plain Node precompute script.
 */

export const DEMO_TASK = "做个完整的产品规划，多方论证后定方案";

export type DemoNodeType = "userInput" | "agent" | "captain";

export interface DemoNode {
  id: string;
  type: DemoNodeType;
  data: Record<string, unknown>;
}

/** Structural edge kind — mirrors the product's GraphEdge.kind. */
export type DemoEdgeKind = "dep" | "delegate" | "revision";

export interface DemoEdge {
  id: string;
  source: string;
  target: string;
  kind: DemoEdgeKind;
}

export const INPUT_ID = "__input__";
export const CAPTAIN_ID = "captain";

// ── Nodes ───────────────────────────────────────────────────────────────────
// Statuses here are a representative mid-climax snapshot (research done, debate
// live) so the Phase-1 still exercises every state; Phase 2 drives status by
// frame instead. `task` / `outputPreview` carry the real on-card copy.

export const DEMO_NODES: DemoNode[] = [
  {
    id: INPUT_ID,
    type: "userInput",
    data: { variant: "input", status: "completed", label: DEMO_TASK },
  },
  {
    id: "research_user",
    type: "agent",
    data: {
      agentId: "research_user",
      runId: "research_user",
      role: "用户调研",
      status: "completed",
      isAnimating: false,
      task: "调研目标用户的核心痛点与未被满足的需求",
      outputPreview: "",
      tokenCount: 0,
      toolCount: 2,
      focused: false,
      modelPreference: "fast",
      durationMs: 5200,
    },
  },
  {
    id: "research_comp",
    type: "agent",
    data: {
      agentId: "research_comp",
      runId: "research_comp",
      role: "竞品分析",
      status: "completed",
      isAnimating: false,
      task: "拆解 3 家主要竞品的能力边界与定价策略",
      outputPreview: "",
      tokenCount: 0,
      toolCount: 3,
      focused: false,
      modelPreference: "strong",
      durationMs: 6100,
    },
  },
  {
    id: "research_tech",
    type: "agent",
    data: {
      agentId: "research_tech",
      runId: "research_tech",
      role: "技术趋势",
      status: "completed",
      isAnimating: false,
      task: "梳理 2026 年 AI Agent 的技术演进方向",
      outputPreview: "",
      tokenCount: 0,
      toolCount: 1,
      focused: false,
      modelPreference: "fast",
      durationMs: 4800,
    },
  },
  {
    id: "moderator",
    type: "agent",
    data: {
      agentId: "moderator",
      runId: "moderator",
      role: "主持人",
      status: "running",
      isAnimating: true,
      task: "主持多方圆桌，逐轮抛出焦点、收敛分歧、裁决交锋",
      outputPreview:
        "本轮焦点：押注差异化 vs 控风险稳健，请各方就成本与时机正面回应……",
      tokenCount: 980,
      toolCount: 0,
      focused: false,
      modelPreference: "strong",
      reasoningEffort: "max",
    },
  },
  {
    id: "view_growth",
    type: "agent",
    data: {
      agentId: "view_growth",
      runId: "view_growth",
      role: "激进增长",
      status: "running",
      isAnimating: true,
      task: "从痛点与竞品空白出发，主张押注差异化、抢占空白的激进路线",
      outputPreview:
        "主张直接押注 Agent 团队协作这一差异点，抢占竞品尚未覆盖的空白……",
      tokenCount: 1840,
      toolCount: 1,
      focused: false,
      modelPreference: "strong",
    },
  },
  {
    id: "view_steady",
    type: "agent",
    data: {
      agentId: "view_steady",
      runId: "view_steady",
      role: "稳健务实",
      status: "running",
      isAnimating: true,
      task: "从技术现实与竞品成熟度出发，主张控风险、按里程碑稳健迭代",
      outputPreview:
        "反对一次性押注，主张先验证关键风险、按里程碑稳健迭代落地……",
      tokenCount: 1720,
      toolCount: 2,
      focused: false,
      modelPreference: "strong",
    },
  },
  {
    id: "view_user",
    type: "agent",
    data: {
      agentId: "view_user",
      runId: "view_user",
      role: "用户价值",
      status: "running",
      isAnimating: true,
      task: "从真实用户痛点出发，主张优先打磨核心体验闭环",
      outputPreview:
        "强调先把协作断点这一最痛场景的核心闭环体验打磨透，再谈扩张……",
      tokenCount: 1560,
      toolCount: 1,
      focused: false,
      modelPreference: "fast",
    },
  },
  {
    id: "view_cost",
    type: "agent",
    data: {
      agentId: "view_cost",
      runId: "view_cost",
      role: "成本风险",
      status: "running",
      isAnimating: true,
      task: "审视投入产出与落地风险，为各方方案做压力测试",
      outputPreview:
        "提醒算力与维护成本、落地复杂度，要求每一步都留有可回退的安全边界……",
      tokenCount: 1480,
      toolCount: 2,
      focused: false,
      modelPreference: "strong",
    },
  },
  {
    id: "strategy",
    type: "agent",
    data: {
      agentId: "strategy",
      runId: "strategy",
      role: "策略定稿",
      status: "pending",
      isAnimating: false,
      task: "综合各方圆桌论点，裁决并定稿产品策略",
      outputPreview: "",
      tokenCount: 0,
      toolCount: 0,
      focused: false,
      modelPreference: "strong",
      reasoningEffort: "max",
    },
  },
  {
    id: "spec_product",
    type: "agent",
    data: {
      agentId: "spec_product",
      runId: "spec_product",
      role: "产品需求",
      status: "pending",
      isAnimating: false,
      task: "据定稿策略产出产品需求文档",
      outputPreview: "",
      tokenCount: 0,
      toolCount: 0,
      focused: false,
      modelPreference: "fast",
    },
  },
  {
    id: "spec_tech",
    type: "agent",
    data: {
      agentId: "spec_tech",
      runId: "spec_tech",
      role: "技术方案",
      status: "pending",
      isAnimating: false,
      task: "据定稿策略产出技术实现方案",
      outputPreview: "",
      tokenCount: 0,
      toolCount: 0,
      focused: false,
      modelPreference: "strong",
    },
  },
  {
    id: CAPTAIN_ID,
    type: "captain",
    data: { variant: "captain", status: "pending", label: "", preview: "" },
  },
];

// ── Edges ───────────────────────────────────────────────────────────────────

/**
 * Layout edges — the depends_on / bookend DAG that defines the 4 layers. Only
 * these are fed to ELK (data/layout.ts) so layering stays clean. The debate edge
 * below is intentionally excluded from layout (it joins two *same-layer* nodes,
 * which would fight ELK's layering) and drawn as an overlay instead.
 */
export const DEMO_LAYOUT_EDGES: DemoEdge[] = [
  edge(INPUT_ID, "research_user"),
  edge(INPUT_ID, "research_comp"),
  edge(INPUT_ID, "research_tech"),
  edge("research_user", "moderator"),
  edge("research_comp", "moderator"),
  edge("research_tech", "moderator"),
  edge("moderator", "view_growth"),
  edge("moderator", "view_steady"),
  edge("moderator", "view_user"),
  edge("moderator", "view_cost"),
  edge("view_growth", "strategy"),
  edge("view_steady", "strategy"),
  edge("view_user", "strategy"),
  edge("view_cost", "strategy"),
  edge("strategy", "spec_product"),
  edge("strategy", "spec_tech"),
  edge("spec_product", CAPTAIN_ID),
  edge("spec_tech", CAPTAIN_ID),
];

/**
 * Round-table 碰撞 overlay edges — the「修订/辩论」cross-talk between the four
 * viewpoints (多边碰撞). A loose web (spine down the column + a top↔bottom wrap) so
 * the cluster reads as a round table, not an independent fan. Kept out of ELK layout
 * (see DEMO_LAYOUT_EDGES — same-layer edges fight layering) and drawn on top.
 */
export const DEMO_DEBATE_EDGES: DemoEdge[] = [
  edge("view_growth", "view_steady", "revision"),
  edge("view_steady", "view_user", "revision"),
  edge("view_user", "view_cost", "revision"),
  edge("view_growth", "view_cost", "revision"),
];

/** Node ids in declaration order (the precompute script feeds these to ELK). */
export const DEMO_NODE_IDS: string[] = DEMO_NODES.map((n) => n.id);

function edge(
  source: string,
  target: string,
  kind: DemoEdgeKind = "dep",
): DemoEdge {
  return { id: `${source}->${target}`, source, target, kind };
}
