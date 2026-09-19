import type { Execution, RunStatus } from "@/stores/execution";
import { isSeatFoldedContinuation, seatFaceRun } from "@/stores/execution";
import type { CoordinationWaitPayload } from "@/types/events";

/**
 * Same membership as {@link deriveCaptainStatus}'s WORKER_TERMINAL.
 * Do not count only `completed` — failed / cancelled / skipped are done too.
 */
const WORKER_TERMINAL = new Set<string>([
  "completed",
  "failed",
  "cancelled",
  "skipped",
]);

function seatCountedRuns(
  execution: Execution,
  opts?: { workersOnly?: boolean },
) {
  return execution.runs.filter((r) => {
    if (isSeatFoldedContinuation(r)) return false;
    if (opts?.workersOnly && r.kind === "captain") return false;
    return true;
  });
}

/** Worker seats only (CEO captain sink is not a delegate progress unit).
 * 同人续写折进座位，不另占分母。 */
export function workerProgress(execution: Execution): {
  completed: number;
  total: number;
} {
  const workers = seatCountedRuns(execution, { workersOnly: true });
  return {
    completed: workers.filter(
      (r) => seatFaceRun(r, execution.runs).status === "completed",
    ).length,
    total: workers.length,
  };
}

/** 条上 n/m：座位（含 CEO 汇总），同人续写不另计。 */
export function graphProgress(execution: Execution): {
  completed: number;
  total: number;
} {
  const counted = seatCountedRuns(execution);
  return {
    completed: counted.filter(
      (r) => seatFaceRun(r, execution.runs).status === "completed",
    ).length,
    total: counted.length,
  };
}

/** True when every non-captain run is in WORKER_TERMINAL (vacant roster = true). */
export function workersAreTerminal(execution: Execution): boolean {
  return execution.runs
    .filter((r) => r.kind !== "captain")
    .every((r) => WORKER_TERMINAL.has(r.status));
}

/** Roles still outstanding while CEO is in ``coordination_wait``. */
export function waitingWorkerRoles(execution: Execution): string[] {
  return coordinationWaitWorkerRows(execution)
    .filter((w) => w.status !== "completed")
    .map((w) => w.role);
}

export type CoordinationWaitWorkerRow = {
  runId: string;
  role: string;
  status: RunStatus;
  summary: string;
  /** 证人席位根：pending 显示「待命」，skipped 显示「未传唤」。 */
  witnessSeat?: boolean;
};

/** All non-captain workers with display role + live run status. */
export function coordinationWaitWorkerRows(
  execution: Execution,
): CoordinationWaitWorkerRow[] {
  return execution.runs
    .filter((r) => r.kind !== "captain" && !isSeatFoldedContinuation(r))
    .map((r) => {
      const face = seatFaceRun(r, execution.runs);
      return {
        runId: r.id,
        role:
          execution.agents.find((a) => a.id === r.agentId)?.role ??
          r.role ??
          r.id,
        status: face.status,
        summary: (face.outputSummary ?? r.outputSummary ?? "").trim(),
        witnessSeat: r.group === "debate:witness" && r.continuesRunId == null,
      };
    });
}

/** Short captain-node caption: 等谁 (n/m). No 已等秒数 — duplicates strip 用时. */
export function coordinationWaitCaptainCaption(
  wait: Pick<CoordinationWaitPayload, "completed" | "total"> | null | undefined,
  opts?: {
    waitingRoles?: string[];
  },
): string | null {
  if (!wait) return null;
  const total = Math.max(0, wait.total);
  const completed = Math.max(
    0,
    Math.min(wait.completed, total || wait.completed),
  );
  const roles = (opts?.waitingRoles ?? []).filter(Boolean);
  if (roles.length === 1) {
    return `等待「${roles[0]}」(${completed}/${total})`;
  }
  return `等待团队 (${completed}/${total})`;
}

/**
 * All workers finished while execution is still running — CEO writing the
 * same-turn close. Matches {@link deriveCaptainStatus}'s "running" sink.
 *
 * ``detached``: captain already left; background settle does not write a close.
 * ``turnTerminal`` without detach is still the same-turn writing window
 * (attach grace). Hiding the spinner while attached painted a false「已汇总」.
 *
 * ``paused``: cold ask hang — workers may be 2/2, but CEO is
 * waiting on the user (same invariant as deriveCaptainStatus).
 */
export function isTeamSynthesizing(
  execution: Execution,
  opts?: { turnTerminal?: boolean; detached?: boolean },
): boolean {
  void opts?.turnTerminal;
  if (opts?.detached) return false;
  if (execution.status === "paused") return false;
  if (execution.status !== "running") return false;
  const { total } = workerProgress(execution);
  return total > 0 && workersAreTerminal(execution);
}

/** Deterministic strip / indicator copy for the synthesis empty window. */
export function teamSynthesisPhaseLabel(execution: Execution): string {
  const { completed, total } = workerProgress(execution);
  return `${completed}/${total} 已完成，正在收尾`;
}
