/**
 * Inline mermaid in a reading column — magazine figure, not a full-bleed poster.
 *
 * Grow a small chart so node labels approach body text (markdown-body 0.875rem),
 * then stop and center. Charts already near/over the column still use the full
 * width (shrink-to-fit). The fullscreen lightbox is a separate contain-fit.
 */

/** Cap how far a small native SVG may grow. */
export const MERMAID_INLINE_MAX_UPSCALE = 1.4;
/** Small charts stop at this fraction of the column so they stay a figure. */
export const MERMAID_INLINE_FIGURE_FILL = 0.88;

export function inlineMermaidWidthPx(nativeW: number, columnW: number): number {
  if (nativeW <= 0) return columnW > 0 ? columnW : 0;
  if (columnW <= 0) return Math.round(nativeW * MERMAID_INLINE_MAX_UPSCALE);
  if (nativeW >= columnW) return columnW;
  const figureCap = Math.round(columnW * MERMAID_INLINE_FIGURE_FILL);
  if (nativeW >= figureCap) return nativeW;
  return Math.round(Math.min(nativeW * MERMAID_INLINE_MAX_UPSCALE, figureCap));
}
