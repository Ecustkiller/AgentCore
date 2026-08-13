// @vitest-environment jsdom
/**
 * 挂起标记只有一句话的信息量，其中半句是指路——指错了就等于没有。
 * 聊天面拍板卡在时间线下方（默认）；画布指挥台装配顺序相反，拍板卡在上。
 */
import { DecisionEntryPlacementContext } from "@/components/chat/decisionEntryPlacement";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PendingDecisionMarker } from "../PendingDecisionMarker";

afterEach(cleanup);

describe("PendingDecisionMarker 指路方位", () => {
  it("默认（聊天面：拍板卡在时间线下方）指下方", () => {
    render(<PendingDecisionMarker label="等你确认 · 计划复核" />);

    const marker = screen.getByTestId("pending-decision-marker");
    expect(marker.textContent).toContain("等你确认 · 计划复核");
    expect(marker.textContent).toContain("入口在下方拍板卡");
  });

  it("宿主声明拍板卡在上（画布指挥台）时指上方", () => {
    render(
      <DecisionEntryPlacementContext.Provider value="above">
        <PendingDecisionMarker label="等你确认 · 计划复核" />
      </DecisionEntryPlacementContext.Provider>,
    );

    const marker = screen.getByTestId("pending-decision-marker");
    expect(marker.textContent).toContain("入口在上方拍板卡");
    expect(marker.textContent).not.toContain("下方");
  });
});
