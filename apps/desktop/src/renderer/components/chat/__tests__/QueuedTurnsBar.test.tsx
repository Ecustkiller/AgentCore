// @vitest-environment jsdom
import { QueuedTurnsBar } from "@/components/chat/QueuedTurnsBar";
import { inlineToken } from "@/lib/inlineBody";
import { ApiError, api } from "@/services/api";
import { useConversationStore } from "@/stores/conversation";
import { useQueuedTurnsStore } from "@/stores/queuedTurns";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/api")>();
  return {
    ...actual,
    api: { ...actual.api, post: vi.fn() },
  };
});

vi.mock("@/lib/toast", () => ({
  notifyError: vi.fn(),
  notifyInfo: vi.fn(),
}));

const post = vi.mocked(api.post);
const CID = "conv-bar-q";

beforeEach(() => {
  post.mockReset();
  useQueuedTurnsStore.setState({ byConversation: {} });
});

afterEach(() => {
  cleanup();
  useQueuedTurnsStore.setState({ byConversation: {} });
});

describe("QueuedTurnsBar", () => {
  it("插话升队项标注来源且可取消", async () => {
    useQueuedTurnsStore.getState().upsert({
      queueId: "q-ij",
      conversationId: CID,
      content: "协调升格的话",
      position: 1,
      queueDepth: 1,
      interjectionId: "ij-9",
    });
    post.mockResolvedValue({});

    render(<QueuedTurnsBar conversationId={CID} />);

    const row = screen.getByTestId("queued-turn-row");
    expect(row.getAttribute("data-from-interjection")).toBe("true");
    expect(row.textContent).toContain("来自你的插话");
    expect(row.textContent).toContain("协调升格的话");
    expect(row.textContent).not.toContain("\uFFFC");

    fireEvent.click(screen.getByTestId("queued-turn-cancel"));
    await waitFor(() => {
      expect(post).toHaveBeenCalledWith(
        `/v1/conversations/${CID}/queued-turns/q-ij/cancel`,
        {},
      );
    });
    await waitFor(() => {
      expect(useQueuedTurnsStore.getState().list(CID)).toEqual([]);
    });
  });

  it("queued preview strips inline markers", () => {
    useQueuedTurnsStore.getState().upsert({
      queueId: "q-mark",
      conversationId: CID,
      content: `协调${inlineToken("A", 0)}升格的话`,
      attachments: [
        {
          name: "brief.md",
          path: "brief.md",
          text: "",
          truncated: false,
          kind: "file",
        },
      ],
      position: 1,
      queueDepth: 1,
    });

    render(<QueuedTurnsBar conversationId={CID} />);
    const row = screen.getByTestId("queued-turn-row");
    expect(row.textContent).toContain("协调[文件 brief.md]升格的话");
    expect(row.textContent).not.toContain("\uFFFC");
  });

  it("单条也画排队条，且不显示序号", () => {
    useConversationStore.getState().switchConversation(CID);
    useConversationStore.getState().addMessage(
      {
        id: "user-q",
        role: "user",
        content: "是这样？",
        createdAt: new Date().toISOString(),
        executionId: null,
        isStreaming: false,
      },
      CID,
    );
    useQueuedTurnsStore.getState().upsert({
      queueId: "q1",
      conversationId: CID,
      messageId: "user-q",
      content: "是这样？",
      position: 1,
      queueDepth: 1,
    });
    render(<QueuedTurnsBar conversationId={CID} />);
    const row = screen.getByTestId("queued-turn-row");
    expect(row.textContent).toContain("排队中");
    expect(row.textContent).not.toContain("第 1/");
    expect(screen.queryByRole("button", { name: "软插队" })).toBeNull();
    expect(screen.getByRole("button", { name: "停止并发送" })).toBeTruthy();
  });

  it("两条时仍画排队条", () => {
    useQueuedTurnsStore.getState().upsert({
      queueId: "q1",
      conversationId: CID,
      messageId: "user-q",
      content: "一",
      position: 1,
      queueDepth: 2,
    });
    useQueuedTurnsStore.getState().upsert({
      queueId: "q2",
      conversationId: CID,
      content: "二",
      position: 2,
      queueDepth: 2,
    });
    render(<QueuedTurnsBar conversationId={CID} />);
    expect(screen.getByTestId("queued-turns-bar")).toBeTruthy();
    expect(screen.getAllByTestId("queued-turn-row")).toHaveLength(2);
  });

  it("404 取消亦清条（插话升队项）", async () => {
    useQueuedTurnsStore.getState().upsert({
      queueId: "q-gone",
      conversationId: CID,
      content: "已出队",
      position: 1,
      queueDepth: 1,
      interjectionId: "ij-gone",
    });
    post.mockRejectedValue(new ApiError(404, "{}"));

    render(<QueuedTurnsBar conversationId={CID} />);
    fireEvent.click(screen.getByTestId("queued-turn-cancel"));
    await waitFor(() => {
      expect(useQueuedTurnsStore.getState().list(CID)).toEqual([]);
    });
  });

  it("点排队行展开编辑，放弃后回到原句", () => {
    useQueuedTurnsStore.getState().upsert({
      queueId: "q-edit",
      conversationId: CID,
      content: "先排队的话",
      position: 1,
      queueDepth: 1,
    });
    render(<QueuedTurnsBar conversationId={CID} />);
    fireEvent.click(screen.getByTestId("queued-turn-edit"));
    expect(screen.getByTestId("queued-turn-editor")).toBeTruthy();
    expect(screen.queryByTestId("queued-turn-stop-send")).toBeNull();
    expect(screen.queryByTestId("queued-turn-cancel")).toBeNull();
    fireEvent.click(screen.getByText("放弃"));
    expect(screen.queryByTestId("queued-turn-editor")).toBeNull();
    expect(screen.getByTestId("queued-turn-row").textContent).toContain(
      "先排队的话",
    );
  });
});
