import type { Edge, Node } from "@xyflow/react";
import {
  CAPTAIN_ID,
  DEMO_LAYOUT_EDGES,
  DEMO_NODES,
  INPUT_ID,
} from "../data/demo";
import { DEMO_LAYOUT } from "../data/layout";
import { typeOut } from "../motion/primitives";

/*
 * The brain of the 7–20s graph segment: one schedule covering both the 7–11s
 * cascade entrance (run_plan declaring the team) and the 11–20s execution waves,
 * turned into per-frame ReactFlow node/edge state. Shared by GraphScene (live)
 * and AnswerScene (final state), rendered by GraphStage.
 *
 * Scene-local frames (fps 30), 0 = 7s:
 *   0–120   entrance cascade (layer by layer, all pending)
 *   120–180 L1 并行调研 running → done
 *   195–285 辩论对射
 *   300–345 策略定稿
 *   360–390 L4 并行产出
 */

export const GRAPH_SCENE_FRAMES = 390; // 13s @ 30fps (7–20s)

interface Sched {
  enter: number;
  run: number;
  done: number;
}

const SCHED: Record<string, Sched> = {
  research_user: { enter: 18, run: 120, done: 180 },
  research_comp: { enter: 24, run: 120, done: 180 },
  research_tech: { enter: 30, run: 120, done: 180 },
  plan_radical: { enter: 54, run: 195, done: 285 },
  plan_stable: { enter: 60, run: 195, done: 285 },
  strategy: { enter: 84, run: 300, done: 345 },
  spec_product: { enter: 102, run: 360, done: 390 },
  spec_tech: { enter: 108, run: 360, done: 390 },
};
const INPUT_ENTER = 0;
const CAPTAIN_ENTER = 116;

const STREAM: Record<string, string> = {
  research_user: "已锁定 3 类核心用户，高频痛点集中在协作断点与上下文丢失……",
  research_comp: "竞品 A 偏协作、B 偏自动化，均未打通真正的多 Agent 团队……",
  research_tech: "Agent 编排正从单体走向团队化，DAG 调度与共享工作区成主线……",
  plan_radical:
    "主张直接押注 Agent 团队协作这一差异点，抢占竞品尚未覆盖的空白……",
  plan_stable: "反对一次性押注，主张先验证关键风险、按里程碑稳健迭代落地……",
  strategy: "综合正反方：先验证关键风险，再分阶段放大投入，锁定团队协作主线……",
  spec_product: "拆出 6 个里程碑，首版聚焦团队协作主链路……",
  spec_tech: "定下 DAG 调度 + 共享工作区 + MCP/A2A 的技术骨架……",
};

const DURATION_MS: Record<string, number> = {
  research_user: 5200,
  research_comp: 6100,
  research_tech: 4800,
  plan_radical: 7200,
  plan_stable: 6800,
  strategy: 5600,
  spec_product: 4200,
  spec_tech: 5400,
};

/** Pull the debate pair apart vertically so the 对射 connector has room. */
export const DEBATE_NUDGE = 36;

export interface CaptainOverride {
  status: string;
  preview?: string;
  /** Scene-local frame the 汇聚点 reaches its terminal state (drives 绿闪). */
  terminalFrame?: number | null;
}

export function nodePosition(id: string): { x: number; y: number } {
  const p = DEMO_LAYOUT.positions[id] ?? { x: 0, y: 0 };
  if (id === "plan_radical") return { x: p.x, y: p.y - DEBATE_NUDGE };
  if (id === "plan_stable") return { x: p.x, y: p.y + DEBATE_NUDGE };
  return p;
}

function enterOf(id: string): number {
  if (id === INPUT_ID) return INPUT_ENTER;
  if (id === CAPTAIN_ID) return CAPTAIN_ENTER;
  return SCHED[id]?.enter ?? 0;
}

function statusAt(id: string, frame: number): string {
  if (id === INPUT_ID) return "completed";
  if (id === CAPTAIN_ID) return "pending";
  const s = SCHED[id];
  if (!s) return "pending";
  if (frame < s.run) return "pending";
  if (frame < s.done) return "running";
  return "completed";
}

function edgeFlow(targetId: string, frame: number): number {
  const s = SCHED[targetId];
  if (!s) return 0;
  return frame >= s.run - 9 && frame < s.done + 2 ? 1 : 0;
}

export interface DebateState {
  cx: number;
  y1: number;
  y2: number;
  active: boolean;
}

export interface GraphState {
  nodes: Node[];
  edges: Edge[];
  debate: DebateState;
}

/**
 * Build the ReactFlow node/edge state for the graph at `frame` (scene-local).
 * `opts.captain` overrides the 汇聚点 (used by AnswerScene where it lights up).
 */
export function buildGraphState(
  frame: number,
  fps: number,
  opts: { captain?: CaptainOverride } = {},
): GraphState {
  const nodes: Node[] = DEMO_NODES.map((n) => {
    const isCaptain = n.id === CAPTAIN_ID;
    let status = statusAt(n.id, frame);
    let preview = "";
    let captainPreview: string | undefined;
    let terminalFrame: number | null = SCHED[n.id]?.done ?? null;
    if (isCaptain && opts.captain) {
      status = opts.captain.status;
      captainPreview = opts.captain.preview;
      terminalFrame = opts.captain.terminalFrame ?? null;
    }
    const s = SCHED[n.id];
    const running = status === "running";
    if (running && STREAM[n.id]) {
      preview = typeOut(STREAM[n.id], frame, s?.run ?? 0, fps);
    }
    const durationMs = status === "completed" ? DURATION_MS[n.id] : undefined;
    return {
      id: n.id,
      type: n.type,
      position: nodePosition(n.id),
      data: {
        ...n.data,
        status,
        isAnimating: running,
        ...(isCaptain
          ? { preview: captainPreview ?? "" }
          : { outputPreview: preview }),
        ...(durationMs ? { durationMs } : {}),
        _enterFrame: enterOf(n.id),
        _terminalFrame: terminalFrame,
        _ok: true,
        handleDirection: "horizontal",
      },
    } as Node;
  });

  const edges: Edge[] = DEMO_LAYOUT_EDGES.map((e) => {
    const appear = Math.max(enterOf(e.source), enterOf(e.target)) + 6;
    const enterOpacity = frame >= appear ? 1 : frame >= appear - 9 ? (frame - (appear - 9)) / 9 : 0;
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      type: "flow",
      data: {
        flow: edgeFlow(e.target, frame),
        kind: e.kind,
        enterOpacity,
      },
    } as Edge;
  });

  const pro = nodePosition("plan_radical");
  const con = nodePosition("plan_stable");
  const debate: DebateState = {
    cx: pro.x + 105,
    y1: pro.y + 66,
    y2: con.y + 66,
    active: frame >= 186 && frame < 292,
  };

  return { nodes, edges, debate };
}
