/**
 * 合回 Diff 评审弹层会话（§7.6）——与 ImportToCloud 同构：store 开关 + Host。
 */

import type { ReviewRow } from "@/lib/handoff-review";
import { create } from "zustand";

export type MergeLandingReviewSession = {
  conversationId: string;
  rootId: string;
  rootName: string;
  rows: ReviewRow[];
  bytesByPath: Record<string, string>;
  skippedOversized: string[];
  skippedUnreadable: string[];
  truncated: boolean;
};

export type CloseResult =
  | { applied: true; summaryLabel: string }
  | { applied: false; reason: "cancelled" | "closed" | "busy" };

type State = {
  session: MergeLandingReviewSession | null;
  /** 等待用户关弹层 / 应用完毕。 */
  _waiter: ((r: CloseResult) => void) | null;
  openSession: (session: MergeLandingReviewSession) => Promise<CloseResult>;
  resolveApplied: (summaryLabel: string) => void;
  resolveCancelled: () => void;
  close: () => void;
};

export const useMergeLandingReviewStore = create<State>((set, get) => ({
  session: null,
  _waiter: null,
  openSession: (session) => {
    // C1：已有会话则硬拒，禁止顶掉旧 waiter / 换 session（对标 importToCloudJob.begin）。
    const { session: cur, _waiter } = get();
    if (cur || _waiter) {
      return Promise.resolve({ applied: false, reason: "busy" as const });
    }
    return new Promise<CloseResult>((resolve) => {
      set({ session, _waiter: resolve });
    });
  },
  resolveApplied: (summaryLabel) => {
    const { _waiter } = get();
    set({ session: null, _waiter: null });
    _waiter?.({ applied: true, summaryLabel });
  },
  resolveCancelled: () => {
    const { _waiter } = get();
    set({ session: null, _waiter: null });
    _waiter?.({ applied: false, reason: "cancelled" });
  },
  close: () => {
    const { _waiter } = get();
    set({ session: null, _waiter: null });
    _waiter?.({ applied: false, reason: "closed" });
  },
}));
