import type { RunNode } from "@/stores/execution";

/** 发言出现前的占位文案。 */
export function speechPlaceholder(run: RunNode | null): string {
  if (!run) return "等待发言…";
  if (run.status === "running") return "正在生成…";
  if (run.status === "failed") return run.error ?? "发言失败。";
  if (run.status === "cancelled") return "已停止。";
  return "等待发言…";
}
