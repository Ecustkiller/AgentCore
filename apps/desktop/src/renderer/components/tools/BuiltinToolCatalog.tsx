import {
  type ToolApproval,
  type ToolCategory,
  type ToolInfo,
  listTools,
} from "@/services/tools";
import {
  FolderOpen,
  Globe,
  Loader2,
  type LucideIcon,
  Network,
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
  };

// Render order; categories with no tools are skipped.
const CATEGORY_ORDER: ToolCategory[] = [
  "filesystem",
  "search",
  "research",
  "execution",
  "orchestration",
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

function ToolCard({ tool }: { tool: ToolInfo }) {
  const Icon = CATEGORY_META[tool.category]?.icon ?? Wrench;
  return (
    <div className="flex flex-col rounded-xl border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Icon size={16} className="shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-medium text-foreground">
            {tool.name}
          </span>
        </div>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${APPROVAL_BADGE[tool.approval]}`}
        >
          {APPROVAL_LABEL[tool.approval]}
        </span>
      </div>
      <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">
        {tool.description}
      </p>
    </div>
  );
}

type Status = "loading" | "error" | "ready";

/** Read-only grid of the platform's built-in tools, grouped by category.
 *
 * Self-contained (fetches its own data + handles loading/error/empty), so any
 * page can drop it in. The page owns the surrounding title and spacing. */
export function BuiltinToolCatalog() {
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [status, setStatus] = useState<Status>("loading");

  const load = useCallback(() => {
    let cancelled = false;
    setStatus("loading");
    listTools()
      .then((data) => {
        if (!cancelled) {
          setTools(data);
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
      <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
        <Loader2 size={16} className="animate-spin" />
        加载中…
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border py-16 text-center">
        <p className="text-sm text-muted-foreground">工具列表加载失败</p>
        <button
          type="button"
          onClick={() => load()}
          className="rounded-lg bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90"
        >
          重试
        </button>
      </div>
    );
  }

  const grouped = CATEGORY_ORDER.map((category) => ({
    category,
    items: tools.filter((t) => t.category === category),
  })).filter((g) => g.items.length > 0);

  if (grouped.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border py-16 text-center">
        <Wrench size={28} className="text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">暂无工具</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {grouped.map(({ category, items }) => (
        <section key={category}>
          <h3 className="mb-2 text-xs font-medium text-muted-foreground">
            {CATEGORY_META[category].label} · {items.length}
          </h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((tool) => (
              <ToolCard key={tool.name} tool={tool} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
