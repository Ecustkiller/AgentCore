import {
  MemoryUpdateItemRow,
  formatMemoryTime,
} from "@/components/memory/MemoryUpdateItemRow";
import { Card } from "@/components/ui";
import { countPillMuted, statusCardChrome } from "@/components/ui/tone-presets";
import { memoryLeafTabName } from "@/services/sources/memorySource";
import type { MemoryUpdate } from "@/stores/conversation";
import { usePersistentDisclosure } from "@/stores/disclosure";
import { Brain, ChevronDown, ChevronRight } from "lucide-react";
import { useNavigate } from "react-router-dom";

/**
 * 记忆已更新 — in-conversation memory-write notice (记忆更新对话内可见, Agent记忆与知识
 * 系统 §1.6).
 *
 * The READ side of memory (`consult_memory`) was already visible inline; the WRITE
 * side (offline consolidation) was only a fleeting toast. This card makes「AI 记了
 * 什么」persistent + conversation-anchored. It is **time-anchored into the timeline**
 * by its `created_at` (MessageList/mergeTimeline) — consolidation folds a window of
 * turns, so it sits right after that window and scrolls into history as the chat
 * continues — replays on reload (loaded with the latest window), and appears live off
 * the firehose.
 *
 * Prominence is **克制** (ChatGPT-style): collapsed to a single quiet line by default
 * (icon +「记忆已更新」+ N 项 + time); click to expand the applied changes. Each row is
 * one change — an action chip (新增/更新/移除) + the friendly target (偏好 / 画像 /
 * 主题·<slug>, plus 全局/本项目 scope) + the bullet text. A row with a `target`
 * deep-links straight to that exact leaf in the「AI 记忆」editor (the `/files` workbench
 * opens the precise tab) — control follows visibility, down to the specific leaf.
 */
export function MemoryUpdateCard({ update }: { update: MemoryUpdate }) {
  const navigate = useNavigate();
  // Neutral chrome: remembering is passive/background, not an action that needs you
  // (color-tokens.mdc — primary is reserved for「需要你」surfaces).
  const chrome = statusCardChrome("muted");
  // Collapsed by default — a memory write is ambient FYI, not something to read every
  // time; expand on demand to audit what changed.
  const [open, setOpen] = usePersistentDisclosure(`memory:${update.id}`, false);

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
      className={`animate-task-card-enter ${chrome.border} ${chrome.surface}`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <Brain size={16} className={`shrink-0 ${chrome.accent}`} />
        <span className={`text-xs font-medium ${chrome.accent}`}>
          记忆已更新
        </span>
        <span className={countPillMuted}>{update.items.length} 项</span>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
          {formatMemoryTime(update.createdAt)}
        </span>
        {open ? (
          <ChevronDown size={14} className="shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight size={14} className="shrink-0 text-muted-foreground" />
        )}
      </button>
      {open && (
        <div className="px-3 pb-3">
          <ul className="space-y-0.5">
            {update.items.map((item, i) => (
              <MemoryUpdateItemRow
                // Items have no own id (they're a JSONB summary); the tuple is stable
                // and the list never reorders.
                key={`${item.action}:${item.file}:${item.section}:${i}`}
                item={item}
                onOpenLeaf={openLeaf}
              />
            ))}
          </ul>
          {/* Legacy fallback: pre-target rows can't deep-link, so offer the generic 记忆
              editor entry. When rows carry targets they ARE the (richer) deep-links, so
              no separate footer. Hash anchor (createHashRouter) needs no Router context. */}
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
        </div>
      )}
    </Card>
  );
}
