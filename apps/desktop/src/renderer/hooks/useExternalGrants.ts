import { externalGrantKeys } from "@/lib/queryKeys";
import { revokeExternalGrant } from "@/lib/revokeExternalGrant";
import {
  invalidateExternalGrants,
  listExternalGrants,
} from "@/services/externalGrants";
import { useMutation, useQuery } from "@tanstack/react-query";

/** Conversation external mounts (`GET …/workspace/external-grants`). */
export function useExternalGrants(
  conversationId: string | null,
  enabled = true,
) {
  return useQuery({
    queryKey: externalGrantKeys.list(conversationId ?? ""),
    queryFn: () => {
      if (!conversationId) return Promise.resolve([]);
      return listExternalGrants(conversationId);
    },
    enabled: !!conversationId && enabled,
    staleTime: 15_000,
  });
}

export function useRevokeExternalGrant(conversationId: string) {
  return useMutation({
    mutationFn: (rootId: string) => revokeExternalGrant(conversationId, rootId),
    onSuccess: () => invalidateExternalGrants(conversationId),
  });
}
