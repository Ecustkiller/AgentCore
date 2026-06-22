import { PageContainer } from "@/components/layout/PageContainer";
import {
  Badge,
  Button,
  Card,
  CatalogIconShell,
  SectionLabel,
} from "@/components/ui";
import { type ArtifactKind, artifactColorVar } from "@/lib/catalogColors";
import { cn } from "@/lib/utils";
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
  color: ArtifactKind;
  /** 可用项点击跳转的子路由；占位（即将上线）项不设。 */
  to?: string;
}

const FEATURED: ToolboxEntry[] = [
  {
    id: "ai-tools",
    title: "AI 能力",
    description: "工具、技能与 AI 工作准则一览，全部公开可查",
    icon: Wrench,
    color: "ai-tools",
    to: "/toolbox/ai-tools",
  },
  {
    id: "manual",
    title: "产品手册",
    description: "从上手到玩转，到看懂团队怎么运转",
    icon: BookOpen,
    color: "manual",
    to: "/toolbox/manual",
  },
];

const CREATION_TOOLS: ToolboxEntry[] = [
  {
    id: "doc",
    title: "文档",
    description: "在线富文本，AI 协同写作",
    icon: FileText,
    color: "doc",
  },
  {
    id: "mindmap",
    title: "思维导图",
    description: "结构化梳理想法与大纲",
    icon: Network,
    color: "mindmap",
  },
  {
    id: "table",
    title: "多维表格",
    description: "结构化数据与多视图",
    icon: Table2,
    color: "table",
  },
  {
    id: "canvas",
    title: "画布",
    description: "自由排布的创作白板",
    icon: Palette,
    color: "canvas",
  },
  {
    id: "slides",
    title: "幻灯片",
    description: "AI 生成可编辑演示",
    icon: Presentation,
    color: "slides",
  },
  {
    id: "app",
    title: "可运行产物",
    description: "HTML / React 即时预览",
    icon: AppWindow,
    color: "app",
  },
  {
    id: "diagram",
    title: "流程图",
    description: "流程 / 架构 / 时序图",
    icon: GitBranch,
    color: "diagram",
  },
  {
    id: "form",
    title: "表单",
    description: "收集数据并汇入表格",
    icon: FormInput,
    color: "form",
  },
];

const MORE_CAPABILITIES: ToolboxEntry[] = [
  {
    id: "connectors",
    title: "集成 · 连接器",
    description: "MCP 与第三方服务接入",
    icon: Plug,
    color: "connectors",
  },
  {
    id: "workflow",
    title: "工作流",
    description: "编排工具与 Agent 协作流程",
    icon: Workflow,
    color: "workflow",
  },
];

function ToolboxSectionHeader({
  label,
  meta,
}: {
  label: string;
  meta?: string;
}) {
  return (
    <div className="mb-4 flex items-baseline justify-between gap-3">
      <SectionLabel>{label}</SectionLabel>
      {meta ? (
        <span className="shrink-0 text-xs text-muted-foreground/60">
          {meta}
        </span>
      ) : null}
    </div>
  );
}

function ToolboxFeaturedCard({ entry }: { entry: ToolboxEntry }) {
  const navigate = useNavigate();
  const { icon: Icon, title, description, to, color } = entry;
  const colorVar = artifactColorVar(color);

  return (
    <Button
      variant="ghost"
      onClick={() => to && navigate(to)}
      className="group h-auto w-full justify-start p-0 text-left font-normal"
    >
      <Card
        variant="interactive"
        className="flex w-full flex-col gap-4 p-5 shadow-sm transition-shadow group-hover:shadow-md"
      >
        <div className="flex items-start justify-between gap-3">
          <CatalogIconShell colorVar={colorVar} size="lg">
            <Icon size={22} />
          </CatalogIconShell>
          <ChevronRight
            size={16}
            className="mt-1 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground"
          />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-foreground">{title}</h3>
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
            {description}
          </p>
        </div>
      </Card>
    </Button>
  );
}

function ToolboxTileCard({
  entry,
  comingSoon = false,
}: {
  entry: ToolboxEntry;
  comingSoon?: boolean;
}) {
  const navigate = useNavigate();
  const { icon: Icon, title, description, to, color } = entry;
  const available = Boolean(to);
  const colorVar = artifactColorVar(color);

  const inner = (
    <Card
      className={cn(
        "flex h-full flex-col gap-3 p-4",
        available && "shadow-sm transition-shadow group-hover:shadow-md",
      )}
      variant={available ? "interactive" : "default"}
    >
      <div className="flex items-start justify-between gap-2">
        <CatalogIconShell colorVar={colorVar} muted={comingSoon}>
          <Icon size={18} />
        </CatalogIconShell>
        {comingSoon ? (
          <Badge tone="muted" pill className="shrink-0">
            即将开放
          </Badge>
        ) : available ? (
          <ChevronRight
            size={14}
            className="mt-0.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground"
          />
        ) : null}
      </div>
      <div className="min-w-0 flex-1">
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
          {description}
        </p>
      </div>
    </Card>
  );

  if (!to) {
    return inner;
  }

  return (
    <Button
      variant="ghost"
      onClick={() => navigate(to)}
      className="group h-auto w-full justify-start p-0 text-left font-normal"
    >
      {inner}
    </Button>
  );
}

export function ToolboxPage() {
  return (
    <PageContainer width="canvas">
      <header className="pb-2">
        <h1 className="text-xl font-semibold text-foreground">工具箱</h1>
        <p className="mt-2 max-w-xl text-sm text-muted-foreground">
          AI 工具与创作工具，人与 Agent 协同的能力中心
        </p>
      </header>

      <section className="mt-8">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {FEATURED.map((entry) => (
            <ToolboxFeaturedCard key={entry.id} entry={entry} />
          ))}
        </div>
      </section>

      <section className="mt-10">
        <ToolboxSectionHeader
          label="创作工具"
          meta={`${CREATION_TOOLS.length} 项`}
        />
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {CREATION_TOOLS.map((entry) => (
            <ToolboxTileCard key={entry.id} entry={entry} comingSoon />
          ))}
        </div>
      </section>

      <section className="mt-10">
        <ToolboxSectionHeader label="更多能力" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {MORE_CAPABILITIES.map((entry) => (
            <ToolboxTileCard key={entry.id} entry={entry} comingSoon />
          ))}
        </div>
      </section>
    </PageContainer>
  );
}
