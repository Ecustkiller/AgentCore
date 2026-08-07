// Sandbox browser sessions list — mobile Bearer client (前端技术与架构 §七).
//
// Light GET …/browser/sessions only (create/navigate/close can land later).
// Cloud-only on mobile (no Local sidecar branch). Auth is Bearer via apiFetch.
// Wire DTOs track OpenAPI; camelCase {@link BrowserSessionInfo} is a client
// projection (OpenAPI has no camelCase schema — M17 exemption).

import { apiFetch } from "@/api/client";
import type { components } from "@/types/api.generated";

type Schemas = components["schemas"];

export type BrowserHostKind = Schemas["BrowserSessionView"]["host_kind"];
export type BrowserControl = Schemas["BrowserSessionView"]["control"];

type BrowserSessionWire = Schemas["BrowserSessionView"];
type BrowserSessionListWire = Schemas["BrowserSessionListResponse"];

/** Client projection (camelCase). M17 exemption: not in OpenAPI schemas. */
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

/** Client projection (camelCase). M17 exemption: not in OpenAPI schemas. */
export interface BrowserSessionList {
  sessions: BrowserSessionInfo[];
  activeSessionId: string | null;
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
