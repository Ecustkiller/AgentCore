import { hasLocalEngine } from "@/lib/capabilities";
import { resolveSidecarInference } from "@/services/inferenceToken";
import {
  liveSidecarTarget,
  resolveNewTurnBind,
} from "@/services/sidecarRouting";
import { useAuthStore } from "@/stores/auth";

/** Match server ``LLM_WARM_COOLDOWN_S`` so focus-spam does not re-GET. */
const WARM_COOLDOWN_MS = 30_000;

const inflight = new Set<string>();
const lastOk = new Map<string, number>();

function targetKey(rootId: string, subpath: string): string {
  return `${rootId}::${subpath}`;
}

export function resetWarmLlmHttpForTests(): void {
  inflight.clear();
  lastOk.clear();
}

/**
 * Composer first-focus handshake: spawn/reuse the live local sidecar and kick
 * ``warmLlmHttp``. Cloud / stale / unbound skip (no spawn). Does not send the
 * draft. Failures are silent; the next focus retries.
 */
export async function warmLlmHttpOnComposerFocus(
  conversationId: string | null | undefined,
): Promise<void> {
  if (!conversationId || !hasLocalEngine()) return;
  if (!window.sidecarApi?.warmLlmHttp) return;

  const bind = await resolveNewTurnBind(conversationId);
  const target = liveSidecarTarget(bind);
  if (!target) return;

  const key = targetKey(target.rootId, target.subpath);
  if (inflight.has(key)) return;
  const prev = lastOk.get(key);
  if (prev != null && Date.now() - prev < WARM_COOLDOWN_MS) return;

  inflight.add(key);
  try {
    const inference = await resolveSidecarInference({ conversationId });
    if (!inference) return;
    await window.sidecarApi.warmLlmHttp({
      rootId: target.rootId,
      subpath: target.subpath,
      inference,
      userId: useAuthStore.getState().user?.id,
    });
    lastOk.set(key, Date.now());
  } catch {
    /* next focus retries */
  } finally {
    inflight.delete(key);
  }
}
