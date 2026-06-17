import type { components } from "@/types/api.generated";
import type {
  AskAssumption,
  AskQuestion,
  AskStyleOption,
  PlanReviewPending,
  PlanReviewStep,
} from "@/types/events";
import { create } from "zustand";

type PausedTurnSummary = components["schemas"]["PausedTurnSummary"];
type SuspensionKind = components["schemas"]["SuspensionKind"];

/**
 * A turn that paused at a plan_review / ask_user checkpoint, was DURABLY persisted,
 * then lost its live SSE — client disconnect / server restart (结构化挂起 2b). On
 * conversation reopen the client lists these (GET /paused) and offers 继续 / 调整 /
 * 停止, each driving POST .../resume to continue the turn on a fresh stream.
 *
 * Mirrors the approvals store: one entry per paused turn, tagged with its
 * `conversationId` so several conversations can each hold their own pending
 * resumes; the card above the composer renders only the active conversation's.
 *
 * `kind` selects the card the {@link ResumePrompt} renders: plan_review reviews the
 * finished `steps` + gated `pending`; ask_user re-asks the unified card content
 * (`question` + `assumptions` / `questions` / `styleOptions`). The unused set is
 * empty for the other kind.
 */
export interface PendingResume {
  /** The paused turn's assistant message_id — the resume key, and the id the
   * resumed reply reuses when it finally persists. */
  messageId: string;
  conversationId: string;
  checkpointId: string;
  /** Which suspend point this turn paused at — drives the resume card variant. */
  kind: SuspensionKind;
  /** The original user request that started the paused turn (for context). */
  userMessage: string;
  /** plan_review: the just-completed checkpoint step(s) under review. */
  steps: PlanReviewStep[];
  /** plan_review: the downstream nodes gated behind the pause. */
  pending: PlanReviewPending[];
  /** ask_user: the framing / opening line (always shown). */
  question: string;
  /** ask_user: optional supporting background for the question. */
  context: string;
  /** ask_user: 起步计划 read-only chips (低影响决策，开场常见). */
  assumptions: AskAssumption[];
  /** ask_user: the askable items (途中岔路通常一个；开场可多个). */
  questions: AskQuestion[];
  /** ask_user: 风格预设 (视觉类产物才有). */
  styleOptions: AskStyleOption[];
}

/** `steps` / `pending` arrive as loose JSON dicts (backend ``list[dict]``); map
 * them to the known display shapes, tolerating any missing field. */
const toSteps = (raw: PausedTurnSummary["steps"]): PlanReviewStep[] =>
  (raw ?? []).map((s) => ({
    run_id: String(s.run_id ?? ""),
    role: String(s.role ?? ""),
    summary: String(s.summary ?? ""),
  }));

const toPending = (raw: PausedTurnSummary["pending"]): PlanReviewPending[] =>
  (raw ?? []).map((p) => ({
    run_id: String(p.run_id ?? ""),
    role: String(p.role ?? ""),
  }));

/** ask_user rich fields arrive as loose JSON dicts (backend ``list[dict]``); map
 * them to the typed display shapes the unified card reads, tolerating missing keys.
 * The backend already normalized + capped + id'd them (ask_user._normalize_*). */
const toAssumptions = (
  raw: PausedTurnSummary["assumptions"],
): AskAssumption[] =>
  (raw ?? []).map((a, i) => ({
    id: String(a.id ?? `a${i}`),
    label: String(a.label ?? ""),
    value: String(a.value ?? ""),
  }));

const toQuestions = (raw: PausedTurnSummary["questions"]): AskQuestion[] =>
  (raw ?? []).map((q, i) => ({
    id: String(q.id ?? `q${i}`),
    prompt: String(q.prompt ?? ""),
    kind: q.kind === "text" ? "text" : "choice",
    options: Array.isArray(q.options) ? q.options.map(String) : [],
    multiple: Boolean(q.multiple),
    default: String(q.default ?? ""),
  }));

const toStyleOptions = (
  raw: PausedTurnSummary["style_options"],
): AskStyleOption[] =>
  (raw ?? []).map((s, i) => ({
    id: String(s.id ?? `s${i}`),
    label: String(s.label ?? ""),
  }));

interface PausedTurnState {
  pending: PendingResume[];
  /** Replace one conversation's pending resumes (from GET /paused on reopen),
   * leaving other conversations' entries untouched. */
  setForConversation: (
    conversationId: string,
    summaries: PausedTurnSummary[],
  ) => void;
  /** Drop one paused turn (it is being / has been resumed). Idempotent. */
  remove: (messageId: string) => void;
  /** Forget pending resumes. Pass a conversationId to drop only that
   * conversation's; omit for a full reset (e.g. logout / tests). */
  clear: (conversationId?: string) => void;
}

export const usePausedTurnStore = create<PausedTurnState>((set) => ({
  pending: [],

  setForConversation: (conversationId, summaries) =>
    set((state) => ({
      pending: [
        ...state.pending.filter((p) => p.conversationId !== conversationId),
        ...summaries.map((s) => ({
          messageId: s.message_id,
          conversationId,
          checkpointId: s.checkpoint_id,
          kind: s.kind,
          userMessage: s.user_message ?? "",
          steps: toSteps(s.steps),
          pending: toPending(s.pending),
          question: s.question ?? "",
          context: s.context ?? "",
          assumptions: toAssumptions(s.assumptions),
          questions: toQuestions(s.questions),
          styleOptions: toStyleOptions(s.style_options),
        })),
      ],
    })),

  remove: (messageId) =>
    set((state) => ({
      pending: state.pending.filter((p) => p.messageId !== messageId),
    })),

  clear: (conversationId) =>
    set((state) =>
      conversationId === undefined
        ? { pending: [] }
        : {
            pending: state.pending.filter(
              (p) => p.conversationId !== conversationId,
            ),
          },
    ),
}));
