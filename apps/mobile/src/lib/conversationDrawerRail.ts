/**
 * 手机对话抽屉 · 方案 C 三区（纯函数）。
 *
 * 桌面侧栏同 IA，但手机全量不设帽、不挤「等你」、不共享桌面 hook。输入是现成的
 * `/v1/conversations/grouped`（{@link GroupedConversations}），输出三区：
 * 置顶 / 文件夹组 / 裸聊。置顶行从组内与裸聊抬走（零重复）；组序看组内**全部**对话
 * （含已抬走的置顶）的最近活动；API 真空组丢掉，「成员全被置顶」仍留组头，好让云组
 * ＋ / 进文件还在。裸聊只来自 `ungrouped` 的未置顶行，没有「未分组」空壳。
 */
import type {
  ConversationSummary,
  FolderGroup,
  GroupedConversations,
} from "@/api/conversations";

/** 抽屉三区。无区标题、无条数帽；渲染侧用分隔线区分即可。 */
export interface ConversationDrawerRail {
  pinned: ConversationSummary[];
  groups: FolderGroup[];
  bare: ConversationSummary[];
}

function updatedAtMs(c: ConversationSummary): number {
  const ms = Date.parse(c.updated_at);
  return Number.isNaN(ms) ? 0 : ms;
}

function byUpdatedAtDesc(
  a: ConversationSummary,
  b: ConversationSummary,
): number {
  return updatedAtMs(b) - updatedAtMs(a);
}

function isPinned(c: ConversationSummary): boolean {
  return c.pinned === true;
}

function collectPinned(grouped: GroupedConversations): ConversationSummary[] {
  const seen = new Set<string>();
  const pinned: ConversationSummary[] = [];
  const take = (rows: readonly ConversationSummary[]) => {
    for (const c of rows) {
      if (!isPinned(c) || seen.has(c.id)) continue;
      seen.add(c.id);
      pinned.push(c);
    }
  };
  take(grouped.ungrouped);
  for (const folder of grouped.folders) take(folder.conversations);
  return pinned.sort(byUpdatedAtDesc);
}

function partitionGroups(grouped: GroupedConversations): FolderGroup[] {
  const ranked: { group: FolderGroup; latest: number }[] = [];
  for (const folder of grouped.folders) {
    // API 本来就空的组丢掉；「全员置顶」走下面 conversations=[] 的组头。
    if (folder.conversations.length === 0) continue;
    const latest = folder.conversations.reduce(
      (m, c) => Math.max(m, updatedAtMs(c)),
      0,
    );
    ranked.push({
      latest,
      group: {
        ...folder,
        conversations: folder.conversations
          .filter((c) => !isPinned(c))
          .sort(byUpdatedAtDesc),
      },
    });
  }
  ranked.sort((a, b) => b.latest - a.latest);
  return ranked.map((r) => r.group);
}

/** 把 grouped 快照切成方案 C 三区。不改入参。 */
export function buildConversationDrawerRail(
  grouped: GroupedConversations,
): ConversationDrawerRail {
  return {
    pinned: collectPinned(grouped),
    groups: partitionGroups(grouped),
    bare: grouped.ungrouped.filter((c) => !isPinned(c)).sort(byUpdatedAtDesc),
  };
}
