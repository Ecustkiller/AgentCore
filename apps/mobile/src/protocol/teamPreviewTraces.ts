/**
 * 开工卡 / 开赛卡 resolved 时间线痕迹（桌面 TeamPreviewCard 对等）。
 * 旁路读原始事件，不入 ProjectedTurn / 不改 fold。
 */
import type { SSEEvent } from "@agentcore/contract-types";

export type TeamPreviewTraceStatus = "pending" | "resolved" | "orphaned";

export interface TeamPreviewTrace {
  status: TeamPreviewTraceStatus;
  primitive: "delegate" | "debate";
  decision?: string;
  note: string;
  headline: string;
  workerCount: number;
  sideCount: number;
  excludedCount: number;
  tightenedCount: number;
  /** 时间线结论文。pending 不画。 */
  label: string;
}

const DELEGATE_RESOLVED: Record<string, string> = {
  continue: "已授权开工 · 首波已放行",
  adjust: "已调整 · 已交回修订",
  stop: "已取消 · 团队未启动",
  research_first: "已取消 · 团队未启动",
  timeout: "未及时回应，团队未启动",
  orphaned: "已失效（回合已结束或服务已重启）",
};

const DEBATE_RESOLVED: Record<string, string> = {
  continue: "已授权开赛 · 辩论已放行",
  adjust: "已调整 · 已交回修订",
  stop: "已取消 · 辩论未开赛",
  research_first: "已选先调研 · 辩论未开赛",
  timeout: "未及时回应，辩论未开赛",
  orphaned: "已失效（回合已结束或服务已重启）",
};

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function leadSuffix(args: {
  primitive: "delegate" | "debate";
  headline: string;
  workerCount: number;
  sideCount: number;
  settled: boolean;
}): string {
  const fromWire = args.headline.trim();
  if (fromWire) return fromWire;
  if (args.primitive === "debate") {
    const n = args.sideCount;
    if (n <= 0) return "";
    return args.settled ? `${n} 方` : `预计 ${n} 方开赛`;
  }
  const n = args.workerCount;
  if (n <= 0) return "";
  return args.settled ? `${n} 人` : `预计 ${n} 人开工`;
}

function correctionSuffix(
  excludedCount: number,
  tightenedCount: number,
): string {
  const parts: string[] = [];
  if (excludedCount > 0) parts.push(`已排除 ${excludedCount} 岗`);
  if (tightenedCount > 0) parts.push("已收紧写盘");
  return parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
}

export function teamPreviewResolvedLabel(args: {
  primitive: "delegate" | "debate";
  decision: string;
  hasNote: boolean;
  headline?: string;
  workerCount: number;
  sideCount: number;
  excludedCount?: number;
  tightenedCount?: number;
}): string {
  const table =
    args.primitive === "debate" ? DEBATE_RESOLVED : DELEGATE_RESOLVED;
  let core = table[args.decision] ?? table.continue;
  if (args.decision === "continue" && args.hasNote) {
    core =
      args.primitive === "debate"
        ? "已授权开赛 · 嘱咐已注入"
        : "已授权开工 · 嘱咐已注入队员";
  }
  const settled = args.decision === "continue";
  const lead = leadSuffix({
    primitive: args.primitive,
    headline: args.headline ?? "",
    workerCount: args.workerCount,
    sideCount: args.sideCount,
    settled,
  });
  const correction = settled
    ? correctionSuffix(args.excludedCount ?? 0, args.tightenedCount ?? 0)
    : "";
  const tail = lead ? ` · ${lead}` : "";
  return `${core}${correction}${tail}`;
}

function relabel(t: TeamPreviewTrace): TeamPreviewTrace {
  if (t.status === "pending") return { ...t, label: "" };
  const decision =
    t.status === "orphaned" ? "orphaned" : (t.decision ?? "timeout");
  return {
    ...t,
    label: teamPreviewResolvedLabel({
      primitive: t.primitive,
      decision,
      hasNote: Boolean(t.note.trim()),
      headline: t.headline,
      workerCount: t.workerCount,
      sideCount: t.sideCount,
      excludedCount: t.excludedCount,
      tightenedCount: t.tightenedCount,
    }),
  };
}

/** 从 journal / live SSE 抽出开工卡 traces（required 槽位 + resolved/orphaned 结论文）。 */
export function extractTeamPreviewTraces(
  events: readonly Pick<SSEEvent, "type" | "payload">[],
): Map<string, TeamPreviewTrace> {
  const byId = new Map<string, TeamPreviewTrace>();
  for (const ev of events) {
    if (ev.type === "team_preview_required") {
      const p = asRecord(ev.payload);
      const id = str(p.checkpoint_id);
      if (!id) continue;
      const workers = Array.isArray(p.workers) ? p.workers : [];
      const sides = Array.isArray(p.sides) ? p.sides : [];
      byId.set(
        id,
        relabel({
          status: "pending",
          primitive: p.primitive === "debate" ? "debate" : "delegate",
          note: "",
          headline: str(p.headline),
          workerCount: workers.length,
          sideCount: sides.length,
          excludedCount: 0,
          tightenedCount: 0,
          label: "",
        }),
      );
    } else if (ev.type === "team_preview_resolved") {
      const p = asRecord(ev.payload);
      const id = str(p.checkpoint_id);
      if (!id) continue;
      const prev = byId.get(id);
      const excluded = Array.isArray(p.excluded_run_ids)
        ? p.excluded_run_ids.filter((x): x is string => typeof x === "string")
        : [];
      const overrides = Array.isArray(p.write_capability_overrides)
        ? p.write_capability_overrides
        : [];
      const tightened = overrides.filter((row) => {
        const r = asRecord(row);
        return r.capability === "text_only";
      }).length;
      byId.set(
        id,
        relabel({
          status: "resolved",
          primitive: prev?.primitive ?? "delegate",
          decision: str(p.decision) || "timeout",
          note: str(p.note),
          headline: prev?.headline ?? "",
          workerCount: prev?.workerCount ?? 0,
          sideCount: prev?.sideCount ?? 0,
          excludedCount: excluded.length,
          tightenedCount: tightened,
          label: "",
        }),
      );
    } else if (ev.type === "interaction_orphaned") {
      const p = asRecord(ev.payload);
      if (p.kind !== "team_preview") continue;
      const id = str(p.interaction_id);
      if (!id) continue;
      const prev = byId.get(id);
      byId.set(
        id,
        relabel({
          status: "orphaned",
          primitive: prev?.primitive ?? "delegate",
          decision: "orphaned",
          note: prev?.note ?? "",
          headline: prev?.headline ?? "",
          workerCount: prev?.workerCount ?? 0,
          sideCount: prev?.sideCount ?? 0,
          excludedCount: prev?.excludedCount ?? 0,
          tightenedCount: prev?.tightenedCount ?? 0,
          label: "",
        }),
      );
    }
  }
  return byId;
}
