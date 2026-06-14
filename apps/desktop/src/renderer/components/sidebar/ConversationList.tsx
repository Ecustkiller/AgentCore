import { type Conversation, useConversationStore } from "@/stores/conversation";
import { UNGROUPED_KEY, useFoldersStore } from "@/stores/folders";
import { MessageSquare } from "lucide-react";
import { useMemo } from "react";
import { ConversationItem } from "./ConversationItem";
import { FolderGroup } from "./FolderGroup";

interface Props {
  /** Case-insensitive title filter from the sidebar search box. */
  query: string;
}

function byRecency(a: Conversation, b: Conversation): number {
  return (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);
}

export function ConversationList({ query }: Props) {
  const conversations = useConversationStore((s) => s.conversations);
  const folders = useFoldersStore((s) => s.folders);

  const { grouped, ungrouped, matchCount } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? conversations.filter((c) => c.title.toLowerCase().includes(q))
      : conversations;

    const folderIds = new Set(folders.map((f) => f.id));
    const buckets = new Map<string, Conversation[]>();
    for (const f of folders) buckets.set(f.id, []);
    const loose: Conversation[] = [];
    for (const c of filtered) {
      const fid = c.folderId;
      if (fid && folderIds.has(fid)) buckets.get(fid)?.push(c);
      else loose.push(c);
    }
    for (const list of buckets.values()) list.sort(byRecency);
    loose.sort(byRecency);

    return {
      grouped: folders.map((f) => ({
        folder: f,
        items: buckets.get(f.id) ?? [],
      })),
      ungrouped: loose,
      matchCount: filtered.length,
    };
  }, [conversations, folders, query]);

  if (conversations.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
        <MessageSquare size={24} className="text-sidebar-foreground/30" />
        <p className="text-sm text-sidebar-foreground/50">暂无对话</p>
        <p className="text-xs text-sidebar-foreground/40">开始第一次对话 →</p>
      </div>
    );
  }

  const searching = query.trim() !== "";
  if (searching && matchCount === 0) {
    return (
      <p className="px-4 py-8 text-center text-sm text-sidebar-foreground/50">
        未找到匹配的对话
      </p>
    );
  }

  // No folders yet: keep the classic flat list (no group headers).
  if (folders.length === 0) {
    return (
      <div className="space-y-0.5 px-2 py-1">
        {ungrouped.map((conv) => (
          <ConversationItem key={conv.id} conversation={conv} />
        ))}
      </div>
    );
  }

  // While searching, hide folders with no matches to cut noise.
  const visibleFolders = searching
    ? grouped.filter((g) => g.items.length > 0)
    : grouped;

  return (
    <div className="px-2 py-1">
      {visibleFolders.map(({ folder, items }) => (
        <FolderGroup
          key={folder.id}
          folder={folder}
          collapseKey={folder.id}
          items={items}
          forceOpen={searching}
        />
      ))}
      {ungrouped.length > 0 && (
        <FolderGroup
          folder={null}
          collapseKey={UNGROUPED_KEY}
          items={ungrouped}
          forceOpen={searching}
        />
      )}
    </div>
  );
}
