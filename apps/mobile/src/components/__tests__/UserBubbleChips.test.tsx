// @vitest-environment jsdom
import { UserBubbleChips } from "@/components/UserBubbleChips";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

afterEach(() => {
  cleanup();
});

describe("UserBubbleChips history replay", () => {
  it("shows persisted 点名 chips on the user bubble", () => {
    render(
      <UserBubbleChips
        attachments={[{ name: "notes.md" }]}
        agentMentions={[{ agentId: "w1", role: "研究员" }]}
      />,
    );
    const chip = screen.getByTestId("agent-mention-chip");
    expect(chip.textContent).toContain("点名");
    expect(chip.textContent).toContain("研究员");
    expect(chip.textContent).not.toMatch(/派单|已派/);
    expect(screen.getByText("notes.md")).toBeTruthy();
  });
});
