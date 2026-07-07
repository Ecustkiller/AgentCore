/** Town resident roster — mirrors backend scenario spawn locations (M2: 10 residents). */

export const TOWN_AGENT_IDS = [
  "lin",
  "chen",
  "zhao",
  "wang",
  "liu",
  "sun",
  "zhang",
  "yang",
  "wu",
  "xu",
] as const;

export type TownAgentId = (typeof TOWN_AGENT_IDS)[number];

export const TOWN_AGENT_NAMES: Record<TownAgentId, string> = {
  lin: "林小梅",
  chen: "陈大爷",
  zhao: "赵老板",
  wang: "王婶",
  liu: "刘警官",
  sun: "孙大厨",
  zhang: "张静",
  yang: "杨护士",
  wu: "吴师傅",
  xu: "徐秘书",
};

/** Home region per agent (authoritative backend contract). */
export const TOWN_AGENT_HOME: Record<TownAgentId, string> = {
  lin: "面包店",
  chen: "公园",
  zhao: "市场",
  wang: "市场",
  liu: "广场",
  sun: "餐厅",
  zhang: "镇政厅",
  yang: "住宅区",
  wu: "市场",
  xu: "镇政厅",
};

/** Small XZ nudge so co-located NPCs don't stack (visual only). */
export const TOWN_SPAWN_OFFSET: Record<TownAgentId, { x: number; z: number }> = {
  lin: { x: 0, z: 0 },
  chen: { x: -2, z: 1.5 },
  zhao: { x: -2.5, z: 1.5 },
  wang: { x: 2.5, z: -1.5 },
  liu: { x: 0, z: 0 },
  sun: { x: 0, z: 0 },
  zhang: { x: 0, z: 0 },
  xu: { x: 0, z: 0 },
  wu: { x: 3, z: -2 },
  yang: { x: 2.5, z: -1.5 },
};
