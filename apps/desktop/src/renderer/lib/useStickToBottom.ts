import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

/**
 * Keeps a transcript pinned to the newest content without hijacking the user's
 * reading. The view "sticks" to the bottom only while they are already near it
 * (within {@link STICK_THRESHOLD_PX}); scrolling up to read history detaches the
 * stick — so streaming/new content no longer yanks the viewport down — and
 * surfaces the 回到底部 affordance. A change of `resetKey` re-sticks to the
 * latest item.
 *
 * Auto-follow uses instant scrolling (a smooth animation can't keep pace with a
 * fast token stream and fights the scroll listener); the manual jump can afford
 * to be instant too, landing the user at the bottom without a long glide.
 *
 * Shared by the AI 对话 transcript (ChatView) and the 消息 IM thread
 * (ChatThread): `contentKey` re-runs the follow when the newest content grows,
 * `resetKey` re-sticks on a context switch (conversation / chat).
 */
const STICK_THRESHOLD_PX = 80;

export function useStickToBottom(contentKey: string, resetKey: string | null) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

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
    stickRef.current = true;
    setAtBottom(true);
    scrollToBottom("auto");
  }, [scrollToBottom]);

  // User-driven scroll toggles the stick: detach when they read upward, re-attach
  // the moment they return to the bottom edge.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const near = isNearBottom();
      stickRef.current = near;
      setAtBottom(near);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [isNearBottom]);

  // New content (streaming tokens / new message): follow only while stuck;
  // otherwise just refresh the button state since the gap to the bottom grew.
  // biome-ignore lint/correctness/useExhaustiveDependencies: contentKey is an intentional re-run key; the helpers it pairs with are stable.
  useLayoutEffect(() => {
    if (stickRef.current) scrollToBottom("auto");
    else setAtBottom(isNearBottom());
  }, [contentKey, isNearBottom, scrollToBottom]);

  // Context switch: always re-stick and land on the latest item.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resetKey is an intentional re-run key.
  useLayoutEffect(() => {
    stickRef.current = true;
    setAtBottom(true);
    scrollToBottom("auto");
  }, [resetKey, scrollToBottom]);

  return { scrollRef, atBottom, jumpToBottom };
}
