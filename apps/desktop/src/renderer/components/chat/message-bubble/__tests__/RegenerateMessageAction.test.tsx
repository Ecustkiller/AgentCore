// @vitest-environment jsdom
/**
 * 定案：助手底栏「重新生成」须二次确认，首点不触发 onRegenerate。
 */
import { TooltipProvider } from "@/components/ui/tooltip";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RegenerateMessageAction } from "../MessageActions";

afterEach(() => {
  cleanup();
});

function renderAction(onRegenerate = vi.fn()) {
  render(
    <TooltipProvider>
      <RegenerateMessageAction onRegenerate={onRegenerate} />
    </TooltipProvider>,
  );
  return onRegenerate;
}

describe("RegenerateMessageAction", () => {
  it("首点只进入确认态，不调用 onRegenerate", () => {
    const onRegenerate = renderAction();
    fireEvent.click(screen.getByRole("button", { name: "重新生成" }));
    expect(onRegenerate).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "确认重新生成" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "取消" })).toBeTruthy();
  });

  it("确认后调用 onRegenerate", () => {
    const onRegenerate = renderAction();
    fireEvent.click(screen.getByRole("button", { name: "重新生成" }));
    fireEvent.click(screen.getByRole("button", { name: "确认重新生成" }));
    expect(onRegenerate).toHaveBeenCalledTimes(1);
  });

  it("取消回到初始态且不调用 onRegenerate", () => {
    const onRegenerate = renderAction();
    fireEvent.click(screen.getByRole("button", { name: "重新生成" }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onRegenerate).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "重新生成" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "确认重新生成" })).toBeNull();
  });
});
