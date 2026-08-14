/**
 * Diagram lightbox view math — contain-fit like the file-preview image lightbox
 * (`object-contain` + inset), then cursor-anchored zoom / drag pan.
 *
 * Native mermaid SVG pixels are often a few hundred px; opening at scale 1 leaves
 * a stamp in the middle of the screen. Fit-to-viewport is the viewer default
 * (Photos / Preview / PDF page-fit), not 1:1.
 */

export const DIAGRAM_MIN_SCALE = 0.2;
export const DIAGRAM_MAX_SCALE = 8;
/** Leave a margin around the fitted diagram (~10% total). */
export const DIAGRAM_FIT_PADDING = 0.9;

export function clampScale(s: number): number {
  return Math.min(DIAGRAM_MAX_SCALE, Math.max(DIAGRAM_MIN_SCALE, s));
}

export type DiagramView = { scale: number; x: number; y: number };

/**
 * Largest scale at which `ct` sits inside `vp` with padding, then centered.
 * `scale` is relative to unscaled content pixels (transform-origin 0 0).
 * Returns null when any box has no layout yet — caller should wait.
 */
export function fitContainView(
  vpW: number,
  vpH: number,
  ctW: number,
  ctH: number,
  padding = DIAGRAM_FIT_PADDING,
): DiagramView | null {
  if (vpW <= 0 || vpH <= 0 || ctW <= 0 || ctH <= 0) return null;
  const scale = clampScale(Math.min(vpW / ctW, vpH / ctH) * padding);
  return {
    scale,
    x: (vpW - ctW * scale) / 2,
    y: (vpH - ctH * scale) / 2,
  };
}
