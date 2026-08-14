import { notifyFileTreeChanged } from "@/components/files/fileTreeBus";
import { handleExecutionEvent } from "@/services/sse/handlers/execution";
import { useConversationStore } from "@/stores/conversation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/files/fileTreeBus", () => ({
  notifyFileTreeChanged: vi.fn(),
}));

const CID = "conv-tree-notify";

function seedTurn(): void {
  useConversationStore.setState({ currentConversationId: null, byId: {} });
  useConversationStore.getState().switchConversation(CID);
  useConversationStore.getState().addMessage({
    id: "u1",
    role: "user",
    content: "go",
    createdAt: "",
    executionId: null,
    isStreaming: false,
  });
  useConversationStore.getState().createAssistantMessage(CID);
}

function endEvent(tool_name: string, status: "success" | "error" = "success") {
  return {
    type: "tool_use_end" as const,
    timestamp: "",
    payload: {
      tool_call_id: "tc1",
      tool_name,
      result: "{}",
      status,
    },
  };
}

beforeEach(() => {
  seedTurn();
  vi.mocked(notifyFileTreeChanged).mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("tool_use_end / delivery_status → file tree notify", () => {
  it("notifies conversation workspace sources on successful file_write", () => {
    handleExecutionEvent(endEvent("file_write"), {
      conversationId: CID,
      source: "server",
    });

    expect(notifyFileTreeChanged).toHaveBeenCalledWith({
      sourceId: `workspace:${CID}`,
      dir: "",
    });
    expect(notifyFileTreeChanged).toHaveBeenCalledWith({
      sourceId: `workspace:conv:${CID}`,
      dir: "",
    });
  });

  it.each([
    "file_append",
    "str_replace",
    "file_delete",
    "file_move",
    "file_copy",
    "mkdir",
    "file_batch",
  ])("notifies on successful %s", (tool) => {
    handleExecutionEvent(endEvent(tool), {
      conversationId: CID,
      source: "server",
    });
    expect(notifyFileTreeChanged).toHaveBeenCalled();
  });

  it("skips failed writes and non-write tools", () => {
    handleExecutionEvent(endEvent("file_write", "error"), {
      conversationId: CID,
      source: "server",
    });
    handleExecutionEvent(endEvent("file_read"), {
      conversationId: CID,
      source: "server",
    });
    expect(notifyFileTreeChanged).not.toHaveBeenCalled();
  });

  it("skips journal replay", () => {
    handleExecutionEvent(endEvent("file_write"), {
      conversationId: CID,
      source: "server",
      replay: true,
    });
    expect(notifyFileTreeChanged).not.toHaveBeenCalled();
  });

  it("notifies on live delivery_status", () => {
    handleExecutionEvent(
      {
        type: "delivery_status",
        timestamp: "",
        payload: {
          execution_id: "e1",
          state: "delivered",
          summary: "",
          delivered_files: ["a.md"],
          gaps: [],
          actions: [],
        },
      },
      { conversationId: CID, source: "server" },
    );
    expect(notifyFileTreeChanged).toHaveBeenCalledWith({
      sourceId: `workspace:${CID}`,
      dir: "",
    });
  });
});
