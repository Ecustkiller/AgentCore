import {
  CollaborationTurnFlow,
  GraphLegend,
  MechanismScenarios,
  RuntimePanorama,
} from "@/components/manual/MechanismContent";
import { useUIStore } from "@/stores/ui";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  BookOpen,
  Brain,
  ChevronRight,
  Compass,
  Crown,
  FolderOpen,
  HelpCircle,
  Info,
  Layers,
  LayoutGrid,
  Lightbulb,
  type LucideIcon,
  MessageSquare,
  Minus,
  Network,
  Rocket,
  Route,
  Settings,
  Sparkles,
  Square,
  UsersRound,
  Wrench,
  X,
} from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

/**
 * 产品手册页（`/toolbox/manual`，工具箱「了解平台」组——本页是「了解平台」唯一入口）。
 *
 * 真·全屏页（`fixed inset-0` 覆盖整窗含应用 TitleBar，顶栏自带窗口拖拽区 + 自绘最小化 /
 * 最大化 / 关闭控件，返回 / Esc 退出），面向用户的手册（截图对外展示点）：左侧目录（滚动
 * 联动高亮）+ 右侧阅读列，四组——开始 / 核心功能 / 运行机制 / 进阶 & 帮助。
 *
 * 原「团队运行机制」独立页已并入本页「运行机制」组（IA 见 `docs/04-前端/前端UX设计.md
 * §十二`）：运行时全景 / 协作回合主线 / 图例 / 机制场景（真实协作图）四件由
 * `components/manual/MechanismContent.tsx` 提供，本页只负责壳与编排。深链 `?s=<sectionId>`
 * 进入即滚动到对应章节（命令面板「团队运行机制」走 `?s=panorama`）。
 */

// ────────────────────────────────────────────────────────────────────────────
// 通用呈现件
// ────────────────────────────────────────────────────────────────────────────

/** 段落内导航链接（hash 路由内跳转）。 */
function GoLink({ to, children }: { to: string; children: ReactNode }) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => navigate(to)}
      className="font-medium text-primary underline-offset-2 hover:underline"
    >
      {children}
    </button>
  );
}

/** 段落内「跳到本页某章节」链接（同页平滑滚动，不走路由）。 */
function JumpLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={() =>
        document
          .getElementById(to)
          ?.scrollIntoView({ behavior: "smooth", block: "start" })
      }
      className="font-medium text-primary underline-offset-2 hover:underline"
    >
      {children}
    </button>
  );
}

function Lead({ children }: { children: ReactNode }) {
  return (
    <p className="text-sm leading-relaxed text-muted-foreground">{children}</p>
  );
}

const CALLOUT = {
  tip: { Icon: Lightbulb, box: "border-primary/30 bg-primary/5", icon: "text-primary" },
  info: { Icon: Info, box: "border-info/30 bg-info/5", icon: "text-info" },
  warning: {
    Icon: AlertTriangle,
    box: "border-warning/30 bg-warning/5",
    icon: "text-warning",
  },
} as const;

function Callout({
  variant = "tip",
  children,
}: {
  variant?: keyof typeof CALLOUT;
  children: ReactNode;
}) {
  const c = CALLOUT[variant];
  const Icon = c.Icon;
  return (
    <div className={`flex gap-3 rounded-xl border p-4 ${c.box}`}>
      <Icon size={16} className={`mt-0.5 shrink-0 ${c.icon}`} />
      <div className="text-sm leading-relaxed text-foreground">{children}</div>
    </div>
  );
}

function CardGrid({
  cols = 2,
  children,
}: {
  cols?: 2 | 3;
  children: ReactNode;
}) {
  return (
    <div
      className={`grid gap-3 ${cols === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}
    >
      {children}
    </div>
  );
}

function InfoCard({
  icon,
  title,
  desc,
}: {
  icon?: ReactNode;
  title: string;
  desc: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      {icon && (
        <div className="mb-2 flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
          {icon}
        </div>
      )}
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{desc}</p>
    </div>
  );
}

/** 编号步骤竖列（与「团队运行机制」回合主线同构）。 */
function Steps({ items }: { items: { title: string; desc: ReactNode }[] }) {
  return (
    <ol className="space-y-0">
      {items.map((s, i) => (
        <li key={s.title} className="flex gap-3">
          <div className="flex flex-col items-center">
            <span className="z-10 flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary">
              {i + 1}
            </span>
            {i < items.length - 1 && (
              <span className="my-1 w-px flex-1 bg-border" />
            )}
          </div>
          <div className="min-w-0 flex-1 pb-5">
            <p className="text-sm font-medium text-foreground">{s.title}</p>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              {s.desc}
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}

function Bullets({ items }: { items: { title: string; desc: string }[] }) {
  return (
    <ul className="space-y-2.5">
      {items.map((b) => (
        <li key={b.title} className="flex gap-2.5">
          <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-primary/60" />
          <p className="text-sm leading-relaxed text-foreground">
            <span className="font-medium">{b.title}</span>
            <span className="text-muted-foreground"> — {b.desc}</span>
          </p>
        </li>
      ))}
    </ul>
  );
}

function Faq({ items }: { items: { q: string; a: ReactNode }[] }) {
  return (
    <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
      {items.map((f) => (
        <div key={f.q} className="p-4">
          <p className="text-sm font-medium text-foreground">{f.q}</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {f.a}
          </p>
        </div>
      ))}
    </div>
  );
}

/** 设置速查：每行跳到对应设置页。 */
function SettingsTable() {
  const navigate = useNavigate();
  const rows: { label: string; desc: string; to: string }[] = [
    { label: "模型配置", desc: "填入 API Key（BYOK）、选择团队使用的模型", to: "/more/model" },
    { label: "用量", desc: "查看花费与额度", to: "/more/usage" },
    { label: "外观", desc: "明暗主题与界面偏好", to: "/more/appearance" },
    { label: "快捷键", desc: "常用操作的键盘快捷键", to: "/more/shortcuts" },
    { label: "关于", desc: "版本与产品信息", to: "/more/about" },
  ];
  return (
    <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
      {rows.map((r) => (
        <button
          key={r.to}
          type="button"
          onClick={() => navigate(r.to)}
          className="flex w-full items-center gap-3 p-3 text-left transition-colors hover:bg-accent/50"
        >
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">{r.label}</p>
            <p className="text-xs text-muted-foreground">{r.desc}</p>
          </div>
          <ChevronRight size={16} className="shrink-0 text-muted-foreground" />
        </button>
      ))}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// 手册内容（结构化写在页面里，便于内嵌示意与 AI 维护）
// ────────────────────────────────────────────────────────────────────────────

type GroupId = "start" | "core" | "mechanism" | "advanced";

interface ManualSection {
  id: string;
  group: GroupId;
  nav: string;
  Icon: LucideIcon;
  title: string;
  render: () => ReactNode;
}

const GROUP_LABELS: Record<GroupId, string> = {
  start: "开始",
  core: "核心功能",
  mechanism: "运行机制",
  advanced: "进阶 & 帮助",
};

const SECTIONS: ManualSection[] = [
  {
    id: "what",
    group: "start",
    nav: "这是什么",
    Icon: Compass,
    title: "这是什么",
    render: () => (
      <>
        <Lead>
          AgentCore 是一个协作智能平台。和别的 AI
          不同，你在这里不是「和一个助手聊天」，而是「管理一支 AI
          团队」——你定目标，团队来分工、协作、互审，共同完成复杂任务。
        </Lead>
        <Callout variant="tip">
          一句话记住它：<span className="font-medium">协作，是更高级的智能。</span>
          单个模型的智能有天花板，协作没有。
        </Callout>
        <p className="text-sm font-medium text-foreground">你的角色升级了</p>
        <CardGrid cols={3}>
          <InfoCard title="在 ChatGPT / Claude" desc="你是提示者：来回追问，自己拼装结果。" />
          <InfoCard title="在 Cursor / Codex" desc="你是指令者：逐条下达，盯着单个助手执行。" />
          <InfoCard
            icon={<Crown size={16} />}
            title="在 AgentCore"
            desc="你是领导者：定目标与约束，把分工交给团队。"
          />
        </CardGrid>
        <Lead>
          你面对的是一位 CEO 主
          Agent。简单问题它直接回答；复杂任务它会自动组建团队、分派子任务、汇总结果再向你汇报。
        </Lead>
      </>
    ),
  },
  {
    id: "quickstart",
    group: "start",
    nav: "5 分钟快速上手",
    Icon: Rocket,
    title: "5 分钟快速上手",
    render: () => (
      <>
        <Lead>四步跑通你的第一个任务。</Lead>
        <Steps
          items={[
            {
              title: "配置模型",
              desc: (
                <>
                  打开 <GoLink to="/more/model">设置 · 模型配置</GoLink>
                  ，填入你的 API Key（BYOK），并选择团队使用的模型。
                </>
              ),
            },
            {
              title: "新建对话",
              desc: "回到对话页，像聊天一样用自然语言描述你的目标。",
            },
            {
              title: "看团队工作",
              desc: "简单问题会被秒回；复杂任务会出现协作图，实时显示每个成员在做什么。",
            },
            {
              title: "收获结果",
              desc: "CEO 汇总团队产出给你一份最终答案；生成的文件落在工作区里。",
            },
          ]}
        />
        <Callout variant="tip">
          第一个任务试试这句：「把这个需求拆成三块并行做：A、B、C」。你会看到团队同时开工。
        </Callout>
      </>
    ),
  },
  {
    id: "mindset",
    group: "start",
    nav: "核心心智：你是领导者",
    Icon: Crown,
    title: "核心心智：你是领导者",
    render: () => (
      <>
        <Lead>用好 AgentCore 的关键，是切换到「带团队」的思维方式。</Lead>
        <Bullets
          items={[
            {
              title: "你定方向，不必给步骤",
              desc: "说清目标与约束，怎么拆、谁来做交给 CEO。",
            },
            {
              title: "简单事直接答，复杂事才组团",
              desc: "纯对话零编排开销，不必担心「小问题也兴师动众」。",
            },
            {
              title: "全程可见、随时可管",
              desc: "协作图实时展示进度，你可以暂停、追问、要求返工。",
            },
          ]}
        />
        <Callout variant="info">
          CEO 是你的唯一对接人。你只和它对话，它负责调度整支团队：按需组团、用 DAG
          安排并行 / 串行、最后把结果收口给你。
        </Callout>
      </>
    ),
  },
  {
    id: "chat",
    group: "core",
    nav: "对话",
    Icon: MessageSquare,
    title: "对话",
    render: () => (
      <>
        <Lead>一切从对话开始——把它当成你和团队的指挥台。</Lead>
        <Bullets
          items={[
            { title: "自然语言提需求", desc: "用日常说法描述目标，无需命令格式。" },
            { title: "富表达", desc: "支持代码、富文本、引用工作区里的文件。" },
            { title: "会话管理", desc: "左侧列表管理历史对话，可分组、检索、续聊。" },
          ]}
        />
        <Callout variant="tip">
          描述越具体（目标 + 约束 + 期望产物），团队的产出越准。
        </Callout>
      </>
    ),
  },
  {
    id: "multiagent",
    group: "core",
    nav: "多 Agent 协作",
    Icon: Network,
    title: "多 Agent 协作",
    render: () => (
      <>
        <Lead>
          这是 AgentCore 的核心。复杂任务会被拆给多个成员并行 / 协作完成，整个过程在协作图上可见。
        </Lead>
        <p className="text-sm font-medium text-foreground">什么时候会组团</p>
        <Lead>
          由 CEO 自动判断：当任务需要产出 / 变更、或可拆分时才组团；纯问答会直接作答，不绕弯。
        </Lead>
        <p className="text-sm font-medium text-foreground">四种协作形态</p>
        <CardGrid>
          <InfoCard title="并行扇出" desc="多个无依赖的子任务同时开跑，最后汇总。" />
          <InfoCard title="串行流水线" desc="调研 → 分析 → 撰写，上游产出喂给下游。" />
          <InfoCard title="辩论 / 互审" desc="正反双方各陈观点，CEO 综合后裁决。" />
          <InfoCard title="嵌套小队" desc="成员可再带一支小队，分层完成大任务。" />
        </CardGrid>
        <Callout variant="info">
          想看真实的协作图、连线与状态图例？往下翻到 <JumpLink to="legend">运行机制 · 图例</JumpLink>{" "}
          与 <JumpLink to="scenarios">机制场景</JumpLink>——讲「系统怎么运转」，和你在对话里看到的图一模一样。
        </Callout>
      </>
    ),
  },
  {
    id: "roles",
    group: "core",
    nav: "角色分配",
    Icon: UsersRound,
    title: "角色分配",
    render: () => (
      <>
        <Lead>
          AgentCore 不预设「代码 Agent」「写作 Agent」这类固定角色，而是按任务动态分配。
        </Lead>
        <Bullets
          items={[
            {
              title: "动态专精",
              desc: "CEO 根据任务为每个成员临时分配角色与工具集（调研员 / 分析师 / 撰写员…）。",
            },
            {
              title: "为什么不预制",
              desc: "真实任务跨领域，固定边界僵硬；把路由决策推给你也违背「管理团队」的心智。",
            },
          ]}
        />
        <Callout variant="info">
          进阶（规划中）：把「我的代码审查工作流」保存为可复用的行为模板，或自定义专属 Agent 配置。
        </Callout>
      </>
    ),
  },
  {
    id: "tools",
    group: "core",
    nav: "工具与能力",
    Icon: Wrench,
    title: "工具与能力",
    render: () => (
      <>
        <Lead>工具是团队的「手」——Agent 通过它读写文件、检索资料、调用外部能力。</Lead>
        <Bullets
          items={[
            {
              title: "内置 AI 工具",
              desc: "平台自带的动作工具，所有 Agent 默认可用。",
            },
            {
              title: "创作工具",
              desc: "文档 / 思维导图 / 多维表格 / 画布 / 幻灯片 / 流程图 / 表单 / 可运行产物（持续上线中）。",
            },
            {
              title: "集成 / 连接器",
              desc: "通过 MCP 接入第三方工具与 API，通过 A2A 连接外部 Agent。",
            },
          ]}
        />
        <Callout variant="tip">
          工具的全景与清单都在 <GoLink to="/toolbox">工具箱</GoLink>。
        </Callout>
      </>
    ),
  },
  {
    id: "progress",
    group: "core",
    nav: "任务进度",
    Icon: Activity,
    title: "任务进度",
    render: () => (
      <>
        <Lead>团队在干什么，你随时看得见、管得了。</Lead>
        <Bullets
          items={[
            { title: "流式输出", desc: "每个成员的思考与产出实时滚动呈现。" },
            { title: "协作图", desc: "整体进度与依赖关系一眼掌握。" },
            {
              title: "检查点 / 待裁决",
              desc: "关键处团队会停下等你确认，审批后继续。",
            },
            {
              title: "暂停与恢复",
              desc: "长任务可中断，稍后从断点续跑，不必从头再来。",
            },
          ]}
        />
        <Callout variant="warning">
          跑偏或太慢？直接发一条消息纠偏，或点停止按钮中止当前回合。
        </Callout>
      </>
    ),
  },
  {
    id: "memory",
    group: "core",
    nav: "记忆",
    Icon: Brain,
    title: "记忆",
    render: () => (
      <>
        <Lead>团队会记住你——你的偏好与项目背景在不同对话间延续。</Lead>
        <Bullets
          items={[
            {
              title: "跨会话记忆",
              desc: "记住你的习惯与上下文，换一个对话也不用从头交代。",
            },
            {
              title: "越用越懂你",
              desc: "语义检索、重要性分级与遗忘机制持续完善中。",
            },
          ]}
        />
        <Callout variant="tip">
          把稳定偏好直接告诉团队（例如「以后回答都用中文，并附上代码」），它会记住。
        </Callout>
      </>
    ),
  },
  {
    id: "panorama",
    group: "mechanism",
    nav: "运行时全景",
    Icon: Layers,
    title: "运行时全景",
    render: () => (
      <>
        <Lead>
          想知道你提交任务后台发生了什么？一次请求经准备 → 执行 →
          收尾三阶段。入口即 CEO 主 Agent：简单对话直接流式作答、零编排开销；需要产出或组队时才进入多
          Agent 编排。
        </Lead>
        <RuntimePanorama />
      </>
    ),
  },
  {
    id: "turnflow",
    group: "mechanism",
    nav: "协作回合主线",
    Icon: Route,
    title: "协作回合主线",
    render: () => (
      <>
        <Lead>
          一次多 Agent
          回合从你的提问到答案落进气泡的完整生命周期：CEO 何时组团、波次如何解锁、worker
          如何流式产出、最后如何收尾汇报。
        </Lead>
        <CollaborationTurnFlow />
      </>
    ),
  },
  {
    id: "legend",
    group: "mechanism",
    nav: "看懂协作图",
    Icon: BookOpen,
    title: "看懂协作图（图例）",
    render: () => (
      <>
        <Lead>
          对话里的协作图怎么看？下面把每个节点 / 状态 / 连线 /
          徽章的含义逐个标注，样式与聊天内嵌图一字不差。
        </Lead>
        <GraphLegend />
      </>
    ),
  },
  {
    id: "scenarios",
    group: "mechanism",
    nav: "机制场景",
    Icon: LayoutGrid,
    title: "机制场景（真实协作图）",
    render: () => (
      <>
        <Lead>
          下面的图都是<span className="font-medium text-foreground">真实</span>
          的协作图组件与 ELK
          布局——和你在对话里看到的一模一样，覆盖并行 / 串行 / 流式 / 辩论 / 嵌套 / 多层 /
          热修 / 超大团队各形态。
        </Lead>
        <Callout variant="info">
          这些是实时渲染的真实节点 / 连线 / 布局，不是截图；随用随挂载（滚到才加载）。
        </Callout>
        <MechanismScenarios />
      </>
    ),
  },
  {
    id: "workspace",
    group: "advanced",
    nav: "工作区与文件",
    Icon: FolderOpen,
    title: "工作区与文件",
    render: () => (
      <>
        <Lead>团队的产物落在工作区里——这是人和 Agent 共享的文件空间。</Lead>
        <Bullets
          items={[
            {
              title: "工作区",
              desc: "团队读写文件的地方；Agent 创建 / 修改的文件都会出现在这里。",
            },
            {
              title: "文件工作台",
              desc: "在文件页直接预览、编辑、整理这些产物。",
            },
          ]}
        />
        <Callout variant="tip">
          想让团队基于某个文件工作？在对话里引用它即可。
        </Callout>
      </>
    ),
  },
  {
    id: "settings",
    group: "advanced",
    nav: "设置速查",
    Icon: Settings,
    title: "设置速查",
    render: () => (
      <>
        <Lead>常用设置入口，点击直达。</Lead>
        <SettingsTable />
      </>
    ),
  },
  {
    id: "faq",
    group: "advanced",
    nav: "常见问题",
    Icon: HelpCircle,
    title: "常见问题",
    render: () => (
      <Faq
        items={[
          {
            q: "为什么我的任务没有组团？",
            a: "CEO 判断这是简单问题，直接回答更快。想要协作，就把任务说成「可拆分的多块」。",
          },
          {
            q: "怎么让它一定多人协作？",
            a: "明确要求拆分或并行，例如「分三路并行做……」「先调研再分析最后撰写」。",
          },
          {
            q: "任务跑偏或太慢怎么停？",
            a: "直接发一条消息纠偏，或点停止按钮中止当前回合。",
          },
          {
            q: "中途想改方向怎么办？",
            a: "继续发消息说明新要求，团队会带着已有上下文热修（修订），而不是从零重来。",
          },
          {
            q: "费用怎么看？",
            a: (
              <>
                在 <GoLink to="/more/usage">设置 · 用量</GoLink> 查看花费与额度。
              </>
            ),
          },
          {
            q: "用的是什么模型？",
            a: (
              <>
                DeepSeek V4（快速档 + 强力档），由你在{" "}
                <GoLink to="/more/model">模型配置</GoLink> 里提供 Key（BYOK）。
              </>
            ),
          },
          {
            q: "我的数据存在哪？",
            a: "生成的文件在工作区，对话记录保存在后端；你可在文件页随时查看与导出。",
          },
          {
            q: "想了解系统底层怎么运转？",
            a: (
              <>
                看本手册的 <JumpLink to="panorama">运行机制</JumpLink>{" "}
                一组：运行时全景、协作回合主线、图例，以及{" "}
                <JumpLink to="scenarios">机制场景</JumpLink>里的真实协作图。
              </>
            ),
          },
        ]}
      />
    ),
  },
];

const GROUP_ORDER: GroupId[] = ["start", "core", "mechanism", "advanced"];

// ────────────────────────────────────────────────────────────────────────────
// 页面
// ────────────────────────────────────────────────────────────────────────────

export function ProductManual() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const exit = useCallback(() => navigate("/toolbox"), [navigate]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});
  const [activeId, setActiveId] = useState<string>(SECTIONS[0].id);

  const setSectionRef = useCallback(
    (id: string) => (el: HTMLElement | null) => {
      sectionRefs.current[id] = el;
    },
    [],
  );

  // 深链 ?s=<sectionId>：进入即滚动到对应章节（命令面板 / 外部入口用）。
  useEffect(() => {
    const target = searchParams.get("s");
    if (!target || !sectionRefs.current[target]) return;
    setActiveId(target);
    requestAnimationFrame(() =>
      sectionRefs.current[target]?.scrollIntoView({ block: "start" }),
    );
  }, [searchParams]);

  // 目录联动：当前阅读到的章节在 TOC 高亮（IntersectionObserver 取「进入顶部带」的最上一节）。
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const visible = new Set<string>();
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.add(e.target.id);
          else visible.delete(e.target.id);
        }
        const top = SECTIONS.find((s) => visible.has(s.id));
        if (top) setActiveId(top.id);
      },
      { root, rootMargin: "0px 0px -70% 0px", threshold: [0, 1] },
    );
    for (const s of SECTIONS) {
      const el = sectionRefs.current[s.id];
      if (el) obs.observe(el);
    }
    return () => obs.disconnect();
  }, []);

  // Esc 退出回工具箱；命令面板（Ctrl/Cmd+K）开着时让它先吃 Esc。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || useUIStore.getState().searchOpen) return;
      exit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [exit]);

  const goTo = useCallback((id: string) => {
    setActiveId(id);
    sectionRefs.current[id]?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const groups = useMemo(
    () =>
      GROUP_ORDER.map((g) => ({
        id: g,
        label: GROUP_LABELS[g],
        items: SECTIONS.filter((s) => s.group === g),
      })),
    [],
  );

  return (
    // 真·全屏：fixed inset-0 覆盖整窗（含应用 TitleBar）。故本页顶栏自带窗口拖拽区
    // （[-webkit-app-region:drag]）+ 自绘最小化/最大化/关闭控件，否则无边框窗口将无法
    // 移动 / 关闭。返回 / Esc 退出回工具箱。
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <header className="flex h-12 shrink-0 items-center border-b border-border [-webkit-app-region:drag]">
        <button
          type="button"
          onClick={exit}
          className="ml-2 flex h-8 items-center gap-1.5 rounded-lg px-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground [-webkit-app-region:no-drag]"
        >
          <ArrowLeft size={16} />
          返回
        </button>
        <span className="ml-1 text-sm font-medium text-foreground">产品手册</span>
        <div className="flex-1" />
        {/* 自绘窗口控件：本页盖住了原生 TitleBar，故在此重建（与 TitleBar 同一 windowApi）。 */}
        <div className="flex items-center [-webkit-app-region:no-drag]">
          <button
            type="button"
            onClick={() => window.windowApi.minimize()}
            aria-label="最小化"
            className="flex h-12 w-12 items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Minus size={14} />
          </button>
          <button
            type="button"
            onClick={() => window.windowApi.maximize()}
            aria-label="最大化"
            className="flex h-12 w-12 items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Square size={12} />
          </button>
          <button
            type="button"
            onClick={() => window.windowApi.close()}
            aria-label="关闭"
            className="flex h-12 w-12 items-center justify-center text-muted-foreground hover:bg-destructive hover:text-destructive-foreground"
          >
            <X size={14} />
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* 左侧目录（滚动联动高亮） */}
        <nav className="hidden w-[260px] shrink-0 flex-col overflow-y-auto border-r border-border bg-muted/30 py-6 md:flex">
          <div className="space-y-5 px-3">
            {groups.map((group) => (
              <div key={group.id}>
                <p className="px-3 pb-1.5 text-xs font-medium text-muted-foreground">
                  {group.label}
                </p>
                <div className="space-y-0.5">
                  {group.items.map((item) => {
                    const Icon = item.Icon;
                    const active = item.id === activeId;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => goTo(item.id)}
                        className={`flex h-9 w-full items-center gap-2.5 rounded-lg px-3 text-left text-sm transition-colors ${
                          active
                            ? "bg-accent font-medium text-accent-foreground"
                            : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                        }`}
                      >
                        <Icon
                          size={16}
                          className={`shrink-0 ${active ? "text-primary" : ""}`}
                        />
                        <span className="truncate">{item.nav}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </nav>

        {/* 右侧阅读列 */}
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl px-6 py-10">
            {/* Hero */}
            <div className="mb-12">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
                <Sparkles size={12} />
                协作，是更高级的智能
              </span>
              <h1 className="mt-3 text-xl font-medium text-foreground">产品手册</h1>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
                从上手到玩转 AgentCore：怎么用好你的 AI
                团队，到看懂它背后怎么运转。系统底层细节见下方{" "}
                <JumpLink to="panorama">运行机制</JumpLink> 一组。
              </p>
            </div>

            {SECTIONS.map((s, i) => {
              const Icon = s.Icon;
              return (
                <section
                  key={s.id}
                  id={s.id}
                  ref={setSectionRef(s.id)}
                  className="mb-14 scroll-mt-6"
                >
                  <div className="flex items-center gap-3">
                    <span className="flex size-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
                      <Icon size={18} />
                    </span>
                    <div>
                      <p className="text-xs font-medium text-muted-foreground">
                        {String(i + 1).padStart(2, "0")}
                      </p>
                      <h2 className="text-base font-medium text-foreground">
                        {s.title}
                      </h2>
                    </div>
                  </div>
                  <div className="mt-4 space-y-4">{s.render()}</div>
                </section>
              );
            })}

            <div className="border-t border-border pt-6 text-xs text-muted-foreground">
              还有疑问？回到 <GoLink to="/toolbox">工具箱</GoLink> 或在对话里直接问你的团队。
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
