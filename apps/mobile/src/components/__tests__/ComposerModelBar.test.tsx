// @vitest-environment jsdom
/**
 * Composer 行内模型组合 chip — 会话钉在哪个组合上必须零层可见，
 * 系统预置要与用户自建区分得开；窄屏省略时完整名走 aria-label / title。
 */
import { ComposerModelBar } from "@/components/ComposerModelBar";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(cleanup);

describe("ComposerModelBar", () => {
  it("shows the combination name without opening any menu", () => {
    render(
      <ComposerModelBar label="GLM-5.2" preset={false} onOpen={vi.fn()} />,
    );
    expect(screen.getByTestId("composer-model-chip").textContent).toContain(
      "GLM-5.2",
    );
  });

  it("exposes the full name on title for truncated chips", () => {
    render(
      <ComposerModelBar
        label="很长的用户自建写作组合名称"
        preset={false}
        onOpen={vi.fn()}
      />,
    );
    const chip = screen.getByTestId("composer-model-chip");
    expect(chip.getAttribute("title")).toBe("很长的用户自建写作组合名称");
    expect(chip.getAttribute("aria-label")).toBe(
      "模型组合：很长的用户自建写作组合名称",
    );
  });

  it("marks system presets so a pinned free-tier combination is legible", () => {
    render(<ComposerModelBar label="GLM-5.2" preset onOpen={vi.fn()} />);
    expect(screen.getByText("预置")).toBeTruthy();
    expect(screen.getByLabelText("模型组合：GLM-5.2（系统预置）")).toBeTruthy();
  });

  it("omits the preset badge for user-built combinations", () => {
    render(
      <ComposerModelBar label="写作强档" preset={false} onOpen={vi.fn()} />,
    );
    expect(screen.queryByText("预置")).toBeNull();
    expect(screen.getByLabelText("模型组合：写作强档")).toBeTruthy();
  });

  it("opens the existing picker on tap", () => {
    const onOpen = vi.fn();
    render(<ComposerModelBar label="GLM-5.2" preset onOpen={onOpen} />);
    fireEvent.click(screen.getByTestId("composer-model-chip"));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("goes inert while the composer is locked", () => {
    const onOpen = vi.fn();
    render(
      <ComposerModelBar label="GLM-5.2" preset disabled onOpen={onOpen} />,
    );
    const chip = screen.getByTestId("composer-model-chip");
    expect((chip as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(chip);
    expect(onOpen).not.toHaveBeenCalled();
  });
});
