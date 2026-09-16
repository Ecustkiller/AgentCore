import { countPillMuted, statusPillInline } from "@/components/ui/tone-presets";
import { getFolders } from "@/hooks/useFolders";
import type { MemoryUpdateItem } from "@/stores/conversation";
import { ChevronRight } from "lucide-react";

/**
 * One applied memory change (新增/更新/移除 + 目标叶子 + 正文), used by the
 * in-conversation「记忆已更新」card. Read-only: expand the card and open the
 * leftover file; no row-level 纠错 / 搬层.
 *
 * Quota cards reuse these rows so「什么没写进来 / 谁占着配额」reads like any other
 * memory row and deep-links the same way; {@link visibleMemoryUpdateItems} hides
 * the internal fingerprint row.
 */

const ACTION_META: Record<
  MemoryUpdateItem["action"],
  { label: string; tone: "success" | "primary" | "muted" }
> = {
  add: { label: "新增", tone: "success" },
  update: { label: "更新", tone: "primary" },
  remove: { label: "移除", tone: "muted" },
  quota: { label: "配额", tone: "muted" },
  quota_denied: { label: "未写入", tone: "muted" },
  quota_holder: { label: "占用", tone: "muted" },
};

/**
 * Drop rows that exist only for the backend (the `quota` row carries the card's dedup
 * fingerprint — a hash the user must never see). Used for both rendering and counting so
 * the「N 项」pill matches what the card actually lists.
 */
export function visibleMemoryUpdateItems<T extends { action: string }>(
  items: readonly T[],
): T[] {
  return items.filter((it) => it.action !== "quota");
}

/** Resolve a folder id to its display name from the cached folder list. */
export function resolveProjectName(
  projectId: string | null | undefined,
): string | null {
  if (!projectId) return null;
  return getFolders().find((f) => f.id === projectId)?.name ?? null;
}

/** Scope pill label: `全局` / `本文件夹 · {名}` / `本文件夹` (name resolve failure). */
export function memoryScopePillLabel(
  scope: string,
  projectId?: string | null,
): string {
  if (scope !== "project") return "全局";
  const name = resolveProjectName(projectId);
  return name ? `本文件夹 · ${name}` : "本文件夹";
}

/**
 * Compact scope overview for a card title (e.g. `全局 + 本文件夹 · Foo`). Empty when
 * there are no items.
 */
export function memoryScopeOverview(
  items: ReadonlyArray<{ scope: string; projectId?: string | null }>,
): string {
  if (items.length === 0) return "";
  const parts: string[] = [];
  if (items.some((it) => it.scope !== "project")) parts.push("全局");
  const seen = new Set<string>();
  for (const it of items) {
    if (it.scope !== "project") continue;
    const key = it.projectId ?? "";
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(memoryScopePillLabel("project", it.projectId));
  }
  return parts.join(" + ");
}

export function MemoryUpdateItemRow({
  item,
  onOpenLeaf,
}: {
  item: MemoryUpdateItem;
  onOpenLeaf: (target: string, projectId?: string | null) => void;
}) {
  const meta = ACTION_META[item.action];
  const leafLabel = item.section ? `${item.file} · ${item.section}` : item.file;
  const removed = item.action === "remove";
  const dimmed = removed || item.action === "quota_denied";

  const metaBlock = (
    <>
      <div className="flex min-w-0 items-center gap-1.5 text-xs">
        <span className="min-w-0 truncate font-medium text-foreground">
          {leafLabel}
        </span>
        <span className={countPillMuted}>
          {memoryScopePillLabel(item.scope, item.projectId)}
        </span>
      </div>
      {item.content && (
        <p
          className={`mt-0.5 whitespace-pre-wrap break-words text-sm ${
            dimmed ? "text-muted-foreground" : "text-foreground"
          } ${removed ? "line-through" : ""}`}
        >
          {item.content}
        </p>
      )}
    </>
  );

  const main = (
    <>
      <span className={`shrink-0 ${statusPillInline[meta.tone]}`}>
        {meta.label}
      </span>
      <div className="min-w-0 flex-1">{metaBlock}</div>
      {item.target ? (
        <ChevronRight
          size={14}
          className="mt-0.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
        />
      ) : null}
    </>
  );

  return (
    <li
      className={`flex items-start gap-2 px-1.5 py-1 ${
        item.target ? "rounded-lg hover:bg-accent/50" : ""
      }`}
    >
      {item.target ? (
        <button
          type="button"
          onClick={() => onOpenLeaf(item.target, item.projectId)}
          title={`在设定中打开${item.file}`}
          className="group flex min-w-0 flex-1 items-start gap-2 text-left"
        >
          {main}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-start gap-2">{main}</div>
      )}
    </li>
  );
}

/** Timestamp label shared by the memory card (MM-DD HH:mm). */
export function formatMemoryTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}
