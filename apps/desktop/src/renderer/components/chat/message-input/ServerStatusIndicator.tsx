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
  if (isWebPreview() || status !== "offline") return null;
  return (
    <div
      aria-live="polite"
      className="flex items-center gap-1.5 px-4 pt-2 text-xs text-destructive"
    >
      <Loader2 size={12} className="shrink-0 animate-spin" />
      与服务器断开连接。可浏览已缓存的对话与本机文件（只读）；不能发送或跑
      AI，恢复连接后再试。
    </div>
  );
}
