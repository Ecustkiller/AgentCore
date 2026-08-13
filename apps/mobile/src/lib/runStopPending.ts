/**
 * 「停止请求已发出」的在飞态 —— 活在组件之外，关掉队员详情再打开仍然算数。
 *
 * 这以前是 `RunInterveneBar` 的局部 state：详情面板一卸载就归零，用户重新点开那位队员，
 * 按钮又是崭新的「停止这位队员」，于是同一个 run 上可以反复发同一条请求。而引擎那边这些
 * 请求全都排着队，界面却一次比一次更像「还没发出去」。
 *
 * 记的是**请求**，不是结果：run 的状态只能由引擎的后续帧改（桌面 `runStopPending` 同口径）。
 * run 一旦离开 pending / running 就自动撤掉在飞态，免得把一句永久的「停止请求中…」留在屏上。
 */
import { useSyncExternalStore } from "react";

type Listener = () => void;

function stopKey(executionId: string, runId: string): string {
  return `${executionId}:${runId}`;
}

let pending: ReadonlySet<string> = new Set();
const listeners = new Set<Listener>();

function publish(next: ReadonlySet<string>): void {
  pending = next;
  for (const l of listeners) l();
}

/** 请求已发出且被引擎受理——**受理失败不要登记**，那次什么都没发生。 */
export function markRunStopSent(executionId: string, runId: string): void {
  const key = stopKey(executionId, runId);
  if (pending.has(key)) return;
  const next = new Set(pending);
  next.add(key);
  publish(next);
}

/** 清空全部在飞态（用例隔离）。生产路径不需要：run 转终局即自动退场。 */
export function resetRunStopPending(): void {
  if (pending.size === 0) return;
  publish(new Set());
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): ReadonlySet<string> {
  return pending;
}

/**
 * 这位队员的停止请求还在飞吗。
 *
 * `runStatus` 一并传进来做自动收口：引擎确认后 run 转终局，在飞态即退场，界面回到
 * 「变灰 + 说明原因」，而不是把一句「停止请求中…」永久挂在屏上。
 */
export function useRunStopSent(
  executionId: string,
  runId: string,
  runStatus: string,
): boolean {
  const snap = useSyncExternalStore(subscribe, snapshot, snapshot);
  const live = runStatus === "pending" || runStatus === "running";
  return live && snap.has(stopKey(executionId, runId));
}
