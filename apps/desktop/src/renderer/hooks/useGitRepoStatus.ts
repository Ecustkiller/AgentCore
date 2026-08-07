import {
  type PresentGitRepoStatus,
  fetchGitRepoStatus,
} from "@/lib/gitRepoStatus";
import { useCallback, useEffect, useRef, useState } from "react";

const POLL_MS = 15_000;

/**
 * U1/U2：本地有 root 时轮询 / 监听工作区变更，刷新分支+dirty+变更列表。
 * 云端 / 无 root / 无仓 → ``null``（调用方不渲染）。
 *
 * 自建 ``watch(root, "")`` + ``watch(root, ".git")``（非递归 watch 下根目录
 * 看不到 HEAD/index），并保留 onChanged / focus / 15s 轮询。
 * refresh 带 generation：过期请求不得 setStatus。
 */
export function useGitRepoStatus(
  rootId: string | null | undefined,
  enabled: boolean,
): { status: PresentGitRepoStatus | null; refresh: () => void } {
  const [status, setStatus] = useState<PresentGitRepoStatus | null>(null);
  const genRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!enabled || !rootId) {
      genRef.current += 1;
      setStatus(null);
      return;
    }
    const gen = ++genRef.current;
    const next = await fetchGitRepoStatus(rootId);
    if (gen !== genRef.current) return;
    setStatus(next);
  }, [enabled, rootId]);

  // rootId / enabled 切换或卸载：丢弃在途结果。
  useEffect(() => {
    return () => {
      genRef.current += 1;
    };
  }, [enabled, rootId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!enabled || !rootId) return;
    const fsApi = typeof window !== "undefined" ? window.fsApi : undefined;
    // 无 fsApi / web 桩缺 watch → 可选链 no-op。
    void fsApi?.watch?.(rootId, "");
    void fsApi?.watch?.(rootId, ".git");
    const unwatchChanged = fsApi?.onChanged?.((ev) => {
      if (ev.rootId === rootId) void refresh();
    });
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => {
      void fsApi?.unwatch?.(rootId, "");
      void fsApi?.unwatch?.(rootId, ".git");
      unwatchChanged?.();
      window.removeEventListener("focus", onFocus);
      window.clearInterval(timer);
    };
  }, [enabled, rootId, refresh]);

  return { status, refresh };
}
