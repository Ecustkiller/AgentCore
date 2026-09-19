import { describe, expect, it } from "vitest";
import {
  INTERACTION_CARD_NAME,
  INTERACTION_CARD_NAME_UNKNOWN,
  interactionCardName,
} from "./interactionCardName";

describe("INTERACTION_CARD_NAME", () => {
  it("covers live UserInteractionKind; unknown keys do not inherit 工具审批", () => {
    expect(INTERACTION_CARD_NAME).toEqual({
      approval: "工具审批",
      escalation: "拍板请求",
      ask_user: "提问确认",
    });
    expect(Object.keys(INTERACTION_CARD_NAME)).not.toContain("plan_review");
    expect(Object.keys(INTERACTION_CARD_NAME)).not.toContain("team_preview");
    expect(Object.keys(INTERACTION_CARD_NAME)).not.toContain("stage_card");
    expect(interactionCardName("approval")).toBe("工具审批");
    expect(interactionCardName("plan_review")).toBe(
      INTERACTION_CARD_NAME_UNKNOWN,
    );
    expect(interactionCardName("what_is_this")).toBe(
      INTERACTION_CARD_NAME_UNKNOWN,
    );
    expect(interactionCardName("what_is_this")).not.toBe(
      INTERACTION_CARD_NAME.approval,
    );
    expect(interactionCardName("toString")).toBe(INTERACTION_CARD_NAME_UNKNOWN);
  });
});
