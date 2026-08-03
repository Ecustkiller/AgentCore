// Sandbox browser sessions list — mobile Bearer client (前端技术与架构 §七).
//
// Light GET …/browser/sessions only (create/navigate/close can land later).
// Cloud-only on mobile (no Local sidecar branch). Auth is Bearer via apiFetch.

import { apiFetch } from "@/api/client";

export type BrowserHostKind = "sandbox" | "local";
export type BrowserControl = "agent" | "user";

/** Client projection (camelCase). */
export interface BrowserSessionInfo {
  sessionId: string;
  conversationId: string;
  hostKind: BrowserHostKind;
  control: BrowserControl;
  runId: string | null;
  createdAt: number;
  lastUsed: number;
  url?: string | null;
  title?: string | null;
}

export interface BrowserSessionList {
  sessions: BrowserSessionInfo[];
  activeSessionId: string | null;
}

/** Server wire (snake_case). */
interface BrowserSessionWire {
  session_id: string;
  conversation_id: string;
  host_kind: BrowserHostKind;
  control: BrowserControl;
  run_id?: string | null;
  created_at: number;
  last_used: number;
  url?: string | null;
  title?: string | null;
}

interface BrowserSessionListWire {
  data: BrowserSessionWire[];
  active_session_id?: string | null;
}

function sessionsPath(conversationId: string): string {
  return `/v1/conversations/${encodeURIComponent(conversationId)}/browser/sessions`;
}

function fromWire(w: BrowserSessionWire): BrowserSessionInfo {
  return {
    sessionId: w.session_id,
    conversationId: w.conversation_id,
    hostKind: w.host_kind,
    control: w.control,
    runId: w.run_id ?? null,
    createdAt: w.created_at,
    lastUsed: w.last_used,
    url: w.url ?? null,
    title: w.title ?? null,
  };
}

function fromListWire(r: BrowserSessionListWire): BrowserSessionList {
  return {
    sessions: (r.data ?? []).map(fromWire),
    activeSessionId: r.active_session_id ?? null,
  };
}

/** GET …/browser/sessions — cloud registry list (sandbox). */
export async function listBrowserSessions(
  conversationId: string,
): Promise<BrowserSessionList> {
  const res = await apiFetch(sessionsPath(conversationId));
  if (!res.ok) {
    throw new Error(`加载浏览器会话失败 (${res.status})`);
  }
  const body = (await res.json()) as BrowserSessionListWire;
  return fromListWire(body);
}

/** Acceptance alias for {@link listBrowserSessions}. */
export const listSessions = listBrowserSessions;
