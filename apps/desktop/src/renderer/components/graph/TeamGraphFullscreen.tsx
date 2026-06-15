import { useActiveExecField } from "@/stores/execution";
import { ArrowLeft } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { GraphView } from "./GraphView";

/**
 * Temporary, locally-owned full-screen for the inline team graph. Replaces the
 * old permanent `GraphOverlay` + global `graphOpen`: the inline graph mounts this
 * on demand (maximize button) and tears it down on close, so there is no global
 * graph state to keep in sync.
 *
 * Portaled to <body> so it escapes the message card's `overflow-hidden` (and any
 * transformed/animated ancestor that would otherwise clip a fixed child) and
 * covers the viewport. It hosts the full (non-embedded) `GraphView` — layout
 * toolbar, replay timeline, context menu. `onClose` is threaded into `GraphView`
 * so node drill-ins and endpoint jumps step the overlay aside to reveal the chat
 * (run detail opens in the conversation panel behind it); Esc and the 返回 button
 * close it too. `autoplay` starts the replay timeline on mount — the inline
 * card's 回放 entry.
 */
export function TeamGraphFullscreen({
  autoplay = false,
  onClose,
}: {
  autoplay?: boolean;
  onClose: () => void;
}) {
  const taskSummary = useActiveExecField((rt) => rt.plan?.taskSummary);
  const [entered, setEntered] = useState(false);

  // Slide in from the right (entrance only, no third-party dep).
  useEffect(() => {
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      className={`fixed inset-0 z-50 flex flex-col bg-background transition-transform duration-300 ${
        entered ? "translate-x-0" : "translate-x-full"
      }`}
    >
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
        <button
          type="button"
          onClick={onClose}
          className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ArrowLeft size={16} />
          返回
        </button>
        {taskSummary && (
          <span className="truncate text-sm font-medium text-foreground">
            {taskSummary}
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1">
        <GraphView autoplay={autoplay} onClose={onClose} />
      </div>
    </div>,
    document.body,
  );
}
