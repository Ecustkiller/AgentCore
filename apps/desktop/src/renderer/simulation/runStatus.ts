import type { SimulationRunView } from "@/simulation/runModel";

const STATUS_LABELS: Record<string, string> = {
  running: "运行中",
  paused: "已暂停",
  completed: "已完成",
};

export function runStatusLabel(status: string | undefined): string {
  if (!status) return "未知";
  return STATUS_LABELS[status] ?? status;
}

export function runStatusTone(
  status: string | undefined,
): "success" | "warning" | "muted" {
  if (status === "running") return "success";
  if (status === "paused") return "warning";
  return "muted";
}

export function formatRunMeta(run: SimulationRunView): string {
  return `${run.scenario} · Tick ${run.tick} · ${runStatusLabel(run.status)}`;
}
