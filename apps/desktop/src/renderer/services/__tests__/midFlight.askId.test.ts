import { sendMidFlightMessage } from "@/services/turns/midFlight";
import { useConversationStore } from "@/stores/conversation";
import { EMPTY_RUNTIME } from "@/stores/conversation/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/toast", () => ({
  notifyInfo: vi.fn(),
  notifyError: vi.fn(),
  notifySuccess: vi.fn(),
}));

describe("sendMidFlightMessage ask_id", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      new Response(new ReadableStream({ start: (c) => c.close() }), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
    useConversationStore.setState({
      currentConversationId: "c1",
      byId: { c1: { ...EMPTY_RUNTIME, isGenerating: true } },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useConversationStore.setState({ currentConversationId: null, byId: {} });
  });

  it("includes ask_id when answering a hanging question", async () => {
    await sendMidFlightMessage(
      "c1",
      "也要 PDF。",
      undefined,
      "steer",
      undefined,
      "ask1",
    );
    const body = JSON.parse(
      (fetchMock.mock.calls[0]?.[1] as RequestInit).body as string,
    ) as { ask_id?: string };
    expect(body.ask_id).toBe("ask1");
  });

  it("omits ask_id on an ordinary interjection", async () => {
    await sendMidFlightMessage("c1", "补充一句", undefined, "steer");
    const body = JSON.parse(
      (fetchMock.mock.calls[0]?.[1] as RequestInit).body as string,
    ) as { ask_id?: string };
    expect(body.ask_id).toBeUndefined();
  });
});
