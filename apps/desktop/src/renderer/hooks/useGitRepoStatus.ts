import {
  type PresentGitRepoStatus,
  fetchGitRepoStatus,
} from "@/lib/gitRepoStatus";
import { useCallback, useEffect, useState } from "react";

const POLL_MS = 15_000;

/**
 * U1/U2：本地有 root 时轮询 / 监听工作区变更，刷新分支+dirty+变更列表。
 * 云端 / 无 root / 无仓 → ``null``（调用方不渲染）。
 */
export function useGitRepoStatus(
  rootId: string | null | undefined,
  enabled: boolean,
): { status: PresentGitRepoStatus | null; refresh: () => void } {
  const [status, setStatus] = useState<PresentGitRepoStatus | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled || !rootId) {
      setStatus(null);
      return;
    }
    const next = await fetchGitRepoStatus(rootId);
    setStatus(next);
  }, [enabled, rootId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!enabled || !rootId) return;
    const fsApi = typeof window !== "undefined" ? window.fsApi : undefined;
    const unwatchChanged = fsApi?.onChanged?.((ev) => {
      if (ev.rootId === rootId) void refresh();
    });
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => {
      unwatchChanged?.();
      window.removeEventListener("focus", onFocus);
      window.clearInterval(timer);
    };
  }, [enabled, rootId, refresh]);

  return { status, refresh };
}
