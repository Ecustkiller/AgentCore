import { toolPhaseText } from "@/components/chat/message-bubble/constants";
import {
  graphBadgeMuted,
  graphBadgeMutedPlain,
  graphBadgePrimary,
} from "@/components/ui/tone-presets";
import { agentColorVar, agentGlyph } from "@/lib/agentIdentity";
import { formatCompact } from "@/lib/format";
import { STANCE_META, toolLabel } from "@/stores/execution";
import {
  AlertTriangle,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  FileText,
  Pause,
  PencilLine,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  type AgentNodeData,
  type AgentNodePresentation,
  FACE_ARTIFACT_CAP,
  basename,
  statusFaceLabel,
} from "./shared";

/** Full card with task line, artifact chips, status line. */
export function AgentNodeCardFace({
  d,
  p,
  flashColor,
  flashing,
}: {
  d: AgentNodeData;
  p: AgentNodePresentation;
  flashColor: string;
  flashing: boolean;
}) {
  const identityColor = agentColorVar(d.role);
  const identityGlyph = agentGlyph(d.role);
  const isRunning = d.status === "running";

  return (
    // biome-ignore lint/a11y/useSemanticElements: graph card hosts nested interactive chrome
    <div
      role="button"
      tabIndex={0}
      aria-label={p.ariaLabel}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          d.onActivate?.();
        }
      }}
      style={
        {
          "--graph-flash-color": flashColor,
          width: p.cardWidth,
        } as React.CSSProperties
      }
      className={`relative cursor-pointer rounded-xl border px-3 py-2.5 text-left shadow-sm outline-none ring-2 ${p.style.bg} ${p.style.ring} ${isRunning ? "animate-pulse" : ""} ${flashing ? "animate-graph-node-flash" : ""} ${
        p.highlighted
          ? "outline outline-2 outline-offset-2 outline-primary"
          : "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary/60"
      }`}
    >
      {p.revisionBadge && (
        <span
          className={`absolute -right-1.5 -top-1.5 z-10 flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-xs font-medium shadow-sm ring-2 ring-card ${graphBadgeMuted}`}
          title={p.revisionBadge.title}
        >
          {p.revisionBadge.kind === "hotfix" && (
            <PencilLine size={10} className="shrink-0" />
          )}
          {p.revisionBadge.label}
        </span>
      )}
      {p.handoffFace && !p.revisionBadge && (
        <span
          className={`absolute -right-1.5 -top-1.5 z-10 flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-xs font-medium shadow-sm ring-2 ring-card ${graphBadgeMuted}`}
          title="已由新队员接手"
        >
          {p.handoffFace}
        </span>
      )}
      <AgentNodeHeader
        d={d}
        p={p}
        identityColor={identityColor}
        identityGlyph={identityGlyph}
      />
      <AgentNodeStatusLine d={d} p={p} />
      <AgentNodeActivity d={d} p={p} showIdleTask />
      {p.artifacts.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {p.artifacts.slice(0, FACE_ARTIFACT_CAP).map((path) => (
            <span
              key={path}
              title={path}
              className="flex max-w-[120px] items-center gap-1 rounded-lg bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
            >
              <FileText size={11} className="shrink-0" />
              <span className="truncate">{basename(path)}</span>
            </span>
          ))}
          {p.artifacts.length > FACE_ARTIFACT_CAP && (
            <span className="shrink-0 rounded-lg bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
              +{p.artifacts.length - FACE_ARTIFACT_CAP}
            </span>
          )}
        </div>
      )}
      {(d.foldedChildCount ?? 0) > 0 && (
        <button
          type="button"
          className="mt-2 flex w-full items-center justify-center gap-1 rounded-lg border border-border/60 bg-muted/30 px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
          onClick={(e) => {
            e.stopPropagation();
            d.onToggleUnitExpand?.();
          }}
        >
          {d.unitExpanded ? (
            <>
              <ChevronDown size={12} />
              收起子队
            </>
          ) : (
            <>
              <ChevronRight size={12} />
              展开子队（{d.foldedChildCount}）
            </>
          )}
        </button>
      )}
    </div>
  );
}

function AgentNodeHeader({
  d,
  p,
  identityColor,
  identityGlyph,
}: {
  d: AgentNodeData;
  p: AgentNodePresentation;
  identityColor: string;
  identityGlyph: string;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <div className="relative shrink-0">
        <div
          className="flex size-7 items-center justify-center rounded-full text-sm font-semibold"
          style={{
            backgroundColor: `color-mix(in oklab, ${identityColor} 18%, transparent)`,
            color: identityColor,
          }}
        >
          {identityGlyph}
        </div>
        <span
          className={`absolute -bottom-0.5 -right-0.5 flex size-3.5 items-center justify-center rounded-full ring-2 ring-card ${p.presence.cls}`}
        >
          {p.presence.icon}
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{d.role}</p>
        {(d.stance ||
          p.checkpointFace ||
          p.reviewConcernFace ||
          (d.escalationPending ?? 0) > 0 ||
          (d.auditEventCount ?? 0) > 0) && (
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            {d.stance && (
              <span className={graphBadgeMutedPlain}>
                {STANCE_META[d.stance].label}
              </span>
            )}
            {(d.auditEventCount ?? 0) > 0 && (
              <span
                className={`flex shrink-0 items-center gap-1 ${graphBadgeMutedPlain}`}
                title={`${d.auditEventCount} 条活动记录`}
              >
                <ClipboardList size={10} />
                活动 {d.auditEventCount}
              </span>
            )}
            {p.reviewConcernFace && (
              <span
                className={`flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 font-medium ${p.reviewConcernFace.cls}`}
              >
                <AlertTriangle size={10} />
                {p.reviewConcernFace.label}
              </span>
            )}
            {p.checkpointFace && (
              <span
                className={`flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 font-medium ${p.checkpointFace.cls}`}
              >
                <Pause size={10} />
                {p.checkpointFace.label}
              </span>
            )}
            {(d.escalationPending ?? 0) > 0 && (
              <span className={graphBadgePrimary}>
                <ArrowUp size={10} />
                待你拍板
                {d.escalationKind && d.escalationKind !== "normal"
                  ? ` · ${d.escalationKind === "scope" ? "职责偏离" : "缺输入"}`
                  : ""}
                {(d.escalationPending ?? 0) > 1
                  ? ` ${d.escalationPending}`
                  : ""}
              </span>
            )}
            {(d.escalationPending ?? 0) === 0 &&
              (d.escalationRaised ?? 0) > 0 &&
              d.escalationKind &&
              d.escalationKind !== "normal" && (
                <span className={graphBadgeMutedPlain}>
                  <ArrowUp size={10} />
                  {d.escalationKind === "scope" ? "职责偏离" : "缺输入"}
                </span>
              )}
          </p>
        )}
      </div>
    </div>
  );
}

function useRunningElapsed(running: boolean): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!running) {
      setElapsed(0);
      return;
    }
    const start = Date.now();
    const id = setInterval(
      () => setElapsed(Math.floor((Date.now() - start) / 1000)),
      1000,
    );
    return () => clearInterval(id);
  }, [running]);
  return elapsed;
}

function AgentNodeStatusLine({
  d,
  p,
}: {
  d: AgentNodeData;
  p: AgentNodePresentation;
}) {
  const elapsed = useRunningElapsed(p.statusFace.tickElapsed);
  const face = statusFaceLabel(d.status, d.durationMs, elapsed);
  return (
    <p className={`mt-1 text-xs tabular-nums leading-snug ${face.cls}`}>
      {face.text}
    </p>
  );
}

function AgentNodeActivity({
  d,
  p,
  showIdleTask,
}: {
  d: AgentNodeData;
  p: AgentNodePresentation;
  showIdleTask: boolean;
}) {
  if (p.liveTool) {
    return (
      <p className="mt-2 line-clamp-2 text-xs leading-snug text-primary/90">
        正在生成 {toolLabel(p.liveTool.toolName)}
        {p.liveTool.chars > 0 && (
          <span className="text-muted-foreground/70">
            {" · "}
            {formatCompact(p.liveTool.chars)} 字
          </span>
        )}
        <span className="ml-0.5 inline-block animate-pulse text-primary">
          ▋
        </span>
      </p>
    );
  }
  if (p.liveToolExec) {
    const phaseLabel = toolPhaseText(p.liveToolExec.phase) ?? "处理中";
    return (
      <p className="mt-2 line-clamp-2 text-xs leading-snug text-primary/90">
        {phaseLabel} · {toolLabel(p.liveToolExec.toolName)}
        <span className="ml-0.5 inline-block animate-pulse text-primary">
          ▋
        </span>
      </p>
    );
  }
  if (p.livePreview) {
    return (
      <p className="mt-2 line-clamp-2 text-xs leading-snug text-muted-foreground/80">
        {p.livePreview}
        <span className="ml-0.5 inline-block animate-pulse text-primary">
          ▋
        </span>
      </p>
    );
  }
  if (p.liveThinking) {
    return (
      <p className="mt-2 line-clamp-2 text-xs italic leading-snug text-muted-foreground/60">
        {p.liveThinking}
        <span className="ml-0.5 inline-block animate-pulse text-primary">
          ▋
        </span>
      </p>
    );
  }
  if (showIdleTask && p.revisionFaceHint) {
    return (
      <p className="mt-2 line-clamp-2 text-xs leading-snug text-muted-foreground/70">
        {p.revisionFaceHint}
      </p>
    );
  }
  if (showIdleTask && d.task) {
    return (
      <p className="mt-2 line-clamp-2 text-xs leading-snug text-muted-foreground/70">
        {d.task}
      </p>
    );
  }
  return null;
}
