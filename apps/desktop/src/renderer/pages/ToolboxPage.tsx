import { PageContainer } from "@/components/layout/PageContainer";
import {
  AppWindow,
  BookOpen,
  ChevronRight,
  FileText,
  FormInput,
  GitBranch,
  type LucideIcon,
  Network,
  Palette,
  Plug,
  Presentation,
  Table2,
  Workflow,
  Wrench,
} from "lucide-react";
import { useNavigate } from "react-router-dom";

interface ToolboxEntry {
  id: string;
  title: string;
  description: string;
  icon: LucideIcon;
  /** 可用项点击跳转的子路由；占位（即将上线）项不设。 */
  to?: string;
}

interface ToolboxGroup {
  id: string;
  label: string;
  entries: ToolboxEntry[];
}

// 卡片网格按「创作工具 / 能力」轻量分组（小标题，非 Tab）。
// 模型见 docs/03-AI核心/工具与能力系统.md §8.4，IA 见 docs/04-前端/前端UX设计.md §十二。
const GROUPS: ToolboxGroup[] = [
  {
    id: "creation",
    label: "创作工具",
    entries: [
      {
        id: "doc",
        title: "文档",
        description: "在线富文本，AI 协同写作",
        icon: FileText,
      },
      {
        id: "mindmap",
        title: "思维导图",
        description: "结构化梳理想法与大纲",
        icon: Network,
      },
      {
        id: "table",
        title: "多维表格",
        description: "结构化数据与多视图",
        icon: Table2,
      },
      {
        id: "canvas",
        title: "画布",
        description: "自由排布的创作白板",
        icon: Palette,
      },
      {
        id: "slides",
        title: "幻灯片",
        description: "AI 生成可编辑演示",
        icon: Presentation,
      },
      {
        id: "app",
        title: "可运行产物",
        description: "HTML / React 即时预览",
        icon: AppWindow,
      },
      {
        id: "diagram",
        title: "流程图",
        description: "流程 / 架构 / 时序图",
        icon: GitBranch,
      },
      {
        id: "form",
        title: "表单",
        description: "收集数据并汇入表格",
        icon: FormInput,
      },
    ],
  },
  {
    id: "capability",
    label: "能力",
    entries: [
      {
        id: "ai-tools",
        title: "AI 能力",
        description: "工具、技能与 AI 工作准则一览，全部公开可查",
        icon: Wrench,
        to: "/toolbox/ai-tools",
      },
      {
        id: "integration",
        title: "集成 / 连接器",
        description: "接入 MCP 与第三方 DB / API",
        icon: Plug,
      },
      {
        id: "workflow",
        title: "工作流",
        description: "编排工具与 Agent 成流程",
        icon: Workflow,
      },
    ],
  },
  {
    id: "platform",
    label: "了解平台",
    entries: [
      {
        id: "manual",
        title: "产品手册",
        description: "从上手到玩转，到看懂团队怎么运转",
        icon: BookOpen,
        to: "/toolbox/manual",
      },
    ],
  },
];

function ToolboxCard({ entry }: { entry: ToolboxEntry }) {
  const navigate = useNavigate();
  const { icon: Icon, title, description, to } = entry;
  const available = Boolean(to);

  const inner = (
    <>
      <div
        className={`flex size-10 shrink-0 items-center justify-center rounded-lg ${
          available
            ? "bg-primary/10 text-primary"
            : "bg-accent text-muted-foreground"
        }`}
      >
        <Icon size={18} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <h3 className="truncate text-sm font-medium text-foreground">
            {title}
          </h3>
          {available ? (
            <ChevronRight
              size={16}
              className="shrink-0 text-muted-foreground"
            />
          ) : (
            <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
              即将上线
            </span>
          )}
        </div>
        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
          {description}
        </p>
      </div>
    </>
  );

  if (!to) {
    return (
      <div className="flex items-start gap-3 rounded-xl border border-border bg-card p-4">
        {inner}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => navigate(to)}
      className="flex items-start gap-3 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-primary/40 hover:bg-accent/40"
    >
      {inner}
    </button>
  );
}

export function ToolboxPage() {
  return (
    <PageContainer width="canvas">
      <h1 className="text-xl font-semibold text-foreground">工具箱</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        AI 工具与创作工具，人与 Agent 协同的能力中心
      </p>

      <div className="mt-6 space-y-6">
        {GROUPS.map((group) => (
          <section key={group.id}>
            <h2 className="mb-2 text-xs font-medium text-muted-foreground">
              {group.label}
            </h2>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
              {group.entries.map((entry) => (
                <ToolboxCard key={entry.id} entry={entry} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </PageContainer>
  );
}
