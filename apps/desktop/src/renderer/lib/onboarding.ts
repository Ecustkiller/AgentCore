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
export type ContextualTipId = "inline_team_graph";

const TIP_KEY_PREFIX = "onboarding:tip:";

export function tipStorageKey(id: ContextualTipId): string {
  return `${TIP_KEY_PREFIX}${id}`;
}

/** 草稿页空态三态。 */
export type DraftEmptyKind = "needs_key" | "starter_chips" | "returning";

export type OnboardingEligibilityInput = {
  /** BYOK / 平台代付 / 免费档已可用（见 {@link hasModelAccess}）。 */
  hasModelAccess: boolean;
  /**
   * 免费档生效时仍展示首启一次，以便接入屏提供「先用免费额度开始」；
   * 点该 CTA 或「跳过」会写 skipped，之后不再自动出现。
   */
  freeTierActive?: boolean;
  conversationCount: number;
  skipped: boolean;
};

/**
 * 是否自动展示整页首启流程。
 * 配完 key / 已有对话 / 已跳过 → 永不再自动出现。
 * 免费档用户例外：在 skipped 之前仍进首启（价值屏 → 接入屏免费路径）。
 */
export function shouldShowOnboarding(
  input: OnboardingEligibilityInput,
): boolean {
  if (input.skipped) return false;
  if (input.conversationCount > 0) return false;
  if (input.freeTierActive) return true;
  if (input.hasModelAccess) return false;
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
 * 空草稿态是否把对话输入框与引导合成视口中央块。
 * 「（草稿态 ∨ 已落库但确定 0 消息）∧ 无消息 ∧ 已有模型接入」；needs_key 保持底栏输入 +
 * 中央 CTA，不居中输入框。
 *
 * `isDraft`（`conversationId === null`）是主闸门：已落库的对话切换时会先经历一个
 * 「消息尚未异步加载完」的空窗口，若只看 `!hasMessages` 会把它误判为居中欢迎态，
 * 导致输入框「先弹到中间、加载完再飞回底栏」的跳动。
 *
 * `knownEmptyPersisted` 覆盖「演示磁带 prepare 绑定的空会话」这类**已落库却确定 0 消息**的场景：
 * 它由会话元数据 `messageCount === 0` 推出——确定为空、无需等历史异步加载，故不会重蹈上述抖动
 * （有消息的会话 messageCount>0、历史加载中未入列表的会话元数据查不到，二者皆不命中）。
 */
export function shouldCenterDraftComposer(input: {
  isDraft: boolean;
  hasMessages: boolean;
  hasModelAccess: boolean;
  knownEmptyPersisted?: boolean;
}): boolean {
  if (!input.hasModelAccess || input.hasMessages) return false;
  return input.isDraft || input.knownEmptyPersisted === true;
}

/**
 * 账号是否已具备发消息的模型接入。
 * `configured` 覆盖 BYOK；`billing_mode === "platform"` 覆盖平台代付；
 * `free_tier_active` 覆盖无 key 的每月免费档（契约字段，单一状态源）。
 */
export function hasModelAccess(
  status:
    | {
        configured?: boolean;
        billing_mode?: string | null;
        free_tier_active?: boolean;
      }
    | null
    | undefined,
): boolean {
  if (!status) return false;
  if (status.configured) return true;
  if (status.billing_mode === "platform") return true;
  return status.free_tier_active === true;
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
