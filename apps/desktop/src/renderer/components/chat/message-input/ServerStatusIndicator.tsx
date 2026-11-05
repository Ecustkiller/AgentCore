import { probeServerHealth } from "@/services/serverHealth";
import { useServerHealthStore } from "@/stores/serverHealth";
import { Loader2 } from "lucide-react";

/** Offline preview (#/preview) runs with no backend, so the heartbeat never
 *  starts there — suppress the connectivity UI rather than showing a permanent
 *  "连接中…". */
function isWebPreview(): boolean {
  return typeof window !== "undefined" && window.__WEB_PREVIEW__ === true;
}

/**
 * Prominent inline notice above the textarea, shown only while offline — mirrors
 * the composer's "回合执行中" hint styling so the disconnected state reads as loud
 * without a modal. The heartbeat auto-recovers. N4-A: send is hard-disabled while
 * offline (button + handleSend guard). Quiet connection dots were removed; offline
 * is the only connection chrome besides send disable.
 */
export function ComposerConnectionNotice() {
  const status = useServerHealthStore((s) => s.status);
  const reason = useServerHealthStore((s) => s.reason);
  if (isWebPreview() || status !== "offline") return null;
  return (
    <div
      aria-live="polite"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 pt-2 text-xs text-muted-foreground"
    >
      <Loader2 size={12} className="shrink-0 animate-spin" />
      <span className="min-w-0 flex-1 text-muted-foreground">
        与服务器断开连接。可浏览已缓存的对话与本机文件（只读）；暂不能发送或运行
        AI。
      </span>
      <button
        type="button"
        title={reason ?? undefined}
        onClick={() => void probeServerHealth()}
        className="shrink-0 font-medium text-primary hover:underline"
      >
        立即重试
      </button>
    </div>
  );
}
