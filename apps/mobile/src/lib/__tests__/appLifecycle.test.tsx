// @vitest-environment jsdom
/**
 * 前后台信号 —— 只在真正切换时回调、退订即止、useAppForeground 用最新闭包。
 */
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type StateHandler = (state: { isActive: boolean }) => void;

let handler: StateHandler | null = null;
const addListener = vi.fn(async (_event: string, cb: StateHandler) => {
  handler = cb;
  return { remove: vi.fn() };
});

vi.mock("@capacitor/app", () => ({
  App: {
    addListener: (event: string, cb: StateHandler) => addListener(event, cb),
  },
}));

import {
  __resetAppLifecycleForTests,
  getAppVisibility,
  subscribeAppState,
  useAppForeground,
} from "../appLifecycle";

/** 等插件 addListener 的 promise 落地后，投递一次原生态变化。 */
async function emitNative(isActive: boolean): Promise<void> {
  await Promise.resolve();
  handler?.({ isActive });
}

beforeEach(() => {
  handler = null;
  addListener.mockClear();
  __resetAppLifecycleForTests();
});

afterEach(() => {
  __resetAppLifecycleForTests();
});

describe("subscribeAppState", () => {
  it("绑定 appStateChange 并把 isActive 翻译成前/后台", async () => {
    const seen: string[] = [];
    subscribeAppState((v) => seen.push(v));
    await Promise.resolve();
    expect(addListener).toHaveBeenCalledWith(
      "appStateChange",
      expect.any(Function),
    );

    await emitNative(false);
    await emitNative(true);
    expect(seen).toEqual(["background", "foreground"]);
    expect(getAppVisibility()).toBe("foreground");
  });

  it("重复同态不回调（原生会重发）", async () => {
    const seen: string[] = [];
    subscribeAppState((v) => seen.push(v));
    await emitNative(false);
    await emitNative(false);
    await emitNative(true);
    expect(seen).toEqual(["background", "foreground"]);
  });

  it("多个订阅者共用一次绑定；退订后不再收到", async () => {
    const a: string[] = [];
    const b: string[] = [];
    const stopA = subscribeAppState((v) => a.push(v));
    subscribeAppState((v) => b.push(v));
    await Promise.resolve();
    expect(addListener).toHaveBeenCalledTimes(1);

    await emitNative(false);
    stopA();
    await emitNative(true);
    expect(a).toEqual(["background"]);
    expect(b).toEqual(["background", "foreground"]);
  });
});

describe("useAppForeground", () => {
  it("只在回前台触发，且用最新一版闭包", async () => {
    const calls: string[] = [];

    function Probe({ tag }: { tag: string }) {
      useAppForeground(() => calls.push(tag));
      return null;
    }

    const view = render(<Probe tag="first" />);
    await Promise.resolve();

    await emitNative(false);
    expect(calls).toEqual([]); // 切后台不触发

    view.rerender(<Probe tag="second" />);
    await emitNative(true);
    expect(calls).toEqual(["second"]);

    view.unmount();
    await emitNative(false);
    await emitNative(true);
    expect(calls).toEqual(["second"]);
  });
});
