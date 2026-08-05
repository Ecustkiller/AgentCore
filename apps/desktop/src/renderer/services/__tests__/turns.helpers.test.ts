import {
  beginTurnPreflight,
  enterTurnStreaming,
  getRuntime,
  getTurnPhase,
  useConversationStore,
} from "@/stores/conversation";
import { beforeEach, describe, expect, it } from "vitest";
import {
  finalizeGeneratingIfNeeded,
  finalizeHonestStopAbort,
} from "../turns/helpers";

const CID = "conv-honest-stop-abort";

beforeEach(() => {
  useConversationStore.setState({ currentConversationId: CID, byId: {} });
  useConversationStore.getState().switchConversation(CID);
});

describe("finalizeHonestStopAbort", () => {
  it("stopping + generating → stopped 且清 isGenerating", () => {
    beginTurnPreflight(CID);
    enterTurnStreaming(CID);
    useConversationStore.getState().createAssistantMessage(CID);
    useConversationStore.getState().setTurnPhase("stopping", CID);
    expect(getTurnPhase(CID)).toBe("stopping");
    expect(getRuntime(CID).isGenerating).toBe(true);

    finalizeHonestStopAbort(CID);

    expect(getTurnPhase(CID)).toBe("stopped");
    expect(getRuntime(CID).isGenerating).toBe(false);
  });

  it("非 stopping 只清 generating（对齐 finalizeGeneratingIfNeeded）", () => {
    beginTurnPreflight(CID);
    enterTurnStreaming(CID);
    useConversationStore.getState().createAssistantMessage(CID);
    expect(getTurnPhase(CID)).toBe("streaming");

    finalizeHonestStopAbort(CID);

    expect(getTurnPhase(CID)).toBe("streaming");
    expect(getRuntime(CID).isGenerating).toBe(false);
  });

  it("idle 无 generating 为 no-op", () => {
    finalizeHonestStopAbort(CID);
    expect(getTurnPhase(CID)).toBe("idle");
    expect(getRuntime(CID).isGenerating).toBe(false);
  });
});

describe("finalizeGeneratingIfNeeded", () => {
  it("generating 时 finalizeLastMessage", () => {
    beginTurnPreflight(CID);
    enterTurnStreaming(CID);
    useConversationStore.getState().createAssistantMessage(CID);
    finalizeGeneratingIfNeeded(CID);
    expect(getRuntime(CID).isGenerating).toBe(false);
  });
});
