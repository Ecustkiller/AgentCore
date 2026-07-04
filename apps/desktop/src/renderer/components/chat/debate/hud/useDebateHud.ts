import { useDebateRoomStore } from "@/stores/debateRoom";
import { useMessageExecution } from "@/stores/execution";
import type { Execution } from "@/stores/execution";
import { useSidePanelStore } from "@/stores/sidePanel";
import { useEffect, useMemo, useRef } from "react";
import { toDebateModel } from "../model";
import type { DebateModel } from "../model";

/**
 * 辩论裁判台 HUD（裁决台 + 记分 + 掌舵）—— 统一右侧面板的**固定「裁判台」tab** 内容
 * （前端UX设计.md §4.3 · §十），与工作区（文件）/ run 详情 tab 平级互斥占满内容区。
 *
 * 数据单一来源：焦点辩论回合由 {@link import("../../graph/CanvasZoomedTurn").CanvasZoomedTurn} 经
 * {@link useDebateRoomStore} 发布（`target`），本模块据 `target.turnId` 从执行 store 投影出 execution +
 * {@link toDebateModel} 归一模型，其余（roster / 净分 / 待掌舵边界）全部 live 派生、无快照拷贝。
 * 流式/并排 与「结论↓」锚是**读法控件**，留在群聊流本体（{@link DebateStream} 的流内工具条），故本区
 * 不持有并排态、不跨树引 verdictRef——HUD 只管「判 / 记分 / 掌舵」，不与正文共享 UI 态（不重复实现）。
 */

/** Everything {@link DebateHudRegion} renders, derived live by {@link useDebateHud}. */
export interface DebateHudData {
  /** Whether a debate room is focused (canvas zoomed into 群聊) → the region may show. */
  show: boolean;
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
  /** Focused debate turn's projected execution (source of steering decisions). */
  execution: Execution | null;
  /** Normalised debate model (roster / 净分 / leaning). */
  model: DebateModel | null;
  /** Focused turn id + steering round-trip context (from the bridge store). */
  turnId: string | null;
  conversationId: string | null;
  interactive: boolean;
  /** Pending steering boundaries (badge + auto-surface). */
  pending: number;
  /** When true the dock body is only 工作区 (no drilled detail tab) → region may grow past 72%. */
  expanded?: boolean;
}

/**
 * Drive the 辩论裁判台 region from stores (mirrors {@link
 * import("../../graph/CanvasDecisionPanel").useCommandRegion}). Reads the focused
 * debate room from {@link useDebateRoomStore}, projects its execution + model live,
 * and owns the auto-surface: entering a debate room opens the dock + expands the
 * region, and a fresh steering boundary re-opens + re-expands it, so the boss never
 * misses a 掌舵 call. Called unconditionally at the top of the side panel (before its
 * closed early-return) so the auto-surface can reveal a closed dock.
 */
export function useDebateHud(): DebateHudData {
  const target = useDebateRoomStore((s) => s.target);
  const collapsed = useDebateRoomStore((s) => s.collapsed);
  const setCollapsed = useDebateRoomStore((s) => s.setCollapsed);

  const turnId = target?.turnId ?? null;
  const execution = useMessageExecution(turnId);
  const model = useMemo(
    () => (execution ? toDebateModel(execution) : null),
    [execution],
  );
  const show = !!target && !!model;
  const pending =
    execution?.debateDecisions.filter((d) => d.status === "pending").length ??
    0;

  // Auto-surface on room entry: opening a debate room reveals the dock + expands the
  // region (the HUD is the debate's primary aux surface, mirroring the old always-on
  // rail) — but only when the focused turn changes, so a boss who deliberately closed
  // the dock mid-room isn't fought on every re-render.
  const prevTurn = useRef<string | null>(null);
  useEffect(() => {
    if (!show || !turnId) {
      prevTurn.current = null;
      return;
    }
    if (prevTurn.current !== turnId) {
      prevTurn.current = turnId;
      useSidePanelStore.getState().showDebateHudTab();
      setCollapsed(false);
    }
  }, [show, turnId, setCollapsed]);

  // Re-surface on a fresh steering boundary: a new 待你掌舵 pend re-opens + re-expands
  // the region and switches to the 工作区 tab so the HUD is visible even if the boss
  // was deep-reading a run tab (mirrors 指挥台 auto-surface).
  const prevPending = useRef(0);
  useEffect(() => {
    if (!show) {
      prevPending.current = 0;
      return;
    }
    if (pending > prevPending.current) {
      useSidePanelStore.getState().showDebateHudTab();
      setCollapsed(false);
    }
    prevPending.current = pending;
  }, [show, pending, setCollapsed]);

  return {
    show,
    collapsed,
    setCollapsed,
    execution,
    model,
    turnId,
    conversationId: target?.conversationId ?? null,
    interactive: target?.interactive ?? false,
    pending,
  };
}
