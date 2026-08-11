import { notifyInfo } from "@/lib/toast";

/**
 * steer 不可注入 → 降级 queue（``degraded_from=steer``）。
 * 持久插话气泡会切到 queued，但 QueuedTurnsBar  alone 看不出「插队失败已降级」，
 * 须 toast 说明降级原因；禁伪装「已插入」；文案勿与五态徽标矛盾。
 */
export function notifySteerDegradedToQueue(): void {
  notifyInfo("当前无法插入，已改为排队，将在本回合结束后发送");
}
