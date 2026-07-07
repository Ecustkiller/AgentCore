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

export const workspaceKeys = {
  all: ["workspaces"] as const,
  /** The user's workspaces (= folders, cloud + local) for the 文件 hub rail
   * (`GET /v1/workspaces`). */
  list: ["workspaces", "list"] as const,
};

export const llmKeyKeys = {
  all: ["llm-key"] as const,
  status: ["llm-key", "status"] as const,
};
