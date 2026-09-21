import type { SchedEntry } from "../../core/graph/graphState";

/*
 * Default fanout wave schedule. Frame evaluation lives in core/graph/graphState.
 *
 * Scene-local frames @30fps:
 *   0–90    entrance cascade
 *   90–210  three workers running (staggered done)
 *   210–270 workers settled (PayoffStill lights the CEO)
 */

export const GRAPH_SCENE_FRAMES = 270;

export const SCHED: Record<string, SchedEntry> = {
  pricing: { enter: 18, run: 90, done: 180 },
  pain: { enter: 24, run: 90, done: 195 },
  channel: { enter: 30, run: 90, done: 210 },
};

export const INPUT_ENTER = 0;
export const CAPTAIN_ENTER = 72;

export const STREAM: Record<string, string> = {
  pricing: "三家竞品价带已对齐，订阅档差主要在席位数……",
  pain: "高频痛点集中在看不见谁在干活、上下文对不上……",
  channel: "现有渠道能覆盖试用，缺一条给决策者看的协作过程……",
};

export const DURATION_MS: Record<string, number> = {
  pricing: 5200,
  pain: 6100,
  channel: 4800,
};
