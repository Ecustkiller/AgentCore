// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/toast", () => ({
  notifyError: vi.fn(),
  notifyInfo: vi.fn(),
  notifyActionError: vi.fn(),
}));

import { handleTerminalResult, runTerminalBash } from "@/lib/terminalFeedback";
import { notifyError, notifyInfo } from "@/lib/toast";

const notifyErrorMock = vi.mocked(notifyError);
const notifyInfoMock = vi.mocked(notifyInfo);

beforeEach(() => {
  notifyErrorMock.mockReset();
  notifyInfoMock.mockReset();
});

describe("handleTerminalResult", () => {
  it("no-ops on success", () => {
    handleTerminalResult({ ok: true });
    expect(notifyErrorMock).not.toHaveBeenCalled();
    expect(notifyInfoMock).not.toHaveBeenCalled();
  });

  it("shows info toast on cancel", () => {
    handleTerminalResult({ ok: false, reason: "已取消" });
    expect(notifyInfoMock).toHaveBeenCalledWith("已取消");
  });

  it("shows error toast on failure", () => {
    handleTerminalResult({ ok: false, reason: "无法启动终端" });
    expect(notifyErrorMock).toHaveBeenCalledWith("无法启动终端");
  });
});

describe("runTerminalBash", () => {
  it("forwards command to terminalApi and surfaces cancel", async () => {
    window.terminalApi = {
      runBash: vi.fn(async () => ({ ok: false, reason: "已取消" })),
    };
    await runTerminalBash("pnpm test");
    expect(window.terminalApi.runBash).toHaveBeenCalledWith("pnpm test");
    expect(notifyInfoMock).toHaveBeenCalledWith("已取消在终端运行");
    window.terminalApi = undefined;
  });
});
