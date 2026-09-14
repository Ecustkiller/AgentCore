import type {
  DebateAxisSpec,
  SchedEntry,
} from "../../core/graph/graphState";

/*
 * Sample-graph wave schedule. Frame evaluation lives in core/graph/graphState.
 *
 * Scene-local frames @30fps:
 *   0–120   entrance cascade
 *   120–180 L1 并行调研 running → done
 *   195–285 L3 圆桌交锋
 *   300–345 L4 策略定稿
 *   360–390 L5 并行产出
 */

/** Graph-run length (last worker done). Stills freeze inside this window. */
export const GRAPH_SCENE_FRAMES = 390;

export const SCHED: Record<string, SchedEntry> = {
  research_user: { enter: 18, run: 120, done: 180 },
  research_comp: { enter: 24, run: 120, done: 180 },
  research_tech: { enter: 30, run: 120, done: 180 },
  moderator: { enter: 48, run: 195, done: 285 },
  view_growth: { enter: 54, run: 195, done: 285 },
  view_steady: { enter: 60, run: 195, done: 285 },
  view_user: { enter: 66, run: 195, done: 285 },
  view_cost: { enter: 72, run: 195, done: 285 },
  strategy: { enter: 84, run: 300, done: 345 },
  spec_product: { enter: 102, run: 360, done: 390 },
  spec_tech: { enter: 108, run: 360, done: 390 },
};

export const INPUT_ENTER = 0;
export const CAPTAIN_ENTER = 116;

export const STREAM: Record<string, string> = {
  research_user: "已锁定 3 类核心用户，高频痛点集中在协作断点与上下文丢失……",
  research_comp: "竞品 A 偏协作、B 偏自动化，均未打通真正的多 Agent 团队……",
  research_tech: "Agent 编排正从单体走向团队化，DAG 调度与共享工作区成主线……",
  moderator:
    "本轮焦点：押注差异化 vs 控风险稳健，请各方就成本与时机正面回应……",
  view_growth:
    "主张直接押注 Agent 团队协作这一差异点，抢占竞品尚未覆盖的空白……",
  view_steady: "反对一次性押注，主张先验证关键风险、按里程碑稳健迭代落地……",
  view_user: "强调先把协作断点这一最痛场景的核心闭环体验打磨透，再谈扩张……",
  view_cost: "提醒算力与维护成本、落地复杂度，要求每一步都留有可回退的安全边界……",
  strategy: "综合各方圆桌论点：先验证关键风险，再分阶段放大投入，锁定团队协作主线……",
  spec_product: "拆出 6 个里程碑，首版聚焦团队协作主链路……",
  spec_tech: "定下 DAG 波调度 + 共享工作区 + 团队便签的技术骨架……",
};

export const DURATION_MS: Record<string, number> = {
  research_user: 5200,
  research_comp: 6100,
  research_tech: 4800,
  moderator: 8400,
  view_growth: 7200,
  view_steady: 6800,
  view_user: 6400,
  view_cost: 5900,
  strategy: 5600,
  spec_product: 4200,
  spec_tech: 5400,
};

export const DEBATE_AXIS: DebateAxisSpec = {
  topNodeId: "view_growth",
  botNodeId: "view_cost",
  centerXOffset: 105,
  centerYOffset: 66,
  activeFrom: 186,
  activeTo: 292,
};
