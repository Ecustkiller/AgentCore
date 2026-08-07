import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  type HTMLAttributes,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useRef,
  useState,
} from "react";
import {
  NO_TAB_DRAG_ATTR,
  type ReorderPlace,
  TAB_DRAG_THRESHOLD_PX,
  moveItem,
} from "./tab-reorder";
import { useHorizontalTabScroll } from "./useHorizontalTabScroll";

export {
  moveItem,
  NO_TAB_DRAG_ATTR,
  TAB_DRAG_THRESHOLD_PX,
  type ReorderPlace,
} from "./tab-reorder";
export {
  useHorizontalTabScroll,
  type HorizontalTabScrollState,
} from "./useHorizontalTabScroll";

export interface HorizontalTabStripProps {
  children: ReactNode;
  className?: string;
  /** Classes on the inner flex row that holds tabs. */
  contentClassName?: string;
  /** When false, only fades are shown (no chevron buttons). Default true. */
  showOverflowButtons?: boolean;
  "aria-label"?: string;
}

/**
 * Horizontally scrollable tab row with overflow fades and optional ‹ › controls.
 * Pass tab cells as `children` (often via `SortableTab` / `useSortableTabIds`).
 */
export function HorizontalTabStrip({
  children,
  className,
  contentClassName,
  showOverflowButtons = true,
  "aria-label": ariaLabel = "标签页",
}: HorizontalTabStripProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const { canScrollLeft, canScrollRight, scrollByPage } =
    useHorizontalTabScroll(scrollRef, contentRef);
  const overflow = canScrollLeft || canScrollRight;

  return (
    <nav
      className={cn(
        "relative flex min-w-0 items-center gap-0.5 self-stretch",
        className,
      )}
      aria-label={ariaLabel}
    >
      {showOverflowButtons && overflow ? (
        <IconButton
          size="sm"
          disabled={!canScrollLeft}
          aria-label="向左滚动标签"
          onClick={() => scrollByPage(-1)}
          className={cn(!canScrollLeft && "opacity-40")}
        >
          <ChevronLeft size={14} aria-hidden />
        </IconButton>
      ) : null}

      <div className="relative flex min-w-0 flex-1 items-center self-stretch">
        {canScrollLeft ? (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 left-0 z-10 w-6 bg-gradient-to-r from-card to-transparent"
          />
        ) : null}
        {canScrollRight ? (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 right-0 z-10 w-6 bg-gradient-to-l from-card to-transparent"
          />
        ) : null}
        {/* Hide scrollbar gutter: overflow-x alone can grow this box and shift tabs up. */}
        <div
          ref={scrollRef}
          className="min-w-0 w-full overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&::-webkit-scrollbar]:h-0 [&::-webkit-scrollbar]:w-0"
        >
          <div
            ref={contentRef}
            className={cn(
              "flex min-w-0 items-center gap-0.5",
              contentClassName,
            )}
          >
            {children}
          </div>
        </div>
      </div>

      {showOverflowButtons && overflow ? (
        <IconButton
          size="sm"
          disabled={!canScrollRight}
          aria-label="向右滚动标签"
          onClick={() => scrollByPage(1)}
          className={cn(!canScrollRight && "opacity-40")}
        >
          <ChevronRight size={14} aria-hidden />
        </IconButton>
      ) : null}
    </nav>
  );
}

type DragSession = {
  pointerId: number;
  fromId: string;
  startX: number;
  startY: number;
  dragging: boolean;
  overId: string | null;
  place: ReorderPlace;
};

export interface UseSortableTabIdsOptions {
  disabled?: boolean;
  thresholdPx?: number;
}

export interface SortableTabItemProps
  extends Omit<HTMLAttributes<HTMLElement>, "id"> {
  "data-tab-id": string;
  "data-dragging"?: string;
}

/**
 * Pointer-based tab reorder (capture after threshold; not HTML5 DnD).
 * Spread `getItemProps(id)` onto each tab root; mark close/etc with `data-no-tab-drag`.
 */
export function useSortableTabIds(
  ids: readonly string[],
  onReorder: (orderedIds: string[]) => void,
  options?: UseSortableTabIdsOptions,
) {
  const disabled = options?.disabled ?? false;
  const thresholdPx = options?.thresholdPx ?? TAB_DRAG_THRESHOLD_PX;
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const sessionRef = useRef<DragSession | null>(null);
  /** Survives past pointerup so the trailing click does not activate the tab. */
  const suppressClickRef = useRef(false);
  const idsRef = useRef(ids);
  idsRef.current = ids;
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;

  const endSession = useCallback(
    (el: HTMLElement, pointerId: number, commit: boolean) => {
      const session = sessionRef.current;
      if (!session || session.pointerId !== pointerId) return;
      sessionRef.current = null;
      setDraggingId(null);
      try {
        if (el.hasPointerCapture?.(pointerId)) {
          el.releasePointerCapture(pointerId);
        }
      } catch {
        /* already released */
      }
      if (
        commit &&
        session.dragging &&
        session.overId &&
        session.overId !== session.fromId
      ) {
        const next = moveItem(
          idsRef.current,
          session.fromId,
          session.overId,
          session.place,
        );
        const same =
          next.length === idsRef.current.length &&
          next.every((id, i) => id === idsRef.current[i]);
        if (!same) onReorderRef.current(next);
      }
    },
    [],
  );

  const resolveOver = useCallback(
    (clientX: number, clientY: number, fromId: string) => {
      const nodes = document.elementsFromPoint(clientX, clientY);
      for (const node of nodes) {
        if (!(node instanceof Element)) continue;
        const tab = node.closest("[data-tab-id]");
        if (!tab) continue;
        const overId = tab.getAttribute("data-tab-id");
        if (!overId || overId === fromId) continue;
        const rect = tab.getBoundingClientRect();
        const place: ReorderPlace =
          clientX < rect.left + rect.width / 2 ? "before" : "after";
        return { overId, place };
      }
      return null;
    },
    [],
  );

  const getItemProps = useCallback(
    (id: string): SortableTabItemProps => {
      const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
        if (disabled || e.button !== 0) return;
        const target = e.target as Element | null;
        if (target?.closest?.(`[${NO_TAB_DRAG_ATTR}]`)) return;
        suppressClickRef.current = false;
        sessionRef.current = {
          pointerId: e.pointerId,
          fromId: id,
          startX: e.clientX,
          startY: e.clientY,
          dragging: false,
          overId: null,
          place: "after",
        };
        // Capture early so moves past the threshold are not lost if the
        // pointer leaves the tab before dragging starts.
        e.currentTarget.setPointerCapture?.(e.pointerId);
      };

      const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
        const session = sessionRef.current;
        if (
          !session ||
          session.pointerId !== e.pointerId ||
          session.fromId !== id
        ) {
          return;
        }
        if (!session.dragging) {
          const dist = Math.hypot(
            e.clientX - session.startX,
            e.clientY - session.startY,
          );
          if (dist < thresholdPx) return;
          session.dragging = true;
          suppressClickRef.current = true;
          setDraggingId(id);
        }
        const hit = resolveOver(e.clientX, e.clientY, id);
        if (hit) {
          session.overId = hit.overId;
          session.place = hit.place;
        }
      };

      const onPointerUp = (e: ReactPointerEvent<HTMLElement>) => {
        endSession(e.currentTarget, e.pointerId, true);
      };

      const onPointerCancel = (e: ReactPointerEvent<HTMLElement>) => {
        suppressClickRef.current = false;
        endSession(e.currentTarget, e.pointerId, false);
      };

      const onClickCapture = (e: ReactMouseEvent<HTMLElement>) => {
        if (suppressClickRef.current) {
          e.preventDefault();
          e.stopPropagation();
          suppressClickRef.current = false;
        }
      };

      return {
        "data-tab-id": id,
        ...(draggingId === id ? { "data-dragging": "true" } : {}),
        onPointerDown,
        onPointerMove,
        onPointerUp,
        onPointerCancel,
        onClickCapture,
        className: cn(
          "touch-none select-none",
          draggingId === id
            ? "cursor-grabbing opacity-60"
            : disabled
              ? undefined
              : "cursor-grab",
        ),
      };
    },
    [disabled, draggingId, endSession, resolveOver, thresholdPx],
  );

  return { getItemProps, draggingId };
}

export interface SortableTabProps extends HTMLAttributes<HTMLDivElement> {
  id: string;
  /** From `useSortableTabIds`. */
  getItemProps: (id: string) => SortableTabItemProps;
}

/** Thin wrapper that merges sortable pointer props onto a tab root. */
export function SortableTab({
  id,
  getItemProps,
  className,
  children,
  ...rest
}: SortableTabProps) {
  const item = getItemProps(id);
  const {
    className: itemClassName,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onClickCapture,
    ...itemRest
  } = item;
  return (
    <div
      {...rest}
      {...itemRest}
      onPointerDown={(e) => {
        onPointerDown?.(e);
        rest.onPointerDown?.(e);
      }}
      onPointerMove={(e) => {
        onPointerMove?.(e);
        rest.onPointerMove?.(e);
      }}
      onPointerUp={(e) => {
        onPointerUp?.(e);
        rest.onPointerUp?.(e);
      }}
      onPointerCancel={(e) => {
        onPointerCancel?.(e);
        rest.onPointerCancel?.(e);
      }}
      onClickCapture={(e) => {
        onClickCapture?.(e);
        rest.onClickCapture?.(e);
      }}
      className={cn(itemClassName, className)}
    >
      {children}
    </div>
  );
}
