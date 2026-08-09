/**
 * Mobile cold-path Interaction store (ask_user / plan_review / team_preview).
 *
 * Live paint authority for ResumeCard — mirrors desktop InteractionStore cold
 * semantics (upsertRequired tombstone / new-host replace / stamp rekey+bind)
 * without importing desktop (cross-platform-frontend.mdc).
 */
import { useSyncExternalStore } from "react";

export const COLD_RESUME_KINDS = [
  "ask_user",
  "plan_review",
  "team_preview",
] as const;

export type ColdResumeKind = (typeof COLD_RESUME_KINDS)[number];

export type ColdInteractionStatus =
  | "pending"
  | "submitting"
  | "resolved"
  | "orphaned";

export interface ColdInteractionEntry {
  id: string;
  kind: ColdResumeKind;
  status: ColdInteractionStatus;
  conversationId: string;
  /** Durable host message id once stamped; may be client turn id or empty pre-stamp. */
  messageId: string;
  payload: Record<string, unknown>;
  resolution?: Record<string, unknown>;
}

export function isColdResumeKind(kind: string): kind is ColdResumeKind {
  return (COLD_RESUME_KINDS as readonly string[]).includes(kind);
}

const REQUIRED_EVENT: Record<string, ColdResumeKind> = {
  checkpoint_required: "ask_user",
  plan_review_required: "plan_review",
  team_preview_required: "team_preview",
};

const RESOLVED_EVENT: Record<string, ColdResumeKind> = {
  checkpoint_resolved: "ask_user",
  plan_review_resolved: "plan_review",
  team_preview_resolved: "team_preview",
};

const ID_FIELD: Record<ColdResumeKind, string> = {
  ask_user: "checkpoint_id",
  plan_review: "checkpoint_id",
  team_preview: "checkpoint_id",
};

export function kindFromColdRequiredEvent(
  eventType: string,
): ColdResumeKind | null {
  return REQUIRED_EVENT[eventType] ?? null;
}

export function kindFromColdResolvedEvent(
  eventType: string,
): ColdResumeKind | null {
  return RESOLVED_EVENT[eventType] ?? null;
}

export function idFromColdRequiredPayload(
  kind: ColdResumeKind,
  payload: Record<string, unknown>,
): string | null {
  const raw = payload[ID_FIELD[kind]];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

function mapCopy(
  src: Map<string, ColdInteractionEntry>,
): Map<string, ColdInteractionEntry> {
  return new Map(src);
}

type Listener = () => void;

let byId = new Map<string, ColdInteractionEntry>();
const listeners = new Set<Listener>();

function emit(): void {
  for (const l of listeners) l();
}

function setById(next: Map<string, ColdInteractionEntry>): void {
  byId = next;
  emit();
}

export function getColdInteractionSnapshot(): Map<
  string,
  ColdInteractionEntry
> {
  return byId;
}

export function subscribeColdInteractions(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React hook — re-render when cold Interaction entries change. */
export function useColdInteractions(): Map<string, ColdInteractionEntry> {
  return useSyncExternalStore(
    subscribeColdInteractions,
    getColdInteractionSnapshot,
    getColdInteractionSnapshot,
  );
}

export function getColdInteraction(
  id: string,
): ColdInteractionEntry | undefined {
  return byId.get(id);
}

export function listColdPending(
  conversationId: string,
  kinds: readonly ColdResumeKind[] = COLD_RESUME_KINDS,
): ColdInteractionEntry[] {
  const want = new Set<string>(kinds);
  const out: ColdInteractionEntry[] = [];
  for (const entry of byId.values()) {
    if (entry.conversationId !== conversationId) continue;
    if (entry.status !== "pending" && entry.status !== "submitting") continue;
    if (!want.has(entry.kind)) continue;
    out.push(entry);
  }
  return out;
}

/**
 * Upsert from `*_required` SSE / recovery hydrate.
 * Tombstone rules (desktop parity):
 * - resolved stub (empty payload) → live required wins
 * - cold kind + new host messageId → replace settled for round-2+
 * - same host settled replay → keep tombstone
 */
export function upsertColdRequired(input: {
  kind: ColdResumeKind;
  conversationId: string;
  messageId: string;
  payload: Record<string, unknown>;
  status?: ColdInteractionStatus;
}): void {
  const id = idFromColdRequiredPayload(input.kind, input.payload);
  if (!id) return;
  const prev = byId.get(id);
  if (prev && (prev.status === "resolved" || prev.status === "orphaned")) {
    const forcedPending = input.status === "pending";
    const resolvedStub =
      prev.status === "resolved" &&
      (!prev.payload || Object.keys(prev.payload).length === 0);
    const coldNewHost =
      prev.status === "resolved" &&
      Boolean(input.messageId) &&
      Boolean(prev.messageId) &&
      input.messageId !== prev.messageId;
    if (!forcedPending && !resolvedStub && !coldNewHost) {
      return;
    }
  }
  if (prev && (prev.status === "pending" || prev.status === "submitting")) {
    let patched = prev;
    if (input.messageId && !prev.messageId) {
      patched = { ...patched, messageId: input.messageId };
    }
    if (patched !== prev) {
      const next = mapCopy(byId);
      next.set(id, patched);
      setById(next);
    }
    return;
  }
  const next = mapCopy(byId);
  next.set(id, {
    id,
    kind: input.kind,
    status: input.status ?? "pending",
    conversationId: input.conversationId,
    messageId: input.messageId || "",
    payload: input.payload,
  });
  setById(next);
}

export function markColdResolved(input: {
  kind: ColdResumeKind;
  id: string;
  resolution?: Record<string, unknown>;
}): void {
  const prev = byId.get(input.id);
  const next = mapCopy(byId);
  if (prev) {
    next.set(input.id, {
      ...prev,
      status: "resolved",
      resolution: input.resolution ?? prev.resolution,
    });
  } else {
    next.set(input.id, {
      id: input.id,
      kind: input.kind,
      status: "resolved",
      conversationId: "",
      messageId: "",
      payload: {},
      resolution: input.resolution,
    });
  }
  setById(next);
}

export function markColdOrphaned(
  id: string,
  opts?: {
    kind?: ColdResumeKind;
    conversationId?: string;
    messageId?: string;
  },
): void {
  const prev = byId.get(id);
  if (prev?.status === "resolved") return;
  const next = mapCopy(byId);
  if (prev) {
    next.set(id, { ...prev, status: "orphaned" });
    setById(next);
    return;
  }
  if (!opts?.kind) return;
  next.set(id, {
    id,
    kind: opts.kind,
    status: "orphaned",
    conversationId: opts.conversationId ?? "",
    messageId: opts.messageId ?? "",
    payload: {},
  });
  setById(next);
}

/** Re-key after message_start stamps the server id onto a client turn bubble. */
export function rekeyColdMessageId(
  fromMessageId: string,
  toMessageId: string,
): void {
  if (!fromMessageId || !toMessageId || fromMessageId === toMessageId) return;
  let changed = false;
  const next = mapCopy(byId);
  for (const [id, entry] of byId) {
    if (entry.messageId !== fromMessageId) continue;
    next.set(id, { ...entry, messageId: toMessageId });
    changed = true;
  }
  if (changed) setById(next);
}

/**
 * Bind unbound cold pending (empty messageId) to a newly stamped server id
 * so ResumeCard paints without waiting for recovery refresh.
 */
export function bindEmptyColdMessageId(
  conversationId: string,
  toMessageId: string,
): void {
  if (!conversationId || !toMessageId) return;
  let changed = false;
  const next = mapCopy(byId);
  for (const [id, entry] of byId) {
    if (entry.conversationId !== conversationId) continue;
    if (entry.messageId) continue;
    if (entry.status !== "pending" && entry.status !== "submitting") continue;
    next.set(id, { ...entry, messageId: toMessageId });
    changed = true;
  }
  if (changed) setById(next);
}

export function clearColdInteractions(conversationId?: string): void {
  if (conversationId === undefined) {
    setById(new Map());
    return;
  }
  const next = new Map<string, ColdInteractionEntry>();
  for (const [id, entry] of byId) {
    if (entry.conversationId !== conversationId) next.set(id, entry);
  }
  setById(next);
}

/** Apply a cold required / resolved / orphaned wire event. */
export function applyColdInteractionWireEvent(
  eventType: string,
  payload: Record<string, unknown>,
  conversationId: string,
  messageId: string,
): boolean {
  if (eventType === "interaction_orphaned") {
    const id =
      typeof payload.interaction_id === "string"
        ? payload.interaction_id
        : null;
    const kind =
      typeof payload.kind === "string" && isColdResumeKind(payload.kind)
        ? payload.kind
        : undefined;
    if (id && kind) {
      markColdOrphaned(id, { kind, conversationId, messageId });
      return true;
    }
    if (id && !kind) {
      // Non-cold orphan — ignore (hot kinds stay on fold / PauseCard).
      return false;
    }
    return false;
  }

  const requiredKind = kindFromColdRequiredEvent(eventType);
  if (requiredKind) {
    upsertColdRequired({
      kind: requiredKind,
      conversationId,
      messageId,
      payload,
    });
    return true;
  }

  const resolvedKind = kindFromColdResolvedEvent(eventType);
  if (resolvedKind) {
    const id = idFromColdRequiredPayload(resolvedKind, payload);
    if (id) {
      markColdResolved({
        kind: resolvedKind,
        id,
        resolution: payload,
      });
    }
    return true;
  }

  return false;
}
