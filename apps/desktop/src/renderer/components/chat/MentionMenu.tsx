import type { IndexedEntry } from "@/lib/fileIndex";
import { File, Folder, FolderPlus, Search } from "lucide-react";
import { useEffect, useRef } from "react";

interface Props {
  items: IndexedEntry[];
  activeIndex: number;
  loading: boolean;
  error: string | null;
  query: string;
  /** browse 模式（回形针触发）自带搜索框；mention 模式由输入框 @query 过滤。 */
  showSearch: boolean;
  noRoots: boolean;
  onQueryChange: (q: string) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onSelect: (entry: IndexedEntry) => void;
  onHover: (index: number) => void;
  onAddRoot: () => void;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
}

export function MentionMenu({
  items,
  activeIndex,
  loading,
  error,
  query,
  showSearch,
  noRoots,
  onQueryChange,
  onKeyDown,
  onSelect,
  onHover,
  onAddRoot,
  searchInputRef,
}: Props) {
  const listRef = useRef<HTMLUListElement>(null);

  // 键盘移动高亮时，把当前项滚入可视区。
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const el = list.children[activeIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  return (
    <div className="absolute bottom-full left-0 z-20 mb-2 w-full overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-lg">
      {showSearch && (
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <Search size={14} className="shrink-0 text-muted-foreground" />
          <input
            ref={searchInputRef}
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="搜索文件…"
            className="w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
          />
        </div>
      )}

      {noRoots ? (
        <div className="px-3 py-4 text-center">
          <p className="text-sm text-muted-foreground">还没有授权目录</p>
          <button
            type="button"
            onClick={onAddRoot}
            className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs text-accent-foreground hover:bg-accent/80"
          >
            <FolderPlus size={14} />
            添加目录
          </button>
        </div>
      ) : loading ? (
        <div className="px-3 py-4 text-center text-sm text-muted-foreground">
          正在索引文件…
        </div>
      ) : items.length === 0 ? (
        <div className="px-3 py-4 text-center text-sm text-muted-foreground">
          {query.trim() ? "没有匹配的文件或目录" : "目录内没有可引用的内容"}
        </div>
      ) : (
        <ul ref={listRef} className="max-h-64 overflow-y-auto py-1">
          {items.map((entry, i) => (
            <li key={`${entry.kind}:${entry.rootId}:${entry.relPath}`}>
              <button
                type="button"
                onMouseDown={(e) => {
                  // mousedown 抢在 textarea blur 之前，避免菜单先收起。
                  e.preventDefault();
                  onSelect(entry);
                }}
                onMouseEnter={() => onHover(i)}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${
                  i === activeIndex
                    ? "bg-accent text-accent-foreground"
                    : "text-foreground"
                }`}
              >
                {entry.kind === "dir" ? (
                  <Folder
                    size={14}
                    className="shrink-0 text-muted-foreground"
                  />
                ) : (
                  <File size={14} className="shrink-0 text-muted-foreground" />
                )}
                <span className="shrink-0 truncate">
                  {entry.name}
                  {entry.kind === "dir" ? "/" : ""}
                </span>
                <span className="ml-auto truncate text-xs text-muted-foreground">
                  {entry.display}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && (
        <div className="border-t border-border px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}
    </div>
  );
}
