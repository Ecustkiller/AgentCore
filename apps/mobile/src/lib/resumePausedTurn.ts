/**
 * Option A · resume identity (mobile): reuse the paused assistant surface by
 * server `message_id` — flip the same turn to streaming and pump resume SSE into
 * it. Never push a second assistant turn (dual TeamView).
 *
 * Mirrors desktop `resumePausedAssistant` / `runResume` intent. Events are reset
 * to an identity `message_start` seed so resume bootstrap can re-seed the journal
 * without double-folding (same idea as reconnect clearing before attach replay).
 */

export type ResumeTurnLike = {
  id: string;
  userText: string | null;
  events: ReadonlyArray<{ type: string; payload?: unknown }>;
};

export type ResumeHistoryLike = {
  id: string;
  role: string;
};

export type PrepareResumePausedTurnResult<
  TTurn extends ResumeTurnLike,
  THist extends ResumeHistoryLike,
> = {
  turnId: string;
  turns: TTurn[];
  history: THist[] | null;
  /** Where the reused surface came from (`fallback` = empty slot, desktop parity). */
  source: "live" | "history" | "fallback";
};

/** Identity-only seed so the turn stays findable after clear + fold keeps same mid. */
export function resumeIdentitySeed(
  messageId: string,
): [
  { type: "message_start"; payload: { message_id: string }; timestamp: string },
] {
  return [
    {
      type: "message_start",
      payload: { message_id: messageId },
      timestamp: "",
    },
  ];
}

export function messageIdFromTurnEvents(
  events: ReadonlyArray<{ type: string; payload?: unknown }>,
): string | null {
  for (const e of events) {
    if (e.type !== "message_start") continue;
    const mid = (e.payload as { message_id?: string } | undefined)?.message_id;
    if (typeof mid === "string" && mid) return mid;
  }
  return null;
}

function stripHistoryAssistant<THist extends ResumeHistoryLike>(
  history: THist[] | null,
  messageId: string,
): THist[] | null {
  if (!history) return history;
  const next = history.filter(
    (m) => !(m.role === "assistant" && m.id === messageId),
  );
  return next.length === history.length ? history : next;
}

/**
 * Merge list identity for「开做」: one assistant turn for `messageId`, ready for
 * resume SSE. User bubbles stay in history / prior turns (`userText: null`).
 */
export function prepareResumePausedTurn<
  TTurn extends ResumeTurnLike,
  THist extends ResumeHistoryLike,
>(opts: {
  messageId: string;
  turns: TTurn[];
  history: THist[] | null;
  /** Used only when neither live turns nor history has the paused assistant. */
  newTurnId: string;
}): PrepareResumePausedTurnResult<TTurn, THist> {
  const { messageId, turns, history, newTurnId } = opts;
  if (!messageId) {
    const fresh = {
      id: newTurnId,
      userText: null,
      events: [],
    } as unknown as TTurn;
    return {
      turnId: newTurnId,
      turns: [...turns, fresh],
      history,
      source: "fallback",
    };
  }

  const seed = resumeIdentitySeed(messageId) as unknown as TTurn["events"];
  const liveIdx = turns.findIndex(
    (t) => messageIdFromTurnEvents(t.events) === messageId,
  );
  if (liveIdx >= 0) {
    const next = turns.slice();
    const prev = next[liveIdx];
    next[liveIdx] = { ...prev, events: seed };
    return {
      turnId: prev.id,
      turns: next,
      history: stripHistoryAssistant(history, messageId),
      source: "live",
    };
  }

  const histIdx =
    history?.findIndex((m) => m.role === "assistant" && m.id === messageId) ??
    -1;
  if (history && histIdx >= 0) {
    const promoted = {
      id: messageId,
      userText: null,
      events: seed,
    } as unknown as TTurn;
    return {
      turnId: messageId,
      turns: [...turns, promoted],
      history: stripHistoryAssistant(history, messageId),
      source: "history",
    };
  }

  const fresh = {
    id: newTurnId,
    userText: null,
    events: seed,
  } as unknown as TTurn;
  return {
    turnId: newTurnId,
    turns: [...turns, fresh],
    history: stripHistoryAssistant(history, messageId),
    source: "fallback",
  };
}
