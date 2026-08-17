// @vitest-environment jsdom
import type { NonBlockingAskDisplay } from "@/stores/conversation";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { NonBlockingAskCard } from "../NonBlockingAskCard";

afterEach(cleanup);

const pending: NonBlockingAskDisplay = {
  id: "n1",
  question: "需要同时导出 PDF 吗？",
  context: "默认仅 Markdown。",
  assumptions: [],
  questions: [],
  status: "pending",
};

const answered: NonBlockingAskDisplay = {
  ...pending,
  status: "resolved",
  settlement: "answered",
  answer: "也要 PDF。",
};

const discarded: NonBlockingAskDisplay = {
  ...pending,
  id: "n2",
  status: "resolved",
  settlement: "discarded",
  note: "按默认只出 Markdown，后半等你回来再决定。",
};

describe("NonBlockingAskCard", () => {
  it("renders nothing while pending (inline 只留 resolved)", () => {
    const { container } = render(<NonBlockingAskCard ask={pending} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows 已答 with the user's reply", () => {
    render(<NonBlockingAskCard ask={answered} />);
    expect(screen.getByText("已答")).toBeTruthy();
    expect(
      document.querySelector('[data-ask-settlement="answered"]'),
    ).toBeTruthy();
    expect(document.body.textContent).toContain("也要 PDF。");
    fireEvent.click(screen.getByText("已答"));
    expect(document.body.textContent).toContain("需要同时导出 PDF 吗？");
  });

  it("shows 已作废 with the CEO note", () => {
    render(<NonBlockingAskCard ask={discarded} />);
    expect(screen.getByText("已作废")).toBeTruthy();
    expect(
      document.querySelector('[data-ask-settlement="discarded"]'),
    ).toBeTruthy();
    expect(document.body.textContent).toContain(
      "按默认只出 Markdown，后半等你回来再决定。",
    );
  });
});
