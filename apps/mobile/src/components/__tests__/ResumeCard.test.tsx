// @vitest-environment jsdom
/**
 * Render + interaction tests for the mobile 离线恢复 card (结构化挂起 2b / 挂起即收口 ②).
 *
 * ResumeCard is the SINGLE durable surface for a turn that paused at a checkpoint and then
 * lost its live stream — surfaced on reopen, and (under ②, post flag-on) the moment a live
 * stream ENDS at a checkpoint (message_end finish_reason=paused → ChatPage.refreshPaused).
 * Unlike PauseCard it reads a PERSISTED PausedTurnSummary and asks the parent to drive a
 * fresh resume stream. These assert the two kind branches (ask_user / plan_review), that the
 * note rides along, and the plan_review-only 调整 gating — coverage the durable path lacked.
 * The block comment keeps the @vitest-environment directive file-leading past organizeImports.
 */

import type { PausedTurnSummary } from "@/api/turn";
import { ResumeCard } from "@/components/ResumeCard";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(cleanup);

function summary(over: Partial<PausedTurnSummary> = {}): PausedTurnSummary {
  return {
    message_id: "m-server-1",
    checkpoint_id: "cp1",
    kind: "ask_user",
    user_message: "做 A 还是 B？",
    user_message_id: "u1",
    question: "先做 A 还是 B?",
    context: "两条路线各有取舍。",
    // 契约序列化必带（服务端带默认值恒输出；仅 team_preview 开工卡才有具体值）
    form: "",
    motion: "",
    primitive: "delegate",
    max_rounds: 0,
    thorough: true,
    ...over,
  };
}

describe("ResumeCard · ask_user", () => {
  it("renders the offline headline, the original request, question + context", () => {
    render(<ResumeCard paused={summary()} onResume={vi.fn()} />);
    expect(screen.getByText("需要你拍板（已离线保留）")).toBeTruthy();
    expect(screen.getByText("做 A 还是 B？")).toBeTruthy();
    expect(screen.getByText("先做 A 还是 B?")).toBeTruthy();
    expect(screen.getByText("两条路线各有取舍。")).toBeTruthy();
    // ask_user has no 调整 (that is plan_review-only steer).
    expect(screen.queryByText("调整")).toBeNull();
  });

  it("继续 submits continue with the trimmed note", () => {
    const onResume = vi.fn();
    render(<ResumeCard paused={summary()} onResume={onResume} />);
    fireEvent.change(screen.getByPlaceholderText(/可选/), {
      target: { value: "  选 A  " },
    });
    fireEvent.click(screen.getByText("继续"));
    expect(onResume).toHaveBeenCalledWith("continue", "选 A");
  });

  it("停止 submits stop", () => {
    const onResume = vi.fn();
    render(<ResumeCard paused={summary()} onResume={onResume} />);
    fireEvent.click(screen.getByText("停止"));
    expect(onResume).toHaveBeenCalledWith("stop", "");
  });
});

describe("ResumeCard · plan_review", () => {
  const planReview = (
    over: Partial<PausedTurnSummary> = {},
  ): PausedTurnSummary =>
    summary({
      kind: "plan_review",
      checkpoint_id: "pr1",
      question: "",
      context: "",
      steps: [{ role: "调研", output_summary: "方案就绪" }],
      pending: [{ role: "执行" }],
      ...over,
    });

  it("renders the plan_review headline and the completed step", () => {
    render(<ResumeCard paused={planReview()} onResume={vi.fn()} />);
    expect(screen.getByText("执行已暂停 · 待你决定是否继续")).toBeTruthy();
    expect(screen.getByText("调研")).toBeTruthy();
    expect(screen.getByText("方案就绪")).toBeTruthy();
  });

  it("调整 is gated until a note is typed, then steers with it", () => {
    const onResume = vi.fn();
    render(<ResumeCard paused={planReview()} onResume={onResume} />);
    const adjust = screen.getByText("调整") as HTMLButtonElement;
    expect(adjust.disabled).toBe(true);

    fireEvent.change(screen.getByPlaceholderText(/可选/), {
      target: { value: "换个方向" },
    });
    expect(adjust.disabled).toBe(false);
    fireEvent.click(adjust);
    expect(onResume).toHaveBeenCalledWith("adjust", "换个方向");
  });
});
