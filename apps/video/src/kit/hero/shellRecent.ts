import type { RecentConversation } from "../../core/chrome/PromoShell";
import { DEMO_TASK } from "./demo";

/** Sidebar recent list for stills / Studio that reuse the sample task title. */
export const HERO_SHELL_RECENT: RecentConversation[] = [
  { title: DEMO_TASK, active: true, running: true },
  { title: "竞品调研与定价策略对比", active: false, running: false },
  { title: "周报：本周进展与下周计划", active: false, running: false },
  { title: "给新功能起一个好名字", active: false, running: false },
];
