// @vitest-environment jsdom
/**
 * 「已由另一端处理」提示条（云对话多端同权 B2 · P1 · 验收 5）。
 *
 * 锁住产品语义：另一端点掉的卡不是凭空消失，而是就地留一张只读条说明去向，用户按
 * 「知道了」才收走。块注释保证 @vitest-environment 指令留在文件首行（organizeImports）。
 */

import { RemoteSettledCards } from "@/components/RemoteSettledCards";
import {
  __resetRemoteSettlementsForTests,
  noteRemoteSettlement,
} from "@/lib/remoteSettlement";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

afterEach(() => {
  cleanup();
  __resetRemoteSettlementsForTests();
});

describe("RemoteSettledCards", () => {
  it("另一端处理后显示「已由另一端处理」+ 卡面名", () => {
    noteRemoteSettlement({
      interactionId: "appr-1",
      conversationId: "c1",
      kind: "approval",
    });
    render(<RemoteSettledCards conversationId="c1" />);
    expect(screen.getByText("已由另一端处理")).toBeTruthy();
    expect(screen.getByText("工具审批")).toBeTruthy();
  });

  it("「知道了」收走这一条", () => {
    noteRemoteSettlement({
      interactionId: "appr-1",
      conversationId: "c1",
      kind: "approval",
    });
    render(<RemoteSettledCards conversationId="c1" />);
    act(() => {
      fireEvent.click(screen.getByText("知道了"));
    });
    expect(screen.queryByTestId("remote-settled-card")).toBeNull();
  });

  it("只画本对话的条（另一对话的不串台），没有则什么都不渲染", () => {
    noteRemoteSettlement({
      interactionId: "appr-1",
      conversationId: "other",
      kind: "approval",
    });
    render(<RemoteSettledCards conversationId="c1" />);
    expect(screen.queryByTestId("remote-settled-card")).toBeNull();
  });

  it("多张卡各留各的条", () => {
    noteRemoteSettlement({
      interactionId: "appr-1",
      conversationId: "c1",
      kind: "approval",
    });
    noteRemoteSettlement({
      interactionId: "cp-1",
      conversationId: "c1",
      kind: "plan_review",
    });
    render(<RemoteSettledCards conversationId="c1" />);
    expect(screen.getAllByTestId("remote-settled-card")).toHaveLength(2);
  });
});
