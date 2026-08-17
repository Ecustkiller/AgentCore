import type { UserInterjection, UserInterjectionAttachment } from "./types";

/** Wire `user_interjection` → runtime leaf (live SSE / journal hydrate / conformance). */
export function userInterjectionFromPayload(
  payload: unknown,
): UserInterjection | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as {
    interjection_id?: string;
    execution_id?: string;
    content?: string;
    status?: string;
    note?: string | null;
    attachments?: Array<{
      name?: string;
      workspace_path?: string;
      binary?: boolean;
    }>;
    agent_mentions?: Array<{
      agent_id?: string;
      role?: string;
    }>;
  };
  const iid = (p.interjection_id || "").trim();
  if (!iid) return null;
  const attachments: UserInterjectionAttachment[] = (p.attachments ?? [])
    .filter(
      (a): a is { name: string; workspace_path?: string; binary?: boolean } =>
        typeof a.name === "string" && Boolean(a.name.trim()),
    )
    .map((a) => ({
      name: a.name.trim(),
      workspacePath:
        typeof a.workspace_path === "string" && a.workspace_path.trim()
          ? a.workspace_path
          : undefined,
      binary: Boolean(a.binary),
    }));
  const agentMentions = (p.agent_mentions ?? [])
    .filter(
      (a): a is { agent_id: string; role: string } =>
        typeof a.agent_id === "string" &&
        Boolean(a.agent_id.trim()) &&
        typeof a.role === "string" &&
        Boolean(a.role.trim()),
    )
    .map((a) => ({
      agentId: a.agent_id.trim(),
      role: a.role.trim(),
    }));
  return {
    interjectionId: iid,
    executionId: p.execution_id || "",
    content: p.content || "",
    status: p.status || "received",
    note: typeof p.note === "string" ? p.note : null,
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(agentMentions.length > 0 ? { agentMentions } : {}),
  };
}
