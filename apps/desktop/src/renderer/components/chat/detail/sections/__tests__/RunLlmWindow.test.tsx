// @vitest-environment jsdom

import { LlmWindowSection } from "@/components/chat/detail/sections/RunLlmWindow";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

describe("LlmWindowSection", () => {
  it("renders folded messages when expanded", () => {
    render(
      <LlmWindowSection
        messages={[
          { role: "system", content: "你是 CEO。" },
          { role: "user", content: "调研一下" },
        ]}
        available
        loading={false}
        error={null}
        keyBase="test"
      />,
    );

    expect(screen.getByText("LLM 窗口")).toBeTruthy();
    fireEvent.click(screen.getByText("LLM 窗口"));
    expect(screen.getByText("系统")).toBeTruthy();
    expect(screen.getByText("你是 CEO。")).toBeTruthy();
    expect(screen.getByText("用户")).toBeTruthy();
    expect(screen.getByText("调研一下")).toBeTruthy();
  });

  it("shows unavailable empty state", () => {
    render(
      <LlmWindowSection
        messages={[]}
        available={false}
        loading={false}
        error={null}
        keyBase="test-empty"
      />,
    );
    fireEvent.click(screen.getByText("LLM 窗口"));
    expect(
      screen.getByText(/无法从 journal 重建此 run 的 LLM 窗口/),
    ).toBeTruthy();
  });
});
