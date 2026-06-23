/** Turn spine: hydrate journal, fold messages → turns, build LOD nodes/edges. */

import { useActiveMessages } from "@/stores/conversation";
import {
  type Execution,
  type ExecutionRuntime,
  projectExecution,
  useExecutionStore,
} from "@/stores/execution";
import type { Edge, Node } from "@xyflow/react";
import { useEffect, useMemo, useRef } from "react";
import {
  countPendingDecisions,
  isTurnRecoverable,
} from "./CanvasDecisionPanel";
import type { TurnRailItem } from "./CanvasTurnRail";
import {
  FOCUS_NODE_HEIGHT,
  FOCUS_NODE_WIDTH,
  type FocusedTurnData,
} from "./FocusedTurnNode";
import type { SimpleTurnData } from "./SimpleTurnNode";
import type { TurnSummaryData } from "./TurnSummaryNode";

export const TURN_NODE_WIDTH = 320;
export const TEAM_NODE_HEIGHT = 132;
export const SIMPLE_NODE_HEIGHT = 96;
export const GAP_Y = 40;

export interface TurnItem {
  id: string;
  kind: "team" | "simple";
  exec: Execution | null;
  prompt: string;
  answer: string;
  running: boolean;
  pendingDecisions: number;
  recoverable: boolean;
}

function dedupeRoles(exec: Execution): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of exec.agents) {
    const r = a.role?.trim();
    if (!r || seen.has(r)) continue;
    seen.add(r);
    out.push(r);
  }
  return out;
}

const projectionCache = new WeakMap<ExecutionRuntime, Execution>();

function projectSlot(rt: ExecutionRuntime | undefined): Execution | null {
  if (!rt?.plan) return null;
  const cached = projectionCache.get(rt);
  if (cached) return cached;
  const exec = projectExecution(
    rt.plan,
    rt.frames.slice(0, rt.playhead ?? rt.frames.length),
    rt.status,
    rt.debate,
    rt.debateRounds,
  );
  projectionCache.set(rt, exec);
  return exec;
}

interface UseCanvasTurnsOptions {
  focusedTurn: string | null;
  setFocusedTurn: (id: string) => void;
  openZoom: (turnId: string, replay: boolean) => void;
}

export function useCanvasTurns({
  focusedTurn,
  setFocusedTurn,
  openZoom,
}: UseCanvasTurnsOptions) {
  const messages = useActiveMessages();
  const byId = useExecutionStore((s) => s.byId);

  useEffect(() => {
    const store = useExecutionStore.getState();
    for (const m of messages) {
      if (
        m.role === "assistant" &&
        m.executionId &&
        m.runs &&
        !store.byId[m.id]?.plan
      ) {
        store.hydrateFromJournal(m.id, m.runs);
      }
    }
  }, [messages]);

  const turns = useMemo<TurnItem[]>(() => {
    const out: TurnItem[] = [];
    let lastUser = "";
    for (const m of messages) {
      if (m.role === "user") {
        lastUser = m.content;
        continue;
      }
      if (m.role !== "assistant") continue;
      if (m.executionId) {
        const exec = projectSlot(byId[m.id]);
        out.push({
          id: m.id,
          kind: "team",
          exec,
          prompt: lastUser,
          answer: m.content,
          running: exec?.status === "running" || m.isStreaming,
          pendingDecisions: countPendingDecisions(m, exec),
          recoverable: isTurnRecoverable(exec),
        });
      } else {
        out.push({
          id: m.id,
          kind: "simple",
          exec: null,
          prompt: lastUser,
          answer: m.content,
          running: m.isStreaming,
          pendingDecisions: 0,
          recoverable: false,
        });
      }
    }
    return out;
  }, [messages, byId]);

  const latestTeamId = useMemo(() => {
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].kind === "team") return turns[i].id;
    }
    return null;
  }, [turns]);

  useEffect(() => {
    if (latestTeamId) setFocusedTurn(latestTeamId);
  }, [latestTeamId, setFocusedTurn]);

  const effectiveFocus = useMemo(() => {
    if (
      focusedTurn &&
      turns.some((t) => t.id === focusedTurn && t.kind === "team")
    ) {
      return focusedTurn;
    }
    return latestTeamId;
  }, [focusedTurn, turns, latestTeamId]);

  const seenTurnsRef = useRef<Set<string>>(new Set());
  const firstSpineRef = useRef(true);
  useEffect(() => {
    for (const t of turns) seenTurnsRef.current.add(t.id);
    firstSpineRef.current = false;
  }, [turns]);

  const nodes = useMemo<Node[]>(() => {
    const out: Node[] = [];
    let y = 0;
    const lastTurnId = turns[turns.length - 1]?.id;
    for (const t of turns) {
      const focused = t.kind === "team" && t.id === effectiveFocus;
      const width = focused ? FOCUS_NODE_WIDTH : TURN_NODE_WIDTH;
      const height = focused
        ? FOCUS_NODE_HEIGHT
        : t.kind === "team"
          ? TEAM_NODE_HEIGHT
          : SIMPLE_NODE_HEIGHT;
      const position = { x: -(width / 2), y };
      if (focused) {
        const data: FocusedTurnData = {
          messageId: t.id,
          onMaximize: () => openZoom(t.id, false),
        };
        out.push({
          id: t.id,
          type: "focusedTurn",
          position,
          data,
          draggable: false,
        });
      } else if (t.kind === "team") {
        const exec = t.exec;
        const data: TurnSummaryData = {
          taskSummary: exec?.taskSummary || t.prompt || "团队回合",
          status: exec?.status ?? "planning",
          roles: exec ? dedupeRoles(exec) : [],
          agentCount: exec?.agents.length ?? 0,
          completed: exec?.progress.completed ?? 0,
          total: exec?.progress.total ?? 0,
          pendingDecisions: t.pendingDecisions,
          recoverable: t.recoverable,
        };
        out.push({
          id: t.id,
          type: "teamTurn",
          position,
          data,
          draggable: false,
        });
      } else {
        const data: SimpleTurnData = {
          prompt: t.prompt,
          answer: t.answer,
          running: t.running,
          enter:
            t.id === lastTurnId &&
            !firstSpineRef.current &&
            !seenTurnsRef.current.has(t.id),
        };
        out.push({
          id: t.id,
          type: "simpleTurn",
          position,
          data,
          draggable: false,
        });
      }
      y += height + GAP_Y;
    }
    return out;
  }, [turns, effectiveFocus, openZoom]);

  const edges = useMemo<Edge[]>(
    () =>
      turns.slice(1).map((t, i) => ({
        id: `${turns[i].id}->${t.id}`,
        source: turns[i].id,
        target: t.id,
        type: "smoothstep",
        selectable: false,
        style: { stroke: "var(--border)" },
      })),
    [turns],
  );

  const railItems = useMemo<TurnRailItem[]>(
    () =>
      turns.map((t) => ({
        id: t.id,
        kind: t.kind,
        status: t.exec?.status ?? null,
        running: t.running,
        pendingDecisions: t.pendingDecisions,
        recoverable: t.recoverable,
        label:
          t.exec?.taskSummary ||
          t.prompt ||
          (t.kind === "team" ? "团队回合" : "直接回答"),
      })),
    [turns],
  );

  return {
    turns,
    latestTeamId,
    effectiveFocus,
    railItems,
    nodes,
    edges,
  };
}
