/** 幕授权来源 → 图上角标/锚点副文案（authorized_by）。 */
import type { ActAuthorizedBy } from "@/stores/execution";

const LABELS: Record<ActAuthorizedBy, string> = {
  auto: "自动开辩",
};

export function actAuthorizedByLabel(
  authorizedBy: ActAuthorizedBy | string | null | undefined,
): string | null {
  if (authorizedBy === "auto") {
    return LABELS[authorizedBy];
  }
  return null;
}

/** 幕分带主标签：标题 + 可选授权角标。 */
export function formatActBandLabel(
  title: string | null | undefined,
  actId: string,
  authorizedBy?: ActAuthorizedBy | string | null,
): string {
  const base = title?.trim() || actId;
  const auth = actAuthorizedByLabel(authorizedBy);
  return auth ? `${base} · ${auth}` : base;
}
