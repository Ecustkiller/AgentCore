// @vitest-environment jsdom
import { useStickToBottom } from "@/lib/useStickToBottom";
import { act, render, renderHook } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RoCallback = ResizeObserverCallback;

let roInstances: Array<{
  callback: RoCallback;
  observe: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}> = [];

function installResizeObserverMock() {
  roInstances = [];
  globalThis.ResizeObserver = class {
    callback: RoCallback;
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
    constructor(cb: RoCallback) {
      this.callback = cb;
      roInstances.push(this);
    }
  } as unknown as typeof ResizeObserver;
}

function fireContentResize() {
  const instance = roInstances[roInstances.length - 1];
  if (!instance) throw new Error("no ResizeObserver");
  const entry = {
    target: document.createElement("div"),
    contentRect: {} as DOMRectReadOnly,
    borderBoxSize: [],
    contentBoxSize: [],
    devicePixelContentBoxSize: [],
  } as unknown as ResizeObserverEntry;
  act(() => {
    instance.callback([entry], instance as unknown as ResizeObserver);
  });
}

function stubHeights(
  el: HTMLElement,
  opts: { scrollHeight: number; clientHeight?: number; scrollTop?: number },
) {
  let scrollHeight = opts.scrollHeight;
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    get: () => scrollHeight,
    set: (v: number) => {
      scrollHeight = v;
    },
  });
  Object.defineProperty(el, "clientHeight", {
    configurable: true,
    value: opts.clientHeight ?? 200,
  });
  if (opts.scrollTop != null) el.scrollTop = opts.scrollTop;
}

type StickApi = ReturnType<typeof useStickToBottom>;

function StickHarness({
  resetKey,
  followOnReset,
  onReady,
}: {
  resetKey: string | null;
  followOnReset?: boolean;
  onReady: (api: StickApi, scroll: HTMLElement) => void;
}) {
  const api = useStickToBottom(resetKey, { followOnReset });
  useEffect(() => {
    const scroll = api.scrollRef.current;
    if (scroll) onReady(api, scroll);
  });
  return (
    <div ref={api.scrollRef} data-testid="scroll">
      <div ref={api.contentRef} data-testid="content" />
    </div>
  );
}

function requireReady(
  api: StickApi | null,
  scrollEl: HTMLElement | null,
): { api: StickApi; scrollEl: HTMLElement } {
  if (!api || !scrollEl) throw new Error("StickHarness did not mount");
  return { api, scrollEl };
}

describe("useStickToBottom followOnReset", () => {
  beforeEach(() => {
    installResizeObserverMock();
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("re-sticks to bottom when followOnReset is true (default)", () => {
    const { result, rerender } = renderHook(
      ({ resetKey }) => useStickToBottom(resetKey),
      { initialProps: { resetKey: "run-1" } },
    );

    const el = document.createElement("div");
    stubHeights(el, { scrollHeight: 800 });
    el.scrollTo = ((opts: ScrollToOptions) => {
      el.scrollTop = opts.top ?? 0;
    }) as typeof el.scrollTo;

    act(() => {
      result.current.scrollRef.current = el;
    });

    rerender({ resetKey: "run-2" });
    expect(result.current.atBottom).toBe(true);
    expect(el.scrollTop).toBe(800);
  });

  it("opens at top and stays detached when followOnReset is false", () => {
    const { result, rerender } = renderHook(
      ({ resetKey, follow }) =>
        useStickToBottom(resetKey, { followOnReset: follow }),
      {
        initialProps: {
          resetKey: "run-1",
          follow: false as boolean,
        },
      },
    );

    const el = document.createElement("div");
    stubHeights(el, { scrollHeight: 800, scrollTop: 400 });
    el.scrollTo = ((opts: ScrollToOptions) => {
      el.scrollTop = opts.top ?? 0;
    }) as typeof el.scrollTo;

    act(() => {
      result.current.scrollRef.current = el;
    });

    rerender({ resetKey: "run-2", follow: false });
    expect(result.current.atBottom).toBe(false);
    expect(el.scrollTop).toBe(0);
  });
});

describe("useStickToBottom layout follow", () => {
  beforeEach(() => {
    installResizeObserverMock();
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("follows async height growth while stuck", () => {
    const box: { api: StickApi | null; scroll: HTMLElement | null } = {
      api: null,
      scroll: null,
    };

    render(
      <StickHarness
        resetKey="chat-1"
        onReady={(a, scroll) => {
          box.api = a;
          box.scroll = scroll;
        }}
      />,
    );

    const ready = requireReady(box.api, box.scroll);
    expect(roInstances.length).toBeGreaterThan(0);

    stubHeights(ready.scrollEl, { scrollHeight: 400, scrollTop: 200 });
    stubHeights(ready.scrollEl, {
      scrollHeight: 900,
      scrollTop: ready.scrollEl.scrollTop,
    });
    fireContentResize();

    expect(ready.scrollEl.scrollTop).toBe(900);
    expect(box.api?.atBottom).toBe(true);
  });

  it("does not follow height growth after detach", () => {
    const box: { api: StickApi | null; scroll: HTMLElement | null } = {
      api: null,
      scroll: null,
    };

    render(
      <StickHarness
        resetKey="chat-1"
        onReady={(a, scroll) => {
          box.api = a;
          box.scroll = scroll;
        }}
      />,
    );

    const ready = requireReady(box.api, box.scroll);
    stubHeights(ready.scrollEl, { scrollHeight: 400, scrollTop: 200 });

    act(() => {
      ready.scrollEl.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
    });
    expect(box.api?.atBottom).toBe(false);
    const topBefore = ready.scrollEl.scrollTop;

    stubHeights(ready.scrollEl, {
      scrollHeight: 900,
      scrollTop: ready.scrollEl.scrollTop,
    });
    fireContentResize();

    expect(ready.scrollEl.scrollTop).toBe(topBefore);
    expect(box.api?.atBottom).toBe(false);
  });

  it("pauses follow while drag-selecting text", () => {
    const box: { api: StickApi | null; scroll: HTMLElement | null } = {
      api: null,
      scroll: null,
    };

    render(
      <StickHarness
        resetKey="chat-1"
        onReady={(a, scroll) => {
          box.api = a;
          box.scroll = scroll;
        }}
      />,
    );

    const ready = requireReady(box.api, box.scroll);
    stubHeights(ready.scrollEl, { scrollHeight: 400, scrollTop: 200 });

    act(() => {
      ready.scrollEl.dispatchEvent(new Event("pointerdown"));
      ready.scrollEl.dispatchEvent(new Event("selectstart"));
    });

    stubHeights(ready.scrollEl, {
      scrollHeight: 900,
      scrollTop: ready.scrollEl.scrollTop,
    });
    fireContentResize();
    expect(ready.scrollEl.scrollTop).toBe(200);

    act(() => {
      window.dispatchEvent(new Event("pointerup"));
    });
    expect(ready.scrollEl.scrollTop).toBe(900);
    expect(box.api?.atBottom).toBe(true);
  });

  it("keeps following when selection starts without a pointer drag", () => {
    const box: { api: StickApi | null; scroll: HTMLElement | null } = {
      api: null,
      scroll: null,
    };

    render(
      <StickHarness
        resetKey="chat-1"
        onReady={(a, scroll) => {
          box.api = a;
          box.scroll = scroll;
        }}
      />,
    );

    const ready = requireReady(box.api, box.scroll);
    stubHeights(ready.scrollEl, { scrollHeight: 400, scrollTop: 200 });

    // Shift+Arrow selection never fires pointerup, so latching here would pause
    // auto-follow for the rest of the pane's life.
    act(() => {
      ready.scrollEl.dispatchEvent(new Event("selectstart"));
    });

    stubHeights(ready.scrollEl, {
      scrollHeight: 900,
      scrollTop: ready.scrollEl.scrollTop,
    });
    fireContentResize();

    expect(ready.scrollEl.scrollTop).toBe(900);
    expect(box.api?.atBottom).toBe(true);
  });

  it("re-pins when the viewport shrinks while stuck", () => {
    const box: { api: StickApi | null; scroll: HTMLElement | null } = {
      api: null,
      scroll: null,
    };

    render(
      <StickHarness
        resetKey="chat-1"
        onReady={(a, scroll) => {
          box.api = a;
          box.scroll = scroll;
        }}
      />,
    );

    const ready = requireReady(box.api, box.scroll);
    expect(roInstances[roInstances.length - 1]?.observe).toHaveBeenCalledTimes(
      2,
    );

    // Content height unchanged; only the pane got shorter, so the bottom moved.
    stubHeights(ready.scrollEl, {
      scrollHeight: 900,
      clientHeight: 120,
      scrollTop: 700,
    });
    fireContentResize();

    expect(ready.scrollEl.scrollTop).toBe(900);
    expect(box.api?.atBottom).toBe(true);
  });
});
