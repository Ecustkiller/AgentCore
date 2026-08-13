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
  setDocumentDisputed,
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
  ThumbsDown,
  Trash2,
  Undo2,
} from "lucide-react";
import { type ReactNode, forwardRef } from "react";

/** Which layer a section renders: GLOBAL entries, or one project's. */
export type EntryScope =
  | { kind: "global" }
  | { kind: "folder"; folderId: string };

const ENTRIES_QUERY_KEY = ["scope-entries"] as const;
const QUOTA_QUERY_KEY = ["always-quota"] as const;

const APPLY_LABEL: Record<DocumentApplyMode, string> = {
  always: "常驻",
  on_demand: "按需",
};

const APPLY_HINT: Record<DocumentApplyMode, string> = {
  always: "每次对话都会带上",
  on_demand: "需要时再查阅",
};

/** Near-full threshold for consequence copy (not just color). */
const NEAR_FULL_PERCENT = 80;

/**
 * Rows under this print no size at all. A row's char count exists to answer
 * 「池子紧张时该删谁」; against a 24k pool a sub-千字 entry answers it with nothing,
 * and it is the common case — repeated down the whole list the number stops
 * reading as a signal and just eats the width the filename needs.
 */
const ROW_CHARS_FLOOR = 1000;

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

export type AlwaysMeterTone = "ok" | "near" | "over";

export function alwaysMeterTone(q: AlwaysQuota): AlwaysMeterTone {
  if (q.maxChars > 0 && q.usedChars > q.maxChars) return "over";
  if (q.usedChars <= 0) return "ok";
  if (q.percent >= NEAR_FULL_PERCENT) return "near";
  return "ok";
}

/** `还剩约 8 千字` / `还剩不足千字` / `超出约 2 千字`. */
function glueCapacity(verb: "还剩" | "超出", amount: string): string {
  if (amount.startsWith("约 ")) return `${verb}${amount}`;
  if (amount === "0 字") return `${verb} ${amount}`;
  return `${verb}${amount}`;
}

/**
 * Meter primary line: remaining (or over-by) in one unit — no 千/万 mix, no subtraction.
 * Exported for unit tests.
 */
export function formatMeterHeadline(
  q: AlwaysQuota,
  variant: "global" | "folder",
): string {
  const tone = alwaysMeterTone(q);
  const subject = variant === "folder" ? "常驻（含全局）" : "常驻";
  if (tone === "over") {
    const overBy = Math.max(0, q.usedChars - q.maxChars);
    return `${subject} · 已满，${glueCapacity("超出", formatRoughChars(overBy))}`;
  }
  const remain = glueCapacity(
    "还剩",
    formatRoughChars(Math.max(0, q.maxChars - q.usedChars)),
  );
  if (tone === "near") return `${subject} · 快满了，${remain}`;
  return `${subject} · ${remain}`;
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
  const folderId = scope.kind === "folder" ? scope.folderId : null;

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

  // 纠错通道: only the user can say「这条不对」, and saying it stops the entry from being
  // used without deleting it — the text stays here to read, re-check and undo.
  const setDisputed = async (doc: DocumentNode, disputed: boolean) => {
    try {
      await setDocumentDisputed(doc.id, disputed);
      await refresh();
    } catch (e) {
      notifyError(e, disputed ? "标记失败" : "撤销标记失败");
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
    const disputed = doc.disputedAt != null;
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
            disputed={disputed}
            active={isActive(target)}
            onOpen={() => onOpen(target)}
            applyMode={mode}
            alwaysChars={doc.alwaysChars}
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
          {disputed ? (
            <ContextMenuItem
              title="恢复后 AI 会重新使用这条"
              onSelect={() => void setDisputed(doc, false)}
            >
              <Undo2 size={14} className="shrink-0" />
              <span className="flex-1 truncate">恢复使用</span>
            </ContextMenuItem>
          ) : (
            <ContextMenuItem
              title="AI 不再使用这条，内容保留，可随时恢复"
              onSelect={() => void setDisputed(doc, true)}
            >
              <ThumbsDown size={14} className="shrink-0" />
              <span className="flex-1 truncate">这条不对</span>
            </ContextMenuItem>
          )}
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
        disputed={false}
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
            <AlwaysQuotaMeter
              quota={quota.data}
              variant={scope.kind === "global" ? "global" : "folder"}
            />
          ) : quota.isError && !isFeatureUnavailable(quota.error) ? (
            <button
              type="button"
              onClick={() => void quota.refetch()}
              className="text-left text-xs text-destructive/80 hover:underline"
            >
              用量加载失败，点此重试
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
          disputed={false}
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
            {scope.kind === "global" ? "还没有全局条目" : "本文件夹还没有条目"}
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

/**
 * Always-pool meter, sized by state: calm scopes collapse to the remaining-chars
 * line alone so the rail reads as a list of entries; 快满 / 已超 keep the full
 * block (consequence copy + two-tone bar). Quota stays visible in every state —
 * only the chrome around it shrinks.
 *
 * Calm state deliberately has **no bar**: at the 288px default rail width an
 * inline bar pushes `常驻（含全局）· 还剩约 N 万字` past truncation, and the number
 * it would cut is the only thing this line exists to say.
 */
function AlwaysQuotaMeter({
  quota,
  variant,
}: {
  quota: AlwaysQuota;
  variant: "global" | "folder";
}) {
  const tone = alwaysMeterTone(quota);
  const headline = formatMeterHeadline(quota, variant);

  if (tone === "ok") {
    return (
      <div
        className="min-w-0 truncate text-xs text-muted-foreground"
        title="每次对话都会带上"
      >
        {headline}
      </div>
    );
  }

  const caption =
    tone === "over"
      ? "AI 暂时记不下新东西，去整理"
      : "AI 快记不下新东西了，去整理";
  const title = [
    variant === "folder" ? "浅色是全局，深色是本文件夹" : null,
    tone === "over" ? `已满：${caption}` : `快满了：${caption}`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      className="min-w-0 rounded-lg bg-destructive/5 px-1.5 py-1.5"
      title={title}
    >
      {/* Wraps rather than truncates: this is the state where 还剩/超出多少字 must
          survive, and the block is already the one allowed to take room. */}
      <div className="text-sm font-medium leading-snug text-destructive">
        {headline}
      </div>
      <div className="mt-1.5 text-xs leading-snug text-destructive">
        {caption}
      </div>
      <AlwaysQuotaBar quota={quota} variant={variant} />
    </div>
  );
}

/** 快满 / 已超 fill — calm scopes render no bar, so every tone here is destructive. */
function AlwaysQuotaBar({
  quota,
  variant,
}: {
  quota: AlwaysQuota;
  variant: "global" | "folder";
}) {
  const max = Math.max(1, quota.maxChars);
  // When over the cap, scale segments against used so both tones stay visible
  // (max-based math would clamp global to 100% and hide the project slice).
  const over = quota.usedChars > quota.maxChars;
  const barBase = over ? Math.max(1, quota.usedChars) : max;
  const globalPct = Math.min(
    100,
    Math.max(0, (100 * quota.globalChars) / barBase),
  );
  const projectPct = Math.min(
    100 - globalPct,
    Math.max(0, (100 * quota.projectChars) / barBase),
  );
  const usedPct = over
    ? 100
    : Math.min(100, Math.max(0, (100 * quota.usedChars) / max));

  return (
    <div className="mt-2 flex h-1.5 w-full overflow-hidden rounded-full bg-muted">
      {variant === "folder" ? (
        <>
          <div
            className="h-full bg-destructive/45 transition-[width]"
            style={{ width: `${globalPct}%` }}
            title="全局"
          />
          <div
            className="h-full bg-destructive transition-[width]"
            style={{ width: `${projectPct}%` }}
            title="本文件夹"
          />
        </>
      ) : (
        <div
          className="h-full rounded-full bg-destructive transition-[width]"
          style={{ width: `${usedPct}%` }}
        />
      )}
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
    /** User marked this entry wrong: AI stops using it, the text stays (纠错通道). */
    disputed?: boolean;
    active: boolean;
    onOpen: () => void;
    applyMode?: DocumentApplyMode;
    /** Always-pool chars for this row; only shown when always + non-null. */
    alwaysChars?: number | null;
    onToggleApplyMode?: () => void;
  }
>(function EntryLeafRow(
  {
    paddingLeft,
    icon,
    label,
    description,
    frontmatterError,
    disputed = false,
    active,
    onOpen,
    applyMode,
    alwaysChars,
    onToggleApplyMode,
    ...rest
  },
  ref,
) {
  const hasMeta = Boolean(description || frontmatterError);
  // A disputed entry no longer rides the prompt, so its always size is not being spent.
  // Empty rows stay silent too, which is also what keeps a cold-start placeholder and a
  // written-but-empty entry looking the same.
  const showAlwaysChars =
    applyMode === "always" &&
    !disputed &&
    typeof alwaysChars === "number" &&
    Number.isFinite(alwaysChars) &&
    alwaysChars >= ROW_CHARS_FLOOR;
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
            <span
              className={cn(
                "min-w-0 truncate",
                disputed && "text-muted-foreground line-through",
              )}
            >
              {label}
            </span>
            {disputed ? (
              <span
                title="你标了「这条不对」：AI 不再使用，内容仍保留（右键可恢复）"
                className="inline-flex shrink-0 items-center gap-0.5 text-muted-foreground"
              >
                <ThumbsDown size={12} aria-hidden />
                <span className="text-xs">已停用</span>
              </span>
            ) : null}
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
      {applyMode && onToggleApplyMode ? (
        <button
          type="button"
          title={
            disputed
              ? `${APPLY_LABEL[applyMode]} · 已停用，AI 不会用（点击切换生效方式）`
              : `${APPLY_LABEL[applyMode]} · ${APPLY_HINT[applyMode]}（点击切换）`
          }
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
