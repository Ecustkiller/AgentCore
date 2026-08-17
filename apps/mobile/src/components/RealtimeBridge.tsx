/**
 * 把前后台信号接到 firehose / fulfill observer 上。切后台就断——webview 一冻结连接本
 * 就废了，主动断掉省得服务端挂着僵尸连接、也不让在线态虚高；回前台立刻重连，不等看门狗。
 * 登录 / 登出侧的开关在 api/auth.ts（对齐推送），这里只管生命周期。渲染 null。
 */
import { startFulfill, stopFulfill } from "@/api/fulfill";
import { startRealtime, stopRealtime } from "@/api/realtime";
import { subscribeAppState } from "@/lib/appLifecycle";
import { useEffect } from "react";

export function RealtimeBridge() {
  useEffect(
    () =>
      subscribeAppState((visibility) => {
        if (visibility === "foreground") {
          startRealtime();
          startFulfill();
        } else {
          stopRealtime();
          stopFulfill();
        }
      }),
    [],
  );
  return null;
}
