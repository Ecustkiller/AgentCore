import { IconButton } from "@/components/files/parts";
import { Badge } from "@/components/ui";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { isFeatureUnavailable } from "@/lib/errors";
import { notifyActionError, notifySuccess } from "@/lib/toast";
import { cn } from "@/lib/utils";
import {
  type DocumentApplyMode,
  type DocumentNode,
  createRuleDocument,
  deleteDocument,
  listUserRules,
  renameDocument,
  updateDocumentApplyMode,
} from "@/services/documents";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  Loader2,
  Pencil,
  Trash2,
} from "lucide-react";
import { type ReactNode, forwardRef, useState } from "react";
import {
  loadRulesCollapsed,
  loadRulesExpanded,
  saveRulesCollapsed,
  saveRulesExpanded,
} from "./storage";

/** Which rules layer a section renders: GLOBAL rules, or one project's. */
export type RuleScope =
  | { kind: "global" }
  | { kind: "project"; folderId: string };

/** Persisted fold key for the pinned「你的规则」section (default expanded). */
const ROOT_KEY = "root";

const RULES_QUERY_KEY = ["user-rules"] as const;

const APPLY_LABEL: Record<DocumentApplyMode, string> = {
  always: "常驻",
  on_demand: "按需",
};

/** Short hint for the two modes (badge title / menu). */
const APPLY_HINT: Record<DocumentApplyMode, string> = {
  always: "短硬约束",
  on_demand: "长条文或偶发",
};

/** Ensure a rule doc name is markdown so it opens in the shared 编辑器 (not the 只读预览). */
function ensureMdName(name: string): string {
  return /\.(md|markdown)$/i.test(name) ? name : `${name}.md`;
}

/** A collision-free "新规则.md" (then "新规则 2.md", …) within a scope's existing names. */
function nextRuleName(existing: Iterable<string>): string {
  const taken = new Set(existing);
  const base = "新规则";
  if (!taken.has(`${base}.md`)) return `${base}.md`;
  for (let i = 2; ; i++) {
    const candidate = `${base} ${i}.md`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * The「规则」rail section (Agent记忆与知识系统 §5.7 / §5.0) — the user's own rules
 * (`role='rule', ai_maintained=false`, §5.2). Mounted under {@link AgentCoreSection} as
 * `AgentCore/规则/` (GLOBAL + per-project).
 *
 * Deliberately NOT the generic {@link FileTree} (照 {@link MemorySection} 先例): rules are a
 * flat per-scope list needing only 打开 / 新建 / 重命名 / 删除 / 常驻·按需. Opening a rule
 * reuses the shared editor host via {@link createDocumentSource} (path = the doc id).
 *
 * Create entry mirrors {@link WorkspaceSection}: header hover `+` + context menu + empty-state CTA
 * (no list-tail fake row).
 */
export function RuleSection({
  scope = { kind: "global" },
  activePath,
  onOpen,
  onDeleted,
  onRenamed,
  indent = 0,
}: {
  scope?: RuleScope;
  /** The synthetic path (= document id) of the open rule tab (highlights its row), or null. */
  activePath: string | null;
  /** Open a rule doc in the detail pane (path = its document id + display name). */
  onOpen: (path: string, name: string) => void;
  /** A rule was deleted — let the host close its tab if open (its document id). */
  onDeleted: (path: string) => void;
  /** A rule was renamed — let the host relabel its tab if open. */
  onRenamed: (path: string, name: string) => void;
  /** Base left indent (px): 0 at the rail root, > 0 when nested under a project. */
  indent?: number;
}) {
  const queryClient = useQueryClient();
  const folderId = scope.kind === "project" ? scope.folderId : null;
  const foldKey = scope.kind === "global" ? ROOT_KEY : scope.folderId;

  // 全局段默认展开；项目「规则」节点默认折叠。
  const [sectionOpen, setSectionOpen] = useState(() =>
    scope.kind === "global"
      ? !loadRulesCollapsed().has(ROOT_KEY)
      : loadRulesExpanded().has(foldKey),
  );

  const persistSectionOpen = (next: boolean) => {
    if (scope.kind === "global") {
      const set = loadRulesCollapsed();
      if (next) set.delete(ROOT_KEY);
      else set.add(ROOT_KEY);
      saveRulesCollapsed(set);
    } else {
      const set = loadRulesExpanded();
      if (next) set.add(foldKey);
      else set.delete(foldKey);
      saveRulesExpanded(set);
    }
  };

  const toggleSection = () =>
    setSectionOpen((open) => {
      const next = !open;
      persistSectionOpen(next);
      return next;
    });

  const ensureSectionOpen = () => {
    if (sectionOpen) return;
    setSectionOpen(true);
    persistSectionOpen(true);
  };

  const rules = useQuery({
    queryKey: RULES_QUERY_KEY,
    queryFn: listUserRules,
    enabled: sectionOpen,
    staleTime: 30_000,
    // A 404/501 = this deployed backend predates the /documents endpoint (前后端版本漂移);
    // retrying can't fix it, so fail fast to the calm「暂不可用」state instead of hammering.
    retry: (failureCount, error) =>
      !isFeatureUnavailable(error) && failureCount < 3,
  });

  const allRules = rules.data ?? [];
  const scopedRules =
    folderId === null
      ? allRules.filter((r) => r.folderId === null)
      : allRules.filter((r) => r.folderId === folderId);

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: RULES_QUERY_KEY });

  const createRule = async () => {
    ensureSectionOpen();
    try {
      const doc = await createRuleDocument(
        nextRuleName(scopedRules.map((r) => r.name)),
        folderId,
      );
      await refresh();
      onOpen(doc.id, doc.name);
    } catch (e) {
      notifyActionError("新建规则失败", e);
    }
  };

  const renameRule = async (doc: DocumentNode) => {
    const input = window.prompt("规则名称", doc.name);
    if (input === null) return;
    const name = ensureMdName(input.trim());
    if (name === ".md" || name === doc.name) return;
    try {
      await renameDocument(doc.id, name);
      await refresh();
      onRenamed(doc.id, name);
      notifySuccess("已重命名");
    } catch (e) {
      notifyActionError("重命名失败", e);
    }
  };

  const removeRule = async (doc: DocumentNode) => {
    if (!window.confirm(`确定删除规则「${doc.name}」？此操作不可撤销。`))
      return;
    try {
      await deleteDocument(doc.id);
      onDeleted(doc.id);
      await refresh();
      notifySuccess("已删除规则");
    } catch (e) {
      notifyActionError("删除失败", e);
    }
  };

  const setApplyMode = async (doc: DocumentNode, mode: DocumentApplyMode) => {
    if (doc.applyMode === mode) return;
    try {
      await updateDocumentApplyMode(doc.id, mode);
      await refresh();
      notifySuccess(`已设为${APPLY_LABEL[mode]}`);
    } catch (e) {
      notifyActionError("切换失败", e);
    }
  };

  const headerPad = indent + 8;
  const leafPad = indent + 26;

  const renderRuleRow = (doc: DocumentNode) => {
    const mode = doc.applyMode;
    const other: DocumentApplyMode = mode === "always" ? "on_demand" : "always";
    return (
      <ContextMenu key={doc.id}>
        <ContextMenuTrigger asChild>
          <RuleLeafRow
            paddingLeft={leafPad}
            icon={
              <FileText size={14} className="shrink-0 text-muted-foreground" />
            }
            label={doc.name}
            active={activePath === doc.id}
            onOpen={() => onOpen(doc.id, doc.name)}
            applyMode={mode}
            onToggleApplyMode={() => void setApplyMode(doc, other)}
          />
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-36">
          <ContextMenuItem
            disabled={mode === "always"}
            title={APPLY_HINT.always}
            onSelect={() => void setApplyMode(doc, "always")}
          >
            <span className="flex-1 truncate">设为常驻</span>
          </ContextMenuItem>
          <ContextMenuItem
            disabled={mode === "on_demand"}
            title={APPLY_HINT.on_demand}
            onSelect={() => void setApplyMode(doc, "on_demand")}
          >
            <span className="flex-1 truncate">设为按需</span>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => void renameRule(doc)}>
            <Pencil size={14} className="shrink-0" />
            <span className="flex-1 truncate">重命名</span>
          </ContextMenuItem>
          <ContextMenuItem
            variant="danger"
            onSelect={() => void removeRule(doc)}
          >
            <Trash2 size={14} className="shrink-0" />
            <span className="flex-1 truncate">删除规则</span>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  };

  const header = (
    <div
      className="flex items-center rounded-lg text-sm"
      style={{ paddingLeft: headerPad }}
    >
      <button
        type="button"
        onClick={toggleSection}
        aria-expanded={sectionOpen}
        className={cn(
          "flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-lg pr-0 text-left text-sm text-foreground transition-colors hover:bg-accent/60",
          scope.kind === "global" && "font-medium",
        )}
      >
        {sectionOpen ? (
          <ChevronDown size={14} className="shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight size={14} className="shrink-0 text-muted-foreground" />
        )}
        {sectionOpen ? (
          <FolderOpen size={14} className="shrink-0 text-muted-foreground" />
        ) : (
          <Folder size={14} className="shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate">规则</span>
      </button>
      <div className="shrink-0">
        <IconButton title="新建规则" onClick={() => void createRule()}>
          <FilePlus size={14} />
        </IconButton>
      </div>
    </div>
  );

  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger asChild>{header}</ContextMenuTrigger>
        <ContextMenuContent className="min-w-36">
          <ContextMenuItem onSelect={() => void createRule()}>
            <FilePlus size={14} className="shrink-0" />
            <span className="flex-1 truncate">新建规则</span>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {sectionOpen &&
        (rules.isLoading ? (
          <div
            className="flex h-7 items-center gap-1.5 text-xs text-muted-foreground"
            style={{ paddingLeft: leafPad }}
          >
            <Loader2 size={12} className="animate-spin" />
            加载中…
          </div>
        ) : rules.isError ? (
          isFeatureUnavailable(rules.error) ? (
            <div
              title="服务端升级后自动恢复"
              className="flex min-h-7 items-center py-1 text-xs text-muted-foreground/60"
              style={{ paddingLeft: leafPad }}
            >
              规则功能暂不可用（服务端待升级）
            </div>
          ) : (
            <button
              type="button"
              onClick={() => void rules.refetch()}
              style={{ paddingLeft: leafPad }}
              className="flex h-7 w-full items-center gap-1 text-left text-xs text-destructive/80 hover:underline"
            >
              加载失败，点此重试
            </button>
          )
        ) : scopedRules.length === 0 ? (
          <div
            className="flex flex-col gap-1 py-1"
            style={{ paddingLeft: leafPad }}
          >
            <p className="text-xs text-muted-foreground/60">
              {scope.kind === "global" ? "还没有全局规则" : "本项目还没有规则"}
            </p>
            <p
              className="text-xs text-muted-foreground/50"
              title="新建默认常驻"
            >
              短硬约束用常驻，长条文或偶发用按需
            </p>
          </div>
        ) : (
          scopedRules.map((doc) => renderRuleRow(doc))
        ))}
    </div>
  );
}

/**
 * A single rule-doc row — open + apply-mode chip as siblings (no nested buttons).
 * Outer div is the context-menu trigger surface (照 MemoryLeafRow 视觉密度).
 */
const RuleLeafRow = forwardRef<
  HTMLDivElement,
  {
    paddingLeft: number;
    icon: ReactNode;
    label: string;
    active: boolean;
    onOpen: () => void;
    applyMode: DocumentApplyMode;
    onToggleApplyMode: () => void;
  }
>(function RuleLeafRow(
  {
    paddingLeft,
    icon,
    label,
    active,
    onOpen,
    applyMode,
    onToggleApplyMode,
    ...rest
  },
  ref,
) {
  return (
    <div
      ref={ref}
      {...rest}
      style={{ paddingLeft }}
      className={cn(
        "flex h-7 w-full items-center gap-1.5 rounded-lg pr-1 text-sm transition-colors",
        active
          ? "bg-accent text-foreground"
          : "text-foreground hover:bg-accent/60",
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg text-left"
      >
        {icon}
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </button>
      <button
        type="button"
        title={`${APPLY_LABEL[applyMode]} · ${APPLY_HINT[applyMode]}（点击切换）`}
        aria-label={`应用方式：${APPLY_LABEL[applyMode]}，点击切换`}
        onClick={onToggleApplyMode}
        className="shrink-0 rounded-full"
      >
        <Badge tone="muted" pill className="pointer-events-none font-normal">
          {APPLY_LABEL[applyMode]}
        </Badge>
      </button>
    </div>
  );
});
RuleLeafRow.displayName = "RuleLeafRow";
