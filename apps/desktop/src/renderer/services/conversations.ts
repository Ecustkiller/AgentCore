import { api } from "@/services/api";
import { type FolderMeta, toFolder } from "@/services/folders";
import type { Conversation } from "@/stores/conversation";
import type { components } from "@/types/api.generated";

// REST DTOs generated from the backend OpenAPI spec (`pnpm gen:api`), aliased to
// the local names so the mappers below read unchanged (API 开发规范, 渐进迁移).
type Schemas = components["schemas"];

/** A conversation row from the list/detail endpoints (server-shaped). */
type BackendConversation = Schemas["ConversationSummary"];
/** Paginated conversation list (`GET /v1/conversations`). */
type ConversationListResponse = Schemas["ConversationListResponse"];
/** Folders + ungrouped conversations in one trip (`/v1/conversations/grouped`). */
type GroupedConversationsResponse = Schemas["GroupedConversationsResponse"];

/** Placeholder shown until the backend generates a title (or for empty ones). */
const UNTITLED = "新对话";

function toConversation(c: BackendConversation): Conversation {
  return {
    id: c.id,
    title: c.title?.trim() || UNTITLED,
    updatedAt: c.updated_at,
    // The list/grouped endpoints carry message_count (0 for an unsent chat); the
    // sidebar uses it to lock workspace-changing folder moves once a chat has
    // started (双模式工作区 §九 ⑩). Previews are not in the contract yet.
    messageCount: c.message_count ?? 0,
    lastMessagePreview: null,
    folderId: c.folder_id ?? null,
    modelMode: c.model_mode ?? null,
    pinned: c.pinned ?? false,
    archived: c.archived ?? false,
  };
}

/** Load the user's conversations, pinned-first then most-recent (server-ordered).
 * `archived` flips to the「已归档」view (归档对话): the live list excludes archived
 * rows, this returns only them. */
export async function listConversations(
  archived = false,
): Promise<Conversation[]> {
  const res = await api.get<ConversationListResponse>(
    `/v1/conversations?page_size=100&archived=${archived}`,
  );
  return res.data.map(toConversation);
}

/**
 * Load folders + every conversation (each tagged with its `folderId`) in one
 * round trip (§七). The flat conversation list stays the store's source of
 * truth; the sidebar shows the recent few and the /conversations page derives
 * the folder groups.
 */
export async function listGrouped(): Promise<{
  folders: FolderMeta[];
  conversations: Conversation[];
}> {
  const res = await api.get<GroupedConversationsResponse>(
    "/v1/conversations/grouped",
  );
  const folders = res.folders.map((f) =>
    toFolder({
      id: f.id,
      name: f.name,
      local_dir: f.local_dir,
      local_root_id: f.local_root_id ?? null,
      created_at: "",
      updated_at: "",
    }),
  );
  const conversations = [
    ...res.folders.flatMap((f) => f.conversations.map(toConversation)),
    ...res.ungrouped.map(toConversation),
  ];
  return { folders, conversations };
}

/** Move a conversation into a folder, or out of one with `folderId = null`. */
export async function moveConversation(
  id: string,
  folderId: string | null,
): Promise<void> {
  await api.patch(`/v1/conversations/${id}/folder`, { folder_id: folderId });
}

/** Soft-delete a conversation server-side. */
export async function deleteConversation(id: string): Promise<void> {
  await api.delete(`/v1/conversations/${id}`);
}

/** Persist a new conversation title. */
export async function renameConversation(
  id: string,
  title: string,
): Promise<void> {
  await api.patch(`/v1/conversations/${id}`, { title });
}

/** Pin / unpin a conversation (置顶对话). Returns the updated row. */
export async function setConversationPinned(
  id: string,
  pinned: boolean,
): Promise<Conversation> {
  const res = await api.patch<BackendConversation>(`/v1/conversations/${id}`, {
    pinned,
  });
  return toConversation(res);
}

/** Archive / unarchive a conversation (归档对话, reversible). Returns the updated
 * row — unarchive (archived=false) yields a live-list row to put back. */
export async function setConversationArchived(
  id: string,
  archived: boolean,
): Promise<Conversation> {
  const res = await api.patch<BackendConversation>(`/v1/conversations/${id}`, {
    archived,
  });
  return toConversation(res);
}
