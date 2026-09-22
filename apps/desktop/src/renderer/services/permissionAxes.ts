import { api } from "@/services/api";
import type { SidecarPermissionAxes } from "@shared/sidecar-contract";

/** Conversation boundary. One control; irreversible actions stay outside it. */
export type WorkspaceBoundaryId = "read" | "folder" | "computer";

export type PermissionAxes = SidecarPermissionAxes;

export const DEFAULT_PERMISSION_AXES: PermissionAxes = { boundary: "folder" };

export const BOUNDARY_ORDER: WorkspaceBoundaryId[] = [
  "read",
  "folder",
  "computer",
];

export const BOUNDARY_LABELS: Record<
  WorkspaceBoundaryId,
  { short: string; description: string }
> = {
  read: {
    short: "只看",
    description: "只能看和搜索。不能改文件、跑命令、用浏览器。",
  },
  folder: {
    short: "这个文件夹",
    description:
      "这个文件夹里可以改文件、跑命令、装依赖、用浏览器。装软件、推远程、毁灭形删除、读私钥仍会单独拦住。",
  },
  computer: {
    short: "这台电脑",
    description:
      "在这个文件夹之外，还能做本机操作。装软件、推远程、毁灭形删除、读私钥仍会单独拦住。",
  },
};

const BOUNDARY_IDS = new Set<string>(BOUNDARY_ORDER);

export function axesEqual(a: PermissionAxes, b: PermissionAxes): boolean {
  return a.boundary === b.boundary;
}

export function normalizeAxes(raw: unknown): PermissionAxes {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const boundary = (raw as { boundary?: unknown }).boundary;
    if (typeof boundary === "string" && BOUNDARY_IDS.has(boundary)) {
      return { boundary: boundary as WorkspaceBoundaryId };
    }
  }
  return { ...DEFAULT_PERMISSION_AXES };
}

export function boundaryShortLabel(boundary: WorkspaceBoundaryId): string {
  return BOUNDARY_LABELS[boundary].short;
}

/**
 * Human label for audit payloads. Only the current boundary ids.
 * Older recipe / axis snapshots have no label.
 */
export function permissionAxesShortLabel(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (BOUNDARY_IDS.has(trimmed)) {
      return boundaryShortLabel(trimmed as WorkspaceBoundaryId);
    }
    if (trimmed.startsWith("{")) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (
          parsed &&
          typeof parsed === "object" &&
          !Array.isArray(parsed) &&
          typeof (parsed as { boundary?: unknown }).boundary === "string" &&
          BOUNDARY_IDS.has((parsed as { boundary: string }).boundary)
        ) {
          return boundaryShortLabel(
            (parsed as { boundary: WorkspaceBoundaryId }).boundary,
          );
        }
      } catch {
        return null;
      }
      return null;
    }
    return null;
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const boundary = (raw as { boundary?: unknown }).boundary;
    if (typeof boundary === "string" && BOUNDARY_IDS.has(boundary)) {
      return boundaryShortLabel(boundary as WorkspaceBoundaryId);
    }
  }
  return null;
}

const COMPUTER_CONFIRM =
  "这台电脑可以做工作区以外的本机操作。装软件、推远程、毁灭形删除、读私钥仍会单独拦住。确定继续？";

export function needsComputerConfirm(
  current: PermissionAxes,
  next: PermissionAxes,
): boolean {
  return next.boundary === "computer" && current.boundary !== "computer";
}

export function confirmComputerIfNeeded(
  current: PermissionAxes,
  next: PermissionAxes,
): boolean {
  if (!needsComputerConfirm(current, next)) return true;
  return window.confirm(COMPUTER_CONFIRM);
}

let cachedDefaultAxes: PermissionAxes | null = null;
let composerDraftAxes: PermissionAxes | null = null;

export function setComposerDraftAxes(axes: PermissionAxes | null): void {
  composerDraftAxes = axes ? normalizeAxes(axes) : null;
}

export function peekComposerDraftAxes(): PermissionAxes | null {
  return composerDraftAxes;
}

export async function resolveDefaultPermissionAxes(): Promise<PermissionAxes> {
  if (composerDraftAxes) return composerDraftAxes;
  if (cachedDefaultAxes) return cachedDefaultAxes;
  try {
    const d = await api.get<{ policy: WorkspaceBoundaryId }>(
      "/v1/users/me/autonomy",
    );
    cachedDefaultAxes = normalizeAxes({ boundary: d.policy });
    return cachedDefaultAxes;
  } catch {
    return { ...DEFAULT_PERMISSION_AXES };
  }
}

export function setCachedDefaultBoundary(policy: WorkspaceBoundaryId): void {
  cachedDefaultAxes = { boundary: policy };
}

/** Persist user-level default boundary (seeds new conversations only). */
export async function setUserDefaultRecipe(
  policy: WorkspaceBoundaryId,
): Promise<WorkspaceBoundaryId> {
  const d = await api.put<{ policy: WorkspaceBoundaryId }>(
    "/v1/users/me/autonomy",
    { policy },
  );
  setCachedDefaultBoundary(d.policy);
  return d.policy;
}

export function clearDefaultPermissionAxesCache(): void {
  cachedDefaultAxes = null;
  composerDraftAxes = null;
}

/** Persist a mid-session boundary switch. Returns the saved axes. */
export async function setConversationPermissionAxes(
  conversationId: string,
  permissionAxes: PermissionAxes,
): Promise<PermissionAxes> {
  const res = await api.put<{
    permission_axes?: PermissionAxes;
  }>(`/v1/conversations/${conversationId}/permission-axes`, {
    permission_axes: normalizeAxes(permissionAxes),
  });
  return normalizeAxes(res.permission_axes ?? permissionAxes);
}

/**
 * Resolve axes for a conversation (React Query cache first, else GET).
 * Sidecar turns send this every startTurn / resume.
 */
export async function resolveConversationPermissionAxes(
  conversationId: string,
): Promise<PermissionAxes | undefined> {
  try {
    const { getConversations } = await import("@/hooks/useConversations");
    const conv = getConversations().find((c) => c.id === conversationId);
    if (conv?.permissionAxes) return normalizeAxes(conv.permissionAxes);
  } catch {
    // query cache may be unavailable in tests
  }
  try {
    const res = await api.get<{ permission_axes?: PermissionAxes }>(
      `/v1/conversations/${conversationId}`,
    );
    if (res.permission_axes) return normalizeAxes(res.permission_axes);
  } catch {
    // network / 404 — last resort below
  }
  return resolveDefaultPermissionAxes();
}
