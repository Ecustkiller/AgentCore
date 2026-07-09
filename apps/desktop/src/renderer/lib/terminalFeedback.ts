import { notifyActionError, notifyError, notifyInfo } from "@/lib/toast";
import type { TerminalRunResult } from "@shared/terminal-contract";

/** Surface `terminalApi` outcomes — cancel is info, failure is error. */
export function handleTerminalResult(
  result: TerminalRunResult,
  opts?: { cancelMessage?: string },
): void {
  if (result.ok) return;
  if (result.reason === "已取消") {
    notifyInfo(opts?.cancelMessage ?? "已取消");
    return;
  }
  notifyError(result.reason);
}

/** Run bash in the user terminal with unified feedback. */
export async function runTerminalBash(command: string): Promise<void> {
  const api = window.terminalApi;
  if (!api?.runBash) {
    notifyError("终端不可用（非桌面环境）");
    return;
  }
  try {
    const result = await api.runBash(command);
    handleTerminalResult(result, { cancelMessage: "已取消在终端运行" });
  } catch (e) {
    notifyActionError("无法在终端运行", e);
  }
}
