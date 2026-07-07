import type {
  CheckpointRequiredPayload,
  CheckpointResolvedPayload,
  PlanReviewRequiredPayload,
  PlanReviewResolvedPayload,
  QuestionPostedPayload,
  SSEEvent,
} from "@/types/events";
import type {
  CheckpointDisplay,
  NonBlockingAskDisplay,
  PlanReviewDisplay,
} from "./types";

export function checkpointsFromEvents(events: SSEEvent[]): CheckpointDisplay[] {
  const byId = new Map<string, CheckpointDisplay>();
  const order: string[] = [];
  for (const e of events) {
    if (e.type === "checkpoint_required") {
      const p = e.payload as CheckpointRequiredPayload;
      if (!byId.has(p.checkpoint_id)) order.push(p.checkpoint_id);
      byId.set(p.checkpoint_id, {
        id: p.checkpoint_id,
        question: p.question,
        context: p.context ?? "",
        assumptions: p.assumptions ?? [],
        questions: p.questions ?? [],
        styleOptions: p.style_options ?? [],
        intent: p.intent ?? "decision",
        status: "pending",
        decision: null,
        note: "",
        selected: [],
      });
    } else if (e.type === "checkpoint_resolved") {
      const p = e.payload as CheckpointResolvedPayload;
      const cur = byId.get(p.checkpoint_id);
      if (cur) {
        cur.status = "resolved";
        cur.decision = p.decision;
        cur.note = p.note ?? "";
        cur.selected = p.selected ?? [];
      }
    }
  }
  return order.map((id) => byId.get(id) as CheckpointDisplay);
}

export function nonBlockingAsksFromEvents(
  events: SSEEvent[],
): NonBlockingAskDisplay[] {
  const byId = new Map<string, NonBlockingAskDisplay>();
  const order: string[] = [];
  for (const e of events) {
    if (e.type !== "question_posted") continue;
    const p = e.payload as QuestionPostedPayload;
    if (byId.has(p.ask_id)) continue;
    order.push(p.ask_id);
    byId.set(p.ask_id, {
      id: p.ask_id,
      question: p.question,
      context: p.context ?? "",
      assumptions: p.assumptions ?? [],
      questions: p.questions ?? [],
      styleOptions: p.style_options ?? [],
    });
  }
  return order.map((id) => byId.get(id) as NonBlockingAskDisplay);
}

export function planReviewsFromEvents(events: SSEEvent[]): PlanReviewDisplay[] {
  const byId = new Map<string, PlanReviewDisplay>();
  const order: string[] = [];
  for (const e of events) {
    if (e.type === "plan_review_required") {
      const p = e.payload as PlanReviewRequiredPayload;
      if (!byId.has(p.checkpoint_id)) order.push(p.checkpoint_id);
      byId.set(p.checkpoint_id, {
        id: p.checkpoint_id,
        steps: p.steps ?? [],
        pending: p.pending ?? [],
        status: "pending",
        decision: null,
        note: "",
      });
    } else if (e.type === "plan_review_resolved") {
      const p = e.payload as PlanReviewResolvedPayload;
      const cur = byId.get(p.checkpoint_id);
      if (cur) {
        cur.status = "resolved";
        cur.decision = p.decision;
        cur.note = p.note ?? "";
      }
    }
  }
  return order.map((id) => byId.get(id) as PlanReviewDisplay);
}
