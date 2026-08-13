// @vitest-environment jsdom
/**
 * EscalationAnswer × 「已由另一端处理」（云对话多端同权 B2 · P1 · 验收 5）。
 *
 * 锁住这道闸：REST 回执只说「已经结了」，不说是谁结的——升级卡还能由主管仲裁、按假设推进或
 * 超时兜底收口，这类压根没有人参与。据回执认成「另一端处理」= 替用户认领一个他没做过的动作。
 * 所以回执路一律不立条，只把归属交回带 `status` / `arbitrated_by` 的 `escalation_resolved` 帧。
 */

import { EscalationAnswer } from "@/components/TeamView";
import {
  __resetRemoteSettlementsForTests,
  getRemoteSettlementSnapshot,
  isLocalSettlement,
} from "@/lib/remoteSettlement";
import type { EscalationSlotEsc } from "@/protocol/fold";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const decideEscalation = vi.fn();

vi.mock("@/api/interaction", () => ({
  decideEscalation: (...args: unknown[]) => decideEscalation(...args),
}));

afterEach(() => {
  cleanup();
  __resetRemoteSettlementsForTests();
});

beforeEach(() => {
  decideEscalation.mockReset().mockResolvedValue("settled");
});

const esc: EscalationSlotEsc = {
  question: "选哪条路？",
  assumption: "走 A",
  blocking: true,
  status: "pending",
  answer: null,
  kind: "normal",
};

function submitAnswer() {
  render(
    <EscalationAnswer esc={esc} escalationId="esc-1" conversationId="conv-1" />,
  );
  fireEvent.change(screen.getByPlaceholderText(/输入你的决定/), {
    target: { value: "走 B" },
  });
  return act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
  });
}

describe("EscalationAnswer · 回执 already_processed", () => {
  it("不立「已由另一端处理」条——回执证不了是人结的", async () => {
    decideEscalation.mockResolvedValue("already_processed");
    await submitAnswer();
    expect(getRemoteSettlementSnapshot()).toEqual([]);
  });

  it("撤回本端登记，把归属交回带线材字段的收口帧", async () => {
    decideEscalation.mockResolvedValue("already_processed");
    await submitAnswer();
    expect(isLocalSettlement("esc-1")).toBe(false);
  });

  it("卡上如实交代结果未知，并解除 busy（不永等一帧已经过去的 SSE）", async () => {
    decideEscalation.mockResolvedValue("already_processed");
    await submitAnswer();
    expect(screen.getByText(/这条已经结了/)).toBeTruthy();
    expect(screen.queryByText("处理中…")).toBeNull();
  });

  it("正常收口（settled）不立条，登记保留以认出抢先回来的自家收口帧", async () => {
    await submitAnswer();
    expect(getRemoteSettlementSnapshot()).toEqual([]);
    expect(isLocalSettlement("esc-1")).toBe(true);
  });
});
