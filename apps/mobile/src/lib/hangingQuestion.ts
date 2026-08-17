import { type NonBlockingAsk, extractAsks } from "@/protocol/fold";
import type {
  QuestionResolvedPayload,
  SSEEvent,
} from "@agentcore/contract-types";

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
  assumptions: NonBlockingAsk["assumptions"] | undefined,
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

/**
 * Apply `question_resolved` from a list onto already-posted asks.
 * `extractAsks` only settles when posted+resolved share a list; another list
 * can carry only the resolved event (live vs history, turn A vs turn B).
 */
function applyResolvedFromEvents(
  byId: Map<string, NonBlockingAsk>,
  events: readonly SSEEvent[],
): void {
  for (const ev of events) {
    if (ev.type !== "question_resolved") continue;
    const p = ev.payload as QuestionResolvedPayload;
    const id = typeof p.ask_id === "string" ? p.ask_id : "";
    const prev = byId.get(id);
    if (!prev || prev.status !== "pending") continue;
    byId.set(id, {
      ...prev,
      status: "resolved",
      settlement: p.status,
      ...(p.answer ? { answer: p.answer } : {}),
      ...(p.note ? { note: p.note } : {}),
    });
  }
}

/** Conversation-wide pending hanging questions. No cap. Any list can settle an id. */
export function collectPendingHangingQuestions(
  eventLists: readonly SSEEvent[][],
): NonBlockingAsk[] {
  const byId = new Map<string, NonBlockingAsk>();
  const order: string[] = [];
  for (const events of eventLists) {
    for (const ask of extractAsks(events)) {
      const prev = byId.get(ask.id);
      if (!prev) {
        order.push(ask.id);
        byId.set(ask.id, ask);
        continue;
      }
      if (prev.status === "pending" && ask.status !== "pending") {
        byId.set(ask.id, ask);
      }
    }
  }
  // Second pass: resolved-only lists never produce an extractAsks row.
  for (const events of eventLists) {
    applyResolvedFromEvents(byId, events);
  }
  return order
    .map((id) => byId.get(id))
    .filter((ask): ask is NonBlockingAsk => ask?.status === "pending");
}

/**
 * Detached hint for the current live team graph only.
 * Do not pass history windows — a past `execution_detached` must not light
 * a current hanging question.
 */
export function eventsHaveExecutionDetached(
  currentGraphEvents: readonly SSEEvent[],
): boolean {
  return currentGraphEvents.some((ev) => ev.type === "execution_detached");
}
