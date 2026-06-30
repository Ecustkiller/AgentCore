import { Card, PatternCardHeader } from "@/components/ui";
import {
  countPillMuted,
  statusCardChrome,
  statusPillInline,
} from "@/components/ui/tone-presets";
import { memoryLeafTabName } from "@/services/sources/memorySource";
import type { MemoryUpdate, MemoryUpdateItem } from "@/stores/conversation";
import { Brain, ChevronRight } from "lucide-react";
import { useNavigate } from "react-router-dom";

/**
 * 记忆已更新 — conversation-tail card (记忆更新对话内可见, Agent记忆与知识系统 §1.6).
 *
 * The READ side of memory (`consult_memory`) was already visible inline; the WRITE
 * side (offline consolidation) was only a fleeting toast. This card makes「AI 记了
 * 什么」persistent and conversation-anchored: it renders after the last message
 * (consolidation folds a window of turns, so it post-dates them all), replays on
 * reload (loaded with the latest window), and appears live off the firehose.
 *
 * Each row is one applied change — an action chip (新增/更新/移除) + the friendly
 * target (偏好 / 画像 / 主题·<slug>, plus 全局/本项目 scope) + the bullet text. A row
 * with a `target` deep-links straight to that exact leaf in the「AI 记忆」editor (the
 * `/files` workbench opens the precise tab), where the user can audit / edit / delete
 * the bullet — control follows visibility, down to the specific leaf.
 */
export function MemoryUpdateCard({ update }: { update: MemoryUpdate }) {
  const navigate = useNavigate();
  // Neutral chrome: remembering is passive/background, not an action that needs you
  // (color-tokens.mdc — primary is reserved for「需要你」surfaces).
  const chrome = statusCardChrome("muted");

  if (update.items.length === 0) return null;

  // Deep-link to a specific memory leaf: navigate to the 文件 hub carrying the leaf in
  // navigation state (mirrors the existing focusWsId「浏览文件」hand-off); the workbench
  // opens that exact tab. The name matches what the rail would label it.
  const openLeaf = (target: string) => {
    navigate("/files", {
      state: {
        openMemoryLeaf: { path: target, name: memoryLeafTabName(target) },
      },
    });
  };

  const hasAnyTarget = update.items.some((it) => it.target);

  return (
    <Card
      className={`animate-task-card-enter p-3 ${chrome.border} ${chrome.surface}`}
    >
      <PatternCardHeader
        icon={<Brain size={16} />}
        iconClassName={chrome.accent}
        label="记忆已更新"
        labelClassName={chrome.accent}
        badge={<span className={countPillMuted}>{update.items.length} 项</span>}
        trailing={formatWhen(update.createdAt)}
      />
      <ul className="mt-2 space-y-0.5">
        {update.items.map((item, i) => (
          <MemoryUpdateRow
            // Items have no own id (they're a JSONB summary); the tuple is stable and
            // the list never reorders.
            key={`${item.action}:${item.file}:${item.section}:${i}`}
            item={item}
            onOpenLeaf={openLeaf}
          />
        ))}
      </ul>
      {/* Legacy fallback: pre-target rows can't deep-link, so offer the generic 记忆
          editor entry. When rows carry targets they ARE the (richer) deep-links, so no
          separate footer. Hash anchor (createHashRouter) needs no Router context. */}
      {!hasAnyTarget && (
        <div className="mt-2 flex justify-end">
          <a
            href="#/files"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            在「AI 记忆」中查看
            <ChevronRight size={13} />
          </a>
        </div>
      )}
    </Card>
  );
}

const ACTION_META: Record<
  string,
  { label: string; tone: "success" | "primary" | "muted" }
> = {
  add: { label: "新增", tone: "success" },
  update: { label: "更新", tone: "primary" },
  remove: { label: "移除", tone: "muted" },
};

function scopeLabel(scope: string): string {
  return scope === "project" ? "本项目" : "全局";
}

function MemoryUpdateRow({
  item,
  onOpenLeaf,
}: {
  item: MemoryUpdateItem;
  onOpenLeaf: (target: string) => void;
}) {
  const meta = ACTION_META[item.action] ?? {
    label: item.action,
    tone: "muted",
  };
  const leafLabel = item.section ? `${item.file} · ${item.section}` : item.file;
  // A remove carries the text that was dropped — strike it through so the row reads
  // as a deletion rather than a new bullet.
  const removed = item.action === "remove";

  const body = (
    <>
      <span className={`shrink-0 ${statusPillInline[meta.tone]}`}>
        {meta.label}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="truncate">{leafLabel}</span>
          <span className={countPillMuted}>{scopeLabel(item.scope)}</span>
        </div>
        {item.content && (
          <p
            className={`mt-0.5 whitespace-pre-wrap break-words text-sm ${
              removed ? "text-muted-foreground line-through" : "text-foreground"
            }`}
          >
            {item.content}
          </p>
        )}
      </div>
    </>
  );

  // With a target the whole row is a deep-link to that leaf; without one (legacy rows)
  // it's plain, with the card footer offering the generic editor entry instead.
  if (item.target) {
    return (
      <li>
        <button
          type="button"
          onClick={() => onOpenLeaf(item.target)}
          title={`在「AI 记忆」中打开${item.file}`}
          className="group flex w-full items-start gap-2 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-accent/50"
        >
          {body}
          <ChevronRight
            size={14}
            className="mt-0.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
          />
        </button>
      </li>
    );
  }

  return <li className="flex items-start gap-2 px-1.5 py-1">{body}</li>;
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}
