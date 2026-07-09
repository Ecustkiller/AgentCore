import { useApprovalStore } from "@/stores/approvals";
import { useDelegationAuthStore } from "@/stores/delegationAuth";

/** Clear turn-scoped interaction prompts (approval + delegation authorization). */
export function clearInteractionPrompts(conversationId?: string): void {
  useApprovalStore.getState().clear(conversationId);
  useDelegationAuthStore.getState().clear(conversationId);
}
