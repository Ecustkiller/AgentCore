/**
 * Central registry of React Query keys. Keeping every key here (rather than
 * inline string arrays at each call site) lets a mutation invalidate exactly the
 * queries it affects without guessing the shape, and makes the cached REST
 * surface discoverable in one place as more resources migrate onto React Query.
 */
export const conversationKeys = {
  all: ["conversations"] as const,
  /** Folders + conversations in one trip (`GET /v1/conversations/grouped`). */
  grouped: ["conversations", "grouped"] as const,
  /** Archived conversations (`GET /v1/conversations?archived=true`) — the
   * on-demand「已归档」view, separate from the live grouped cache. */
  archived: ["conversations", "archived"] as const,
};
