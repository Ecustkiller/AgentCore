// @vitest-environment jsdom
/**
 * 草稿首发 (startDraft)：一次发送动作只能建出一条会话。
 *
 * 线上 7 天 8 起「一次发送建出两条内容完全相同的会话」（其中一起三条，间隔 14ms / 269ms —— 人手
 * 按不出来），根因是并发闸用了 `busy`：它由 React 态 `sending` 派生，`setSending(true)` 不同步，
 * 同一帧里的两次提交（双击 / Enter 连按 / 触摸+点击双触发）读到的都是提交前的那一版闭包，一起
 * 穿过闸门各建一条。这里用「同一个 act 里连点两次」复现同帧双发（嵌套 act 不会在两次事件之间
 * 提交），再加一把 `client_request_id` 幂等键兜住真穿过去的重发。
 */
import { getAutonomy } from "@/api/autonomy";
import { createConversation } from "@/api/conversations";
import { ChatPage } from "@/pages/ChatPage";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof import("react-router-dom")>(
      "react-router-dom",
    );
  return { ...actual, useNavigate: () => navigate, useParams: () => ({}) };
});

vi.mock("@/api/client", () => ({
  getTokens: () => ({ access_token: "a", refresh_token: "r" }),
  apiFetch: vi.fn(),
}));

vi.mock("@/api/conversations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/conversations")>()),
  createConversation: vi.fn(),
}));

vi.mock("@/api/autonomy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/autonomy")>()),
  getAutonomy: vi.fn(),
}));

vi.mock("@/api/modelProfiles", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/modelProfiles")>()),
  useModelProfiles: () => ({
    data: null,
    loading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // 未消费的 reject 不该炸测试进程：调用方总会 await 到它。
  return { promise, resolve, reject };
}

/** 本次 render 里 POST /v1/conversations 带上的幂等键。 */
function requestIdOfCall(index: number): string | undefined {
  const call = vi.mocked(createConversation).mock.calls[index];
  return call?.[1]?.client_request_id ?? undefined;
}

function composer(): HTMLTextAreaElement {
  return screen.getByPlaceholderText("说点什么…") as HTMLTextAreaElement;
}

function typeDraft(text: string) {
  fireEvent.change(composer(), { target: { value: text } });
}

function clickSend() {
  fireEvent.click(screen.getByLabelText("发送"));
}

let uuidSeq = 0;

beforeEach(() => {
  vi.clearAllMocks();
  uuidSeq = 0;
  Object.defineProperty(globalThis.crypto, "randomUUID", {
    configurable: true,
    writable: true,
    value: () => `req-${++uuidSeq}`,
  });
  // jsdom 没有元素级滚动实现（useStickScroll 每次内容变更都会调）。
  Object.defineProperty(Element.prototype, "scrollTo", {
    configurable: true,
    writable: true,
    value: () => {},
  });
  vi.mocked(getAutonomy).mockRejectedValue(new Error("offline"));
});

afterEach(cleanup);

describe("ChatPage · 草稿首发并发闸", () => {
  it("同帧重复提交只产生一次创建请求", async () => {
    const create = deferred<string>();
    vi.mocked(createConversation).mockReturnValue(create.promise);

    render(<ChatPage />);
    typeDraft("帮我写个周报");

    // 同一个 act 内连点两次 = 同一帧双发：两个 handler 看到的是同一次提交前的 React 态。
    const send = screen.getByLabelText("发送");
    await act(async () => {
      fireEvent.click(send);
      fireEvent.click(send);
    });

    expect(createConversation).toHaveBeenCalledTimes(1);
    expect(requestIdOfCall(0)).toBeTruthy();

    await act(async () => {
      create.resolve("conv-1");
    });
    await waitFor(() => {
      expect(navigate).toHaveBeenCalledTimes(1);
    });
    expect(navigate).toHaveBeenCalledWith("/c/conv-1", { replace: true });
  });

  it("按下发送立刻收草稿、摆出进行中气泡，不等创建返回", async () => {
    const create = deferred<string>();
    vi.mocked(createConversation).mockReturnValue(create.promise);

    render(<ChatPage />);
    typeDraft("帮我写个周报");
    clickSend();

    expect(composer().value).toBe("");
    expect(screen.getByText("帮我写个周报")).toBeTruthy();
    expect(screen.getByTestId("draft-pending-turn")).toBeTruthy();
    // 还没有 run 可停：主槽是不可点的「发送中」，不是 Stop。
    expect(screen.getByLabelText("发送中")).toBeTruthy();
    expect(screen.queryByLabelText("停止")).toBeNull();
    expect(navigate).not.toHaveBeenCalled();

    await act(async () => {
      create.resolve("conv-1");
    });
  });

  it("创建失败把整份草稿还回输入框，重发复用同一把幂等键", async () => {
    const first = deferred<string>();
    vi.mocked(createConversation).mockReturnValueOnce(first.promise);

    render(<ChatPage />);
    typeDraft("  周报草稿  ");
    clickSend();
    await act(async () => {
      first.reject(new Error("网络炸了"));
    });

    // 原样（含首尾空白）还给用户，进行中气泡撤掉，错误如实摆出。
    expect(composer().value).toBe("  周报草稿  ");
    expect(screen.queryByTestId("draft-pending-turn")).toBeNull();
    expect(await screen.findByText("网络炸了")).toBeTruthy();

    const second = deferred<string>();
    vi.mocked(createConversation).mockReturnValueOnce(second.promise);
    clickSend();
    expect(createConversation).toHaveBeenCalledTimes(2);
    // 同一份草稿 → 同一把键：上一发若其实已在服务端落地，同键只会拿回那一条会话。
    expect(requestIdOfCall(1)).toBe(requestIdOfCall(0));

    await act(async () => {
      second.reject(new Error("又炸了"));
    });

    // 用户自己清空草稿 → 这份草稿的生命周期结束，下一发换新键。
    typeDraft("");
    typeDraft("换个话题");
    const third = deferred<string>();
    vi.mocked(createConversation).mockReturnValueOnce(third.promise);
    clickSend();
    expect(requestIdOfCall(2)).not.toBe(requestIdOfCall(0));

    await act(async () => {
      third.resolve("conv-2");
    });
  });
});
