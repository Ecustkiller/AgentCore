import { create } from "zustand";

/**
 * Cross-tree 回填 channel for the chat composer (`MessageInput`).
 *
 * The composer holds its draft in local state, but a non-blocking ask card
 * ({@link NonBlockingAskCard}) lives deep in the message list and needs to drop the
 * user's pick into that draft when an option chip is clicked. This tiny store is the
 * one-way pipe: the card calls {@link fill}, the composer subscribes to {@link token}
 * (a monotonic counter so even an identical text re-triggers) and applies the text.
 *
 * `append` (the default) adds the text as a new line after any existing draft so a
 * user can stack answers to several questions; `replace` overwrites. The store keeps
 * NO per-conversation key — the composer is a singleton bound to the active
 * conversation, and a stale fill is harmless (the user reviews before sending).
 */
interface ComposerDraftState {
  /** Monotonic; bumped on every {@link fill} so the consumer's effect always runs. */
  token: number;
  /** The text to drop into the composer on the latest fill. */
  text: string;
  mode: "append" | "replace";
  /** 回填 the composer with `text` (default: append as a new line). */
  fill: (text: string, mode?: "append" | "replace") => void;
}

export const useComposerDraftStore = create<ComposerDraftState>((set) => ({
  token: 0,
  text: "",
  mode: "append",
  fill: (text, mode = "append") =>
    set((s) => ({ token: s.token + 1, text, mode })),
}));
