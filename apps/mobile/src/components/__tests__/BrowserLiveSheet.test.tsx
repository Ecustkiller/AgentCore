// @vitest-environment jsdom
/**
 * BrowserLiveSheet — mount starts live SSE, unmount stops + best-effort takeover
 * end, takeover start/return toggles. Mocks api/browserLive + browserTakeover
 * network; keeps real toFrameSpace / createInputBatcher. Modal stubbed (jsdom
 * lacks showModal). Block comment keeps @vitest-environment file-leading.
 */

import type { BrowserLiveClient, BrowserLiveHandlers } from "@/api/browserLive";
import { startBrowserLive } from "@/api/browserLive";
import { listBrowserSessions } from "@/api/browserSessions";
import {
  endBrowserTakeover,
  sendBrowserInput,
  startBrowserTakeover,
} from "@/api/browserTakeover";
import { BrowserLiveSheet } from "@/components/BrowserLiveSheet";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/Modal", () => ({
  Modal: ({
    children,
    className,
  }: {
    children: ReactNode;
    className?: string;
  }) => <div className={className}>{children}</div>,
}));

vi.mock("@/api/browserLive", () => ({
  startBrowserLive: vi.fn(),
}));

vi.mock("@/api/browserSessions", () => ({
  listBrowserSessions: vi.fn(),
}));

vi.mock("@/api/browserTakeover", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/browserTakeover")>();
  return {
    ...actual,
    startBrowserTakeover: vi.fn(),
    endBrowserTakeover: vi.fn(),
    sendBrowserInput: vi.fn(),
  };
});

const mockStart = vi.mocked(startBrowserLive);
const mockListSessions = vi.mocked(listBrowserSessions);
const mockStartTakeover = vi.mocked(startBrowserTakeover);
const mockEndTakeover = vi.mocked(endBrowserTakeover);
const mockSendInput = vi.mocked(sendBrowserInput);

let captured: BrowserLiveHandlers | null;
let stopSpy: ReturnType<typeof vi.fn>;
let urlSeq: number;

beforeEach(() => {
  captured = null;
  stopSpy = vi.fn();
  urlSeq = 0;
  URL.createObjectURL = vi.fn(
    () => `blob:frame-${++urlSeq}`,
  ) as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
  mockStart.mockReset();
  mockStart.mockImplementation((_cid, _sid, handlers) => {
    captured = handlers;
    return { stop: stopSpy } satisfies BrowserLiveClient;
  });
  mockListSessions.mockReset().mockResolvedValue({
    sessions: [],
    activeSessionId: null,
  });
  mockStartTakeover.mockReset().mockResolvedValue({
    active: true,
    reason: "started",
  });
  mockEndTakeover.mockReset().mockResolvedValue(undefined);
  mockSendInput.mockReset().mockResolvedValue(undefined);
});

afterEach(cleanup);

function emit(fn: (h: BrowserLiveHandlers) => void): void {
  act(() => {
    if (captured) fn(captured);
  });
}

const FRAME = (frame_b64: string) => ({ frame_b64, width: 4, height: 4 });

function goLive(): void {
  emit((h) => {
    h.onConnection("open");
    h.onStatus("started");
  });
  emit((h) => h.onFrame(FRAME("AAAA")));
}

async function clickAsync(text: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByText(text));
  });
}

describe("BrowserLiveSheet · 挂载开播 / 卸载停", () => {
  it("open=false renders nothing and does not attach live", () => {
    const { container } = render(
      <BrowserLiveSheet
        conversationId="c1"
        sessionId="sess-1"
        open={false}
        onClose={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("mount with sessionId starts live and shows 连接中", () => {
    render(
      <BrowserLiveSheet
        conversationId="c1"
        sessionId="sess-1"
        open
        onClose={vi.fn()}
      />,
    );
    expect(mockStart).toHaveBeenCalledWith("c1", "sess-1", expect.anything());
    expect(screen.getByText("连接中…")).toBeTruthy();
  });

  it("resolves session via listBrowserSessions when sessionId omitted", async () => {
    mockListSessions.mockResolvedValue({
      sessions: [
        {
          sessionId: "sess-from-list",
          conversationId: "c1",
          hostKind: "sandbox",
          control: "agent",
          runId: null,
          createdAt: 1,
          lastUsed: 1,
        },
      ],
      activeSessionId: "sess-from-list",
    });
    render(<BrowserLiveSheet conversationId="c1" open onClose={vi.fn()} />);
    await waitFor(() => {
      expect(mockStart).toHaveBeenCalledWith(
        "c1",
        "sess-from-list",
        expect.anything(),
      );
    });
  });

  it("shows no_session when list returns empty", async () => {
    render(<BrowserLiveSheet conversationId="c1" open onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText("当前没有进行中的直播")).toBeTruthy();
    });
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("stops live and revokes the last frame URL on unmount", () => {
    const { unmount } = render(
      <BrowserLiveSheet
        conversationId="c1"
        sessionId="sess-1"
        open
        onClose={vi.fn()}
      />,
    );
    goLive();
    unmount();
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:frame-1");
  });

  it("swaps frames and revokes the previous object URL", () => {
    render(
      <BrowserLiveSheet
        conversationId="c1"
        sessionId="sess-1"
        open
        onClose={vi.fn()}
      />,
    );
    goLive();
    emit((h) => h.onFrame(FRAME("BBBB")));
    const img = screen.getByAltText("浏览器直播画面") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("blob:frame-2");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:frame-1");
  });
});

describe("BrowserLiveSheet · 状态文案", () => {
  it("shows reconnecting overlay copy", () => {
    render(
      <BrowserLiveSheet
        conversationId="c1"
        sessionId="sess-1"
        open
        onClose={vi.fn()}
      />,
    );
    emit((h) => h.onConnection("reconnecting"));
    expect(screen.getByText("连接已断开，正在重连…")).toBeTruthy();
  });

  it("shows session_closed when no prior frame", () => {
    render(
      <BrowserLiveSheet
        conversationId="c1"
        sessionId="sess-1"
        open
        onClose={vi.fn()}
      />,
    );
    emit((h) => h.onStatus("session_closed"));
    expect(screen.getByText("直播已结束")).toBeTruthy();
  });
});

describe("BrowserLiveSheet · 接管切换", () => {
  it("offers 接管 once a live frame is streaming", () => {
    render(
      <BrowserLiveSheet
        conversationId="c1"
        sessionId="sess-1"
        open
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByText("接管")).toBeNull();
    goLive();
    expect(screen.getByText("接管")).toBeTruthy();
  });

  it("start takeover → 归还控制; return → end", async () => {
    render(
      <BrowserLiveSheet
        conversationId="c1"
        sessionId="sess-1"
        open
        onClose={vi.fn()}
      />,
    );
    goLive();
    await clickAsync("接管");
    expect(mockStartTakeover).toHaveBeenCalledWith("c1", "sess-1");
    expect(screen.getByText("归还控制")).toBeTruthy();
    expect(screen.queryByText("接管")).toBeNull();

    await clickAsync("归还控制");
    expect(mockEndTakeover).toHaveBeenCalledWith("c1", "sess-1");
    expect(screen.getByText("控制已归还")).toBeTruthy();
    expect(screen.getByText("接管")).toBeTruthy();
  });

  it("best-effort ends takeover on unmount", async () => {
    const { unmount } = render(
      <BrowserLiveSheet
        conversationId="c1"
        sessionId="sess-1"
        open
        onClose={vi.fn()}
      />,
    );
    goLive();
    await clickAsync("接管");
    unmount();
    expect(mockEndTakeover).toHaveBeenCalledWith("c1", "sess-1");
  });

  it("maps pointer down/up to batched mouse input (touch→mouse)", async () => {
    render(
      <BrowserLiveSheet
        conversationId="c1"
        sessionId="sess-1"
        open
        onClose={vi.fn()}
      />,
    );
    goLive();
    await clickAsync("接管");

    const surface = screen.getByLabelText(/接管中的浏览器画面/);
    // Stub layout so toFrameSpace has a real rect (jsdom defaults to 0×0).
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 4,
      height: 4,
      right: 4,
      bottom: 4,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    await act(async () => {
      fireEvent.pointerDown(surface, { clientX: 2, clientY: 2, button: 0 });
      fireEvent.pointerUp(surface, { clientX: 2, clientY: 2, button: 0 });
    });

    expect(mockSendInput).toHaveBeenCalledWith(
      "c1",
      "sess-1",
      expect.arrayContaining([
        expect.objectContaining({ kind: "mouse", type: "down" }),
        expect.objectContaining({ kind: "mouse", type: "up" }),
      ]),
    );
  });

  it("compositionend injects kind:text (IME / soft-keyboard)", async () => {
    render(
      <BrowserLiveSheet
        conversationId="c1"
        sessionId="sess-1"
        open
        onClose={vi.fn()}
      />,
    );
    goLive();
    await clickAsync("接管");

    const surface = screen.getByLabelText(/接管中的浏览器画面/);
    await act(async () => {
      fireEvent.compositionStart(surface);
      fireEvent.compositionEnd(surface, { data: "密" });
    });

    await waitFor(() => {
      expect(mockSendInput).toHaveBeenCalledWith(
        "c1",
        "sess-1",
        expect.arrayContaining([
          expect.objectContaining({ kind: "text", text: "密" }),
        ]),
      );
    });
  });

  it("beforeinput insertText injects kind:text (soft keyboard Latin)", async () => {
    render(
      <BrowserLiveSheet
        conversationId="c1"
        sessionId="sess-1"
        open
        onClose={vi.fn()}
      />,
    );
    goLive();
    await clickAsync("接管");

    const surface = screen.getByLabelText(/接管中的浏览器画面/);
    await act(async () => {
      surface.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          inputType: "insertText",
          data: "p",
        }),
      );
    });

    await waitFor(() => {
      expect(mockSendInput).toHaveBeenCalledWith(
        "c1",
        "sess-1",
        expect.arrayContaining([
          expect.objectContaining({ kind: "text", text: "p" }),
        ]),
      );
    });
  });

  it("keydown/keyup still inject kind:key when not composing", async () => {
    render(
      <BrowserLiveSheet
        conversationId="c1"
        sessionId="sess-1"
        open
        onClose={vi.fn()}
      />,
    );
    goLive();
    await clickAsync("接管");

    const surface = screen.getByLabelText(/接管中的浏览器画面/);
    await act(async () => {
      fireEvent.keyDown(surface, { key: "a", code: "KeyA" });
      fireEvent.keyUp(surface, { key: "a", code: "KeyA" });
    });

    await waitFor(() => {
      expect(mockSendInput).toHaveBeenCalledWith(
        "c1",
        "sess-1",
        expect.arrayContaining([
          expect.objectContaining({
            kind: "key",
            type: "down",
            key: "a",
            code: "KeyA",
          }),
          expect.objectContaining({
            kind: "key",
            type: "up",
            key: "a",
            code: "KeyA",
          }),
        ]),
      );
    });
  });

  it("surfaces start failure and stays idle", async () => {
    const { TakeoverStartError } = await import("@/api/browserTakeover");
    mockStartTakeover.mockRejectedValue(new TakeoverStartError("no_session"));
    render(
      <BrowserLiveSheet
        conversationId="c1"
        sessionId="sess-1"
        open
        onClose={vi.fn()}
      />,
    );
    goLive();
    await clickAsync("接管");
    expect(screen.getByText("当前没有进行中的浏览器会话")).toBeTruthy();
    expect(screen.getByText("接管")).toBeTruthy();
    expect(screen.queryByText("归还控制")).toBeNull();
  });
});
