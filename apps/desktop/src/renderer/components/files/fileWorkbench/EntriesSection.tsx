import { ConfirmDialog } from "@/components/ui";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { isFeatureUnavailable } from "@/lib/errors";
import { notifyError } from "@/lib/toast";
import { cn } from "@/lib/utils";
import {
  type DocumentNode,
  deleteDocument,
  listScopeEntries,
  renameDocument,
} from "@/services/documents";
import { type MemoryKind, writeMemoryFile } from "@/services/memory";
import {
  GLOBAL_PREFERENCES_PATH,
  GLOBAL_PROFILE_PATH,
  isMemoryTopicPath,
  memoryProjectNavigationPath,
  memoryProjectProfilePath,
  memoryTopicPath,
  parseProjectMemoryFolderId,
} from "@/services/sources/memorySource";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Eraser,
  FileText,
  Folder,
  FolderOpen,
  Loader2,
  Pencil,
  Trash2,
} from "lucide-react";
import {
  type HTMLAttributes,
  type ReactNode,
  forwardRef,
  useEffect,
  useState,
} from "react";
import { loadMemoryTopicsExpanded, saveMemoryTopicsExpanded } from "./storage";

/** Which layer a section renders: GLOBAL entries, or one project's. */
export type EntryScope =
  | { kind: "global" }
  | { kind: "folder"; folderId: string };

const ENTRIES_QUERY_KEY = ["scope-entries"] as const;

/**
 * Rows under this print no size at all. A row's char count exists to answer
 * 「池子紧张时该删谁」; against a 24k pool a sub-千字 entry answers it with nothing,
 * and it is the common case — repeated down the whole list the number stops
 * reading as a signal and just eats the width the filename needs.
 */
const ROW_CHARS_FLOOR = 1000;

/** Fixed AI core leaf names (aligned with server ``memory.store`` / write_guards). */
const AI_CORE_NAMES = new Set(["偏好.md", "画像.md", "导航.md"]);

const TOPIC_NAME_RE = /^主题\//;

/** Storage name ``主题/<slug>.md`` — logical dir, not a documents-tree folder. */
export function isTopicEntryName(name: string): boolean {
  return TOPIC_NAME_RE.test(name);
}

/** Rail label inside the 主题 folder: strip the ``主题/`` prefix. */
export function topicEntryDisplayName(name: string): string {
  return name.replace(TOPIC_NAME_RE, "");
}

function topicFolderKey(scope: EntryScope): string {
  return scope.kind === "global" ? "global" : scope.folderId;
}

/** True when the open tab is a 主题 leaf of *this* scope (not another desk's). */
function topicPathBelongsToScope(
  path: string | null,
  scope: EntryScope,
): boolean {
  if (!path || !isMemoryTopicPath(path)) return false;
  const folderId = parseProjectMemoryFolderId(path);
  return scope.kind === "global"
    ? folderId === null
    : folderId === scope.folderId;
}

/** AI-maintained 画像 / 偏好 / 导航 — named slots; clear via empty PUT, not DELETE. */
export function isAiCoreMemoryLeaf(
  doc: Pick<DocumentNode, "name" | "aiMaintained">,
): boolean {
  return doc.aiMaintained && AI_CORE_NAMES.has(doc.name);
}

/** Map a core leaf onto the per-file memory write surface; ``null`` = not a core. */
export function coreMemoryLeafKind(
  doc: Pick<DocumentNode, "name" | "aiMaintained" | "folderId">,
): MemoryKind | null {
  if (!isAiCoreMemoryLeaf(doc)) return null;
  if (doc.name === "偏好.md") return "preferences";
  if (doc.name === "画像.md") return "profile";
  if (doc.name === "导航.md") return "navigation";
  return null;
}

/** Ensure an entry name is markdown so it opens in the shared editor. */
function ensureMdName(name: string): string {
  return /\.(md|markdown)$/i.test(name) ? name : `${name}.md`;
}

function listedMainDocs(docs: DocumentNode[]): DocumentNode[] {
  return docs
    .filter((d) => !isTopicEntryName(d.name))
    .sort((a, b) => a.name.localeCompare(b.name, "zh"));
}

function topicEntryRows(docs: DocumentNode[]): DocumentNode[] {
  return docs
    .filter((d) => isTopicEntryName(d.name))
    .sort((a, b) =>
      topicEntryDisplayName(a.name).localeCompare(
        topicEntryDisplayName(b.name),
        "zh",
      ),
    );
}

/**
 * Where to open an entry in the detail pane.
 * AI-maintained leftover cores keep memory synthetic paths (ordinary md editor);
 * user-owned entries open via the documents source (path = document id).
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

/**
 * Coarsen char counts for humans: 千字 / 万字 buckets, never exact ones.
 * 0 and「不足千」are distinct — empty is not "almost a thousand".
 * Exported for unit tests.
 */
export function formatRoughChars(n: number): string {
  const chars = Math.max(0, Math.round(n));
  if (chars === 0) return "0 字";
  if (chars < 1000) return "不足千字";
  if (chars < 9500) return `约 ${Math.max(1, Math.round(chars / 1000))} 千字`;
  const wan = Math.round(chars / 1000) / 10;
  const label = Number.isInteger(wan) ? String(wan) : wan.toFixed(1);
  return `约 ${label} 万字`;
}

/** Per-entry always size (same coarsening as the meter). */
export function formatAlwaysChars(n: number): string {
  return formatRoughChars(n);
}

/**
 * Flat entry list for one AgentCore scope (目标形态 · 文件页形态).
 * No 记忆/规则/文档 folders — partition is scope only; each row shows
 * description + frontmatter errors. Location is the 加载档 (root = always,
 * ``主题/*.md`` nest under a default-collapsed 主题 row = on_demand). Create
 * lives on the section / `.agentcore` header so it still works while this list
 * is unmounted (collapsed).
 */
export function EntriesSection({
  scope,
  memoryActivePath,
  documentActivePath,
  onOpen,
  onDeleted,
  onRenamed,
  indent = 0,
}: {
  scope: EntryScope;
  memoryActivePath: string | null;
  documentActivePath: string | null;
  onOpen: (target: EntryOpenTarget) => void;
  onDeleted: (target: EntryOpenTarget) => void;
  onRenamed: (target: EntryOpenTarget, name: string) => void;
  indent?: number;
}) {
  const queryClient = useQueryClient();
  const folderId = scope.kind === "folder" ? scope.folderId : null;
  const [clearing, setClearing] = useState<DocumentNode | null>(null);
  const [clearBusy, setClearBusy] = useState(false);
  const foldKey = topicFolderKey(scope);
  const [topicsOpen, setTopicsOpen] = useState(() =>
    loadMemoryTopicsExpanded().has(foldKey),
  );

  const entries = useQuery({
    queryKey: [...ENTRIES_QUERY_KEY, folderId ?? "global"],
    queryFn: () => listScopeEntries(folderId),
    staleTime: 30_000,
    retry: (failureCount, error) =>
      !isFeatureUnavailable(error) && failureCount < 3,
  });

  const rows = entries.data ?? [];
  const displayRows = listedMainDocs(rows);
  const topicRows = topicEntryRows(rows);
  const topicActive = topicPathBelongsToScope(memoryActivePath, scope);
  const leafPad = indent + 8;
  const topicLeafPad = leafPad + 12;

  useEffect(() => {
    if (topicActive) setTopicsOpen(true);
  }, [topicActive]);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ENTRIES_QUERY_KEY });
  };

  const renameEntry = async (doc: DocumentNode) => {
    if (doc.aiMaintained) return;
    const input = window.prompt(
      "条目名称",
      isTopicEntryName(doc.name) ? topicEntryDisplayName(doc.name) : doc.name,
    );
    if (input === null) return;
    const trimmed = input.trim();
    const name = isTopicEntryName(doc.name)
      ? `主题/${ensureMdName(trimmed.replace(/^主题\//, ""))}`
      : ensureMdName(trimmed);
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

  const confirmClearCoreLeaf = async () => {
    const doc = clearing;
    if (!doc || clearBusy) return;
    const kind = coreMemoryLeafKind(doc);
    if (!kind) return;
    setClearBusy(true);
    try {
      const result = await writeMemoryFile(kind, "", null, doc.folderId);
      if (!result.ok) {
        notifyError("这篇设定刚被改过，请刷新后再试。", "清空失败");
        return;
      }
      onDeleted(entryOpenTarget(doc));
      setClearing(null);
      await refresh();
    } catch (e) {
      notifyError(e, "清空失败");
    } finally {
      setClearBusy(false);
    }
  };

  const isActive = (target: EntryOpenTarget) =>
    target.channel === "memory"
      ? memoryActivePath === target.path
      : documentActivePath === target.path;

  const renderDocRow = (
    doc: DocumentNode,
    opts?: { paddingLeft?: number; label?: string },
  ) => {
    const target = entryOpenTarget(doc);
    return (
      <ContextMenu key={doc.id}>
        <ContextMenuTrigger asChild>
          <EntryLeafRow
            paddingLeft={opts?.paddingLeft ?? leafPad}
            icon={
              <FileText size={14} className="shrink-0 text-muted-foreground" />
            }
            label={opts?.label ?? doc.name}
            description={doc.description}
            frontmatterError={doc.frontmatterError}
            active={isActive(target)}
            onOpen={() => onOpen(target)}
            alwaysChars={doc.alwaysChars}
          />
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-36">
          <ContextMenuItem
            disabled={doc.aiMaintained}
            onSelect={() => void renameEntry(doc)}
          >
            <Pencil size={14} className="shrink-0" />
            <span className="flex-1 truncate">重命名</span>
          </ContextMenuItem>
          {isAiCoreMemoryLeaf(doc) ? (
            <ContextMenuItem variant="danger" onSelect={() => setClearing(doc)}>
              <Eraser size={14} className="shrink-0" />
              <span className="flex-1 truncate">清空</span>
            </ContextMenuItem>
          ) : (
            <ContextMenuItem
              variant="danger"
              onSelect={() => void removeEntry(doc)}
            >
              <Trash2 size={14} className="shrink-0" />
              <span className="flex-1 truncate">删除</span>
            </ContextMenuItem>
          )}
        </ContextMenuContent>
      </ContextMenu>
    );
  };

  return (
    <div>
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
            className="flex h-7 w-full items-center gap-1 text-left text-xs text-muted-foreground hover:underline"
          >
            加载失败，点此重试
          </button>
        )
      ) : displayRows.length === 0 && topicRows.length === 0 ? (
        <div
          className="flex flex-col gap-1 py-1"
          style={{ paddingLeft: leafPad }}
        >
          <p className="text-xs text-muted-foreground/60">
            {scope.kind === "global" ? "还没有全局条目" : "本文件夹还没有条目"}
          </p>
        </div>
      ) : (
        <>
          {displayRows.map((doc) => renderDocRow(doc))}
          {topicRows.length > 0 ? (
            <div>
              <button
                type="button"
                aria-expanded={topicsOpen}
                aria-label={`主题，${topicRows.length} 条`}
                onClick={() => {
                  setTopicsOpen((open) => {
                    const next = !open;
                    const stored = loadMemoryTopicsExpanded();
                    if (next) stored.add(foldKey);
                    else stored.delete(foldKey);
                    saveMemoryTopicsExpanded(stored);
                    return next;
                  });
                }}
                style={{ paddingLeft: leafPad }}
                className="flex h-7 w-full items-center gap-1.5 rounded-lg pr-1 text-left text-sm text-foreground hover:bg-accent/60"
              >
                {topicsOpen ? (
                  <ChevronDown
                    size={14}
                    className="shrink-0 text-muted-foreground"
                  />
                ) : (
                  <ChevronRight
                    size={14}
                    className="shrink-0 text-muted-foreground"
                  />
                )}
                {topicsOpen ? (
                  <FolderOpen
                    size={14}
                    className="shrink-0 text-muted-foreground"
                  />
                ) : (
                  <Folder
                    size={14}
                    className="shrink-0 text-muted-foreground"
                  />
                )}
                <span className="min-w-0 flex-1 truncate">
                  主题 · {topicRows.length}
                </span>
              </button>
              {topicsOpen
                ? topicRows.map((doc) =>
                    renderDocRow(doc, {
                      paddingLeft: topicLeafPad,
                      label: topicEntryDisplayName(doc.name),
                    }),
                  )
                : null}
            </div>
          ) : null}
        </>
      )}

      <ConfirmDialog
        open={clearing != null}
        onOpenChange={(open) => {
          if (!open) setClearing(null);
        }}
        title={clearing ? `清空「${clearing.name}」？` : "清空这篇？"}
        description="列表里还会留下这个名字。项目文件不会被删。"
        confirmLabel="清空"
        tone="danger"
        busy={clearBusy}
        onConfirm={() => void confirmClearCoreLeaf()}
      />
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
    /** Always-pool chars for this row; only shown when non-null and above floor. */
    alwaysChars?: number | null;
    dimmed?: boolean;
  } & Omit<HTMLAttributes<HTMLDivElement>, "onClick">
>(function EntryLeafRow(
  {
    paddingLeft,
    icon,
    label,
    description,
    frontmatterError,
    active,
    onOpen,
    alwaysChars,
    dimmed = false,
    className,
    style,
    ...rest
  },
  ref,
) {
  const hasMeta = Boolean(description || frontmatterError);
  const showAlwaysChars =
    typeof alwaysChars === "number" &&
    Number.isFinite(alwaysChars) &&
    alwaysChars >= ROW_CHARS_FLOOR;
  return (
    <div
      ref={ref}
      {...rest}
      style={{ paddingLeft, ...style }}
      className={cn(
        "flex w-full items-start gap-1.5 rounded-lg py-1 pr-1 text-sm transition-colors",
        hasMeta ? "min-h-7" : "h-7 items-center",
        dimmed && !active && "text-muted-foreground opacity-60",
        active
          ? "bg-accent text-foreground"
          : "text-foreground hover:bg-accent/60",
        className,
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
      {showAlwaysChars ? (
        <span
          title="每次对话都会带上"
          className={cn(
            "shrink-0 text-xs text-muted-foreground",
            hasMeta ? "mt-0.5" : "",
          )}
        >
          {formatAlwaysChars(alwaysChars)}
        </span>
      ) : null}
    </div>
  );
});
EntryLeafRow.displayName = "EntryLeafRow";

export { EntryLeafRow };
