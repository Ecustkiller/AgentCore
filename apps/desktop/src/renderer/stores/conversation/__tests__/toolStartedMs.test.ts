import { getRuntime, useConversationStore } from "@/stores/conversation";
import { beforeEach, describe, expect, it } from "vitest";

const CID = "conv-tool-started";

describe("addProcessTool · toolStartedMs", () => {
  beforeEach(() => {
    useConversationStore.setState({
      currentConversationId: CID,
      byId: {},
    });
  });

  it("stamps the SSE event wall-clock, not Date.now, and is idempotent", () => {
    const store = useConversationStore.getState();
    store.createAssistantMessage(CID);
    store.addProcessTool(
      { tool_call_id: "t1", tool_name: "web_search", arguments: {} },
      CID,
      1_700_000_000_000,
    );
    expect(getRuntime(CID).toolStartedMs.t1).toBe(1_700_000_000_000);
    store.addProcessTool(
      { tool_call_id: "t1", tool_name: "web_search", arguments: {} },
      CID,
      1_700_000_111_000,
    );
    expect(getRuntime(CID).toolStartedMs.t1).toBe(1_700_000_000_000);
  });

  it("stamps on attach catch-up even when the tool is already folded", () => {
    const store = useConversationStore.getState();
    store.createAssistantMessage(CID);
    store.addProcessTool(
      { tool_call_id: "t1", tool_name: "web_search", arguments: {} },
      CID,
      1,
    );
    const rt = getRuntime(CID);
    useConversationStore.setState({
      byId: {
        ...useConversationStore.getState().byId,
        [CID]: { ...rt, toolStartedMs: {} },
      },
    });
    expect(getRuntime(CID).toolStartedMs.t1).toBeUndefined();
    store.addProcessTool(
      { tool_call_id: "t1", tool_name: "web_search", arguments: {} },
      CID,
      1_700_000_000_000,
    );
    expect(getRuntime(CID).toolStartedMs.t1).toBe(1_700_000_000_000);
  });
});
