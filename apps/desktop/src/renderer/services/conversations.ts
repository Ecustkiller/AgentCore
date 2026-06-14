import { api } from "@/services/api";
import { type FolderMeta, toFolder } from "@/services/folders";
import type { Conversation } from "@/stores/conversation";

interface BackendConversation {
  id: string;
  title: string | null;
  updated_at: string;
  created_at: string;
  folder_id?: string | null;
}

interface ConversationListResponse {
  data: BackendConversation[];
  total: number;
  page: number;
  page_size: number;
}

interface BackendFolderGroup {
  id: string;
  name: string;
  local_dir: string | null;
  conversations: BackendConversation[];
}

interface GroupedConversationsResponse {
  folders: BackendFolderGroup[];
  ungrouped: BackendConversation[];
}

/** Placeholder shown until the backend generates a title (or for empty ones). */
const UNTITLED = "新对话";

function toConversation(c: BackendConversation): Conversation {
  return {
    id: c.id,
    title: c.title?.trim() || UNTITLED,
    updatedAt: c.updated_at,
    // The list endpoint returns summaries only; counts/previews are not part of
    // the contract yet, so default them rather than guess.
    messageCount: 0,
    lastMessagePreview: null,
    folderId: c.folder_id ?? null,
  };
}

/** Load the user's conversations, most-recent first (server-ordered). */
export async function listConversations(): Promise<Conversation[]> {
  const res = await api.get<ConversationListResponse>(
    "/v1/conversations?page_size=100",
  );
  return res.data.map(toConversation);
}

/**
 * Load folders + every conversation (each tagged with its `folderId`) in one
 * round trip, for the folder-grouped sidebar (§七). The flat conversation list
 * stays the store's source of truth; `ConversationList` derives the groups.
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
