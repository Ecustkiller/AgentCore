// @vitest-environment jsdom
/**
 * Generic ask_user chrome: clarification CTA is 提交, cancel → decision=stop.
 */

import { TooltipProvider } from "@/components/ui/tooltip";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AskUserCard } from "../CheckpointCard";
import type { AskUserContent } from "../ask/AskUserFields";

vi.mock("@/lib/toast", () => ({
  notifyError: vi.fn(),
}));

afterEach(cleanup);

const content: AskUserContent = {
  question: "选哪条？",
  questions: [
    {
      id: "q0",
      prompt: "选哪条？",
      kind: "choice",
      multiple: false,
      default: "",
      options: [{ label: "方案 A" }, { label: "方案 B" }],
    },
  ],
};

describe("AskUserCard", () => {
  it("通用澄清 CTA 为提交；次要键取消仍发 decision=stop", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <MemoryRouter>
        <TooltipProvider>
          <AskUserCard
            content={content}
            intent="decision"
            onSubmit={onSubmit}
          />
        </TooltipProvider>
      </MemoryRouter>,
    );

    expect(document.querySelector('[data-ask-intent="decision"]')).toBeTruthy();
    expect(document.querySelector('[data-ask-card="decision"]')).toBeTruthy();
    expect(screen.queryByText("停止")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onSubmit).toHaveBeenCalledWith("stop", "");
  });
});
