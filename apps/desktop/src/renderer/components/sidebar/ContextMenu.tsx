import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface ContextMenuProps {
  /** Anchor point in viewport coordinates (usually the right-click position). */
  x: number;
  y: number;
  onClose: () => void;
  children: React.ReactNode;
}

/**
 * A right-click menu rendered in a body portal and positioned at (x, y), clamped
 * to the viewport. Closes on outside click, Escape, scroll, or resize. Callers
 * compose items with {@link MenuItem} / {@link MenuDivider} / {@link MenuLabel}.
 */
export function ContextMenu({ x, y, onClose, children }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  // Clamp into the viewport once measured, so a menu opened near an edge stays
  // fully on-screen.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const pad = 8;
    setPos({
      x: Math.min(x, window.innerWidth - width - pad),
      y: Math.min(y, window.innerHeight - height - pad),
    });
  }, [x, y]);

  useLayoutEffect(() => {
    const onPointerDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Capture phase so a scroll inside the sidebar list also dismisses the menu.
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  return createPortal(
    // biome-ignore lint/a11y/useKeyWithClickEvents: container only stops bubbling; focusable items handle keys.
    <div
      ref={ref}
      role="menu"
      style={{ top: pos.y, left: pos.x }}
      onClick={(e) => e.stopPropagation()}
      className="fixed z-50 min-w-44 overflow-hidden rounded-lg border border-border bg-popover py-1 text-popover-foreground shadow-lg"
    >
      {children}
    </div>,
    document.body,
  );
}

interface MenuItemProps {
  icon?: React.ReactNode;
  label: string;
  onSelect: () => void;
  danger?: boolean;
  /** Trailing adornment (e.g. a check for the current selection). */
  trailing?: React.ReactNode;
}

export function MenuItem({
  icon,
  label,
  onSelect,
  danger,
  trailing,
}: MenuItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-accent ${
        danger
          ? "text-destructive hover:text-destructive"
          : "text-popover-foreground hover:text-accent-foreground"
      }`}
    >
      {icon && <span className="shrink-0">{icon}</span>}
      <span className="flex-1 truncate">{label}</span>
      {trailing && <span className="shrink-0">{trailing}</span>}
    </button>
  );
}

export function MenuDivider() {
  return <div className="my-1 border-t border-border" />;
}

export function MenuLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 pt-1.5 pb-1 text-xs font-medium text-muted-foreground">
      {children}
    </div>
  );
}
