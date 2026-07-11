import { uiGet, uiSet } from "@/lib/uiStorage";
import type { DebateModel, DebateSideModel } from "../model";

/** 辩论室剧本主列布局：并排对照 vs 上下单栏（长文阅读）。 */
export type DebateArenaLayout = "split" | "stack";

const STORAGE_KEY = "debate-arena-layout";

/** 赛事页外层容器宽度（记分牌 + 剧本主列共用）。 */
export const DEBATE_ARENA_PAGE_MAX = "max-w-7xl";

export function loadDebateArenaLayout(): DebateArenaLayout {
  return uiGet<string>(STORAGE_KEY) === "stack" ? "stack" : "split";
}

export function saveDebateArenaLayout(layout: DebateArenaLayout): void {
  uiSet(STORAGE_KEY, layout);
}

/** 仅正反 2 方、有 pro/con 语义身份时可并排。 */
export function canUseSplitLayout(model: DebateModel): boolean {
  if (model.form !== "debate") return false;

  if (model.sides?.length === 2) {
    const keys = new Set(model.sides.map((s) => s.key));
    if (keys.has("pro") && keys.has("con")) return true;
  }

  // 进行中 2 方正反：liveTwoSideRounds 会给 side 打上 pro/con stance
  return model.rounds.some((r) =>
    r.sides.some((s) => s.stance === "pro" || s.stance === "con"),
  );
}

export function partitionProCon(sides: DebateSideModel[]): {
  pro: DebateSideModel | undefined;
  con: DebateSideModel | undefined;
} {
  const pro = sides.find((s) => s.stance === "pro" || s.sideKey === "pro");
  const con = sides.find((s) => s.stance === "con" || s.sideKey === "con");
  return { pro, con };
}
