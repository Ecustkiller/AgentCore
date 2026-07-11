/**
 * 新用户首启体验 — 纯客户端决策与本地持久化键。
 *
 * 判定不依赖服务端状态 / DB：未配 LLM key 且 0 对话 → 可展示首启；
 * 跳过标志、情境提示 seen 一律走 {@link uiStorage}。
 */

import { uiGet, uiSet } from "@/lib/uiStorage";

/** 本地：用户跳过了一次性首启流程。 */
export const ONBOARDING_SKIPPED_KEY = "onboarding:skipped";

/** 情境提示 id（总量 ≤3，各只出现一次）。 */
export type ContextualTipId = "inline_team_graph" | "decision_card";

const TIP_KEY_PREFIX = "onboarding:tip:";

export function tipStorageKey(id: ContextualTipId): string {
  return `${TIP_KEY_PREFIX}${id}`;
}

/** 草稿页空态三态。 */
export type DraftEmptyKind = "needs_key" | "starter_chips" | "returning";

export type OnboardingEligibilityInput = {
  /** BYOK / 平台模型已可用（`LlmKeyStatus.configured` 或 billing_mode=platform）。 */
  hasModelAccess: boolean;
  conversationCount: number;
  skipped: boolean;
};

/**
 * 是否自动展示整页首启流程。
 * 配完 key / 已有对话 / 已跳过 → 永不再自动出现。
 */
export function shouldShowOnboarding(
  input: OnboardingEligibilityInput,
): boolean {
  if (input.skipped) return false;
  if (input.hasModelAccess) return false;
  if (input.conversationCount > 0) return false;
  return true;
}

export type DraftEmptyInput = {
  hasModelAccess: boolean;
  conversationCount: number;
};

/** 草稿空态（无消息）三态选择。首个对话产生后 starter chips 永久消失。 */
export function resolveDraftEmptyKind(input: DraftEmptyInput): DraftEmptyKind {
  if (!input.hasModelAccess) return "needs_key";
  if (input.conversationCount === 0) return "starter_chips";
  return "returning";
}

/**
 * 账号是否已具备发消息的模型接入。
 * `configured` 覆盖 BYOK；`billing_mode === "platform"` 覆盖平台代付路径
 *（本产品主路是 BYOK，但状态机仍尊重已有 platform 模式以免误拦）。
 */
export function hasModelAccess(
  status:
    | {
        configured?: boolean;
        billing_mode?: string | null;
      }
    | null
    | undefined,
): boolean {
  if (!status) return false;
  if (status.configured) return true;
  return status.billing_mode === "platform";
}

/** 首启任务建议 — 天然触发多 Agent 分工；点击仅填入输入框。 */
export const STARTER_TASK_CHIPS: readonly string[] = [
  "分三路并行调研：竞品定价、用户痛点、渠道策略，各自产出一页摘要后由你汇总成决策简报。",
  "请拉一位写手起草产品介绍初稿，一位审校挑逻辑漏洞，一位整理成对外可用的发布说明。",
  "帮我规划一次周末短途旅行：一人查交通与住宿，一人排景点与用餐，最后合成一份可执行行程。",
] as const;

export function isOnboardingSkipped(): boolean {
  return uiGet<boolean>(ONBOARDING_SKIPPED_KEY) === true;
}

export function markOnboardingSkipped(): void {
  uiSet(ONBOARDING_SKIPPED_KEY, true);
}

export function hasSeenTip(id: ContextualTipId): boolean {
  return uiGet<boolean>(tipStorageKey(id)) === true;
}

export function markTipSeen(id: ContextualTipId): void {
  uiSet(tipStorageKey(id), true);
}

/** 是否应展示某条情境提示（未 seen 才展示）。 */
export function shouldShowTip(id: ContextualTipId): boolean {
  return !hasSeenTip(id);
}
