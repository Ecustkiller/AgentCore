/**
 * 前后台生命周期信号（手机独有的一课）。
 *
 * App 切后台后系统会冻结 webview：socket 断、计时器停摆——连 SSE 的空闲看门狗都不会走。
 * 回前台若不主动探活，就只能干等下一次超时或用户手点「重连」。这里把「回到前台」收成
 * 一个订阅面，firehose (api/realtime.ts) 与对话流 (ChatPage) 各自挂上去重连。
 *
 * 不分平台：`@capacitor/app` 的 web 实现就是 `visibilitychange` → `appStateChange`，
 * 原生壳与浏览器共用同一个事件，调用方不需要知道自己跑在哪。
 */
import { App } from "@capacitor/app";
import { useEffect, useRef } from "react";

export type AppVisibility = "foreground" | "background";

type Listener = (visibility: AppVisibility) => void;

let current: AppVisibility = "foreground";
const listeners = new Set<Listener>();
let bound = false;

function apply(next: AppVisibility): void {
  if (next === current) return;
  current = next;
  // 快照迭代：订阅者的回调里退订不该漏掉后面的人。
  for (const listener of [...listeners]) listener(next);
}

/** 懒绑一次插件监听，随后跟进程共存（订阅者来去不重绑）。 */
function ensureBound(): void {
  if (bound) return;
  bound = true;
  try {
    void App.addListener("appStateChange", ({ isActive }) => {
      apply(isActive ? "foreground" : "background");
    }).catch(() => {
      // 插件缺失（老壳）——降级成「永远前台」，各订阅方保持现有行为，不崩。
    });
  } catch {
    /* 同上 */
  }
}

/** 订阅前后台切换；返回退订函数。只在真正发生切换时回调。 */
export function subscribeAppState(listener: Listener): () => void {
  listeners.add(listener);
  ensureBound();
  return () => {
    listeners.delete(listener);
  };
}

/** 当前可见性（同步读，用于订阅前判断初值）。 */
export function getAppVisibility(): AppVisibility {
  return current;
}

/** 每次「后台 → 前台」跑一次 `onForeground`；总是用最新一版闭包。 */
export function useAppForeground(onForeground: () => void): void {
  const saved = useRef(onForeground);
  saved.current = onForeground;

  useEffect(
    () =>
      subscribeAppState((visibility) => {
        if (visibility === "foreground") saved.current();
      }),
    [],
  );
}

/** 测试钩子：直接投递一次可见性变化（免起 Capacitor 桥）。 */
export function __emitAppVisibilityForTests(visibility: AppVisibility): void {
  apply(visibility);
}

/** 测试钩子：回到「前台 + 无订阅者」初值。 */
export function __resetAppLifecycleForTests(): void {
  listeners.clear();
  current = "foreground";
  bound = false;
}
