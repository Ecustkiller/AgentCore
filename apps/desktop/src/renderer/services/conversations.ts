import { api } from "@/services/api";
import type { Conversation } from "@/stores/conversation";

interface BackendConversation {
  id: string;
  title: string | null;
  updated_at: string;
  created_at: string;
}

interface ConversationListResponse {
  data: BackendConversation[];
  total: number;
  page: number;
  page_size: number;
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
  };
}

/** Load the user's conversations, most-recent first (server-ordered). */
export async function listConversations(): Promise<Conversation[]> {
  const res = await api.get<ConversationListResponse>(
    "/v1/conversations?page_size=100",
  );
  return res.data.map(toConversation);
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
