import { toolPhaseText } from "@/components/chat/message-bubble/constants";
import { statusPillSoft } from "@/components/ui/tone-presets";
import { formatCompact, formatDuration } from "@/lib/format";
import { MODEL_TIER_META, STANCE_META, toolLabel } from "@/stores/execution";
import {
  type AgentNodeData,
  type AgentNodePresentation,
  PRESENCE_STYLES,
  STATUS_STYLES,
  checkpointBadge,
  revisedBadge,
  revisionVersionBadge,
  statusFaceLabel,
} from "./shared";

export function buildAgentNodePresentation(
  d: AgentNodeData,
): AgentNodePresentation {
  const style = STATUS_STYLES[d.status] ?? STATUS_STYLES.pending;
  const presence = PRESENCE_STYLES[d.status] ?? PRESENCE_STYLES.pending;
  const artifacts = d.artifacts ?? [];
  const isRunning = d.status === "running";
  const liveTool = isRunning ? (d.toolProgress ?? null) : null;
  const liveToolExec =
    isRunning && !liveTool ? (d.toolExecutionLive ?? null) : null;
  const livePreview =
    isRunning && !liveTool && !liveToolExec ? d.outputPreview : "";
  const liveThinking =
    isRunning && !liveTool && !liveToolExec && !livePreview
      ? (d.reasoningPreview ?? "")
      : "";
  const isTimeline = d.layoutMode === "timeline";
  const cardWidth = isTimeline ? (d.nodeWidth ?? 210) : 210;
  const enterDelay = Math.min((d.enterIndex ?? 0) * 35, 280);

  const modelText =
    d.model ??
    (d.modelPreference ? MODEL_TIER_META[d.modelPreference].label : "—");
  const tokenText =
    d.realTokens && d.realTokens > 0
      ? formatCompact(d.realTokens)
      : d.tokenCount > 0
        ? `≈${formatCompact(d.tokenCount)}`
        : "—";
  const durationText = d.durationMs ? formatDuration(d.durationMs) : null;
  const statusFace = statusFaceLabel(d.status, d.durationMs);
  const revisionFace =
    d.isRevision && d.revision ? revisionVersionBadge(d.revision) : null;

  const ariaLabel = `${d.role}，${statusFace.text.replace(/ · \d+s$/, "")}，模型 ${modelText}，Token ${tokenText}${
    d.costText ? `，成本 ${d.costText}` : ""
  }${durationText ? `，用时 ${durationText}` : ""}${
    d.toolCount > 0 ? `，工具 ${d.toolCount} 次` : ""
  }${artifacts.length > 0 ? `，产物 ${artifacts.length} 个` : ""}${
    d.revised ? `，${revisedBadge(d.revised).label}` : ""
  }${revisionFace ? `，修订 ${revisionFace}` : ""}${
    d.checkpoint ? `，检查点${checkpointBadge(d.checkpoint).label}` : ""
  }${
    (d.escalationPending ?? 0) > 0
      ? `，${d.escalationPending} 项待你拍板`
      : (d.escalationRaised ?? 0) > 0
        ? `，上报 ${d.escalationRaised} 条`
        : ""
  }`;

  const peekActivity = liveTool
    ? {
        heading: "正在生成",
        text: `${toolLabel(liveTool.toolName)}${
          liveTool.chars > 0 ? ` · ${formatCompact(liveTool.chars)} 字` : ""
        }`,
      }
    : liveToolExec
      ? {
          heading: toolPhaseText(liveToolExec.phase) ?? "处理中",
          text: toolLabel(liveToolExec.toolName),
        }
      : livePreview
        ? { heading: "输出中", text: livePreview }
        : liveThinking
          ? { heading: "思考中", text: liveThinking, italic: true }
          : d.outputPreview
            ? { heading: "产出预览", text: d.outputPreview }
            : null;

  const peekTags: string[] = [];
  if (d.stance) peekTags.push(STANCE_META[d.stance].label);
  if (d.isSubtask) peekTags.push("子任务");
  if (d.isRevision) peekTags.push(`修订 v${d.revision ?? 2}`);
  if (d.revised) peekTags.push(revisedBadge(d.revised).label);
  if (d.modelPreference)
    peekTags.push(MODEL_TIER_META[d.modelPreference].label);
  if (d.checkpoint) peekTags.push(checkpointBadge(d.checkpoint).label);
  if (d.reviewConcern === "critical") peekTags.push("方向风险");
  else if (d.reviewConcern === "warning") peekTags.push("待关注");
  if ((d.escalationPending ?? 0) > 0) {
    peekTags.push(
      `待你拍板${(d.escalationPending ?? 0) > 1 ? ` ${d.escalationPending}` : ""}`,
    );
  } else if ((d.escalationRaised ?? 0) > 0) {
    peekTags.push(
      `上报${(d.escalationRaised ?? 0) > 1 ? ` ${d.escalationRaised}` : ""}`,
    );
  }

  const checkpointFace =
    d.checkpoint &&
    (d.checkpoint.status === "pending" || d.checkpoint.decision === "stop")
      ? checkpointBadge(d.checkpoint)
      : null;

  const reviewConcernFace =
    d.reviewConcern === "critical"
      ? { label: "方向风险", cls: statusPillSoft.destructive }
      : d.reviewConcern === "warning"
        ? { label: "待关注", cls: "bg-warning/10 text-warning" }
        : null;

  return {
    style,
    presence,
    artifacts,
    liveTool,
    liveToolExec,
    livePreview,
    liveThinking,
    highlighted: d.focused,
    isTimeline,
    cardWidth,
    enterDelay,
    modelText,
    tokenText,
    durationText,
    ariaLabel,
    peekActivity,
    peekTags,
    checkpointFace,
    reviewConcernFace,
    statusFace,
    revisionFace,
  };
}
