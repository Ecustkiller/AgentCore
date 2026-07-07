import type { SimTickSnapshot } from "@/services/simulation/api";
import { REGION_POSITIONS } from "@/simulation/regionPositions";
import {
  applyTickSnapshot,
  useSimulationUiStore,
} from "@/simulation/store/simulationStore";

const PREVIEW_RUN_ID = "preview-town";

const PREVIEW_SNAPSHOT: SimTickSnapshot = {
  tick: 1,
  hour: 10,
  agents: {
    lin: {
      agent_id: "lin",
      name: "林小梅",
      role: "面包师",
      location: "市场",
      position: REGION_POSITIONS.市场,
      activity: "摆摊",
      mood: 0.3,
      goal: "卖出今日面包",
      money: 100,
      last_thought: "早市人不少。",
    },
    zhang: {
      agent_id: "zhang",
      name: "张建国",
      role: "镇长",
      location: "镇政厅",
      position: REGION_POSITIONS.镇政厅,
      activity: "办公",
      mood: 0.1,
      goal: "审议预算",
      money: 100,
      last_thought: "本周要开议会。",
    },
    liu: {
      agent_id: "liu",
      name: "刘芳",
      role: "教师",
      location: "广场",
      position: REGION_POSITIONS.广场,
      activity: "散步",
      mood: 0.5,
      goal: "联系家长",
      money: 100,
      last_thought: "天气不错。",
    },
  },
  event_log: [],
};

/** Offline preview for shoot / CI — no backend or SSE. */
export function seedTownPreview(search = ""): void {
  const params = new URLSearchParams(search);
  const storm = params.get("storm") === "1";
  const festival = params.get("festival") === "1";
  const snapshot: SimTickSnapshot = {
    ...PREVIEW_SNAPSHOT,
    modifiers: {
      market_price_multiplier: 1,
      storm_active: storm,
      festival_active: festival,
      square_attraction_boost: festival ? 0.5 : 0,
    },
  };

  const store = useSimulationUiStore.getState();
  store.resetSession();
  store.setRun({
    id: PREVIEW_RUN_ID,
    scenario: "town",
    tick: snapshot.tick,
    hour: snapshot.hour,
    status: "active",
  });
  store.cacheTickSnapshot(snapshot.tick, snapshot);
  applyTickSnapshot(snapshot);
}

export function isTownPreviewMode(search: string): boolean {
  return new URLSearchParams(search).get("preview") === "1";
}
