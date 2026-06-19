// Global keyword search for the mobile client (对话管理 · 跨会话搜索; 全局搜索 Tier 1).
//
// One query fans out over the user's own conversations (title) and messages (content) via
// the shared backend endpoint (api/routes/search.py). Folders are out of scope on mobile
// (no folder surface), so the `types` filter narrows to conversation + message. Backed by
// ILIKE (owner-scoped, recency-ordered). Types are a hand-written subset of the backend
// schema (schemas.py), matching the skeleton convention in conversations.ts.
import { apiFetch } from "@/api/client";

/** One hit. For a conversation: `id` = conversation id, `title` = its title. For a message:
 *  `id` = message id, `conversation_id` = where to jump, `title` = the owning conversation's
 *  title, `snippet` + `match_start`/`match_end` = the match window for highlighting. */
export interface SearchItem {
  id: string;
  title: string | null;
  conversation_id: string | null;
  role: string | null;
  snippet: string | null;
  match_start: number | null;
  match_end: number | null;
  updated_at: string | null;
}

export interface SearchSection {
  type: "conversation" | "message" | "folder";
  items: SearchItem[];
}

interface SearchResponse {
  query: string;
  sections: SearchSection[];
}

/** Search conversations + messages by keyword. Empty sections are omitted by the backend;
 *  an empty array means no hits. */
export async function search(q: string): Promise<SearchSection[]> {
  const res = await apiFetch(
    `/v1/search?q=${encodeURIComponent(q)}&types=conversation,message`,
  );
  if (!res.ok) throw new Error(`搜索失败 (${res.status})`);
  const data = (await res.json()) as SearchResponse;
  return data.sections;
}
