import { llmKeyKeys } from "@/lib/queryKeys";
import { type LlmKeyStatus, getLlmKey } from "@/services/llmKey";
import { useQuery } from "@tanstack/react-query";

/** Cached BYOK LLM configuration (settings + probe hints). */
export function useLlmKey() {
  return useQuery<LlmKeyStatus>({
    queryKey: llmKeyKeys.status,
    queryFn: getLlmKey,
    staleTime: 60_000,
    refetchOnMount: "always",
  });
}
