import { getRuntime, useConversationStore } from "@/stores/conversation";
import type {
  SidecarOccupancyRequest,
  SidecarOccupancyResponse,
} from "@shared/sidecar-contract";

function occupancyIpc():
  | ((req: SidecarOccupancyRequest) => Promise<SidecarOccupancyResponse>)
  | undefined {
  const occupancy =
    typeof window !== "undefined" ? window.sidecarApi?.occupancy : undefined;
  return typeof occupancy === "function" ? occupancy : undefined;
}

/** 发送门用：活表原样，或问不清（不当闲）。 */
export type OccupancyQuery = SidecarOccupancyResponse & { unknown?: boolean };

/**
 * 本机这通是否还在写。问主进程活表，不经 ``loadRecovery``。
 * 无 API / 空 id = 不当成占着（网页预览、云对话）。
 * IPC 抛错 = ``unknown``：发送门不开新回合、不 POST 云。
 */
export async function querySidecarOccupancy(
  conversationId: string,
): Promise<OccupancyQuery> {
  const id = conversationId.trim();
  if (!id) return { occupied: false };
  const occupancy = occupancyIpc();
  if (!occupancy) return { occupied: false };
  try {
    return await occupancy({ conversationId: id });
  } catch {
    return { occupied: false, unknown: true };
  }
}

/** 关生成中用。问不清 = unknown（失败不当闲）。发送门同形，见 {@link querySidecarOccupancy}。 */
export type SidecarLiveness = "occupied" | "idle" | "unknown";

export async function probeSidecarLiveness(
  conversationId: string,
): Promise<SidecarLiveness> {
  const id = conversationId.trim();
  if (!id) return "unknown";
  const occupancy = occupancyIpc();
  if (!occupancy) return "unknown";
  try {
    const res = await occupancy({ conversationId: id });
    return res.occupied === true ? "occupied" : "idle";
  } catch {
    return "unknown";
  }
}

/**
 * 活表已闲才关生成中。问不清 / 仍占着不动。
 * ``setGenerating(false)`` 的队列 hold 仍由 store 自己守。
 */
export async function clearGeneratingWhenSidecarIdle(
  conversationId: string,
  opts?: { skip?: () => boolean },
): Promise<void> {
  if (!getRuntime(conversationId).isGenerating) return;
  const live = await probeSidecarLiveness(conversationId);
  if (live !== "idle") return;
  if (opts?.skip?.()) return;
  if (!getRuntime(conversationId).isGenerating) return;
  useConversationStore.getState().setGenerating(false, conversationId);
}
