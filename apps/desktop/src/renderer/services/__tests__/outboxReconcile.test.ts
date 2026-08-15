import { EXECUTION_HARVEST_ORIGIN } from "@/lib/executionHarvest";
import { useConversationStore } from "@/stores/conversation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadLatestWindow = vi.fn(
  async (_conversationId: string, _opts?: { softRefresh?: boolean }) => true,
);
vi.mock("@/services/messages", () => ({
  loadLatestWindow: (
    conversationId: string,
    opts?: { softRefresh?: boolean },
  ) => loadLatestWindow(conversationId, opts),
}));

vi.mock("@/hooks/useConversations", () => ({
  patchConversationCache: vi.fn(),
}));

import { applyOutboxSynced } from "../outboxReconcile";
import {
  beginLocalConversationStream,
  hasLocalConversationStream,
  resetStreamOwnershipForTests,
} from "../turns/streamOwnership";

const CID = "c-harvest";

function harvestAck(
  over: Partial<Parameters<typeof applyOutboxSynced>[0]> = {},
) {
  return {
    conversationId: CID,
    userMessageId: "u-harvest",
    cloudUserMessageId: "u-harvest",
    assistantMessageId: "m-harvest",
    title: null,
    origin: EXECUTION_HARVEST_ORIGIN,
    harvestKind: "completed",
    ...over,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  loadLatestWindow.mockClear();
  resetStreamOwnershipForTests();
  useConversationStore.setState({
    currentConversationId: CID,
    byId: {},
    sliceLruOrder: [],
    pendingFocus: null,
  });
});

afterEach(() => {
  vi.useRealTimers();
  resetStreamOwnershipForTests();
});

describe("applyOutboxSynced harvest write-back", () => {
  it("softRefresh after harvest write-back", () => {
    applyOutboxSynced(harvestAck());
    expect(loadLatestWindow).toHaveBeenCalledTimes(1);
    expect(loadLatestWindow).toHaveBeenCalledWith(CID, { softRefresh: true });
  });

  it("defers softRefresh until the later local stream releases (no forceRelease)", () => {
    const release = beginLocalConversationStream(CID);
    expect(hasLocalConversationStream(CID)).toBe(true);

    applyOutboxSynced(harvestAck());

    expect(hasLocalConversationStream(CID)).toBe(true);
    expect(loadLatestWindow).not.toHaveBeenCalled();

    release();
    expect(loadLatestWindow).toHaveBeenCalledTimes(1);
    expect(loadLatestWindow).toHaveBeenCalledWith(CID, { softRefresh: true });
  });

  it("ordinary write-back does not softRefresh", () => {
    applyOutboxSynced(
      harvestAck({
        userMessageId: "u-user",
        cloudUserMessageId: "u-user",
        origin: null,
        harvestKind: null,
      }),
    );
    expect(loadLatestWindow).not.toHaveBeenCalled();
  });
});
