import { computeShellPresence } from "@shared/shell-presence";
import { describe, expect, it } from "vitest";

const mainPresent = {
  destroyed: false,
  minimized: false,
  visible: true,
  focused: true,
};

describe("computeShellPresence", () => {
  it("is present when the main window is focused and visible", () => {
    expect(computeShellPresence({ main: mainPresent, floats: [] })).toEqual({
      present: true,
      floatConversationIds: [],
    });
  });

  it("is away when the main window is minimized", () => {
    expect(
      computeShellPresence({
        main: { ...mainPresent, minimized: true, focused: false },
        floats: [{ destroyed: false, focused: false, conversationId: "c1" }],
      }),
    ).toEqual({ present: false, floatConversationIds: ["c1"] });
  });

  it("is present when a float is focused even if main is not", () => {
    expect(
      computeShellPresence({
        main: { ...mainPresent, focused: false },
        floats: [{ destroyed: false, focused: true, conversationId: "c1" }],
      }),
    ).toEqual({ present: true, floatConversationIds: ["c1"] });
  });

  it("is away when no product window is focused", () => {
    expect(
      computeShellPresence({
        main: { ...mainPresent, focused: false },
        floats: [{ destroyed: false, focused: false, conversationId: "c1" }],
      }),
    ).toEqual({ present: false, floatConversationIds: ["c1"] });
  });
});
