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
import { notifyError } from "@/lib/toast";
import { cn } from "@/lib/utils";
import {
  type AlwaysQuota,
  type DocumentApplyMode,
  type DocumentNode,
  createRuleDocument,
  deleteDocument,
  getAlwaysQuota,
  listScopeEntries,
  renameDocument,
  updateDocumentApplyMode,
} from "@/services/documents";
import {
  GLOBAL_PREFERENCES_PATH,
  GLOBAL_PROFILE_PATH,
  MEMORY_UPDATES_PATH,
  memoryProjectNavigationPath,
  memoryProjectProfilePath,
  memoryTopicPath,
} from "@/services/sources/memorySource";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  FilePlus,
  FileText,
  History,
  Loader2,
  Pencil,
  Trash2,
} from "lucide-react";
import { type ReactNode, forwardRef } from "react";

/** Which layer a section renders: GLOBAL entries, or one project's. */
export type EntryScope =
  | { kind: "global" }
  | { kind: "project"; folderId: string };

const ENTRIES_QUERY_KEY = ["scope-entries"] as const;
const QUOTA_QUERY_KEY = ["always-quota"] as const;

const APPLY_LABEL: Record<DocumentApplyMode, string> = {
  always: "常驻",
  on_demand: "按需",
};

const APPLY_HINT: Record<DocumentApplyMode, string> = {
  always: "每回合注入",
  on_demand: "目录可见，按需查阅",
};

/** Fixed AI core leaf names (aligned with server ``memory.store`` / write_guards). */
const AI_CORE_NAMES = new Set(["偏好.md", "画像.md", "导航.md"]);

/** AI-maintained 画像 / 偏好 / 导航 — undeletable; topics stay deletable. */
export function isAiCoreMemoryLeaf(
  doc: Pick<DocumentNode, "name" | "aiMaintained">,
): boolean {
  return doc.aiMaintained && AI_CORE_NAMES.has(doc.name);
}

/** Ensure an entry name is markdown so it opens in the shared editor. */
function ensureMdName(name: string): string {
  return /\.(md|markdown)$/i.test(name) ? name : `${name}.md`;
}

/** Collision-free「新条目.md」within a scope's existing names. */
function nextEntryName(existing: Iterable<string>): string {
  const taken = new Set(existing);
  const base = "新条目";
  if (!taken.has(`${base}.md`)) return `${base}.md`;
  for (let i = 2; ; i++) {
    const candidate = `${base} ${i}.md`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Cold-start placeholders so core leaves stay visible before any document row exists. */
type CorePlaceholder = {
  name: string;
  path: string;
  applyMode: DocumentApplyMode;
};

function corePlaceholders(scope: EntryScope): CorePlaceholder[] {
  if (scope.kind === "global") {
    return [
      {
        name: "偏好.md",
        path: GLOBAL_PREFERENCES_PATH,
        applyMode: "always",
      },
      {
        name: "画像.md",
        path: GLOBAL_PROFILE_PATH,
        applyMode: "always",
      },
    ];
  }
  return [
    {
      name: "画像.md",
      path: memoryProjectProfilePath(scope.folderId),
      applyMode: "always",
    },
    {
      name: "导航.md",
      path: memoryProjectNavigationPath(scope.folderId),
      applyMode: "always",
    },
  ];
}

type DisplayRow =
  | { kind: "doc"; doc: DocumentNode }
  | { kind: "placeholder"; leaf: CorePlaceholder };

function mergeDisplayRows(
  scope: EntryScope,
  docs: DocumentNode[],
): DisplayRow[] {
  const present = new Set(docs.map((d) => d.name));
  const rows: DisplayRow[] = [
    ...docs.map((doc): DisplayRow => ({ kind: "doc", doc })),
    ...corePlaceholders(scope)
      .filter((leaf) => !present.has(leaf.name))
      .map((leaf): DisplayRow => ({ kind: "placeholder", leaf })),
  ];
  return rows.sort((a, b) => {
    const an = a.kind === "doc" ? a.doc.name : a.leaf.name;
    const bn = b.kind === "doc" ? b.doc.name : b.leaf.name;
    return an.localeCompare(bn, "zh");
  });
}

/**
 * Where to open an entry in the detail pane.
 * AI-maintained notes keep memory synthetic paths (editor + 双栏画像); user-owned
 * entries open via the documents source (path = document id).
 */
export type EntryOpenTarget =
  | { channel: "memory"; path: string; name: string }
  | { channel: "document"; path: string; name: string };

/** Map a listed document onto the workbench open channel. */
export function entryOpenTarget(doc: DocumentNode): EntryOpenTarget {
  if (doc.aiMaintained) {
    const memoryPath = memoryPathForDocument(doc);
    if (memoryPath) {
      return { channel: "memory", path: memoryPath, name: doc.name };
    }
  }
  return { channel: "document", path: doc.id, name: doc.name };
}

function memoryPathForDocument(doc: DocumentNode): string | null {
  const { name, folderId } = doc;
  if (name === "偏好.md" && folderId == null) return GLOBAL_PREFERENCES_PATH;
  if (name === "画像.md") {
    return folderId ? memoryProjectProfilePath(folderId) : GLOBAL_PROFILE_PATH;
  }
  if (name === "导航.md" && folderId != null) {
    return memoryProjectNavigationPath(folderId);
  }
  const topic = /^主题\/(.+?)(?:\.md)?$/i.exec(name);
  if (topic) return memoryTopicPath(folderId, topic[1]);
  return null;
}

function formatQuota(q: AlwaysQuota): string {
  return `常驻 ${q.percent}%（${q.usedChars} / ${q.maxChars}）`;
}

/**
 * Flat entry list for one AgentCore scope (目标形态 · 文件页形态).
 * No 记忆/规则/文档 folders — partition is scope only; each row shows 常驻/按需 +
 * description + frontmatter errors; always-pool meter stays visible when open.
 */
export function EntriesSection({
  scope,
  memoryActivePath,
  documentActivePath,
  onOpen,
  onDeleted,
  onRenamed,
  onOpenUpdates,
  indent = 0,
}: {
  scope: EntryScope;
  memoryActivePath: string | null;
  documentActivePath: string | null;
  onOpen: (target: EntryOpenTarget) => void;
  onDeleted: (target: EntryOpenTarget) => void;
  onRenamed: (target: EntryOpenTarget, name: string) => void;
  /** GLOBAL-only「最近更新」feed opener. */
  onOpenUpdates?: () => void;
  indent?: number;
}) {
  const queryClient = useQueryClient();
  const folderId = scope.kind === "project" ? scope.folderId : null;

  const entries = useQuery({
    queryKey: [...ENTRIES_QUERY_KEY, folderId ?? "global"],
    queryFn: () => listScopeEntries(folderId),
    staleTime: 30_000,
    retry: (failureCount, error) =>
      !isFeatureUnavailable(error) && failureCount < 3,
  });

  const quota = useQuery({
    queryKey: [...QUOTA_QUERY_KEY, folderId ?? "global"],
    queryFn: () => getAlwaysQuota(folderId),
    staleTime: 15_000,
    retry: (failureCount, error) =>
      !isFeatureUnavailable(error) && failureCount < 3,
  });

  const rows = entries.data ?? [];
  const displayRows = mergeDisplayRows(scope, rows);
  const leafPad = indent + 8;

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ENTRIES_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: QUOTA_QUERY_KEY }),
    ]);
  };

  const createEntry = async () => {
    try {
      const doc = await createRuleDocument(
        nextEntryName(rows.map((r) => r.name)),
        folderId,
      );
      await refresh();
      onOpen(entryOpenTarget(doc));
    } catch (e) {
      notifyError(e, "新建条目失败");
    }
  };

  const renameEntry = async (doc: DocumentNode) => {
    if (doc.aiMaintained) return;
    const input = window.prompt("条目名称", doc.name);
    if (input === null) return;
    const name = ensureMdName(input.trim());
    if (name === ".md" || name === doc.name) return;
    try {
      await renameDocument(doc.id, name);
      await refresh();
      onRenamed(entryOpenTarget({ ...doc, name }), name);
    } catch (e) {
      notifyError(e, "重命名失败");
    }
  };

  const removeEntry = async (doc: DocumentNode) => {
    if (isAiCoreMemoryLeaf(doc)) return;
    if (!window.confirm(`确定删除「${doc.name}」？此操作不可撤销。`)) return;
    try {
      const target = entryOpenTarget(doc);
      await deleteDocument(doc.id);
      onDeleted(target);
      await refresh();
    } catch (e) {
      notifyError(e, "删除失败");
    }
  };

  const setApplyMode = async (doc: DocumentNode, mode: DocumentApplyMode) => {
    if (doc.aiMaintained || doc.applyMode === mode) return;
    try {
      await updateDocumentApplyMode(doc.id, mode);
      await refresh();
    } catch (e) {
      notifyError(e, "切换失败");
    }
  };

  const isActive = (target: EntryOpenTarget) =>
    target.channel === "memory"
      ? memoryActivePath === target.path
      : documentActivePath === target.path;

  const renderDocRow = (doc: DocumentNode) => {
    const mode = doc.applyMode;
    const other: DocumentApplyMode = mode === "always" ? "on_demand" : "always";
    const canToggleApply = !doc.aiMaintained && !doc.frontmatterError;
    const canDelete = !isAiCoreMemoryLeaf(doc);
    const target = entryOpenTarget(doc);
    return (
      <ContextMenu key={doc.id}>
        <ContextMenuTrigger asChild>
          <EntryLeafRow
            paddingLeft={leafPad}
            icon={
              <FileText size={14} className="shrink-0 text-muted-foreground" />
            }
            label={doc.name}
            description={doc.description}
            frontmatterError={doc.frontmatterError}
            active={isActive(target)}
            onOpen={() => onOpen(target)}
            applyMode={mode}
            onToggleApplyMode={
              canToggleApply ? () => void setApplyMode(doc, other) : undefined
            }
          />
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-36">
          <ContextMenuItem
            disabled={!canToggleApply || mode === "always"}
            title={APPLY_HINT.always}
            onSelect={() => void setApplyMode(doc, "always")}
          >
            <span className="flex-1 truncate">设为常驻</span>
          </ContextMenuItem>
          <ContextMenuItem
            disabled={!canToggleApply || mode === "on_demand"}
            title={APPLY_HINT.on_demand}
            onSelect={() => void setApplyMode(doc, "on_demand")}
          >
            <span className="flex-1 truncate">设为按需</span>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            disabled={doc.aiMaintained}
            onSelect={() => void renameEntry(doc)}
          >
            <Pencil size={14} className="shrink-0" />
            <span className="flex-1 truncate">重命名</span>
          </ContextMenuItem>
          <ContextMenuItem
            variant="danger"
            disabled={!canDelete}
            onSelect={() => void removeEntry(doc)}
          >
            <Trash2 size={14} className="shrink-0" />
            <span className="flex-1 truncate">删除</span>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  };

  const renderPlaceholderRow = (leaf: CorePlaceholder) => {
    const target: EntryOpenTarget = {
      channel: "memory",
      path: leaf.path,
      name: leaf.name,
    };
    return (
      <EntryLeafRow
        key={`placeholder:${leaf.path}`}
        paddingLeft={leafPad}
        icon={<FileText size={14} className="shrink-0 text-muted-foreground" />}
        label={leaf.name}
        description=""
        frontmatterError={null}
        active={isActive(target)}
        onOpen={() => onOpen(target)}
        applyMode={leaf.applyMode}
      />
    );
  };

  return (
    <div>
      <div
        className="flex items-center gap-1 py-0.5"
        style={{ paddingLeft: leafPad }}
      >
        <div className="min-w-0 flex-1">
          {quota.isSuccess ? (
            <AlwaysQuotaMeter quota={quota.data} />
          ) : quota.isError && !isFeatureUnavailable(quota.error) ? (
            <button
              type="button"
              onClick={() => void quota.refetch()}
              className="text-left text-xs text-destructive/80 hover:underline"
            >
              常驻用量加载失败，点此重试
            </button>
          ) : null}
        </div>
        <IconButton title="新建条目" onClick={() => void createEntry()}>
          <FilePlus size={14} />
        </IconButton>
      </div>

      {scope.kind === "global" && onOpenUpdates && (
        <EntryLeafRow
          paddingLeft={leafPad}
          icon={
            <History size={14} className="shrink-0 text-muted-foreground" />
          }
          label="最近更新"
          description=""
          frontmatterError={null}
          active={memoryActivePath === MEMORY_UPDATES_PATH}
          onOpen={onOpenUpdates}
        />
      )}

      {entries.isLoading ? (
        <div
          className="flex h-7 items-center gap-1.5 text-xs text-muted-foreground"
          style={{ paddingLeft: leafPad }}
        >
          <Loader2 size={12} className="animate-spin" />
          加载中…
        </div>
      ) : entries.isError ? (
        isFeatureUnavailable(entries.error) ? (
          <div
            title="服务端升级后自动恢复"
            className="flex min-h-7 items-center py-1 text-xs text-muted-foreground/60"
            style={{ paddingLeft: leafPad }}
          >
            条目功能暂不可用（服务端待升级）
          </div>
        ) : (
          <button
            type="button"
            onClick={() => void entries.refetch()}
            style={{ paddingLeft: leafPad }}
            className="flex h-7 w-full items-center gap-1 text-left text-xs text-destructive/80 hover:underline"
          >
            加载失败，点此重试
          </button>
        )
      ) : displayRows.length === 0 ? (
        <div
          className="flex flex-col gap-1 py-1"
          style={{ paddingLeft: leafPad }}
        >
          <p className="text-xs text-muted-foreground/60">
            {scope.kind === "global" ? "还没有全局条目" : "本项目还没有条目"}
          </p>
          <p className="text-xs text-muted-foreground/50">
            短硬约束用常驻，厚知识用按需
          </p>
        </div>
      ) : (
        displayRows.map((row) =>
          row.kind === "doc"
            ? renderDocRow(row.doc)
            : renderPlaceholderRow(row.leaf),
        )
      )}
    </div>
  );
}

function AlwaysQuotaMeter({ quota }: { quota: AlwaysQuota }) {
  const over = quota.maxChars > 0 && quota.usedChars > quota.maxChars;
  const pct = Math.min(100, Math.max(0, quota.percent));
  return (
    <div className="min-w-0" title="常驻条目占用的注入配额（写侧闸；读侧全量）">
      <div
        className={cn(
          "truncate text-xs",
          over ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {formatQuota(quota)}
      </div>
      <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full transition-[width]",
            over ? "bg-destructive" : "bg-primary/70",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

const EntryLeafRow = forwardRef<
  HTMLDivElement,
  {
    paddingLeft: number;
    icon: ReactNode;
    label: string;
    description: string;
    frontmatterError: string | null;
    active: boolean;
    onOpen: () => void;
    applyMode?: DocumentApplyMode;
    onToggleApplyMode?: () => void;
  }
>(function EntryLeafRow(
  {
    paddingLeft,
    icon,
    label,
    description,
    frontmatterError,
    active,
    onOpen,
    applyMode,
    onToggleApplyMode,
    ...rest
  },
  ref,
) {
  const hasMeta = Boolean(description || frontmatterError);
  return (
    <div
      ref={ref}
      {...rest}
      style={{ paddingLeft }}
      className={cn(
        "flex w-full items-start gap-1.5 rounded-lg py-1 pr-1 text-sm transition-colors",
        hasMeta ? "min-h-7" : "h-7 items-center",
        active
          ? "bg-accent text-foreground"
          : "text-foreground hover:bg-accent/60",
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-start gap-1.5 rounded-lg text-left"
      >
        <span className={cn("shrink-0", hasMeta ? "mt-0.5" : "")}>{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1">
            <span className="min-w-0 truncate">{label}</span>
            {frontmatterError ? (
              <span
                title={`frontmatter 无效，该条不生效：${frontmatterError}`}
                className="inline-flex shrink-0 items-center gap-0.5 text-destructive"
              >
                <AlertTriangle size={12} aria-hidden />
                <span className="text-xs">不生效</span>
              </span>
            ) : null}
          </span>
          {frontmatterError ? (
            <span className="mt-0.5 block truncate text-xs text-destructive/80">
              {frontmatterError}
            </span>
          ) : description ? (
            <span className="mt-0.5 block truncate text-xs text-muted-foreground">
              {description}
            </span>
          ) : null}
        </span>
      </button>
      {applyMode && onToggleApplyMode ? (
        <button
          type="button"
          title={`${APPLY_LABEL[applyMode]} · ${APPLY_HINT[applyMode]}（点击切换）`}
          aria-label={`生效方式：${APPLY_LABEL[applyMode]}，点击切换`}
          onClick={onToggleApplyMode}
          className={cn("shrink-0 rounded-full", hasMeta ? "mt-0.5" : "")}
        >
          <Badge tone="muted" pill className="pointer-events-none font-normal">
            {APPLY_LABEL[applyMode]}
          </Badge>
        </button>
      ) : applyMode ? (
        <span className={cn("shrink-0", hasMeta ? "mt-0.5" : "")}>
          <Badge tone="muted" pill className="font-normal">
            {APPLY_LABEL[applyMode]}
          </Badge>
        </span>
      ) : null}
    </div>
  );
});
EntryLeafRow.displayName = "EntryLeafRow";
