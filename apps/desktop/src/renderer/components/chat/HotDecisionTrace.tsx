/**
 * 热审批 / 委派授权 / 阶段推进卡时间线痕迹（统一时间线二期 D3 + 打磨批）：
 * pending 期间仅决策区有操作面（推进卡在 Dock），时间线不渲染；
 * resolved / orphaned 后在 required 时刻的标记槽显轻状态行。
 *
 * 多端同权（B2 · 验收 2）：这一拍是另一端点的时补一句归属——决策区的收口条几秒后就退场，
 * 这行痕迹才是回看时「不是我点的」的长期答案。判定只在本会话内成立，见
 * `InteractionEntry.settledElsewhere`；不确定时一个字都不加，绝不替用户认领。
 */
import { toolLabel } from "@/stores/execution/types";
import {
  type InteractionEntry,
  useInteractionStore,
} from "@/stores/interactions";
import { Check, X } from "lucide-react";

function elsewhereSuffix(entry: InteractionEntry): string {
  return entry.settledElsewhere ? " · 已由另一端处理" : "";
}

/**
 * 卡是被提交回执关掉的、而结果那帧还没到：`resolution` 是空的，此时默认分支会说成
 * 「已批准 / 已授权开工」——那是替它猜。等 `*_resolved` 到了自然会换成真的那句。
 */
function outcomeUnknown(entry: InteractionEntry): boolean {
  return entry.settledByReceipt === true && !entry.resolution?.decision;
}

export function ApprovalTrace({ approvalId }: { approvalId: string }) {
  const entry = useInteractionStore((s) => s.byId.get(approvalId));
  if (!entry || entry.kind !== "approval" || entry.status !== "resolved") {
    return null;
  }
  const toolName =
    typeof entry.payload.tool_name === "string" ? entry.payload.tool_name : "";
  const decision =
    typeof entry.resolution?.decision === "string"
      ? entry.resolution.decision
      : "";
  const denied = decision === "deny";
  const tool = toolLabel(toolName) || toolName || "工具";
  const label = outcomeUnknown(entry)
    ? `已处理 · ${tool}`
    : denied
      ? `已拒绝 · ${tool}`
      : `已批准 · ${tool}`;
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Check size={12} className="shrink-0" />
      <span>{`${label}${elsewhereSuffix(entry)}`}</span>
    </div>
  );
}

export function DelegationAuthorizationTrace({
  authorizationId,
}: {
  authorizationId: string;
}) {
  const entry = useInteractionStore((s) => s.byId.get(authorizationId));
  if (
    !entry ||
    entry.kind !== "delegation_authorization" ||
    entry.status !== "resolved"
  ) {
    return null;
  }
  const decision =
    typeof entry.resolution?.decision === "string"
      ? entry.resolution.decision
      : "";
  const denied = decision === "deny";
  const label = outcomeUnknown(entry)
    ? "委派授权已处理"
    : denied
      ? "已拒绝委派授权"
      : "已授权开工";
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Check size={12} className="shrink-0" />
      <span>{`${label}${elsewhereSuffix(entry)}`}</span>
    </div>
  );
}

/** 阶段推进卡时间线轻锚点：历史回看显「已开辩 / 已选补充调研 / 已失效」。 */
export function StageCardTrace({ stageCardId }: { stageCardId: string }) {
  const entry = useInteractionStore((s) => s.byId.get(stageCardId));
  if (!entry || entry.kind !== "stage_card") return null;
  if (entry.status === "orphaned") {
    return (
      <div
        className="flex items-center gap-1.5 text-xs text-muted-foreground"
        data-testid="stage-card-trace"
      >
        <X size={12} className="shrink-0" />
        <span>推进卡 · 已失效</span>
      </div>
    );
  }
  if (entry.status !== "resolved") return null;
  const decision =
    typeof entry.resolution?.decision === "string"
      ? entry.resolution.decision
      : "";
  const label = outcomeUnknown(entry)
    ? "推进卡 · 已处理"
    : decision === "research_first"
      ? "推进卡 · 已选补充调研"
      : "推进卡 · 已开辩";
  return (
    <div
      className="flex items-center gap-1.5 text-xs text-muted-foreground"
      data-testid="stage-card-trace"
    >
      <Check size={12} className="shrink-0" />
      <span>{`${label}${elsewhereSuffix(entry)}`}</span>
    </div>
  );
}
