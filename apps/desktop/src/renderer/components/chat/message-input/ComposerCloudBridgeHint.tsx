import { useActiveExecutionVia } from "@/stores/conversation";
import { useUIStore } from "@/stores/ui";

/**
 * 本机绑定会话本轮走了云端过桥时的弱状态（非引擎切换器、非恐吓）。
 *
 * 探活 / 启动失败另有节流 toast；此处常驻一行轻提示，直到下一轮改回 sidecar。
 * 显式强制关（`sidecarPreference==="off"`）不展示——勿吓大众。
 */
export function ComposerCloudBridgeHint() {
  const via = useActiveExecutionVia();
  const forceOff = useUIStore((s) => s.sidecarPreference === "off");
  if (via !== "cloud_bridge" || forceOff) return null;
  return (
    <div
      aria-live="polite"
      data-testid="composer-cloud-bridge-hint"
      className="flex items-center gap-1.5 px-4 pt-2 text-xs text-muted-foreground"
    >
      本轮经云端协助完成（本机引擎暂未同侧跑）
    </div>
  );
}
