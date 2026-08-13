import { useEffect, useRef, useState } from "react";

const DEBOUNCE_MS = 300;

/**
 * A text filter that belongs in the URL but must not navigate on every keystroke.
 *
 * Driving the input's `value` straight off the query string leaves the caret a
 * navigation behind, so typed text stays in local state and only the settled value is
 * written. Seeded from the URL once and never re-synced back: adopting a later URL
 * value would overwrite whatever was typed while a write was still in flight, and
 * since every write replaces, no history entry can hand back a different value.
 *
 * The corollary is that a handler which clears the param itself (清空筛选) has to clear
 * the box in the same breath — nothing will push the emptied URL back into it.
 */
export function useDebouncedUrlText(
  urlValue: string,
  write: (next: string) => void,
): [string, (next: string) => void] {
  const [text, setText] = useState(urlValue);
  const writeRef = useRef(write);
  writeRef.current = write;

  useEffect(() => {
    if (text === urlValue) return;
    const t = setTimeout(() => writeRef.current(text), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [text, urlValue]);

  return [text, setText];
}
