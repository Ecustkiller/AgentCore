/** 放大态：总览 ↔ 全屏 DAG 相机过渡 + UI store 桥接。 */

import { type CanvasFocusView, useUIStore } from "@/stores/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "./constants";

export function useCanvasZoom(setFocusedTurn: (id: string) => void) {
  const reduceMotion = prefersReducedMotion();
  const [zoomedTurn, setZoomedTurn] = useState<string | null>(null);
  const [zoomAutoplay, setZoomAutoplay] = useState(false);
  // 深链的初始视图（聊天侧信号，如「对比」→ 放大态直达对应视图）；无则走回合自然默认。
  const [zoomView, setZoomView] = useState<CanvasFocusView | undefined>(
    undefined,
  );
  // 深链「对比」预选的 A/B 版本对（如从侧面板版本链点 vN 直达 vN-1×vN diff）；随 openZoom 透传给
  // CanvasZoomedTurn → TurnCompare 的初始 pair。无则对比视图用自然默认对。
  const [zoomComparePair, setZoomComparePair] = useState<
    [string, string] | undefined
  >(undefined);
  const [zoomShown, setZoomShown] = useState(false);
  const revealRaf = useRef(0);

  const openZoom = useCallback(
    (
      turnId: string,
      replay: boolean,
      view?: CanvasFocusView,
      comparePair?: [string, string],
    ) => {
      setZoomedTurn(turnId);
      setZoomAutoplay(replay);
      setZoomView(view);
      setZoomComparePair(comparePair);
      setFocusedTurn(turnId);
      if (reduceMotion) setZoomShown(true);
    },
    [reduceMotion, setFocusedTurn],
  );

  useEffect(() => {
    if (!zoomedTurn || reduceMotion) return;
    revealRaf.current = requestAnimationFrame(() => setZoomShown(true));
    return () => cancelAnimationFrame(revealRaf.current);
  }, [zoomedTurn, reduceMotion]);

  const exitZoom = useCallback(() => {
    cancelAnimationFrame(revealRaf.current);
    setZoomShown(false);
    if (reduceMotion) {
      setZoomedTurn(null);
      setZoomAutoplay(false);
    }
  }, [reduceMotion]);

  const pendingCanvasFocus = useUIStore((s) => s.pendingCanvasFocus);
  const clearCanvasFocus = useUIStore((s) => s.clearCanvasFocus);
  useEffect(() => {
    if (!pendingCanvasFocus) return;
    openZoom(
      pendingCanvasFocus.turnId,
      pendingCanvasFocus.autoplay,
      pendingCanvasFocus.view,
      pendingCanvasFocus.comparePair,
    );
    clearCanvasFocus();
  }, [pendingCanvasFocus, clearCanvasFocus, openZoom]);

  const setCanvasZoomed = useUIStore((s) => s.setCanvasZoomed);
  useEffect(() => {
    setCanvasZoomed(zoomedTurn != null);
    return () => setCanvasZoomed(false);
  }, [zoomedTurn, setCanvasZoomed]);

  const onZoomOverlayTransitionEnd = useCallback(
    (e: React.TransitionEvent<HTMLDivElement>) => {
      if (
        e.target === e.currentTarget &&
        e.propertyName === "opacity" &&
        !zoomShown
      ) {
        setZoomedTurn(null);
        setZoomAutoplay(false);
      }
    },
    [zoomShown],
  );

  const overviewScaleClass =
    zoomedTurn && zoomShown ? "scale-[1.03]" : "scale-100";

  return {
    zoomedTurn,
    zoomAutoplay,
    zoomView,
    zoomComparePair,
    zoomShown,
    openZoom,
    exitZoom,
    onZoomOverlayTransitionEnd,
    overviewScaleClass,
  };
}
