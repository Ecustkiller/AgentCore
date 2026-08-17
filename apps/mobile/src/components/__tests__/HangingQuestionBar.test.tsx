// @vitest-environment jsdom
/**
 * Render tests for the hanging-question bar (non-blocking ask while the turn still runs).
 * The block comment keeps the @vitest-environment directive file-leading past organizeImports.
 */
import { HANGING_QUESTION_CAPTION } from "@/lib/hangingQuestion";
import type { NonBlockingAsk } from "@/protocol/fold";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { HangingQuestionBar } from "../HangingQuestionBar";

const pending: NonBlockingAsk = {
  id: "ask1",
  question: "需要同时导出 PDF 吗？",
  context: "默认仅 Markdown。",
  assumptions: [{ id: "a1", label: "格式", value: "仅 Markdown" }],
  questions: [],
  status: "pending",
};

afterEach(cleanup);

describe("HangingQuestionBar", () => {
  it("paints pending questions with the running-not-stuck face", () => {
    render(<HangingQuestionBar asks={[pending]} />);
    expect(screen.getByTestId("hanging-question-bar")).toBeTruthy();
    expect(screen.getByTestId("hanging-question-caption").textContent).toBe(
      HANGING_QUESTION_CAPTION,
    );
    expect(screen.getByText("需要同时导出 PDF 吗？")).toBeTruthy();
    expect(screen.getByText("答复")).toBeTruthy();
    expect(document.body.textContent).toContain("没回之前按这个继续");
    expect(document.body.textContent).not.toContain("需要你拍板");
    expect(
      screen
        .getByTestId("hanging-question-card")
        .getAttribute("data-hanging-urgency"),
    ).toBe("running");
  });

  it("renders nothing when there are no pending asks", () => {
    const { container } = render(<HangingQuestionBar asks={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
