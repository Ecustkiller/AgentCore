import { type RefObject, useCallback, useEffect, useState } from "react";

export interface HorizontalTabScrollState {
  canScrollLeft: boolean;
  canScrollRight: boolean;
  /** Scroll roughly one viewport in `dir` (−1 left / +1 right). */
  scrollByPage: (dir: -1 | 1) => void;
  /** Re-measure overflow (e.g. after children change). */
  updateOverflow: () => void;
}

/**
 * Wheel → horizontal scroll + overflow flags via scroll/ResizeObserver.
 * `preventDefault` only when `scrollLeft` actually changes.
 */
export function useHorizontalTabScroll(
  scrollRef: RefObject<HTMLElement | null>,
  contentRef?: RefObject<HTMLElement | null>,
): HorizontalTabScrollState {
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateOverflow = useCallback(() => {
    const el = scrollRef.current;
    if (!el) {
      setCanScrollLeft(false);
      setCanScrollRight(false);
      return;
    }
    const { scrollLeft, scrollWidth, clientWidth } = el;
    // 1px slack for subpixel rounding
    setCanScrollLeft(scrollLeft > 1);
    setCanScrollRight(scrollLeft + clientWidth < scrollWidth - 1);
  }, [scrollRef]);

  const scrollByPage = useCallback(
    (dir: -1 | 1) => {
      const el = scrollRef.current;
      if (!el) return;
      const step = Math.max(120, Math.floor(el.clientWidth * 0.6));
      el.scrollBy({ left: dir * step, behavior: "smooth" });
    },
    [scrollRef],
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    updateOverflow();

    const onScroll = () => updateOverflow();
    el.addEventListener("scroll", onScroll, { passive: true });

    const onWheel = (e: WheelEvent) => {
      const delta = e.deltaY + e.deltaX;
      if (delta === 0) return;
      const before = el.scrollLeft;
      el.scrollLeft = before + delta;
      if (el.scrollLeft !== before) {
        e.preventDefault();
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });

    const ro = new ResizeObserver(() => updateOverflow());
    ro.observe(el);
    const content = contentRef?.current;
    if (content) ro.observe(content);

    const onWinResize = () => updateOverflow();
    window.addEventListener("resize", onWinResize);

    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
      ro.disconnect();
      window.removeEventListener("resize", onWinResize);
    };
  }, [scrollRef, contentRef, updateOverflow]);

  return { canScrollLeft, canScrollRight, scrollByPage, updateOverflow };
}
