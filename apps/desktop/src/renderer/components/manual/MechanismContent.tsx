import { AgentNode } from "@/components/graph/AgentNode";
import { EndpointNode } from "@/components/graph/EndpointNode";
import { StepEdge } from "@/components/graph/StepEdge";
import {
  EMBED_MIN_HEIGHT,
  type LayoutResult,
  NODE_HEIGHT,
  computeLayout,
  fitWidthBox,
} from "@/lib/elk-layout";
import { MODEL_TIER_META, type RunStatus } from "@/stores/execution";
import type { GraphEdge, GraphLayout } from "@/stores/graph";
import {
  Background,
  type Edge,
  type Node,
  type NodeChange,
  ReactFlow,
  type ReactFlowInstance,
} from "@xyflow/react";
import {
  Bot,
  CheckCircle2,
  ChevronRight,
  CornerDownRight,
  History,
  Loader2,
  Package,
  Sparkles,
  UserRound,
  Workflow,
  XCircle,
} from "lucide-react";
import {
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

/**
 * 运行机制内容块（产品手册「运行机制」组的 4 个内容件）。
 *
 * 由 `pages/toolbox/ProductManual.tsx` 组合渲染——本模块只提供内容件，全屏壳 / 顶栏 /
 * 左侧目录 / Esc 退出都归手册页。原「团队运行机制」独立页（`/toolbox/mechanism`）已并入
 * 产品手册（IA 见 `docs/04-前端/前端UX设计.md §十二`）。
 *
 * 四件：① `RuntimePanorama` 运行时全景 ② `CollaborationTurnFlow` 协作回合主线
 * ③ `GraphLegend` 图例 ④ `MechanismScenarios` 机制场景——后者是 **真实**
 * `AgentNode`/`EndpointNode`/`StepEdge` + **真实** ELK 布局 + 内嵌 fit-to-width（所见即聊天
 * 内嵌协作图），单列呈现并按需懒挂载（`LazyMount`）避免一次性挂 8 个 ReactFlow。
 *
 * 开发 / AI 价值靠源码自身：各数据块（PHASES / TURN_FLOW / SCENARIOS）旁以注释保留实现入口。
 * SSE 事件族见 `docs/03-AI核心/执行引擎架构设计.md §十二` + `runtime/events.py`·
 * `types/events.ts`；前端执行态见 `docs/04-前端 §9.x`。
 */

// `userInput`（非 `input`）：避开 ReactFlow 保留 type 名，否则默认样式表会给节点画
// 黑边/150px 固定宽（详见 GraphView.tsx 同处注释）。
const nodeTypes = {
  agent: AgentNode,
  userInput: EndpointNode,
  captain: EndpointNode,
};
const edgeTypes = { step: StepEdge };

// ────────────────────────────────────────────────────────────────────────────
// ① 运行时全景（请求管线）
// ────────────────────────────────────────────────────────────────────────────

// 实现入口（喂 AI，不渲染）：Prepare=runtime/pipeline.py · Execute=runtime/engine.py·runs/ ·
// Finalize=conversation/service.py
const PHASES: { title: string; icon: typeof Package; desc: string }[] = [
  {
    title: "Prepare",
    icon: Package,
    desc: "装配 CEO 工具集（只读/检索 + delegate）、注入会话历史；历史只回放文本，工具 I/O 不进 LLM 上下文。",
  },
  {
    title: "Execute（ReAct 循环）",
    icon: Workflow,
    desc: "CEO 思考 →（按需）delegate 组团 → WaveScheduler 跑 DAG → worker 执行 → CEO 收尾；收敛治理防机械循环。",
  },
  {
    title: "Finalize",
    icon: CheckCircle2,
    desc: "消息落库、用量计费、标题生成；断连也「能存多少存多少」，不全有或全无。",
  },
];

/** ① 运行时全景：Prepare → Execute → Finalize 三阶段。 */
export function RuntimePanorama() {
  return (
    <div className="flex flex-col gap-2 lg:flex-row lg:items-stretch">
      {PHASES.map((p, i) => {
        const Icon = p.icon;
        return (
          <Fragment key={p.title}>
            <div className="flex-1 rounded-xl border border-border bg-card p-4">
              <div className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Icon size={16} />
              </div>
              <p className="mt-3 text-sm font-medium text-foreground">
                {p.title}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {p.desc}
              </p>
            </div>
            {i < PHASES.length - 1 && (
              <ChevronRight
                size={16}
                className="hidden shrink-0 self-center text-muted-foreground lg:block"
              />
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// ② 协作回合主线（图怎么活起来）
// ────────────────────────────────────────────────────────────────────────────

// 实现入口（喂 AI，不渲染）：步骤 → SSE 事件 → 代码
//  1 用户输入       turn_saved                              GraphView · INPUT_ID
//  2 CEO 判断组团    delegate(tasks, depends_on)             tools/builtin/delegate.py
//  3 run_plan 预声明 run_plan                                runs/builder.py
//  4 逐波调度       run_started · run_progress              runs/wave.py
//  5 worker 执行    run_output_delta→run_completed/failed   runs/executor.py · engine.py
//  6 CEO 收尾       content_delta                           tools/builtin/delegate.py
//  7 答案入气泡     message_end                             GraphView · captainRun
// SSE 事件语义详见 docs/03-AI核心/执行引擎架构设计.md §十二。
const TURN_FLOW: {
  title: string;
  desc: string;
  note?: string;
}[] = [
  {
    title: "用户输入",
    desc: "你的提问落库；图上是「你的任务」端点（无 run 的合成节点）。",
    note: "回传权威 user_message_id，前端把乐观气泡换成真实行。",
  },
  {
    title: "CEO 判断是否组团",
    desc: "chat 档直接流式作答（零编排开销）；只有需要产出 / 变更或团队时才调 delegate。",
    note: "并行/串行由 depends_on 数据声明，不靠模型主动发并行调用。",
  },
  {
    title: "run_plan 预声明",
    desc: "一次性把本批 run 节点点亮为 pending，图在开跑前即成形（带 parent_run_id 成组）。",
  },
  {
    title: "WaveScheduler 逐波调度",
    desc: "无依赖的节点同波并行起跑，有依赖的等上游齐了再解锁；asyncio 协程并发。",
  },
  {
    title: "worker 执行",
    desc: "每个 worker 跑自己的 ReAct 循环（工具调用 + 收敛治理），答案流式推送、入边走粒子流。",
  },
  {
    title: "CEO 收尾汇报",
    desc: "非终态返回 CEO，用自己的声音写一段简短概览；单 worker 且 finalize 时其产出直接作答。",
  },
  {
    title: "答案入气泡",
    desc: "CEO 汇聚点节点 = 这段最终答案，点它跳到气泡；回合收口。",
    note: "含 finish_reason / usage，前端递归收口悬挂节点兜底。",
  },
];

/** ② 协作回合主线：从你的提问到答案落进气泡的完整生命周期。 */
export function CollaborationTurnFlow() {
  return (
    <ol className="space-y-0">
      {TURN_FLOW.map((s, i) => (
        <li key={s.title} className="flex gap-3">
          <div className="flex flex-col items-center">
            <span className="z-10 flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary">
              {i + 1}
            </span>
            {i < TURN_FLOW.length - 1 && (
              <span className="my-1 w-px flex-1 bg-border" />
            )}
          </div>
          <div className="min-w-0 flex-1 pb-5">
            <p className="text-sm font-medium text-foreground">{s.title}</p>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              {s.desc}
            </p>
            {s.note && (
              <p className="mt-1 text-xs text-muted-foreground/70">{s.note}</p>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// ③ 图例（每个符号的含义）
// ────────────────────────────────────────────────────────────────────────────

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
            <span className="flex items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary">
              <History size={10} />
              修订 v2
            </span>
          }
          name="修订 vN"
          desc="多轮热修：唤回原队员带记忆续写的新版本。"
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

// ────────────────────────────────────────────────────────────────────────────
// ④ 机制场景（真实节点 + 真实 ELK 布局）
// ────────────────────────────────────────────────────────────────────────────

interface PreviewNode {
  id: string;
  type: "agent" | "userInput" | "captain";
  data: Record<string, unknown>;
}

interface Scenario {
  title: string;
  desc: string;
  /** ELK 布局；缺省走左右流（与产品默认一致）。串行链用 "tree" 自上而下读。 */
  layout?: GraphLayout;
  nodes: PreviewNode[];
  edges: GraphEdge[];
}

/** worker 节点：默认补齐 AgentNodeData 必填项，`extra` 覆盖差异化字段。 */
const agent = (
  id: string,
  role: string,
  status: RunStatus,
  extra: Record<string, unknown> = {},
): PreviewNode => ({
  id,
  type: "agent",
  data: {
    agentId: id,
    runId: id,
    role,
    status,
    isAnimating: status === "running",
    task: "",
    outputPreview: "",
    tokenCount: 0,
    toolCount: 0,
    focused: false,
    ...extra,
  },
});

const input = (label: string): PreviewNode => ({
  id: "__input__",
  type: "userInput",
  data: { variant: "input", status: "completed", label },
});

const captain = (id: string, status: RunStatus, preview = ""): PreviewNode => ({
  id,
  type: "captain",
  data: { variant: "captain", status, label: "", preview },
});

const edge = (
  source: string,
  target: string,
  kind: "dep" | "delegate" | "revision" = "dep",
): GraphEdge => ({ id: `${source}->${target}`, source, target, kind });

const SCENARIOS: Scenario[] = [
  {
    title: "并行扇出（fan-out）",
    desc: "三个 worker 的 depends_on 均为空 → WaveScheduler 判为同一波、asyncio 并发起跑；全部完成后 CEO 汇聚点收尾。并行度是数据（depends_on）不是模式。",
    // 实现：runs/wave.py
    nodes: [
      input("把这个需求拆成三块并行做"),
      agent("w1", "文件操作员", "completed", {
        task: "创建 greeting.txt 并写入测试输出",
        durationMs: 4200,
        toolCount: 3,
        modelPreference: "fast",
      }),
      agent("w2", "文件操作员", "completed", {
        task: "创建测试笔记文件并记录测试过程",
        durationMs: 5100,
        toolCount: 2,
        modelPreference: "fast",
      }),
      agent("w3", "脚本编写员", "completed", {
        task: "编写多行打印脚本并验证可运行",
        durationMs: 6800,
        toolCount: 5,
        modelPreference: "strong",
      }),
      captain(
        "cap",
        "completed",
        "三个文件都已在工作区根目录创建完成，均可直接查看与运行。",
      ),
    ],
    edges: [
      edge("__input__", "w1"),
      edge("__input__", "w2"),
      edge("__input__", "w3"),
      edge("w1", "cap"),
      edge("w2", "cap"),
      edge("w3", "cap"),
    ],
  },
  {
    title: "串行流水线（depends_on 链）",
    layout: "tree",
    desc: "调研 → 分析 → 撰写：每个节点 depends_on 上一个，调度器逐个解锁；上游 RunState.content 按 result_handling（默认全文）注入下游。树形布局自上而下读更顺。",
    // 实现：runs/executor.py
    nodes: [
      input("调研近 7 日成本趋势并产出一段摘要"),
      agent("s1", "调研员", "completed", {
        task: "检索成本相关数据源与口径",
        durationMs: 3400,
        toolCount: 2,
        modelPreference: "fast",
      }),
      agent("s2", "数据分析师", "completed", {
        task: "汇总近 7 日成本趋势、定位异常点",
        durationMs: 5200,
        toolCount: 1,
        modelPreference: "strong",
      }),
      agent("s3", "文案", "completed", {
        task: "据分析结论撰写一段可读摘要",
        durationMs: 2600,
        modelPreference: "fast",
      }),
      captain("scap", "completed", "成本趋势摘要已生成，关键异常已标注。"),
    ],
    edges: [
      edge("__input__", "s1"),
      edge("s1", "s2"),
      edge("s2", "s3"),
      edge("s3", "scap"),
    ],
  },
  {
    title: "执行中（流式输出 · 待定 · 深度思考）",
    desc: "运行中节点带脉冲 + run_output 流式预览 + 光标，入边走 primary 粒子流；未解锁节点灰显 pending；reasoning=max 的 worker 带「深度」徽章。",
    // 实现：runtime/events.py
    nodes: [
      input("分析近 7 日成本趋势并产出一段摘要"),
      agent("r1", "调研员", "running", {
        task: "检索最佳实践",
        outputPreview:
          "正在检索 React Flow 自定义节点的最佳实践，已找到 3 篇相关文档，正在归纳关键结论",
        toolCount: 2,
        modelPreference: "strong",
        reasoningEffort: "max",
      }),
      agent("r2", "数据分析师", "completed", {
        task: "汇总近 7 日成本趋势数据",
        durationMs: 3200,
        toolCount: 1,
        modelPreference: "fast",
      }),
      agent("r3", "文案", "pending", {
        task: "根据分析结论撰写一段摘要",
        modelPreference: "fast",
      }),
      captain("cap2", "pending", ""),
    ],
    edges: [
      edge("__input__", "r1"),
      edge("__input__", "r2"),
      edge("__input__", "r3"),
      edge("r1", "cap2"),
      edge("r2", "cap2"),
      edge("r3", "cap2"),
    ],
  },
  {
    title: "辩论 / 审查（正方 · 反方）",
    desc: "带 stance 标记的普通 AGENT DAG（非独立模式）。ELK considerModelOrder 把正 / 反分带对置，再汇聚到 CEO 裁决；立场徽章用 primary 令牌、与状态色解耦。",
    // 实现：lib/elk-layout.ts
    nodes: [
      input("评估是否采用激进重构方案"),
      agent("pro", "架构师", "completed", {
        stance: "pro",
        task: "论证采用激进重构方案的收益与可行性",
        durationMs: 5000,
        modelPreference: "strong",
      }),
      agent("con", "架构师", "completed", {
        stance: "con",
        task: "论证保持稳健迭代、反对激进重构的理由",
        durationMs: 4800,
        modelPreference: "strong",
      }),
      captain(
        "cap3",
        "completed",
        "综合正反双方论点，建议分阶段推进：先在隔离分支验证关键风险，再决定是否全量切换。",
      ),
    ],
    edges: [
      edge("__input__", "pro"),
      edge("__input__", "con"),
      edge("pro", "cap3"),
      edge("con", "cap3"),
    ],
  },
  {
    title: "嵌套小队（can_delegate，一层）+ 失败",
    desc: "项目经理被标 can_delegate → 获得绑定自身的 delegate，再带一支小队（虚线委派边 + 子任务徽章）。子 worker 失败按 on_failure 处理，红环 + 红叉，不拖垮整 DAG。",
    // 实现：runs/executor.py
    nodes: [
      input("实现一个新设置页，前端 + 测试分工完成"),
      agent("pm", "项目经理", "completed", {
        task: "拆解任务并协调子团队",
        durationMs: 8000,
        toolCount: 1,
        modelPreference: "strong",
      }),
      agent("fe", "前端开发", "completed", {
        task: "实现页面组件与样式",
        durationMs: 6000,
        toolCount: 4,
        modelPreference: "strong",
        isSubtask: true,
      }),
      agent("qa", "测试", "failed", {
        task: "为新页面编写单元测试",
        modelPreference: "fast",
        isSubtask: true,
      }),
      captain(
        "cap4",
        "completed",
        "页面主体已完成并通过自测；测试子任务失败，待修复后补单测。",
      ),
    ],
    edges: [
      edge("__input__", "pm"),
      edge("pm", "fe", "delegate"),
      edge("pm", "qa", "delegate"),
      edge("pm", "cap4"),
    ],
  },
  {
    title: "多层嵌套（depth ≤ 2）+ 子树整体下沉",
    desc: "CEO(0) → worker(1) → sub-worker(2)：深度 2 永不再获 delegate（硬上限封死递归）。整条委派子树作为整体下沉到主干线之下，CEO 汇聚点恒在末层、不被横穿。",
    // 实现：runs/constants.py
    nodes: [
      input("拆解并实现协作图，前端再分一层小队"),
      agent("mpm", "项目经理", "completed", {
        task: "拆解任务、协调前端小队",
        durationMs: 9000,
        toolCount: 1,
        modelPreference: "strong",
      }),
      agent("lead", "前端组长", "completed", {
        task: "细分前端工作并分派给队员",
        durationMs: 6500,
        toolCount: 2,
        modelPreference: "strong",
        isSubtask: true,
      }),
      agent("eng1", "前端工程师", "completed", {
        task: "实现预览页布局与卡片样式",
        durationMs: 5200,
        toolCount: 4,
        modelPreference: "fast",
        isSubtask: true,
      }),
      agent("eng2", "前端工程师", "running", {
        task: "接入真实 ELK 布局并联调",
        outputPreview: "正在把 fit-to-width 接到内嵌画布，已联通 2/3…",
        toolCount: 2,
        modelPreference: "fast",
        isSubtask: true,
      }),
      captain("mcap", "pending", ""),
    ],
    edges: [
      edge("__input__", "mpm"),
      edge("mpm", "lead", "delegate"),
      edge("lead", "eng1", "delegate"),
      edge("lead", "eng2", "delegate"),
      edge("mpm", "mcap"),
    ],
  },
  {
    title: "多轮热修（修订 vN 版本链）",
    desc: "后续消息要求返工时，CEO 经 revise 唤回原队员带现场记忆续写，图上挂一条点线「修订 vN」版本链——是同一节点的新版本，不是新队员（留人双 miss 才回落重派）。",
    // 实现：tools/builtin/revise.py
    nodes: [
      input("把上一版报告的第 2 章重写得更详细"),
      agent("orig", "撰写员", "completed", {
        task: "撰写报告初稿",
        durationMs: 6400,
        toolCount: 2,
        modelPreference: "strong",
      }),
      agent("rev", "撰写员", "completed", {
        task: "按反馈重写第 2 章并扩充论据",
        durationMs: 3800,
        toolCount: 1,
        modelPreference: "strong",
        isRevision: true,
        revision: 2,
      }),
      captain("rcap", "completed", "已交付重写后的第 2 章，其余章节沿用初稿。"),
    ],
    edges: [
      edge("__input__", "orig"),
      edge("orig", "rcap"),
      edge("orig", "rev", "revision"),
    ],
  },
  {
    title: "超大团队（9 路并行 · 执行中）",
    desc: "并行度拉满（max_parallel = 10 上限内）：横向填满列宽、纵向超过内嵌高度上限(520) → 顶对齐 + 底部渐隐示意「还有更多」，看全图进全屏。也用来检验小缩放下节点是否仍可读。",
    // 实现：runs/wave.py
    nodes: [
      input("把这份长报告拆成 9 块并行润色"),
      agent("b1", "润色员", "completed", {
        task: "润色第 1 章：引言",
        durationMs: 2600,
        toolCount: 1,
        modelPreference: "fast",
      }),
      agent("b2", "润色员", "completed", {
        task: "润色第 2 章：背景",
        durationMs: 3100,
        toolCount: 1,
        modelPreference: "fast",
      }),
      agent("b3", "润色员", "completed", {
        task: "润色第 3 章：方法",
        durationMs: 4200,
        toolCount: 2,
        modelPreference: "fast",
      }),
      agent("b4", "润色员", "completed", {
        task: "润色第 4 章：实验",
        durationMs: 3800,
        toolCount: 1,
        modelPreference: "fast",
      }),
      agent("b5", "润色员", "completed", {
        task: "润色第 5 章：结果",
        durationMs: 2900,
        toolCount: 1,
        modelPreference: "fast",
      }),
      agent("b6", "润色员", "completed", {
        task: "润色第 6 章：讨论",
        durationMs: 3300,
        toolCount: 2,
        modelPreference: "fast",
      }),
      agent("b7", "润色员", "running", {
        task: "润色第 7 章：相关工作",
        outputPreview: "正在统一术语与时态，已处理 12 处表述，剩余约 1/3…",
        toolCount: 1,
        modelPreference: "fast",
      }),
      agent("b8", "润色员", "pending", {
        task: "润色第 8 章：局限性",
        modelPreference: "fast",
      }),
      agent("b9", "校对员", "failed", {
        task: "全文交叉引用与编号校对",
        modelPreference: "strong",
      }),
      captain("bcap", "pending", ""),
    ],
    edges: ["b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8", "b9"].flatMap(
      (id) => [edge("__input__", id), edge(id, "bcap")],
    ),
  },
];

/** 单个场景的内嵌画布：跑真实 ELK 布局 + 内嵌 fit-to-width 定高，复刻聊天内嵌形态。 */
function ScenarioGraph({ scenario }: { scenario: Scenario }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [colWidth, setColWidth] = useState(0);
  const [layout, setLayout] = useState<LayoutResult | null>(null);
  const [inst, setInst] = useState<ReactFlowInstance | null>(null);
  // 方案 D（真居中，与 GraphView 同源）：按真实测量高度把节点回中到 ELK 固定槽位，连线
  // 锚点齐平 → 1→1 边笔直、接真正中；只读高度不重排。
  const [nodeHeights, setNodeHeights] = useState<Record<string, number>>({});
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodeHeights((prev) => {
      let next = prev;
      for (const c of changes) {
        if (c.type === "dimensions" && c.dimensions) {
          const h = c.dimensions.height;
          if (h > 0 && prev[c.id] !== h) {
            if (next === prev) next = { ...prev };
            next[c.id] = h;
          }
        }
      }
      return next;
    });
  }, []);

  const debate = scenario.nodes.some(
    (n) => n.type === "agent" && (n.data as { stance?: string }).stance != null,
  );

  // 实测内嵌画布宽度（= 阅读列宽），fit-to-width 据此缩放。
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setColWidth(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w > 0) setColWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const layoutKind = scenario.layout ?? "leftright";

  // 真实 ELK 布局（含收紧间距）；辩论场景传 preserveOrder 让正反分带，并把端点（用户
  // 输入 / CEO 汇聚点）钉到首 / 末层，复刻 GraphView 的端点约束。
  useEffect(() => {
    let cancelled = false;
    computeLayout(
      scenario.nodes.map((n) => n.id),
      scenario.edges,
      layoutKind,
      debate,
      {
        source: scenario.nodes.find((n) => n.type === "userInput")?.id,
        sink: scenario.nodes.find((n) => n.type === "captain")?.id,
      },
    ).then((res) => {
      if (!cancelled) setLayout(res);
    });
    return () => {
      cancelled = true;
    };
  }, [scenario, debate, layoutKind]);

  const fit =
    layout && colWidth > 0
      ? fitWidthBox(layout.width, layout.height, colWidth)
      : null;

  // 与 GraphView 内嵌一致：只缩不放，居中，超高顶对齐。
  useEffect(() => {
    if (!inst || !layout || !fit) return;
    const x = Math.max(0, (colWidth - fit.renderedWidth) / 2);
    const y =
      fit.renderedHeight <= fit.height
        ? (fit.height - fit.renderedHeight) / 2
        : 0;
    inst.setViewport({ x, y, zoom: fit.zoom });
  }, [inst, layout, fit, colWidth]);

  const flowNodes = useMemo<Node[]>(() => {
    if (!layout) return [];
    // 左右流→连线锚点在左右；树形(DOWN)→锚点在上下，否则边会从节点侧面斜拉。
    const handleDirection = layoutKind === "tree" ? "vertical" : "horizontal";
    // 方案 D：按真实高度把节点居中到槽位（displayY = slot.y + (NODE_HEIGHT − 实测高)/2）。
    const placed = (id: string, slot: { x: number; y: number }) => {
      const h = nodeHeights[id];
      return h ? { x: slot.x, y: slot.y + (NODE_HEIGHT - h) / 2 } : slot;
    };
    return scenario.nodes.map(
      (n, i) =>
        ({
          id: n.id,
          type: n.type,
          position: placed(n.id, layout.positions[n.id] ?? { x: 0, y: 0 }),
          data: { ...n.data, handleDirection, enterIndex: i },
        }) as Node,
    );
  }, [scenario, layout, layoutKind, nodeHeights]);

  const flowEdges = useMemo<Edge[]>(() => {
    const statusOf = new Map(
      scenario.nodes.map((n) => [n.id, n.data.status as string]),
    );
    return scenario.edges.map(
      (e) =>
        ({
          id: e.id,
          source: e.source,
          target: e.target,
          type: "step",
          data: {
            kind: e.kind ?? "dep",
            animated: statusOf.get(e.target) === "running",
          },
        }) as Edge,
    );
  }, [scenario]);

  return (
    <div>
      <h3 className="text-sm font-medium text-foreground">{scenario.title}</h3>
      <p className="mb-2 mt-0.5 text-xs leading-relaxed text-muted-foreground">
        {scenario.desc}
      </p>
      <div
        ref={containerRef}
        className="relative overflow-hidden rounded-xl border border-border bg-card"
        style={{ height: fit?.height ?? EMBED_MIN_HEIGHT }}
      >
        {layout && colWidth > 0 && (
          <ReactFlow
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onInit={setInst}
            onNodesChange={onNodesChange}
            nodesDraggable={false}
            nodesConnectable={false}
            nodesFocusable={false}
            zoomOnScroll={false}
            zoomOnPinch={false}
            zoomOnDoubleClick={false}
            panOnDrag={false}
            preventScrolling={false}
            minZoom={0.05}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={20} size={1} />
          </ReactFlow>
        )}
        {/* 与 GraphView 内嵌一致：超过高度上限(520)时顶对齐 + 底部渐隐示意「还有更多」。 */}
        {fit?.overflowing && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-card to-transparent" />
        )}
      </div>
    </div>
  );
}

/**
 * 视口懒挂载：滚动进入（提前 200px）才挂子树，避免一次性挂 8 个 ReactFlow。
 * 占位用 minHeight 防跳动。
 */
function LazyMount({
  minHeight,
  children,
}: {
  minHeight: number;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (show) return;
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShow(true);
          obs.disconnect();
        }
      },
      { rootMargin: "200px 0px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [show]);
  return (
    <div ref={ref} style={show ? undefined : { minHeight }}>
      {show ? children : null}
    </div>
  );
}

/** ④ 机制场景：8 个真实协作图，单列呈现、按需懒挂载。 */
export function MechanismScenarios() {
  return (
    <div className="space-y-8">
      {SCENARIOS.map((s) => (
        <LazyMount key={s.title} minHeight={EMBED_MIN_HEIGHT + 56}>
          <ScenarioGraph scenario={s} />
        </LazyMount>
      ))}
    </div>
  );
}
