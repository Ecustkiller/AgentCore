import { Modal } from "@/components/Modal";
import type {
  MentionCategoryRow,
  MentionSectionId,
} from "@/lib/composerMention";
import type { MentionListItem } from "@/lib/useComposerMention";
import { ChevronLeft, ChevronRight } from "lucide-react";

/**
 * Agent 对话 @ 分类 sheet：附件 / 团队 / 对话 / 文件夹 / 文件。
 * 「＋」→ @ 引用 与输入框手打 @ 共用这一张。IM 群聊 @人 不走这里。
 */
export function ComposerMentionSheet({
  query,
  showCategoryLevel,
  categories,
  items,
  emptyHint,
  focusedLabel,
  canGoBack,
  loading,
  error,
  disabled,
  onQueryChange,
  onDrill,
  onBack,
  onSelect,
  onPickAttach,
  onClose,
}: {
  query: string;
  showCategoryLevel: boolean;
  categories: MentionCategoryRow[];
  items: MentionListItem[];
  emptyHint?: string;
  focusedLabel?: string;
  canGoBack: boolean;
  loading?: boolean;
  error?: string | null;
  disabled?: boolean;
  onQueryChange: (q: string) => void;
  onDrill: (id: MentionSectionId) => void;
  onBack: () => void;
  onSelect: (item: MentionListItem) => void;
  onPickAttach: () => void;
  onClose: () => void;
}) {
  return (
    <Modal className="sheet" onClose={onClose} label="引用">
      <div className="sheet-title" data-testid="composer-mention-sheet">
        {canGoBack ? (
          <button
            type="button"
            className="mention-back"
            onClick={onBack}
            aria-label="返回分类"
            data-testid="composer-mention-back"
          >
            <ChevronLeft size={16} aria-hidden />
            {focusedLabel ?? "引用"}
          </button>
        ) : (
          "引用"
        )}
      </div>

      {!showCategoryLevel && (
        <input
          className="composer-mention-search"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="筛选"
          aria-label="筛选引用"
          data-testid="composer-mention-search"
        />
      )}

      {error && (
        <div className="more-row-sub" data-testid="composer-mention-error">
          {error}
        </div>
      )}

      {showCategoryLevel &&
        categories.map((row) => {
          if (row.id === "attach") {
            return (
              <button
                key={row.id}
                type="button"
                className="more-row"
                disabled={disabled}
                data-testid="composer-mention-attach"
                aria-label="附件"
                onClick={onPickAttach}
              >
                <div className="more-row-main">
                  <span className="more-row-title">{row.label}</span>
                  <span className="more-row-sub muted">{row.hint}</span>
                </div>
              </button>
            );
          }
          const meta = row.disabled
            ? row.hint
            : row.loading
              ? "…"
              : String(row.count);
          return (
            <button
              key={row.id}
              type="button"
              className="more-row"
              disabled={disabled || row.disabled}
              data-testid={`composer-mention-cat-${row.id}`}
              aria-label={row.hint ? `${row.label}：${row.hint}` : row.label}
              onClick={() => {
                if (row.id === "attach") return;
                onDrill(row.id);
              }}
            >
              <div className="more-row-main">
                <span className="more-row-title">{row.label}</span>
                {meta && <span className="more-row-sub muted">{meta}</span>}
              </div>
              <ChevronRight size={16} className="muted" aria-hidden />
            </button>
          );
        })}

      {!showCategoryLevel &&
        items.map((item) => (
          <button
            key={itemKey(item)}
            type="button"
            className="more-row"
            disabled={disabled}
            data-testid="composer-mention-item"
            aria-label={item.label}
            onClick={() => onSelect(item)}
          >
            <div className="more-row-main">
              <span className="more-row-title">{item.label}</span>
              {"subtitle" in item && item.subtitle && (
                <span className="more-row-sub muted">{item.subtitle}</span>
              )}
            </div>
          </button>
        ))}

      {!showCategoryLevel && items.length === 0 && (
        <div
          className="more-row-sub muted"
          data-testid="composer-mention-empty"
        >
          {loading ? "加载中…" : (emptyHint ?? "没有匹配的引用")}
        </div>
      )}

      <button
        type="button"
        className="sheet-item sheet-cancel"
        onClick={onClose}
      >
        取消
      </button>
    </Modal>
  );
}

function itemKey(item: MentionListItem): string {
  if (item.kind === "agent") return `agent:${item.agentId}`;
  if (item.kind === "conversation") return `conv:${item.id}`;
  if (item.kind === "folder") return `folder:${item.id}`;
  return `file:${item.desk}:${item.deskId}:${item.path}`;
}
