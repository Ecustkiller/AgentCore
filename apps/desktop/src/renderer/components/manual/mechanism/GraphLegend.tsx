import { MODEL_TIER_META } from "@/stores/execution";
import {
  Bot,
  CheckCircle2,
  CornerDownRight,
  Loader2,
  PencilLine,
  Sparkles,
  UserRound,
  XCircle,
} from "lucide-react";
import type { ReactNode } from "react";

/** 圆形头像底（与节点左上角图标同构）。 */
function IconChip({ children }: { children: ReactNode }) {
  return (
    <span className="flex size-7 items-center justify-center rounded-full bg-muted">
      {children}
    </span>
  );
}

/** 连线样本：复刻 StepEdge 的描边语义（实线/虚线/点线 + 运行中 primary 粒子）。 */
function EdgeSample({
  variant,
}: {
  variant: "dep" | "delegate" | "revision" | "running";
}) {
  const stroke =
    variant === "running" ? "var(--primary)" : "var(--muted-foreground)";
  const dash =
    variant === "revision" ? "2 4" : variant === "delegate" ? "5 4" : undefined;
  const opacity = variant === "running" ? 1 : variant === "dep" ? 0.6 : 0.45;
  const label = {
    dep: "实线依赖边",
    delegate: "虚线委派边",
    revision: "点线修订边",
    running: "运行中粒子边",
  }[variant];
  return (
    <svg
      width="48"
      height="12"
      viewBox="0 0 48 12"
      role="img"
      aria-label={label}
    >
      <line
        x1="2"
        y1="6"
        x2="46"
        y2="6"
        stroke={stroke}
        strokeWidth="2"
        strokeDasharray={dash}
        opacity={opacity}
        strokeLinecap="round"
      />
      {variant === "running" && (
        <circle cx="24" cy="6" r="3" fill="var(--primary)" />
      )}
    </svg>
  );
}

function LegendRow({
  sample,
  name,
  desc,
}: {
  sample: ReactNode;
  name: string;
  desc: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex w-14 shrink-0 items-center justify-center">
        {sample}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm text-foreground">{name}</p>
        <p className="text-xs leading-snug text-muted-foreground">{desc}</p>
      </div>
    </div>
  );
}

function LegendGroup({
  title,
  children,
}: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="mb-3 text-xs font-medium text-muted-foreground">{title}</p>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

// 复刻 AgentNode 的徽章样式（这些是纯 span，无 Handle，可安全离开 ReactFlow 渲染）。
const tierBadge = (tier: "strong" | "fast") => (
  <span
    className={`rounded-full px-1.5 py-0.5 text-xs font-medium ${
      tier === "strong"
        ? "bg-primary/10 text-primary"
        : "bg-muted text-muted-foreground"
    }`}
  >
    {MODEL_TIER_META[tier].short}
  </span>
);

/** ③ 图例：节点 / 状态 / 连线 / 徽章的含义，样式与聊天内嵌图一字不差。 */
export function GraphLegend() {
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <LegendGroup title="节点">
        <LegendRow
          sample={
            <IconChip>
              <UserRound size={16} className="text-muted-foreground" />
            </IconChip>
          }
          name="你的任务"
          desc="本回合 prompt，无 run 的合成端点；点它跳回完整提问。"
        />
        <LegendRow
          sample={
            <IconChip>
              <Bot size={16} className="text-muted-foreground" />
            </IconChip>
          }
          name="worker 节点"
          desc="一个 worker run：角色 → 在干什么 → 用时 / 工具。"
        />
        <LegendRow
          sample={
            <IconChip>
              <Sparkles size={15} className="text-muted-foreground" />
            </IconChip>
          }
          name="CEO 汇总"
          desc="captain 根 run（汇聚点），状态全队派生，答案入气泡。"
        />
      </LegendGroup>

      <LegendGroup title="状态（节点色环）">
        <LegendRow
          sample={<Bot size={18} className="text-muted-foreground" />}
          name="等待中 pending"
          desc="未解锁或排队中，灰环。"
        />
        <LegendRow
          sample={<Loader2 size={18} className="animate-spin text-primary" />}
          name="执行中 running"
          desc="正在跑，primary 环 + 脉冲，入边走粒子流。"
        />
        <LegendRow
          sample={<CheckCircle2 size={18} className="text-success" />}
          name="已完成 completed"
          desc="success 环，进终态闪烁一次。"
        />
        <LegendRow
          sample={<XCircle size={18} className="text-destructive" />}
          name="失败 failed"
          desc="destructive 环；按 on_failure 处理，不必拖垮全 DAG。"
        />
      </LegendGroup>

      <LegendGroup title="连线">
        <LegendRow
          sample={<EdgeSample variant="dep" />}
          name="依赖（实线）"
          desc="depends_on——并行 / 串行的唯一开关。"
        />
        <LegendRow
          sample={<EdgeSample variant="delegate" />}
          name="委派（虚线）"
          desc="can_delegate：captain worker → 子 worker（一层）。"
        />
        <LegendRow
          sample={<EdgeSample variant="revision" />}
          name="修订（点线）"
          desc="原 run → 「修订 vN」续写，是版本不是新队员。"
        />
        <LegendRow
          sample={<EdgeSample variant="running" />}
          name="运行中（粒子流）"
          desc="run_output 流式：粒子由上游流向运行中节点。"
        />
      </LegendGroup>

      <LegendGroup title="徽章">
        <LegendRow
          sample={
            <span className="flex items-center gap-0.5">
              {tierBadge("strong")}
              {tierBadge("fast")}
            </span>
          }
          name="模型档"
          desc="强力档 / 快速档（model_preference 的 fast·strong 抽象）。"
        />
        <LegendRow
          sample={
            <span className="flex items-center gap-0.5 rounded-full bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary">
              <Sparkles size={10} />
              深度
            </span>
          }
          name="深度思考"
          desc="reasoning_effort = max，最强推理强度。"
        />
        <LegendRow
          sample={
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <CornerDownRight size={10} className="text-primary/70" />
              子任务
            </span>
          }
          name="子任务"
          desc="嵌套委派的子 worker（parent 是另一个 worker）。"
        />
        <LegendRow
          sample={
            <span className="flex items-center gap-0.5 rounded-full bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
              <PencilLine size={10} />
              vN
            </span>
          }
          name="热修修订 vN"
          desc="定向唤回：铅笔 + 版本号；卡片面优先露出改点（按指示：…）。"
        />
        <LegendRow
          sample={
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
              第 N 轮
            </span>
          }
          name="第 N 轮"
          desc="辩论续轮角标（与侧栏轮次轨一致），不再标成热修修订。"
        />
        <LegendRow
          sample={
            <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary">
              正方
            </span>
          }
          name="辩论立场"
          desc="stance 正方 / 反方，ELK 分带对置后汇聚裁决。"
        />
      </LegendGroup>
    </div>
  );
}
