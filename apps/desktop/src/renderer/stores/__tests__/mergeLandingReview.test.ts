import {
  type MergeLandingReviewSession,
  useMergeLandingReviewStore,
} from "@/stores/mergeLandingReview";
import { beforeEach, describe, expect, it } from "vitest";

function session(id: string): MergeLandingReviewSession {
  return {
    conversationId: id,
    rootId: `root-${id}`,
    rootName: `landing-${id}`,
    rows: [],
    bytesByPath: {},
    skippedOversized: [],
    skippedUnreadable: [],
    truncated: false,
  };
}

describe("mergeLandingReview store", () => {
  beforeEach(() => {
    useMergeLandingReviewStore.setState({ session: null, _waiter: null });
  });

  it("second openSession returns busy and keeps the first session", async () => {
    const first = useMergeLandingReviewStore
      .getState()
      .openSession(session("a"));
    const firstSession = useMergeLandingReviewStore.getState().session;
    expect(firstSession?.conversationId).toBe("a");

    const second = await useMergeLandingReviewStore
      .getState()
      .openSession(session("b"));
    expect(second).toEqual({ applied: false, reason: "busy" });
    expect(useMergeLandingReviewStore.getState().session).toBe(firstSession);
    expect(useMergeLandingReviewStore.getState().session?.conversationId).toBe(
      "a",
    );

    // 旧 waiter 仍可正常收口，未被顶掉。
    useMergeLandingReviewStore.getState().resolveCancelled();
    await expect(first).resolves.toEqual({
      applied: false,
      reason: "cancelled",
    });
    expect(useMergeLandingReviewStore.getState().session).toBeNull();
  });

  it("openSession succeeds after the previous session closes", async () => {
    const first = useMergeLandingReviewStore
      .getState()
      .openSession(session("a"));
    useMergeLandingReviewStore.getState().close();
    await expect(first).resolves.toEqual({ applied: false, reason: "closed" });

    const second = useMergeLandingReviewStore
      .getState()
      .openSession(session("b"));
    expect(useMergeLandingReviewStore.getState().session?.conversationId).toBe(
      "b",
    );
    useMergeLandingReviewStore.getState().resolveApplied("1 已写入");
    await expect(second).resolves.toEqual({
      applied: true,
      summaryLabel: "1 已写入",
    });
  });
});
