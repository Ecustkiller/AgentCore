import type { ResumeDeferredBusyReason } from "@/lib/resumeDeferred";
import type { ResumeOrigin } from "@/stores/pausedTurns";
import type {
  InteractionKind,
  InteractionStatus,
} from "@/types/interactionExt";
import { create } from "zustand";
import {
  type InteractionEntry,
  idFromRequiredPayload,
  idFromResolvedPayload,
  isColdResumeKind,
  kindFromRequiredEvent,
  kindFromResolvedEvent,
} from "./types";

interface InteractionState {
  /** All interactions keyed by id (8 kinds). */
  byId: Map<string, InteractionEntry>;
  /** Upsert from a `*_required` / question_posted SSE or recovery/journal hydrate. */
  upsertRequired: (input: {
    kind: InteractionKind;
    conversationId: string;
    messageId: string;
    payload: Record<string, unknown>;
    /** Force status (e.g. recovery hydrate → pending; journal resolved skip). */
    status?: InteractionStatus;
    /** Live SSE transport (`ctx.source`); omit on journal/recovery hydrate. */
    origin?: ResumeOrigin;
  }) => void;
  /** Mark resolved from a `*_resolved` SSE / journal. */
  markResolved: (input: {
    kind: InteractionKind;
    id: string;
    resolution?: Record<string, unknown>;
  }) => void;
  /**
   * Mark orphaned (SSE interaction_orphaned or local sidecar death).
   * When id is unknown (SSE reorder: orphaned before required), `opts.kind`
   * builds a terminal stub so a later required cannot resurrect a false pending.
   */
  markOrphaned: (
    id: string,
    opts?: {
      kind?: InteractionKind;
      conversationId?: string;
      messageId?: string;
    },
  ) => void;
  /** Flip pending → submitting (returns false if not pending). */
  beginSubmit: (id: string) => boolean;
  /**
   * Cold resume accepted while slot busy (EPHEMERAL `resume_deferred`).
   * Keeps / forces submitting so ResumePrompt stays busy until stream settles.
   */
  markResumeDeferred: (input: {
    conversationId: string;
    messageId: string;
    busyReason: ResumeDeferredBusyReason;
  }) => void;
  /** Re-open after a failed submit (not 410). */
  reopen: (id: string) => void;
  /** Drop one entry (legacy remove paths / tests). */
  remove: (id: string) => void;
  /**
   * Forget interactions at a turn / conversation boundary.
   * Prefer {@link orphanConversation} for sidecar death (灰态) over wipe.
   */
  clear: (conversationId?: string) => void;
  /** Sidecar / process death: flip hot pending cards to orphaned 灰态. */
  orphanConversation: (conversationId: string, hotOnly?: boolean) => void;
  /**
   * Replace this conversation's pending set from recovery hydrate.
   * Empty snapshots are authoritative only when the turn is not live: an early
   * empty `/recovery` must not wipe journal/SSE pending that is still valid
   * while the turn is running (or locally still active). Non-empty snapshots
   * always replace. Resolved/orphan empties with `liveRunning: false` clear.
   */
  hydratePending: (
    conversationId: string,
    entries: Array<{
      kind: InteractionKind;
      id: string;
      messageId: string;
      payload: Record<string, unknown>;
      origin?: ResumeOrigin;
    }>,
    opts?: { liveRunning?: boolean },
  ) => void;
  /**
   * Re-key entry.messageId after message_start stamps the server id
   * (cold entries may have been upserted against the client bubble id).
   */
  rekeyMessageId: (fromMessageId: string, toMessageId: string) => void;
  /**
   * Bind unbound cold pending (empty messageId) to a newly stamped server
   * message id so live ResumePrompt paints without waiting for hard refresh.
   */
  bindEmptyMessageId: (conversationId: string, toMessageId: string) => void;
  get: (id: string) => InteractionEntry | undefined;
  listForConversation: (conversationId: string) => InteractionEntry[];
  listPending: (
    conversationId: string,
    kinds?: InteractionKind[],
  ) => InteractionEntry[];
}

function mapCopy(
  src: Map<string, InteractionEntry>,
): Map<string, InteractionEntry> {
  return new Map(src);
}

export const useInteractionStore = create<InteractionState>((set, get) => ({
  byId: new Map(),

  upsertRequired: ({
    kind,
    conversationId,
    messageId,
    payload,
    status,
    origin,
  }) => {
    const id = idFromRequiredPayload(kind, payload);
    if (!id) return;
    set((state) => {
      const prev = state.byId.get(id);
      if (prev && (prev.status === "resolved" || prev.status === "orphaned")) {
        // Explicit force (recovery hydrate → pending) may replace terminal.
        const forcedPending = status === "pending";
        // Resolved stub (resolved SSE before required): empty prior payload —
        // a live required is authoritative and must paint.
        const resolvedStub =
          prev.status === "resolved" &&
          (!prev.payload || Object.keys(prev.payload).length === 0);
        // Cold: same checkpoint id on a new host message ⇒ new occurrence
        // (re-delivery of a settled card keeps the same messageId).
        const coldNewHost =
          prev.status === "resolved" &&
          isColdResumeKind(kind) &&
          Boolean(messageId) &&
          Boolean(prev.messageId) &&
          messageId !== prev.messageId;
        if (!forcedPending && !resolvedStub && !coldNewHost) {
          return {};
        }
      }
      // Idempotent re-delivery: keep the first pending/submitting payload.
      if (prev && (prev.status === "pending" || prev.status === "submitting")) {
        let patched = prev;
        if (messageId && !prev.messageId) {
          patched = { ...patched, messageId };
        }
        if (origin && !prev.origin) {
          patched = { ...patched, origin };
        }
        if (patched !== prev) {
          const next = mapCopy(state.byId);
          next.set(id, patched);
          return { byId: next };
        }
        return {};
      }
      const next = mapCopy(state.byId);
      next.set(id, {
        id,
        kind,
        status: status ?? "pending",
        conversationId,
        messageId: messageId || "",
        payload,
        ...(origin ? { origin } : {}),
      });
      return { byId: next };
    });
  },

  markResolved: ({ kind, id, resolution }) => {
    set((state) => {
      const prev = state.byId.get(id);
      const next = mapCopy(state.byId);
      if (prev) {
        next.set(id, {
          ...prev,
          status: "resolved",
          resolution: resolution ?? prev.resolution,
          resumeDeferred: undefined,
        });
      } else {
        // Resolved without a prior required (reload edge) — keep a stub so UI
        // can show 已答 if something still looks up by id.
        next.set(id, {
          id,
          kind,
          status: "resolved",
          conversationId: "",
          messageId: "",
          payload: {},
          resolution,
        });
      }
      return { byId: next };
    });
  },

  markOrphaned: (id, opts) => {
    set((state) => {
      const prev = state.byId.get(id);
      if (prev?.status === "resolved") return {};
      const next = mapCopy(state.byId);
      if (prev) {
        next.set(id, { ...prev, status: "orphaned" });
        return { byId: next };
      }
      // Orphaned without a prior required (SSE reorder) — terminal stub so a
      // later `*_required` cannot resurrect a false pending (see upsertRequired).
      const kind = opts?.kind;
      if (!kind) return {};
      next.set(id, {
        id,
        kind,
        status: "orphaned",
        conversationId: opts?.conversationId ?? "",
        messageId: opts?.messageId ?? "",
        payload: {},
      });
      return { byId: next };
    });
  },

  beginSubmit: (id) => {
    const prev = get().byId.get(id);
    if (!prev || prev.status !== "pending") return false;
    set((state) => {
      const cur = state.byId.get(id);
      if (!cur || cur.status !== "pending") return {};
      const next = mapCopy(state.byId);
      next.set(id, { ...cur, status: "submitting" });
      return { byId: next };
    });
    return true;
  },

  markResumeDeferred: ({ conversationId, messageId, busyReason }) => {
    set((state) => {
      const next = mapCopy(state.byId);
      let changed = false;
      for (const [id, entry] of state.byId) {
        if (entry.conversationId !== conversationId) continue;
        if (!isColdResumeKind(entry.kind)) continue;
        if (entry.status !== "pending" && entry.status !== "submitting")
          continue;
        if (entry.messageId && entry.messageId !== messageId) continue;
        next.set(id, {
          ...entry,
          status: "submitting",
          messageId: entry.messageId || messageId,
          resumeDeferred: { busyReason },
        });
        changed = true;
      }
      return changed ? { byId: next } : {};
    });
  },

  reopen: (id) => {
    set((state) => {
      const prev = state.byId.get(id);
      if (!prev || prev.status !== "submitting") return {};
      const next = mapCopy(state.byId);
      next.set(id, {
        ...prev,
        status: "pending",
        resumeDeferred: undefined,
      });
      return { byId: next };
    });
  },

  remove: (id) => {
    set((state) => {
      if (!state.byId.has(id)) return {};
      const next = mapCopy(state.byId);
      next.delete(id);
      return { byId: next };
    });
  },

  clear: (conversationId) => {
    set((state) => {
      if (conversationId === undefined) return { byId: new Map() };
      const next = new Map<string, InteractionEntry>();
      for (const [id, entry] of state.byId) {
        if (entry.conversationId !== conversationId) next.set(id, entry);
      }
      return { byId: next };
    });
  },

  orphanConversation: (conversationId, hotOnly = true) => {
    const hot: InteractionKind[] = [
      "approval",
      "delegation_authorization",
      "escalation",
    ];
    set((state) => {
      let changed = false;
      const next = mapCopy(state.byId);
      for (const [id, entry] of state.byId) {
        if (entry.conversationId !== conversationId) continue;
        if (entry.status !== "pending" && entry.status !== "submitting")
          continue;
        if (hotOnly && !hot.includes(entry.kind)) continue;
        next.set(id, { ...entry, status: "orphaned" });
        changed = true;
      }
      return changed ? { byId: next } : {};
    });
  },

  hydratePending: (conversationId, entries, opts) => {
    set((state) => {
      if (entries.length === 0 && opts?.liveRunning) {
        // Early empty recovery while the turn is still live — keep journal/SSE
        // pending (aligns with e2e mock guard against wipe-on-race).
        for (const entry of state.byId.values()) {
          if (
            entry.conversationId === conversationId &&
            (entry.status === "pending" || entry.status === "submitting")
          ) {
            return {};
          }
        }
      }
      const next = mapCopy(state.byId);
      // Drop prior pending/submitting for this conversation (recovery is authoritative
      // for the live pending set); keep resolved/orphaned history.
      for (const [id, entry] of state.byId) {
        if (
          entry.conversationId === conversationId &&
          (entry.status === "pending" || entry.status === "submitting")
        ) {
          next.delete(id);
        }
      }
      for (const e of entries) {
        next.set(e.id, {
          id: e.id,
          kind: e.kind,
          status: "pending",
          conversationId,
          messageId: e.messageId,
          payload: e.payload,
          ...(e.origin ? { origin: e.origin } : {}),
        });
      }
      return { byId: next };
    });
  },

  rekeyMessageId: (fromMessageId, toMessageId) => {
    if (!fromMessageId || !toMessageId || fromMessageId === toMessageId) return;
    set((state) => {
      let changed = false;
      const next = mapCopy(state.byId);
      for (const [id, entry] of state.byId) {
        if (entry.messageId !== fromMessageId) continue;
        next.set(id, { ...entry, messageId: toMessageId });
        changed = true;
      }
      return changed ? { byId: next } : {};
    });
  },

  /**
   * Bind cold pending entries that arrived before message_start stamped a
   * durable resume key (empty messageId) to the new server message id so
   * ResumePrompt can paint as soon as the stamp lands.
   */
  bindEmptyMessageId: (conversationId, toMessageId) => {
    if (!conversationId || !toMessageId) return;
    set((state) => {
      let changed = false;
      const next = mapCopy(state.byId);
      for (const [id, entry] of state.byId) {
        if (entry.conversationId !== conversationId) continue;
        if (entry.messageId) continue;
        if (entry.status !== "pending" && entry.status !== "submitting")
          continue;
        if (!isColdResumeKind(entry.kind)) continue;
        next.set(id, { ...entry, messageId: toMessageId });
        changed = true;
      }
      return changed ? { byId: next } : {};
    });
  },

  get: (id) => get().byId.get(id),

  listForConversation: (conversationId) => {
    const out: InteractionEntry[] = [];
    for (const entry of get().byId.values()) {
      if (entry.conversationId === conversationId) out.push(entry);
    }
    return out;
  },

  listPending: (conversationId, kinds) => {
    const out: InteractionEntry[] = [];
    for (const entry of get().byId.values()) {
      if (entry.conversationId !== conversationId) continue;
      if (entry.status !== "pending" && entry.status !== "submitting") continue;
      if (kinds && !kinds.includes(entry.kind)) continue;
      out.push(entry);
    }
    return out;
  },
}));

/** Apply a required/resolved/orphaned wire event into the store. */
export function applyInteractionWireEvent(
  eventType: string,
  payload: Record<string, unknown>,
  conversationId: string,
  messageId: string,
  origin?: ResumeOrigin,
): boolean {
  const store = useInteractionStore.getState();

  if (eventType === "interaction_orphaned") {
    const id =
      typeof payload.interaction_id === "string"
        ? payload.interaction_id
        : null;
    const kind =
      typeof payload.kind === "string"
        ? (payload.kind as InteractionKind)
        : undefined;
    if (id) {
      store.markOrphaned(id, { kind, conversationId, messageId });
    }
    return true;
  }

  const requiredKind = kindFromRequiredEvent(eventType);
  if (requiredKind) {
    store.upsertRequired({
      kind: requiredKind,
      conversationId,
      messageId,
      payload,
      ...(origin ? { origin } : {}),
    });
    return true;
  }

  const resolvedKind = kindFromResolvedEvent(eventType);
  if (resolvedKind) {
    const id = idFromResolvedPayload(resolvedKind, payload);
    if (id) store.markResolved({ kind: resolvedKind, id, resolution: payload });
    return true;
  }

  return false;
}

/** Hydrate InteractionStore from a message's journal events (reload path). */
export function hydrateInteractionsFromJournal(
  conversationId: string,
  messageId: string,
  events: Array<{ type: string; payload: unknown }>,
): void {
  for (const ev of events) {
    applyInteractionWireEvent(
      ev.type,
      (ev.payload ?? {}) as Record<string, unknown>,
      conversationId,
      messageId,
    );
  }
}
