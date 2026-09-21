/*
 * Default kit DAG: three-way parallel fanout, then CEO merge.
 * Debate is a still (`Still-debate`), not the default GraphRun / AppShell sample.
 *
 * Shape:
 *   L1 并行调研   竞品定价 / 用户痛点 / 渠道策略
 *   L2 CEO 汇总
 *
 * Precompute bakes ELK into layout.ts; GraphStage reads node identities + per-node data.
 */

export const DEMO_TASK = "分三路并行调研竞品、痛点与渠道，汇总成决策简报";

export type DemoNodeType = "userInput" | "agent" | "captain";

export interface DemoNode {
  id: string;
  type: DemoNodeType;
  data: Record<string, unknown>;
}

export type DemoEdgeKind = "dep" | "delegate";

export interface DemoEdge {
  id: string;
  source: string;
  target: string;
  kind: DemoEdgeKind;
}

export const INPUT_ID = "__input__";
export const CAPTAIN_ID = "captain";

export const DEMO_NODES: DemoNode[] = [
  {
    id: INPUT_ID,
    type: "userInput",
    data: { variant: "input", status: "completed", label: DEMO_TASK },
  },
  {
    id: "pricing",
    type: "agent",
    data: {
      agentId: "pricing",
      runId: "pricing",
      role: "竞品定价",
      status: "completed",
      isAnimating: false,
      task: "对齐三家竞品的价带与席位档差",
      outputPreview: "",
      tokenCount: 0,
      toolCount: 2,
      focused: false,
    },
  },
  {
    id: "pain",
    type: "agent",
    data: {
      agentId: "pain",
      runId: "pain",
      role: "用户痛点",
      status: "running",
      isAnimating: true,
      task: "归纳「看不见进度 / 上下文对不上」等协作断点",
      outputPreview: "",
      tokenCount: 0,
      toolCount: 2,
      focused: false,
    },
  },
  {
    id: "channel",
    type: "agent",
    data: {
      agentId: "channel",
      runId: "channel",
      role: "渠道策略",
      status: "running",
      isAnimating: true,
      task: "看现有渠道能否把协作过程讲给决策者",
      outputPreview: "",
      tokenCount: 0,
      toolCount: 1,
      focused: false,
    },
  },
  {
    id: CAPTAIN_ID,
    type: "captain",
    data: { variant: "captain", status: "pending", label: "", preview: "" },
  },
];

export const DEMO_LAYOUT_EDGES: DemoEdge[] = [
  edge(INPUT_ID, "pricing"),
  edge(INPUT_ID, "pain"),
  edge(INPUT_ID, "channel"),
  edge("pricing", CAPTAIN_ID),
  edge("pain", CAPTAIN_ID),
  edge("channel", CAPTAIN_ID),
];

export const DEMO_NODE_IDS: string[] = DEMO_NODES.map((n) => n.id);

function edge(
  source: string,
  target: string,
  kind: DemoEdgeKind = "dep",
): DemoEdge {
  return { id: `${source}->${target}`, source, target, kind };
}
