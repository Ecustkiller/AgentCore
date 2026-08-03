// @vitest-environment jsdom
/**
 * EscalationAnswer · browser_login：
 * - pending + browserLogin → 「需要你登录」+ Sandbox 引导 +「查看直播」
 * - 主钮一键 answer「已登录，继续」（不因空 textarea 禁用）
 * - 有 assumption →「按假设继续」
 * - 普通 escalate 仍要 textarea 非空才可提交
 */

import { EscalationAnswer } from "@/components/TeamView";
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

afterEach(cleanup);

beforeEach(() => {
  decideEscalation.mockReset().mockResolvedValue(undefined);
});

const loginEsc: EscalationSlotEsc = {
  question: "请先登录目标站点",
  assumption: "用户已登录",
  blocking: true,
  status: "pending",
  answer: null,
  kind: "normal",
  browserLogin: true,
};

function renderAnswer(
  esc: EscalationSlotEsc = loginEsc,
  onOpenLive?: () => void,
) {
  return render(
    <EscalationAnswer
      esc={esc}
      escalationId="esc-login"
      conversationId="conv-1"
      onOpenLive={onOpenLive}
    />,
  );
}

describe("EscalationAnswer · browser_login", () => {
  it("shows 需要你登录 + Sandbox 引导；可开直播；无假打开浏览器", () => {
    const onOpenLive = vi.fn();
    renderAnswer(loginEsc, onOpenLive);
    expect(screen.getByText(/需要你登录/)).toBeTruthy();
    expect(screen.getByText("请先登录目标站点")).toBeTruthy();
    expect(screen.getByText(/Sandbox/)).toBeTruthy();
    expect(screen.queryByText(/手机暂无内嵌浏览器/)).toBeNull();
    expect(screen.queryByText(/桌面端完成登录/)).toBeNull();
    expect(screen.getByText("已登录，继续")).toBeTruthy();
    expect(screen.getByText("按假设继续")).toBeTruthy();
    expect(screen.getByTestId("browser-login-open-live")).toBeTruthy();
    fireEvent.click(screen.getByText("查看直播"));
    expect(onOpenLive).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("打开浏览器")).toBeNull();
    expect(screen.queryByPlaceholderText(/输入你的决定/)).toBeNull();
  });

  it("主钮不因空输入禁用；提交 answer「已登录，继续」", async () => {
    renderAnswer();
    const cta = screen.getByRole("button", { name: "已登录，继续" });
    expect((cta as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      fireEvent.click(cta);
    });
    expect(decideEscalation).toHaveBeenCalledWith("conv-1", "esc-login", {
      kind: "answer",
      answer: "已登录，继续",
    });
  });

  it("按假设继续 → use_assumption", async () => {
    renderAnswer();
    await act(async () => {
      fireEvent.click(screen.getByText("按假设继续"));
    });
    expect(decideEscalation).toHaveBeenCalledWith("conv-1", "esc-login", {
      kind: "use_assumption",
    });
  });

  it("无 assumption 时不显示「按假设继续」", () => {
    renderAnswer({ ...loginEsc, assumption: "" });
    expect(screen.queryByText("按假设继续")).toBeNull();
    expect(screen.getByText("已登录，继续")).toBeTruthy();
  });

  it("普通 escalate 仍要求非空 note 才可提交", () => {
    renderAnswer({
      question: "选哪条路？",
      assumption: "走 A",
      blocking: true,
      status: "pending",
      answer: null,
      kind: "normal",
    });
    expect(screen.queryByText(/需要你登录/)).toBeNull();
    expect(screen.getByPlaceholderText(/输入你的决定/)).toBeTruthy();
    const submit = screen.getByRole("button", { name: "提交" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText(/输入你的决定/), {
      target: { value: "走 B" },
    });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
  });
});
