import {
  foldContentDelta,
  foldContentReset,
  foldReasoningDelta,
  messageLaneFromMessage,
} from "@/lib/foldMessageLane";
import { describe, expect, it } from "vitest";

describe("foldMessageLane", () => {
  it("foldContentDelta appends content and process step", () => {
    const base = messageLaneFromMessage({ content: "hi" });
    const next = foldContentDelta(base, " there");
    expect(next.content).toBe("hi there");
    expect(next.process).toEqual([{ kind: "content", text: " there" }]);
  });

  it("foldContentReset clears content and trailing content steps", () => {
    const base = messageLaneFromMessage({
      content: "bad draft",
      process: [
        { kind: "reasoning", text: "think" },
        { kind: "content", text: "bad draft" },
      ],
    });
    const next = foldContentReset(base);
    expect(next.content).toBe("");
    expect(next.process).toEqual([{ kind: "reasoning", text: "think" }]);
  });

  it("foldReasoningDelta appends reasoning lane", () => {
    const base = messageLaneFromMessage({ content: "" });
    const next = foldReasoningDelta(base, "hmm");
    expect(next.reasoning).toBe("hmm");
    expect(next.process).toEqual([{ kind: "reasoning", text: "hmm" }]);
  });
});
