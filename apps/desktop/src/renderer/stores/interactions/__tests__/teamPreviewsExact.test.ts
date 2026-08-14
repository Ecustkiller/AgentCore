import { teamPreviewsExact } from "@/stores/interactions";
import type { InteractionEntry } from "@/stores/interactions";
import { describe, expect, it } from "vitest";

function preview(
  partial: Pick<InteractionEntry, "id" | "conversationId" | "messageId"> &
    Partial<Pick<InteractionEntry, "status">>,
): InteractionEntry {
  return {
    kind: "team_preview",
    status: partial.status ?? "pending",
    payload: { primitive: "delegate", workers: [] },
    ...partial,
  };
}

describe("teamPreviewsExact", () => {
  it("does not treat empty messageId as match-all", () => {
    const leaked = preview({
      id: "old",
      conversationId: "c1",
      messageId: "",
      status: "resolved",
    });
    expect(teamPreviewsExact([leaked], "c1", "msg-2")).toEqual([]);
  });

  it("keeps only the same conversation + message", () => {
    const mine = preview({ id: "mine", conversationId: "c1", messageId: "m1" });
    const otherMsg = preview({
      id: "other",
      conversationId: "c1",
      messageId: "m2",
    });
    const found = teamPreviewsExact([mine, otherMsg], "c1", "m1");
    expect(found.map((p) => p.id)).toEqual(["mine"]);
  });
});
