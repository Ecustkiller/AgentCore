import { resolveChatTurn } from "@/components/chat/chatTurn";
import { describe, expect, it } from "vitest";

describe("resolveChatTurn", () => {
  it("prefers projected.process when runs_payload.process is an empty array", () => {
    const turn = resolveChatTurn({
      content: "x",
      projected: {
        status: "completed",
        process: [{ kind: "reasoning", text: "完整思考" }],
      },
      runsPayload: { process: [] },
    });
    expect(turn.process).toEqual([{ kind: "reasoning", text: "完整思考" }]);
  });

  it("falls back to runs_payload.process only when projected is null", () => {
    const turn = resolveChatTurn({
      content: "x",
      projected: null,
      runsPayload: {
        process: [{ kind: "tool", tool_name: "web_search", status: "success" }],
      },
    });
    expect(turn.process).toHaveLength(1);
    expect(turn.process[0]).toMatchObject({ kind: "tool" });
  });

  it("treats missing nested projected fields as empty, not throw", () => {
    const turn = resolveChatTurn({
      content: "hi",
      projected: { status: "completed" },
    });
    expect(turn.citations).toEqual([]);
    expect(turn.runs).toEqual([]);
    expect(turn.interactions).toEqual([]);
    expect(turn.process).toEqual([]);
    expect(turn.progress).toEqual({ completed: 0, total: 0 });
  });
});
