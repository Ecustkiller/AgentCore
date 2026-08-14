/**
 * Minimal Android soft-keyboard inset bridge via visualViewport → CSS variable.
 * Mount from TabLayout (tab roots) or a bare detail screen that owns the
 * keyboard inset (IM thread). No @capacitor/keyboard dependency.
 * When visualViewport is missing or adjustResize already shrunk the view, inset stays 0.
 */
import { type RefObject, useEffect } from "react";

export const KEYBOARD_INSET_VAR = "--keyboard-inset-bottom";

function keyboardInsetPx(vv: VisualViewport): number {
  return Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
}

/** Subscribe visualViewport → `--keyboard-inset-bottom` on the target (or <html>). */
export function useKeyboardInsetBridge(
  targetRef?: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const target = () => targetRef?.current ?? document.documentElement;

    const update = () => {
      try {
        const el = target();
        if (!el) return;
        el.style.setProperty(KEYBOARD_INSET_VAR, `${keyboardInsetPx(vv)}px`);
      } catch {
        // graceful: leave prior / unset value
      }
    };

    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      try {
        target()?.style.removeProperty(KEYBOARD_INSET_VAR);
      } catch {
        // ignore cleanup failures
      }
    };
  }, [targetRef]);
}
