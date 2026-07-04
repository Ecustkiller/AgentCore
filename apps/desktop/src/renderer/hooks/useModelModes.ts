import { modelModeKeys } from "@/lib/queryKeys";
import { type ModelModes, listModelModes } from "@/services/modelModes";
import { useQuery } from "@tanstack/react-query";

/**
 * The 质量档 option space (built-in presets + the user's custom modes + resolved
 * default) as React Query data — the single source the tier pickers read from.
 *
 * Rarely changes (presets are static; custom modes are edited on a dedicated
 * settings surface), so it's cached with a long stale window rather than refetched
 * per mount. Consumers that mutate the default update the auth store directly, so
 * the「跟随默认」label stays correct without invalidating this list.
 */
export function useModelModes() {
  return useQuery<ModelModes>({
    queryKey: modelModeKeys.list,
    queryFn: listModelModes,
    staleTime: 5 * 60_000,
    gcTime: Number.POSITIVE_INFINITY,
  });
}
