import { notifyInfo } from "@/lib/toast";

/**
 * 已收下的插话赶不上下一工具步 → 升成排队（``degraded_from=steer``）。
 * 持久插话气泡会切到 queued，但 QueuedTurnsBar 看不出「赶不上了」，
 * 须 toast 说明降级原因；禁伪装「已插入」；文案勿与五态徽标矛盾。
 */
export function notifySteerDegradedToQueue(): void {
  notifyInfo("当前无法插入，已改为排队，将在本回合结束后发送");
}
