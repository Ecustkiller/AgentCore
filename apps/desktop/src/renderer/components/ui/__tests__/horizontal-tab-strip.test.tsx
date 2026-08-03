// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  HorizontalTabStrip,
  SortableTab,
  moveItem,
  useSortableTabIds,
} from "../horizontal-tab-strip";

beforeAll(() => {
  // jsdom 无 ResizeObserver；hook 会挂观察器。
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

describe("moveItem", () => {
  const ids = ["a", "b", "c", "d"];

  it("moves before a later target", () => {
    expect(moveItem(ids, "a", "c", "before")).toEqual(["b", "a", "c", "d"]);
  });

  it("moves after a later target", () => {
    expect(moveItem(ids, "a", "c", "after")).toEqual(["b", "c", "a", "d"]);
  });

  it("moves before an earlier target", () => {
    expect(moveItem(ids, "d", "b", "before")).toEqual(["a", "d", "b", "c"]);
  });

  it("moves after an earlier target", () => {
    expect(moveItem(ids, "d", "b", "after")).toEqual(["a", "b", "d", "c"]);
  });

  it("returns a copy when from === over", () => {
    const next = moveItem(ids, "b", "b", "after");
    expect(next).toEqual(ids);
    expect(next).not.toBe(ids);
  });

  it("returns a copy when an id is unknown", () => {
    expect(moveItem(ids, "x", "a", "before")).toEqual(ids);
    expect(moveItem(ids, "a", "x", "after")).toEqual(ids);
  });

  it("is a stable no-op when already adjacent before", () => {
    expect(moveItem(ids, "b", "c", "before")).toEqual(["a", "b", "c", "d"]);
  });

  it("is a stable no-op when already adjacent after", () => {
    expect(moveItem(ids, "c", "b", "after")).toEqual(["a", "b", "c", "d"]);
  });
});

function SortableHarness({
  initial,
  onReorder,
}: {
  initial: string[];
  onReorder?: (ids: string[]) => void;
}) {
  const [ids, setIds] = useState(initial);
  const { getItemProps, draggingId } = useSortableTabIds(ids, (next) => {
    setIds(next);
    onReorder?.(next);
  });
  return (
    <HorizontalTabStrip aria-label="测试标签">
      {ids.map((id) => (
        <SortableTab key={id} id={id} getItemProps={getItemProps}>
          <button type="button">{id}</button>
          <button type="button" data-no-tab-drag aria-label={`关闭 ${id}`}>
            x
          </button>
          <span data-testid={`drag-${id}`}>
            {draggingId === id ? "dragging" : "idle"}
          </span>
        </SortableTab>
      ))}
    </HorizontalTabStrip>
  );
}

describe("HorizontalTabStrip / useSortableTabIds", () => {
  it("renders the strip landmark", () => {
    render(
      <HorizontalTabStrip>
        <div>tab</div>
      </HorizontalTabStrip>,
    );
    expect(screen.getByRole("navigation", { name: "标签页" })).toBeTruthy();
  });

  it("does not start a drag from data-no-tab-drag chrome", () => {
    const onReorder = vi.fn();
    render(<SortableHarness initial={["a", "b"]} onReorder={onReorder} />);
    const close = screen.getByLabelText("关闭 a");
    fireEvent.pointerDown(close, {
      button: 0,
      clientX: 10,
      clientY: 10,
      pointerId: 1,
    });
    fireEvent.pointerMove(close, {
      clientX: 40,
      clientY: 10,
      pointerId: 1,
    });
    expect(screen.getByTestId("drag-a").textContent).toBe("idle");
    expect(onReorder).not.toHaveBeenCalled();
  });
});
