/**
 * 热审批 / 委派授权时间线痕迹（统一时间线二期 D3）：
 * pending 期间仅决策区有操作面，时间线不渲染；resolved 后在 required 时刻的标记槽显轻状态行。
 */
import { toolLabel } from "@/stores/execution/types";
import { useInteractionStore } from "@/stores/interactions";
import { Check } from "lucide-react";

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
  const label = denied
    ? `已拒绝 · ${toolLabel(toolName) || toolName || "工具"}`
    : `已批准 · ${toolLabel(toolName) || toolName || "工具"}`;
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Check size={12} className="shrink-0" />
      <span>{label}</span>
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
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Check size={12} className="shrink-0" />
      <span>{denied ? "已拒绝委派授权" : "已授权开工"}</span>
    </div>
  );
}
