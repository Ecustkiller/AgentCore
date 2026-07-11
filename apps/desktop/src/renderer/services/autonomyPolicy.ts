import { api } from "@/services/api";
import type { SidecarAutonomyPolicy } from "@shared/sidecar-contract";

/**
 * 桌面侧的「当前自主度」获取器（安全权限与治理 §三 AutonomyPolicy 三档）。
 *
 * 云回合由服务端自己读 `users.autonomy_policy`；sidecar 本地回合没有用户库，须由桌面把
 * 当前设置随每次 startTurn / resume 送达本地引擎（与 `inferenceToken` 的按回合刷新姿态
 * 一致——策略可在会话中途改，initialize 快照会过期）。
 *
 * 缓存策略：首次使用时 GET 一次并缓存；设置页改动经 `setCachedAutonomyPolicy` 同步刷新，
 * 无需每回合都打一次 API。取不到（离线 / 会话过期）返回 `undefined`——sidecar 沿用其当前
 * 值（初始默认 first_grant），与服务端回退一致。
 */

let cached: SidecarAutonomyPolicy | null = null;

export async function resolveAutonomyPolicy(): Promise<
  SidecarAutonomyPolicy | undefined
> {
  if (cached) return cached;
  try {
    const d = await api.get<{ policy: SidecarAutonomyPolicy }>(
      "/v1/users/me/autonomy",
    );
    cached = d.policy;
    return cached;
  } catch (err) {
    console.error("[sidecar] 取自主度设置失败", err);
    return undefined;
  }
}

/** 设置页读到 / 保存了新档位时同步进缓存，使下一个本地回合立即用上。 */
export function setCachedAutonomyPolicy(policy: SidecarAutonomyPolicy): void {
  cached = policy;
}

/** 丢弃缓存（登出时调），使下次回合在新账号下重新拉取。 */
export function clearAutonomyPolicyCache(): void {
  cached = null;
}
