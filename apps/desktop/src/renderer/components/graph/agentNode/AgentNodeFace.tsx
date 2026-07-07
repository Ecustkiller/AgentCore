import {
  graphBadgeMutedPlain,
  graphBadgePrimary,
} from "@/components/ui/tone-presets";
import { agentColorVar, agentGlyph } from "@/lib/agentIdentity";
import { formatCompact } from "@/lib/format";
import { STANCE_META, toolLabel } from "@/stores/execution";
import {
  AlertTriangle,
  ArrowUp,
  ClipboardList,
  Clock,
  FileText,
  Pause,
} from "lucide-react";
import {
  type AgentNodeData,
  type AgentNodePresentation,
  FACE_ARTIFACT_CAP,
  basename,
} from "./shared";

/** Dependency layout: full card with task line, artifact chips, duration in header. */
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
      <AgentNodeHeader
        d={d}
        p={p}
        identityColor={identityColor}
        identityGlyph={identityGlyph}
      />
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
    </div>
  );
}

/** Timeline layout: compact bar on the real time axis; task one-liner, no artifact chips. */
export function AgentNodeTimelineFace({
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
      className={`relative flex h-full min-w-0 cursor-pointer flex-col justify-center rounded-xl border px-3 py-2 text-left shadow-sm outline-none ring-2 ${p.style.bg} ${p.style.ring} ${isRunning ? "animate-pulse" : ""} ${flashing ? "animate-graph-node-flash" : ""} ${
        p.highlighted
          ? "outline outline-2 outline-offset-2 outline-primary"
          : "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary/60"
      }`}
    >
      <AgentNodeHeader
        d={d}
        p={p}
        identityColor={identityColor}
        identityGlyph={identityGlyph}
      />
      <AgentNodeActivity d={d} p={p} showIdleTask={false} />
      {d.task && (
        <p className="mt-1 line-clamp-1 text-xs leading-snug text-muted-foreground/70">
          {d.task}
        </p>
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
                {(d.escalationPending ?? 0) > 1
                  ? ` ${d.escalationPending}`
                  : ""}
              </span>
            )}
          </p>
        )}
      </div>
      {p.durationText && (
        <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
          <Clock size={11} />
          <span className="tabular-nums">{p.durationText}</span>
        </span>
      )}
    </div>
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
  if (showIdleTask && d.task) {
    return (
      <p className="mt-2 line-clamp-2 text-xs leading-snug text-muted-foreground/70">
        {d.task}
      </p>
    );
  }
  return null;
}
