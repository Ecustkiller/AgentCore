import { PageContainer } from "@/components/layout/PageContainer";
import {
  Brain,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Code2,
  Globe,
  type LucideIcon,
  Search,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

/**
 * 临时讨论页：单 Agent 回合「工具活动」前端展示的几种候选方案预览。
 *
 * 背景：CEO 单 Agent 直接调工具（联网搜索/读网页/检索代码/执行）时，后端发了
 * tool_use_start/end，但前端把事件路由进多 Agent 团队图谱、因「无 plan」全部丢弃，
 * 故气泡里看不到任何工具痕迹。此页用截图里那次「第三者赠与纠纷」调研回合的真实数据，
 * 把 4 种展示方案渲染成接近真实气泡的样子，供选型讨论。定稿后此页可删。
 */

type ToolType = "search" | "read" | "grep" | "exec";

interface ToolCall {
  id: string;
  type: ToolType;
  label: string;
  detail: string;
  result: string;
  status: "success" | "error" | "running";
}

const CALLS: ToolCall[] = [
  { id: "1", type: "search", label: "搜索网页", detail: "第三者赠与纠纷 法律实务", result: "命中 8 条结果", status: "success" },
  { id: "2", type: "read", label: "读取网页", detail: "婚姻法司法解释——夫妻共同财产赠与的效力", result: "提取正文约 6k 字", status: "success" },
  { id: "3", type: "read", label: "读取网页", detail: "最高法案例：赠与第三者财产应全额返还", result: "提取正文约 4k 字", status: "success" },
  { id: "4", type: "search", label: "搜索网页", detail: "赠与第三者 举证 与 返还范围", result: "命中 6 条结果", status: "success" },
  { id: "5", type: "read", label: "读取网页", detail: "人民法院报：第三者赠与纠纷的三个关键问题", result: "提取正文约 5k 字", status: "success" },
];

const TOOL_ICON: Record<ToolType, LucideIcon> = {
  search: Search,
  read: Globe,
  grep: Code2,
  exec: Terminal,
};

function ToolIcon({ type, className }: { type: ToolType; className?: string }) {
  const Icon = TOOL_ICON[type];
  return <Icon size={14} className={className} />;
}

function StatusIcon({ status }: { status: ToolCall["status"] }) {
  if (status === "running")
    return (
      <span className="mt-1.5 size-1.5 shrink-0 animate-pulse rounded-full bg-primary" />
    );
  if (status === "error")
    return <X size={14} className="mt-0.5 shrink-0 text-destructive" />;
  return <Check size={14} className="mt-0.5 shrink-0 text-success" />;
}

/** 一条工具行：图标 + 标签 + 参数 + 结果摘要 + 状态。A / C 共用。 */
function ToolRow({ call }: { call: ToolCall }) {
  return (
    <div className="flex items-start gap-2">
      <ToolIcon type={call.type} className="mt-0.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="text-sm text-foreground">
          <span className="font-medium">{call.label}</span>
          <span className="ml-1.5 text-muted-foreground">{call.detail}</span>
        </p>
        <p className="text-xs text-muted-foreground/70">{call.result}</p>
      </div>
      <StatusIcon status={call.status} />
    </div>
  );
}

/** 一个模拟助手气泡外壳。 */
function MockBubble({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-2.5 rounded-xl border border-border bg-card/40 p-4">
      {children}
    </div>
  );
}

/** 折叠态的「思考过程」条，用来锚定工具展示相对思考面板的位置。 */
function ThinkingStub() {
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Brain size={14} className="shrink-0" />
      <span>思考过程</span>
      <ChevronRight size={14} className="ml-auto shrink-0" />
    </div>
  );
}

function AnswerStub() {
  return (
    <p className="text-sm text-foreground">
      第三者赠与纠纷的核心：婚姻关系存续期间，一方未经配偶同意将
      <span className="font-medium">夫妻共同财产</span>
      赠与婚外第三者，因无权处分共有财产且违背公序良俗，通常认定
      <span className="font-medium">赠与无效</span>
      ，配偶可主张全额返还……
    </p>
  );
}

// ── 方案 A：内联折叠活动条（与 ThinkingPanel 并列、同款交互） ──
function OptionA() {
  const [open, setOpen] = useState(true);
  return (
    <MockBubble>
      <ThinkingStub />
      <div className="rounded-lg border border-border bg-muted/40">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-1.5 px-3 py-2 text-xs text-muted-foreground hover:text-foreground"
        >
          <Wrench size={14} className="shrink-0" />
          <span>已使用 {CALLS.length} 个工具</span>
          {open ? (
            <ChevronDown size={14} className="ml-auto shrink-0" />
          ) : (
            <ChevronRight size={14} className="ml-auto shrink-0" />
          )}
        </button>
        {open && (
          <div className="space-y-3 border-t border-border px-3 py-2.5">
            {CALLS.map((call) => (
              <ToolRow key={call.id} call={call} />
            ))}
          </div>
        )}
      </div>
      <AnswerStub />
    </MockBubble>
  );
}

// ── 方案 D：极简单行 chips ──
function OptionD() {
  return (
    <MockBubble>
      <ThinkingStub />
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-muted-foreground">
          <Search size={14} />
          搜索网页 ×2
        </span>
        <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-muted-foreground">
          <Globe size={14} />
          读取网页 ×3
        </span>
        <span className="text-muted-foreground/60">· 全部成功</span>
      </div>
      <AnswerStub />
    </MockBubble>
  );
}

// ── 方案 B：执行时间线（run 详情语言） ──
function TimelineStep({
  icon,
  label,
  detail,
  dotClass,
  last,
}: {
  icon: React.ReactNode;
  label: string;
  detail: string;
  dotClass: string;
  last?: boolean;
}) {
  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        <span className={`mt-1 size-2 shrink-0 rounded-full ${dotClass}`} />
        {!last && <span className="w-px flex-1 bg-border" />}
      </div>
      <div className={`min-w-0 ${last ? "" : "pb-3"}`}>
        <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          {icon}
          <span>{label}</span>
        </div>
        <p className="text-xs text-muted-foreground">{detail}</p>
      </div>
    </div>
  );
}

function OptionB() {
  return (
    <MockBubble>
      <div>
        <TimelineStep
          icon={<Brain size={14} className="text-muted-foreground" />}
          label="思考"
          detail="判断为婚内财产赠与，规划检索路径"
          dotClass="bg-muted-foreground/40"
        />
        {CALLS.map((call) => (
          <TimelineStep
            key={call.id}
            icon={<ToolIcon type={call.type} className="text-muted-foreground" />}
            label={call.label}
            detail={`${call.detail} · ${call.result}`}
            dotClass="bg-success"
          />
        ))}
        <TimelineStep
          icon={<Check size={14} className="text-primary" />}
          label="输出答案"
          detail="综合司法解释与案例生成结论"
          dotClass="bg-primary"
          last
        />
      </div>
      <AnswerStub />
    </MockBubble>
  );
}

// ── 方案 C：正文穿插工具卡 ──
function InlineCard({ call }: { call: ToolCall }) {
  return (
    <div className="rounded-lg border border-border bg-muted/30 px-3 py-2">
      <ToolRow call={call} />
    </div>
  );
}

function OptionC() {
  return (
    <MockBubble>
      <p className="text-sm italic text-muted-foreground">
        先确认这是婚姻关系中的共同财产赠与问题，需要检索相关司法解释与案例……
      </p>
      <InlineCard call={CALLS[0]} />
      <InlineCard call={CALLS[1]} />
      <p className="text-sm italic text-muted-foreground">
        案例支持全额返还，再补充举证与返还范围……
      </p>
      <InlineCard call={CALLS[3]} />
      <InlineCard call={CALLS[4]} />
      <AnswerStub />
    </MockBubble>
  );
}

// ── 方案 E：B+C 混合 —— 可折叠的「过程时间线」 ──
// 思考与工具按真实顺序交织（C 的时序）+ 时间线串起（B 的结构）+ 整条可折叠（A 的零噪音）；
// 最终答案始终独立在时间线下方，不被打碎。
type ProcessStep =
  | { kind: "think"; id: string; text: string }
  | { kind: "tool"; id: string; call: ToolCall };

const PROCESS: ProcessStep[] = [
  { kind: "think", id: "k1", text: "先确认这是婚姻关系中的共同财产赠与问题，规划检索司法解释与案例。" },
  { kind: "tool", id: "t1", call: CALLS[0] },
  { kind: "tool", id: "t2", call: CALLS[1] },
  { kind: "tool", id: "t3", call: CALLS[2] },
  { kind: "think", id: "k2", text: "案例支持全额返还，再补充举证责任与返还范围。" },
  { kind: "tool", id: "t4", call: CALLS[3] },
  { kind: "tool", id: "t5", call: CALLS[4] },
];

function ProcessRow({ step, last }: { step: ProcessStep; last: boolean }) {
  const isThink = step.kind === "think";
  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        <span
          className={`mt-1 size-2 shrink-0 rounded-full ${
            isThink ? "bg-muted-foreground/40" : "bg-success"
          }`}
        />
        {!last && <span className="w-px flex-1 bg-border" />}
      </div>
      <div className={`min-w-0 ${last ? "" : "pb-3"}`}>
        {step.kind === "think" ? (
          <div className="flex items-start gap-1.5">
            <Brain size={14} className="mt-0.5 shrink-0 text-muted-foreground" />
            <p className="text-sm italic text-muted-foreground">{step.text}</p>
          </div>
        ) : (
          <ToolRow call={step.call} />
        )}
      </div>
    </div>
  );
}

function OptionE() {
  const [open, setOpen] = useState(true);
  const toolCount = PROCESS.filter((s) => s.kind === "tool").length;
  return (
    <MockBubble>
      <div className="rounded-lg border border-border bg-muted/40">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-1.5 px-3 py-2 text-xs text-muted-foreground hover:text-foreground"
        >
          <Brain size={14} className="shrink-0" />
          <span>思考并使用了 {toolCount} 个工具</span>
          {open ? (
            <ChevronDown size={14} className="ml-auto shrink-0" />
          ) : (
            <ChevronRight size={14} className="ml-auto shrink-0" />
          )}
        </button>
        {open && (
          <div className="border-t border-border px-3 py-2.5">
            {PROCESS.map((step, i) => (
              <ProcessRow
                key={step.id}
                step={step}
                last={i === PROCESS.length - 1}
              />
            ))}
          </div>
        )}
      </div>
      <AnswerStub />
    </MockBubble>
  );
}

function OptionBlock({
  title,
  recommended,
  caption,
  children,
}: {
  title: string;
  recommended?: boolean;
  caption: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <h3 className="text-base font-medium text-foreground">{title}</h3>
        {recommended && (
          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
            推荐
          </span>
        )}
      </div>
      {children}
      <p className="text-xs text-muted-foreground">{caption}</p>
    </section>
  );
}

const COMPARISON: {
  name: string;
  density: string;
  order: string;
  noise: string;
  cost: string;
  replay: string;
  highlight?: boolean;
}[] = [
  { name: "E · B+C 混合（可折叠过程线）", density: "高（折叠后低）", order: "最高", noise: "低（折叠）", cost: "高", replay: "需持久化＋保序", highlight: true },
  { name: "A · 内联折叠条", density: "中（展开后高）", order: "中", noise: "低", cost: "低", replay: "需后端持久化" },
  { name: "B · 时间线", density: "高", order: "高", noise: "中", cost: "中", replay: "需后端持久化" },
  { name: "C · 正文穿插", density: "高", order: "最高", noise: "高", cost: "高", replay: "需持久化＋保序" },
  { name: "D · 单行 chips", density: "低", order: "低", noise: "最低", cost: "最低", replay: "易" },
];

export function ToolActivityPreview() {
  const navigate = useNavigate();

  return (
    <PageContainer width="canvas">
      <button
        type="button"
        onClick={() => navigate("/toolbox")}
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft size={16} />
        工具箱
      </button>

      <h1 className="text-xl font-semibold text-foreground">
        工具活动 · 展示方案预览
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">
        单 Agent 回合直接调工具时，前端目前完全不展示。下面用真实调研回合数据，预览
        4 种候选展示方案的气泡效果（方案 A 的活动条可点击折叠/展开）。
      </p>

      <div className="mt-4 rounded-xl border border-info/30 bg-info/10 p-3 text-sm text-foreground">
        <span className="font-medium">示例回合：</span>
        用户问「我想研究下第三者赠与纠纷的法律实务」→ CEO 执行了 5 次工具（搜索网页
        ×2 · 读取网页 ×3，全部成功），随后综合生成答案。        当前线上：这 5 次工具一个都看不到。
      </div>

      <section className="mt-6 space-y-2">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-medium text-foreground">
            E · B+C 混合：可折叠过程时间线
          </h2>
          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
            推荐
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          把「过程」收进一条
          <span className="font-medium text-foreground">可折叠的时间线</span>
          ：思考与工具
          <span className="font-medium text-foreground">按真实顺序交织</span>
          （C 的时序）、用时间线串起（B 的结构）、整条可折叠（默认流式展开、完成收起＝A
          的零噪音）；
          <span className="font-medium text-foreground">最终答案始终独立在时间线下方</span>
          、不被打碎。点下面的标题条试试折叠。
        </p>
        <div className="max-w-2xl">
          <OptionE />
        </div>
      </section>

      <h2 className="mt-8 text-base font-medium text-foreground">
        其余候选（对照）
      </h2>
      <div className="mt-3 grid grid-cols-1 gap-x-8 gap-y-7 lg:grid-cols-2">
        <OptionBlock
          title="A · 内联折叠活动条"
          caption="与现有「思考过程」面板并列、同款交互。默认折叠＝零噪音，点开＝完整透明度。改动最小，但工具与思考分两个面板、不交织。"
        >
          <OptionA />
        </OptionBlock>

        <OptionBlock
          title="D · 极简单行 chips"
          caption="噪音最低、改动最小，但只给「用了几次」、看不到搜了什么/读了哪篇，透明度最弱。可作为 A 折叠态的更轻形态。"
        >
          <OptionD />
        </OptionBlock>

        <OptionBlock
          title="B · 执行时间线"
          caption="借用多 Agent「run 详情」的时间线语言，时序完整、专业感强；占高度比 A 大，常驻展开会拉长气泡。"
        >
          <OptionB />
        </OptionBlock>

        <OptionBlock
          title="C · 正文穿插工具卡"
          caption="工具卡按真实发生顺序穿插在思考/正文之间，最忠实「边想边查边答」；但最显眼、最吵，与「inline 只做信号」原则冲突最大。"
        >
          <OptionC />
        </OptionBlock>
      </div>

      <h2 className="mt-8 text-base font-medium text-foreground">横向对比</h2>
      <div className="mt-2 overflow-hidden rounded-xl border border-border">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
              <th className="px-3 py-2 font-medium">方案</th>
              <th className="px-3 py-2 font-medium">信息密度</th>
              <th className="px-3 py-2 font-medium">时序忠实</th>
              <th className="px-3 py-2 font-medium">视觉噪音</th>
              <th className="px-3 py-2 font-medium">实现成本</th>
              <th className="px-3 py-2 font-medium">刷新可回放</th>
            </tr>
          </thead>
          <tbody>
            {COMPARISON.map((row) => (
              <tr
                key={row.name}
                className={`border-b border-border last:border-0 ${
                  row.highlight ? "bg-primary/5" : ""
                }`}
              >
                <td className="px-3 py-2 font-medium text-foreground">
                  {row.name}
                </td>
                <td className="px-3 py-2 text-muted-foreground">{row.density}</td>
                <td className="px-3 py-2 text-muted-foreground">{row.order}</td>
                <td className="px-3 py-2 text-muted-foreground">{row.noise}</td>
                <td className="px-3 py-2 text-muted-foreground">{row.cost}</td>
                <td className="px-3 py-2 text-muted-foreground">{row.replay}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-6 rounded-xl border border-primary/30 bg-primary/5 p-4">
        <h3 className="text-sm font-medium text-foreground">
          推荐：方案 E（B+C 混合）
        </h3>
        <p className="mt-1.5 text-sm text-muted-foreground">
          E 把 B 的「结构化时间线」与 C 的「真实时序交织」合成一条
          <span className="font-medium text-foreground">可折叠的过程时间线</span>
          ，再用 A 的折叠机制兜住噪音：流式时自动展开、你能看着它边想边查；完成后自动收起成一行
          「思考并使用了 N 个工具」，气泡保持干净。关键是
          <span className="font-medium text-foreground">把「过程」与「答案」分开</span>
          ——思考＋工具进时间线，最终答案独立在下方不被打碎（这正是 C 纯穿插最吵的根因）。
          顺带把现有「思考过程」面板并入这条时间线，过程从此只有一处、更连贯。
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          代价：成本最高。要按真实顺序交织思考与工具，需把 reasoning 流按工具调用边界切成段
          （前端按 SSE 到达顺序分段即可，后端已是有序流）；持久化也要保序存。若想先快出效果，可先落
          A（两个独立面板、不交织），后续再升级成 E。
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          落地等于推翻文档里「气泡内工具卡已否决 / 单 Agent 纯气泡」的旧决策，属产品取舍，定了我同步改{" "}
          <code className="rounded bg-muted px-1 py-0.5">前端UX设计.md</code>。 实现落点：
          <code className="rounded bg-muted px-1 py-0.5">stores/conversation.ts</code>（Message 加有序 process 流）·{" "}
          <code className="rounded bg-muted px-1 py-0.5">services/streamConversation.ts</code>（单 Agent 分支按序 append 思考段/工具）·{" "}
          <code className="rounded bg-muted px-1 py-0.5">components/chat/MessageBubble.tsx</code>（新增 ProcessTimeline，并入 ThinkingPanel）·{" "}
          <code className="rounded bg-muted px-1 py-0.5">runtime/events.py</code>（保序持久化）。
        </p>
      </div>
    </PageContainer>
  );
}
