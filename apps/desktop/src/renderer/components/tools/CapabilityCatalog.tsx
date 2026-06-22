import { Button, CatalogIconShell } from "@/components/ui";
import { catalogCategoryColorVar } from "@/lib/catalogColors";
import {
  type Capabilities,
  type CapabilitySkill,
  type CapabilityTool,
  type ToolApproval,
  type ToolCategory,
  getCapabilities,
} from "@/services/capabilities";
import {
  BookOpen,
  ChevronRight,
  FolderOpen,
  Globe,
  Loader2,
  type LucideIcon,
  MessageCircleQuestion,
  Network,
  ScrollText,
  Search,
  Terminal,
  Wrench,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

const CATEGORY_META: Record<ToolCategory, { label: string; icon: LucideIcon }> =
  {
    filesystem: { label: "文件系统", icon: FolderOpen },
    search: { label: "搜索", icon: Search },
    research: { label: "研究", icon: Globe },
    execution: { label: "执行", icon: Terminal },
    orchestration: { label: "编排", icon: Network },
    interaction: { label: "交互", icon: MessageCircleQuestion },
    skill: { label: "技能", icon: BookOpen },
  };

const CATEGORY_ORDER: ToolCategory[] = [
  "research",
  "search",
  "filesystem",
  "execution",
  "orchestration",
  "skill",
  "interaction",
];

const APPROVAL_LABEL: Record<ToolApproval, string> = {
  never: "自动执行",
  grantable: "需审批",
  always: "始终审批",
};

// Governance colors map to the project's status tokens: neutral (auto), warning
// (asks the user), destructive (always gated). No hardcoded palette.
const APPROVAL_BADGE: Record<ToolApproval, string> = {
  never: "bg-muted text-muted-foreground",
  grantable: "bg-warning/10 text-warning",
  always: "bg-destructive/10 text-destructive",
};

/** Which side of the team holds a tool — the CEO coordinator, the 队员 (workers), or
 * both. Neutral styling: this is metadata, not a status. */
function availabilityLabel(availableTo: string[]): string {
  const ceo = availableTo.includes("ceo");
  const worker = availableTo.includes("worker");
  if (ceo && worker) return "全员";
  if (ceo) return "CEO";
  return "队员";
}

interface ParamProp {
  type?: string;
  description?: string;
}

/** Top-level call parameters as a 用法教学 list (name · type — description). Nested
 * shapes (e.g. delegate's task tree) are summarized by their top-level description, not
 * expanded — enough to teach "how you'd call it" without dumping the whole schema. */
function ToolParams({ parameters }: { parameters: Record<string, unknown> }) {
  const props = parameters.properties as Record<string, ParamProp> | undefined;
  if (!props || Object.keys(props).length === 0) {
    return (
      <p className="px-1 text-xs text-muted-foreground/70">
        该工具无调用参数。
      </p>
    );
  }
  const required = new Set(
    Array.isArray(parameters.required) ? (parameters.required as string[]) : [],
  );
  return (
    <dl className="space-y-1.5">
      {Object.entries(props).map(([name, prop]) => (
        <div key={name} className="text-xs">
          <dt className="flex items-center gap-1.5">
            <span className="font-mono text-foreground">{name}</span>
            {required.has(name) && (
              <span className="text-destructive" title="必填">
                *
              </span>
            )}
            {prop?.type && (
              <span className="text-muted-foreground/70">{prop.type}</span>
            )}
          </dt>
          {prop?.description && (
            <dd className="mt-0.5 line-clamp-3 text-muted-foreground">
              {prop.description}
            </dd>
          )}
        </div>
      ))}
    </dl>
  );
}

/** One tool tile: name · reach · approval, description, click-to-expand parameters. */
function ToolCard({ tool }: { tool: CapabilityTool }) {
  const [open, setOpen] = useState(false);
  const Icon = CATEGORY_META[tool.category]?.icon ?? Wrench;
  const colorVar = catalogCategoryColorVar(tool.category);
  return (
    <div className="flex flex-col rounded-xl border border-border bg-card p-4">
      <Button
        variant="ghost"
        onClick={() => setOpen((v) => !v)}
        className="h-auto w-full justify-between gap-2 p-0 text-left font-normal"
      >
        <div className="flex min-w-0 items-center gap-2">
          <CatalogIconShell colorVar={colorVar} className="size-8 rounded-lg">
            <Icon size={14} />
          </CatalogIconShell>
          <span className="truncate font-medium text-foreground text-sm">
            {tool.name}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground text-xs">
            {availabilityLabel(tool.available_to)}
          </span>
          <span
            className={`rounded-full px-2 py-0.5 text-xs ${APPROVAL_BADGE[tool.approval]}`}
          >
            {APPROVAL_LABEL[tool.approval]}
          </span>
        </div>
      </Button>
      <p className="mt-2 text-muted-foreground text-xs">{tool.description}</p>
      <Button
        variant="ghost"
        onClick={() => setOpen((v) => !v)}
        className="mt-2 h-auto self-start gap-1 px-0 py-0 text-muted-foreground hover:text-foreground"
        icon={
          <ChevronRight
            size={12}
            className={`transition-transform ${open ? "rotate-90" : ""}`}
          />
        }
      >
        调用参数
      </Button>
      {open && (
        <div className="mt-2 border-border/60 border-t pt-2">
          <ToolParams parameters={tool.parameters} />
        </div>
      )}
    </div>
  );
}

/** One Skill tile: catalog summary, click-to-expand the full guidance body verbatim. */
function SkillCard({ skill }: { skill: CapabilitySkill }) {
  const [open, setOpen] = useState(false);
  const skillColor = catalogCategoryColorVar("skill");
  return (
    <div className="flex flex-col rounded-xl border border-border bg-card p-4">
      <Button
        variant="ghost"
        onClick={() => setOpen((v) => !v)}
        className="h-auto w-full items-start gap-2 p-0 text-left font-normal"
      >
        <CatalogIconShell
          colorVar={skillColor}
          className="mt-0.5 size-8 rounded-lg"
        >
          <BookOpen size={14} />
        </CatalogIconShell>
        <div className="min-w-0 flex-1">
          <span className="block font-mono text-foreground text-sm">
            {skill.name}
          </span>
          <span className="mt-0.5 block text-muted-foreground text-xs">
            {skill.summary}
          </span>
        </div>
        <ChevronRight
          size={14}
          className={`mt-0.5 shrink-0 text-muted-foreground transition-transform ${
            open ? "rotate-90" : ""
          }`}
        />
      </Button>
      {open && (
        <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/50 px-3 py-2 text-foreground/90 text-xs leading-relaxed">
          {skill.body}
        </pre>
      )}
    </div>
  );
}

/** A collapsible verbatim prompt block (AI 工作准则). Collapsed by default — these are
 * long, and the page reads as a clean summary until the user opts to see the原文. */
function GuidelineBlock({
  title,
  subtitle,
  text,
}: {
  title: string;
  subtitle: string;
  text: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-border bg-card">
      <Button
        variant="ghost"
        onClick={() => setOpen((v) => !v)}
        className="h-auto w-full justify-start gap-2 px-4 py-3 text-left font-normal"
      >
        <ScrollText size={16} className="shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <span className="block font-medium text-foreground text-sm">
            {title}
          </span>
          <span className="block text-muted-foreground text-xs">
            {subtitle}
          </span>
        </div>
        <ChevronRight
          size={14}
          className={`shrink-0 text-muted-foreground transition-transform ${
            open ? "rotate-90" : ""
          }`}
        />
      </Button>
      {open && (
        <pre className="mx-4 mb-4 max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/50 px-3 py-2 text-foreground/90 text-xs leading-relaxed">
          {text}
        </pre>
      )}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-2 font-medium text-muted-foreground text-xs">
      {children}
    </h2>
  );
}

type Status = "loading" | "error" | "ready";

/** The complete 能力图鉴 (前端UX设计.md §十二): every tool (with CEO/队员 reach +
 * 调用参数), the system Skills (summary + full body), and the CEO system-prompt
 * template — all from /v1/capabilities so the page never drifts from what the agents
 * actually hold. Self-contained (fetch + loading/error/empty); the page owns the title. */
export function CapabilityCatalog() {
  const [data, setData] = useState<Capabilities | null>(null);
  const [status, setStatus] = useState<Status>("loading");

  const load = useCallback(() => {
    let cancelled = false;
    setStatus("loading");
    getCapabilities()
      .then((res) => {
        if (!cancelled) {
          setData(res);
          setStatus("ready");
        }
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => load(), [load]);

  if (status === "loading") {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground text-sm">
        <Loader2 size={16} className="animate-spin" />
        加载中…
      </div>
    );
  }

  if (status === "error" || !data) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-border border-dashed py-16 text-center">
        <p className="text-muted-foreground text-sm">能力列表加载失败</p>
        <Button onClick={() => load()}>重试</Button>
      </div>
    );
  }

  const grouped = CATEGORY_ORDER.map((category) => ({
    category,
    items: data.tools.filter((t) => t.category === category),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="space-y-10">
      <section>
        <SectionTitle>工具 · {data.tools.length}</SectionTitle>
        <p className="mb-4 text-muted-foreground text-xs">
          Agent 可调用的动作工具。
          <span className="text-muted-foreground/70">
            「全员」CEO
            与队员都可用，「CEO」仅协调者持有，「队员」交付时才动用。
          </span>
        </p>
        <div className="space-y-6">
          {grouped.map(({ category, items }) => {
            const meta = CATEGORY_META[category];
            const colorVar = catalogCategoryColorVar(category);
            const CatIcon = meta.icon;
            return (
              <div key={category}>
                <h3 className="mb-2 flex items-center gap-1.5 text-muted-foreground text-xs">
                  <CatalogIconShell
                    colorVar={colorVar}
                    className="size-6 rounded-lg"
                  >
                    <CatIcon size={12} />
                  </CatalogIconShell>
                  {meta.label} · {items.length}
                </h3>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {items.map((tool) => (
                    <ToolCard key={tool.name} tool={tool} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {data.skills.length > 0 && (
        <section>
          <SectionTitle>技能 · {data.skills.length}</SectionTitle>
          <p className="mb-4 text-muted-foreground text-xs">
            CEO
            按需查阅的进阶协作能力（渐进披露：平时只挂一行说明，要用时才拉取完整指引）。
          </p>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {data.skills.map((skill) => (
              <SkillCard key={skill.name} skill={skill} />
            ))}
          </div>
        </section>
      )}

      <section>
        <SectionTitle>AI 工作准则</SectionTitle>
        <p className="mb-4 text-muted-foreground text-xs">
          AI 遵循的系统提示词模板。每条 AI 回复还可查看「本回合实际提示词」。
        </p>
        <div className="space-y-3">
          <GuidelineBlock
            title="全员共享准则"
            subtitle="每个 Agent（CEO 与队员）共享的基座：身份、表达风格、工具使用与安全。"
            text={data.guidelines.shared_base}
          />
          <GuidelineBlock
            title="CEO 完整提示词"
            subtitle="协调者 CEO 的完整对话系统提示词：共享基座 + 路由核心 + 能力目录 + 引用规范。"
            text={data.guidelines.ceo}
          />
        </div>
      </section>
    </div>
  );
}
