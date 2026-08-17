import type { AskAssumption } from "@/types/events";

/** Bottom-bar face for a non-blocking hanging question (not a freeze). */
export const HANGING_QUESTION_CAPTION = "有事等你，团队照跑";

/** CTA — not 「提交」, which is the paused checkpoint word. */
export const HANGING_QUESTION_CTA = "答复";

export const HANGING_QUESTION_DEFAULT_HINT = "没回之前按这个继续";

/**
 * Honest copy when the CEO turn already ended and the team is detached-running.
 * New-turn reply cannot rejoin that live graph (known seam; 本刀不修).
 */
export const HANGING_QUESTION_DETACHED_HINT =
  "答了会作为新消息发出；后台还在跑的那张图这轮接不上";

export function formatHangingDefault(
  assumptions: readonly AskAssumption[] | undefined,
): string | null {
  if (!assumptions?.length) return null;
  const parts = assumptions
    .map((a) => {
      const label = a.label?.trim() ?? "";
      const value = a.value?.trim() ?? "";
      if (label && value) return `${label}：${value}`;
      return value || label;
    })
    .filter(Boolean);
  if (parts.length === 0) return null;
  return `${HANGING_QUESTION_DEFAULT_HINT}：${parts.join("；")}`;
}
