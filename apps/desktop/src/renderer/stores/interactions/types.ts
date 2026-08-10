import type { ResumeDeferredBusyReason } from "@/lib/resumeDeferred";
import type { ResumeOrigin } from "@/stores/pausedTurns";
import type { InteractionStatus } from "@/types/interactionExt";
import {
  INTERACTION_ID_FIELD,
  INTERACTION_SUBMIT_PATH,
  type InteractionKind,
  type InteractionSubmitPath,
  kindFromRequiredEvent,
  kindFromResolvedEvent,
} from "./registry";

// Re-export registry surface so existing `@/stores/interactions` imports keep working.
export {
  INTERACTION_ID_FIELD,
  INTERACTION_SUBMIT_PATH,
  kindFromRequiredEvent,
  kindFromResolvedEvent,
  type InteractionKind,
  type InteractionSubmitPath,
};

/** Cold-path kinds that paint the durable ResumePrompt card. */
export const COLD_RESUME_KINDS = [
  "ask_user",
  "plan_review",
  "team_preview",
] as const satisfies readonly InteractionKind[];

export type ColdResumeKind = (typeof COLD_RESUME_KINDS)[number];

export function isColdResumeKind(
  kind: InteractionKind,
): kind is ColdResumeKind {
  return (COLD_RESUME_KINDS as readonly string[]).includes(kind);
}

/** One user-facing interaction card in the unified store (方案 §3.2). */
export interface InteractionEntry {
  id: string;
  kind: InteractionKind;
  status: InteractionStatus;
  conversationId: string;
  messageId: string;
  /** Original `*_required` (or question_posted) wire payload. */
  payload: Record<string, unknown>;
  /** Settlement payload when status is resolved (kind-specific). */
  resolution?: Record<string, unknown>;
  /**
   * Live transport that delivered this entry (SSE `ctx.source`).
   * Cold submit prefers this for sidecar vs server routing; pausedTurns remains
   * recovery/`setForConversation` shell + origin fallback.
   */
  origin?: ResumeOrigin;
  /**
   * Cold resume accepted while slot busy (EPHEMERAL `resume_deferred`).
   * Settlement is locked — UI keeps submitting and hides cancel-改口.
   */
  resumeDeferred?: { busyReason: ResumeDeferredBusyReason };
}

/**
 * 「等你」判定（侧栏灯 / 全局提醒共用语义）：这条交互是否正把执行阻塞在用户身上。
 *
 * - 热阻塞 kind（approval / delegation_authorization / escalation）pending 或
 *   submitting 时为真——live turn 挂在卡上等答复。
 * - escalation 例外：`awaiting === "ceo"` 由 CEO 仲裁，用户无需行动 → 不算。
 * - 冷 kind（ask_user / plan_review / team_preview）恒为假：可操作权威是
 *   InteractionStore cold pending（ResumePrompt）；侧栏灯由调用方另订 pausedTurns
 *   recovery 壳或 cold pending，不经本函数。
 * - question_posted（非阻塞提问）团队没停 → 不算。
 */
export function isAwaitingUserEntry(entry: InteractionEntry): boolean {
  if (entry.status !== "pending" && entry.status !== "submitting") return false;
  if (INTERACTION_SUBMIT_PATH[entry.kind] !== "hot") return false;
  if (entry.kind === "escalation" && entry.payload.awaiting === "ceo") {
    return false;
  }
  return true;
}

export function idFromRequiredPayload(
  kind: InteractionKind,
  payload: Record<string, unknown>,
): string | null {
  const field = INTERACTION_ID_FIELD[kind];
  const raw = payload[field];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

export function idFromResolvedPayload(
  kind: InteractionKind,
  payload: Record<string, unknown>,
): string | null {
  return idFromRequiredPayload(kind, payload);
}
