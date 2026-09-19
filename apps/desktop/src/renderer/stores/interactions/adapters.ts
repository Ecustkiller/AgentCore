import { parseCheckpointIntent } from "@/lib/checkpointIntent";
import type { CheckpointDisplay } from "@/stores/conversation/types";
import type { PendingResume, ResumeOrigin } from "@/stores/pausedTurns";
import type { AskQuestion } from "@/types/events";
import type { InteractionKind } from "@/types/interactionExt";
import { mapEntryResolution } from "./mapResolution";
import { useInteractionStore } from "./store";
import {
  COLD_RESUME_KINDS,
  type InteractionEntry,
  isColdResumeKind,
} from "./types";

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function arr<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

/** View-model for a pending approval card. */
export interface ApprovalView {
  approvalId: string;
  conversationId: string;
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  resolving: boolean;
}

export function entryToCheckpoint(e: InteractionEntry): CheckpointDisplay {
  const p = e.payload;
  const settlement = mapEntryResolution(e);
  return {
    id: e.id,
    question: str(p.question),
    questions: arr<AskQuestion>(p.questions),
    intent: parseCheckpointIntent(p.intent),
    ...settlement,
    selected:
      settlement.status === "resolved"
        ? arr<string>(e.resolution?.selected)
        : [],
  };
}

export function entryToApproval(e: InteractionEntry): ApprovalView {
  const p = e.payload;
  return {
    approvalId: e.id,
    conversationId: e.conversationId,
    toolCallId: str(p.tool_call_id, e.id),
    toolName: str(p.tool_name),
    arguments: (p.arguments ?? {}) as Record<string, unknown>,
    resolving: e.status === "submitting",
  };
}

function matchesMessage(
  e: InteractionEntry,
  conversationId: string,
  messageId: string,
): boolean {
  if (e.conversationId !== conversationId) return false;
  if (!e.messageId || !messageId) return true;
  return e.messageId === messageId;
}

export function listMessageEntries(
  conversationId: string,
  messageId: string,
  kinds?: InteractionKind[],
): InteractionEntry[] {
  const out: InteractionEntry[] = [];
  for (const e of useInteractionStore.getState().byId.values()) {
    if (!matchesMessage(e, conversationId, messageId)) continue;
    if (kinds && !kinds.includes(e.kind)) continue;
    out.push(e);
  }
  return out;
}

export function messageCheckpoints(
  conversationId: string,
  messageId: string,
): CheckpointDisplay[] {
  return listMessageEntries(conversationId, messageId, ["ask_user"]).map(
    entryToCheckpoint,
  );
}

/**
 * Kickoff-card grant list retired — backend `command=auto` already granted.
 * Approval prompts no longer hide based on a team_preview tools roster.
 */
export function isToolGranted(
  _conversationId: string,
  _toolName: string,
): boolean {
  return false;
}

/**
 * Build a ResumePrompt view-model from an InteractionStore cold pending entry.
 * Caller supplies the stamped resume key + user context + routing origin.
 */
export function entryToColdResume(
  e: InteractionEntry,
  opts: {
    resumeMessageId: string;
    userMessage: string;
    userMessageId: string;
    origin: ResumeOrigin;
  },
): PendingResume | null {
  if (!isColdResumeKind(e.kind)) return null;
  if (e.kind !== "ask_user") return null;
  const cp = entryToCheckpoint(e);
  return {
    messageId: opts.resumeMessageId,
    conversationId: e.conversationId,
    checkpointId: e.id,
    userMessage: opts.userMessage,
    userMessageId: opts.userMessageId,
    origin: opts.origin,
    kind: e.kind,
    steps: [],
    pending: [],
    question: cp.question,
    questions: cp.questions,
    intent: cp.intent,
  };
}

/** Cold pending entries for a conversation (ResumePrompt authority). */
export function listColdPendingEntries(
  conversationId: string,
): InteractionEntry[] {
  return useInteractionStore
    .getState()
    .listPending(conversationId, COLD_RESUME_KINDS);
}
