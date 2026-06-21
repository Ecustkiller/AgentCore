import { agentColorVar, agentGlyph } from "@/lib/agentIdentity";
import { Check, Loader2, X } from "lucide-react";

/**
 * 单 Agent 回合的「1 节点图」退化渲染（前端UX设计.md §6.1）。
 *
 * 核心论点（见提案 §二）：聊天本就是协作图的退化形态——单 Agent = 只有 Captain 的 Team。
 * 这张卡就是那个退化形态：当一支「团队」只剩 CEO 一个节点时，协作图坍缩成**单个节点**——
 * 不拉 React Flow 画布（一个节点不需要平移 / 缩放 / 画布 chrome，那只会比气泡更重），而是把
 * CEO 的「思考·正文·工具」时间线（`ProcessTimeline`）直接装进这张「CEO 节点卡」。这样既如实
 * 画出了后端的「统一执行路径」，又让简单问答读起来仍 ≈ 一张聊天气泡（手感验证的命根，见 §五.1）。
 *
 * 身份与状态解耦（同 `AgentNode`，见 `agentIdentity.ts`）：头像盘 = CEO 身份色 + 字形，运行
 * 状态走头像角标的「在线点」+（仅运行 / 失败时）卡片色环。**静息态（已完成）不挂彩色环**——
 * 长对话里每条历史回答都套一圈绿环会变成视觉噪音，故只有运行中（品牌蓝）/ 失败（红）才上环，
 * 已完成由角标的对勾承载。
 */
export type SoloStatus = "running" | "completed" | "failed" | "cancelled";

const CARD_ACCENT: Record<SoloStatus, string> = {
  running: "ring-2 ring-primary",
  completed: "border-border",
  failed: "ring-2 ring-destructive",
  cancelled: "border-border",
};

const PRESENCE: Record<
  SoloStatus,
  { cls: string; icon: React.ReactNode | null }
> = {
  running: {
    cls: "bg-primary",
    icon: <Loader2 size={9} className="animate-spin text-primary-foreground" />,
  },
  completed: {
    cls: "bg-success",
    icon: (
      <Check size={9} strokeWidth={3} className="text-success-foreground" />
    ),
  },
  failed: {
    cls: "bg-destructive",
    icon: (
      <X size={9} strokeWidth={3} className="text-destructive-foreground" />
    ),
  },
  cancelled: { cls: "bg-muted-foreground/50", icon: null },
};

const STATUS_LABEL: Record<SoloStatus, string> = {
  running: "执行中…",
  completed: "已完成",
  failed: "失败",
  cancelled: "已停止",
};

export function CeoNodeCard({
  status,
  children,
}: {
  status: SoloStatus;
  children: React.ReactNode;
}) {
  // CEO 身份从角色串「CEO」稳定派生（同 worker 节点的派生口径），让 CEO 在单 / 团队两种回合
  // 里读作同一个「人」。glyph("CEO") = 「C」。
  const identityColor = agentColorVar("CEO");
  const identityGlyph = agentGlyph("CEO");
  const presence = PRESENCE[status];

  return (
    <div
      className={`rounded-xl border bg-card px-4 py-3 shadow-sm ${CARD_ACCENT[status]}`}
    >
      <div className="mb-2 flex items-center gap-2.5">
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
            className={`absolute -bottom-0.5 -right-0.5 flex size-3.5 items-center justify-center rounded-full ring-2 ring-card ${presence.cls}`}
          >
            {presence.icon}
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">CEO</p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {STATUS_LABEL[status]}
          </p>
        </div>
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
