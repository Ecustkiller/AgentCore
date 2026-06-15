import type { Message } from "@/stores/conversation";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

/**
 * Scroll controller for the AI 对话 transcript: stick-to-bottom *and*
 * bidirectional infinite scroll over a cursor window (载入模型 B).
 *
 * The transcript holds a contiguous window of the conversation, not the whole
 * history. Three concerns are folded into the one scroll container:
 *
 * - **Stick to bottom** while the user is at the live head, so a streaming turn
 *   stays in view — but only when the window actually reaches the tail
 *   (`hasMoreAfter === false`). In a historical window (after a search-hit jump)
 *   sticking is disabled, so appended pages don't yank the viewport past them.
 * - **Load older on scroll-up**: near the top, fetch the previous page and
 *   prepend it; the inflated top is anchored so the viewport stays on the same
 *   line instead of jumping.
 * - **Load newer on scroll-down**: near the bottom of a historical window, fetch
 *   the next page and append it (no anchoring needed — content added below the
 *   fold doesn't move what's above).
 *
 * `onLoadOlder` / `onLoadNewer` must be idempotent under a burst of scroll events
 * (the service guards with the loading flags); this hook additionally locks the
 * prepend anchor so it won't fire a second older-page before the first lands.
 *
 * The IM 消息 thread keeps using the simpler {@link useStickToBottom} — it is
 * append-only and needs none of the windowing here.
 */

/** Re-stick / detach band: treat "within this of the bottom" as at-bottom. */
const STICK_THRESHOLD_PX = 80;
/** Fetch the previous page once the user scrolls within this of the top. */
const TOP_LOAD_THRESHOLD_PX = 240;
/** Fetch the next page once within this of a historical window's bottom. */
const BOTTOM_LOAD_THRESHOLD_PX = 240;

interface ChatScrollOptions {
  messages: Message[];
  /** Conversation id — a change re-sticks to the latest item. */
  resetKey: string | null;
  /** Re-stick trigger as the newest turn grows (answer + reasoning lengths). */
  contentKey: string;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  loadingOlder: boolean;
  loadingNewer: boolean;
  /** Fetch + prepend the previous page (stable identity). */
  onLoadOlder: () => void;
  /** Fetch + append the next page (stable identity). */
  onLoadNewer: () => void;
  /** Reload the latest window — the 回到底部 action when reading history. */
  onJumpToLatest: () => void;
}

export function useChatScroll(opts: ChatScrollOptions) {
  const { messages, resetKey, contentKey, loadingOlder } = opts;
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  // Latest props for the scroll listener, so it subscribes once yet always reads
  // current flags/callbacks (avoids re-binding the listener on every toggle).
  const liveRef = useRef(opts);
  liveRef.current = opts;

  // Prepend anchor: distance bookkeeping captured when an older-page fetch is
  // triggered, restored once the new rows land so the viewport doesn't jump.
  const anchorRef = useRef<{
    firstId: string | null;
    prevHeight: number;
    prevTop: number;
  } | null>(null);

  const firstId = messages[0]?.id ?? null;

  const isNearBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return true;
    return (
      el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD_PX
    );
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  const jumpToBottom = useCallback(() => {
    // Reading history (newer pages unloaded): snap back to the live head by
    // reloading the latest window; the content-key effect then lands at bottom.
    if (liveRef.current.hasMoreAfter) {
      stickRef.current = true;
      setAtBottom(true);
      liveRef.current.onJumpToLatest();
      return;
    }
    stickRef.current = true;
    setAtBottom(true);
    scrollToBottom("auto");
  }, [scrollToBottom]);

  // User-driven scroll: toggle the stick, and page in either direction when the
  // user reaches an edge that still has more.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const live = liveRef.current;
      const near = isNearBottom();
      // Stick only at the true tail — never in a historical window.
      stickRef.current = near && !live.hasMoreAfter;
      setAtBottom(near && !live.hasMoreAfter);

      if (
        el.scrollTop < TOP_LOAD_THRESHOLD_PX &&
        live.hasMoreBefore &&
        !live.loadingOlder &&
        !anchorRef.current
      ) {
        anchorRef.current = {
          firstId: live.messages[0]?.id ?? null,
          prevHeight: el.scrollHeight,
          prevTop: el.scrollTop,
        };
        live.onLoadOlder();
      }

      if (
        el.scrollHeight - el.scrollTop - el.clientHeight <
          BOTTOM_LOAD_THRESHOLD_PX &&
        live.hasMoreAfter &&
        !live.loadingNewer
      ) {
        live.onLoadNewer();
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
    // Reads live flags/edges through liveRef, so it binds once per mount.
  }, [isNearBottom]);

  // Older page landed (or finished with nothing new): restore the anchored
  // position so the inflated top doesn't shift the user's place, then release
  // the lock so the next scroll-up can page again.
  useLayoutEffect(() => {
    const a = anchorRef.current;
    if (!a) return;
    const el = scrollRef.current;
    if (a.firstId !== firstId && el) {
      el.scrollTop = a.prevTop + (el.scrollHeight - a.prevHeight);
      anchorRef.current = null;
    } else if (!loadingOlder) {
      anchorRef.current = null;
    }
  }, [firstId, loadingOlder]);

  // New content at the tail (new turn / streaming tokens): follow only while
  // stuck and at the real head; otherwise just refresh the button state.
  // biome-ignore lint/correctness/useExhaustiveDependencies: contentKey is an intentional re-run key; helpers are stable.
  useLayoutEffect(() => {
    if (stickRef.current && !liveRef.current.hasMoreAfter) {
      scrollToBottom("auto");
    } else {
      setAtBottom(isNearBottom() && !liveRef.current.hasMoreAfter);
    }
  }, [contentKey, isNearBottom, scrollToBottom]);

  // Context switch: re-stick and land on the latest item, dropping any anchor.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resetKey is an intentional re-run key.
  useLayoutEffect(() => {
    stickRef.current = true;
    setAtBottom(true);
    anchorRef.current = null;
    scrollToBottom("auto");
  }, [resetKey, scrollToBottom]);

  return { scrollRef, atBottom, jumpToBottom };
}
