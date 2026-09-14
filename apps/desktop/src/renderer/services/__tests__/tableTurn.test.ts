import { streamConversation } from "@/services/streamConversation";
import { sendTableTurn } from "@/services/tableTurn";
import { ensureTableConversation } from "@/services/tables";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/tables", () => ({
  ensureTableConversation: vi.fn(),
}));

vi.mock("@/services/streamConversation", () => ({
  streamConversation: vi.fn(),
}));

const ensure = vi.mocked(ensureTableConversation);
const stream = vi.mocked(streamConversation);

describe("sendTableTurn", () => {
  beforeEach(() => {
    ensure.mockReset();
    stream.mockReset();
    ensure.mockResolvedValue({ conversationId: "conv-t" });
    stream.mockResolvedValue(undefined);
  });

  it("ensures the table conversation then streams with a frozen row-id snapshot", async () => {
    const ids = ["r1", "r2"];
    const pending = sendTableTurn("tbl-1", "把这些标成完成", {
      tableSelection: ids,
    });
    ids.push("r3");
    ids.shift();
    await pending;

    expect(ensure).toHaveBeenCalledWith("tbl-1");
    expect(stream).toHaveBeenCalledWith({
      conversationId: "conv-t",
      content: "把这些标成完成",
      delivery: "steer",
      signal: undefined,
      tableSelection: ["r1", "r2"],
    });
    expect(stream.mock.calls[0][0].tableSelection).not.toBe(ids);
  });

  it("omits selection when none is passed", async () => {
    await sendTableTurn("tbl-1", "筛一下");
    expect(stream.mock.calls[0][0].tableSelection).toEqual([]);
  });
});
