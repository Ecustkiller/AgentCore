import {
  distanceFromBottom,
  isScrollUpTouch,
  isScrollUpWheel,
  nextStickState,
} from "@/lib/stickScroll";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

export interface StickToBottomOptions {
  /**
   * When `resetKey` changes: `true` (default) re-sticks to the latest content;
   * `false` opens at the top and stays detached (for historical / finished runs).
   * Read via ref at reset time so a live→done flip mid-view does not yank to top.
   */
  followOnReset?: boolean;
}

/**
 * Keeps a transcript pinned to the newest content without hijacking the user's
 * reading. Layout is observed via {@link ResizeObserver} on both `contentRef`
 * (async SVG / expand-collapse / REST-loaded sections all count — no content
 * fingerprint) and the viewport, which can move the bottom on its own. The view
 * sticks while near the bottom; an upward wheel/touch
 * detaches immediately (so streaming cannot yank the viewport back), and
 * hysteresis keeps re-attach from flickering at the band edge. Drag-selecting
 * text pauses auto-follow so the selection is not yanked away. A change of
 * `resetKey` re-sticks (unless {@link StickToBottomOptions.followOnReset} is
 * false).
 *
 * Auto-follow sets `scrollTop` directly: `scrollTo({ behavior: "auto" })` still
 * honors CSS `scroll-behavior`, which can animate and lose the stream.
 *
 * Shared by the IM 消息 thread (ChatThread) and the SidePanel run-detail dock.
 * AI 对话 uses {@link useChatScroll}, which applies the same stick helpers plus
 * bidirectional windowing.
 */
export function useStickToBottom(
  resetKey: string | null,
  options?: StickToBottomOptions,
) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const touchYRef = useRef<number | null>(null);
  const pointerDownRef = useRef(false);
  const selectingRef = useRef(false);
  const followOnResetRef = useRef(options?.followOnReset !== false);
  followOnResetRef.current = options?.followOnReset !== false;
  const [atBottom, setAtBottom] = useState(true);

  const applyStick = useCallback((stuck: boolean) => {
    stickRef.current = stuck;
    setAtBottom(stuck);
  }, []);

  /** Instant pin — bypasses CSS `scroll-behavior`. */
  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  const jumpToBottom = useCallback(() => {
    applyStick(true);
    scrollToBottom();
  }, [applyStick, scrollToBottom]);

  // Position + upward gesture: detach on intent, hysteresis on scroll position.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const onScroll = () => {
      applyStick(nextStickState(stickRef.current, distanceFromBottom(el)));
    };

    const onWheel = (e: WheelEvent) => {
      if (isScrollUpWheel(e.deltaY) && stickRef.current) {
        applyStick(false);
      }
    };

    const onTouchStart = (e: TouchEvent) => {
      touchYRef.current = e.touches[0]?.clientY ?? null;
    };

    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY;
      const prev = touchYRef.current;
      if (y == null || prev == null) return;
      if (isScrollUpTouch(prev, y) && stickRef.current) {
        applyStick(false);
      }
      touchYRef.current = y;
    };

    const onTouchEnd = () => {
      touchYRef.current = null;
    };

    // Drag-select pauses follow; release (even outside the pane) resumes and
    // catches up if still stuck. Only a pointer drag qualifies: it tracks the
    // cursor, so following the stream would swing the selection over whatever
    // scrolled under it. Keyboard selection is DOM-anchored and never releases
    // the flag, so it must not set it.
    const onPointerDown = () => {
      pointerDownRef.current = true;
    };

    const onSelectStart = () => {
      if (pointerDownRef.current) selectingRef.current = true;
    };

    const onPointerUp = () => {
      pointerDownRef.current = false;
      if (!selectingRef.current) return;
      selectingRef.current = false;
      if (stickRef.current) scrollToBottom();
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    el.addEventListener("touchcancel", onTouchEnd, { passive: true });
    el.addEventListener("pointerdown", onPointerDown, { passive: true });
    el.addEventListener("selectstart", onSelectStart);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("mouseup", onPointerUp);
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("selectstart", onSelectStart);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("mouseup", onPointerUp);
    };
  }, [applyStick, scrollToBottom]);

  // Content / viewport layout growth (async diagrams, expand/collapse, tab
  // unhide 0→real size): follow only while stuck. rAF batches RO deliveries and
  // avoids "ResizeObserver loop" when we mutate scrollTop in the same turn.
  useEffect(() => {
    const content = contentRef.current;
    const viewport = scrollRef.current;
    if (!content) return;

    let raf = 0;
    const followFromLayout = () => {
      raf = 0;
      if (selectingRef.current) return;
      if (stickRef.current) scrollToBottom();
      // Detached on purpose: keep the 回到底部 affordance visible until the user
      // scrolls back into the attach band or taps jump (don't re-hide from gap alone).
      else setAtBottom(false);
    };

    const ro = new ResizeObserver(() => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(followFromLayout);
    });
    ro.observe(content);
    // A shorter viewport (window resize, panel chrome expanding) moves the bottom
    // away without changing content height, so observe it too.
    if (viewport) ro.observe(viewport);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [scrollToBottom]);

  // Context switch: re-stick to latest, or open at top when followOnReset is false.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resetKey is an intentional re-run key.
  useLayoutEffect(() => {
    if (followOnResetRef.current) {
      applyStick(true);
      scrollToBottom();
      return;
    }
    applyStick(false);
    const el = scrollRef.current;
    if (el) el.scrollTop = 0;
  }, [resetKey, applyStick, scrollToBottom]);

  return { scrollRef, contentRef, atBottom, jumpToBottom };
}
