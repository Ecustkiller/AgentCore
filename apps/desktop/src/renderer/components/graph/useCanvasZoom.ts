/** 放大态：总览 ↔ 全屏 DAG 相机过渡 + UI store 桥接。 */

import { useUIStore } from "@/stores/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "./constants";

export function useCanvasZoom(setFocusedTurn: (id: string) => void) {
  const reduceMotion = prefersReducedMotion();
  const [zoomedTurn, setZoomedTurn] = useState<string | null>(null);
  const [zoomAutoplay, setZoomAutoplay] = useState(false);
  const [zoomShown, setZoomShown] = useState(false);
  const revealRaf = useRef(0);

  const openZoom = useCallback(
    (turnId: string, replay: boolean) => {
      setZoomedTurn(turnId);
      setZoomAutoplay(replay);
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
    openZoom(pendingCanvasFocus.turnId, pendingCanvasFocus.autoplay);
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
    zoomShown,
    openZoom,
    exitZoom,
    onZoomOverlayTransitionEnd,
    overviewScaleClass,
  };
}
