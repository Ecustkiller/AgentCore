import { runningElapsedSec } from "@/lib/runningElapsed";
import { useEffect, useRef, useState } from "react";

/**
 * Live 秒表：1s ticker 只逼重绘，数值每帧从墙钟重算（折叠/虚拟化重挂不归零）。
 *
 * `ticking=false` 默认回 0。`freezeWhenStopped` 冻住最后一秒
 * （状态条停止中），避免跳回 `elapsedMs(frames)` 跨度。
 * 过程行不出秒表；调用方是协作图状态条与节点 face。
 */
export function useRunningElapsed(
  ticking: boolean,
  startedAt: number | null | undefined,
  opts?: { freezeWhenStopped?: boolean },
): number {
  const [, force] = useState(0);
  const frozenSec = useRef<number | null>(null);
  useEffect(() => {
    if (!ticking) return;
    frozenSec.current = null;
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [ticking]);
  if (startedAt == null) return 0;
  if (!ticking) {
    if (opts?.freezeWhenStopped) {
      if (frozenSec.current == null) {
        frozenSec.current = runningElapsedSec(startedAt);
      }
      return frozenSec.current;
    }
    return 0;
  }
  return runningElapsedSec(startedAt);
}
