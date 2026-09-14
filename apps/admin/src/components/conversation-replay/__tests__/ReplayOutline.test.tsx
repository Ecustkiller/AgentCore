// @vitest-environment jsdom
import { ReplayOutline } from "@/components/conversation-replay/ReplayOutline";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  cleanup();
});

describe("ReplayOutline", () => {
  it("序号不占右对齐固定槽", () => {
    render(
      <ReplayOutline
        turns={[
          { id: "u1", label: "第一问" },
          { id: "u2", label: "第二问" },
        ]}
        onJump={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "对话大纲" }));
    const index = screen.getByText("1");
    expect(index.className).not.toMatch(/\bw-5\b/);
    expect(index.className).not.toMatch(/\btext-right\b/);
  });
});
