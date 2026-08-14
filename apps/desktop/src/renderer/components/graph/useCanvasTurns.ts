/** Turn spine: hydrate journal, fold messages → turns (LOD nodes built in useCanvasFlow). */

import { teamGraphVisible } from "@/components/chat/debatePreviewPlacement";
import { visibleMessageText } from "@/lib/errors";
import {
  assistantProjectionId,
  useActiveMessages,
  useConversationStore,
} from "@/stores/conversation";
import {
  type Execution,
  projectRuntime,
  useExecutionStore,
} from "@/stores/execution";
import { teamPreviewsExact, useInteractionStore } from "@/stores/interactions";
import { useEffect, useMemo, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { countPendingDecisions } from "./CanvasDecisionPanel";
import type { TurnRailItem } from "./CanvasTurnRail";
import {
  type TeamJournalSlot,
  teamJournalsIfIdentityChanged,
} from "./journalHydrate";

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
  /** User bubble id for this turn (empty when no preceding user message). */
  promptMessageId: string;
  /** Assistant bubble id (client id; may differ from projection `id`). */
  answerMessageId: string;
  running: boolean;
  pendingDecisions: number;
}

/** Spine height for a turn — prefers rendered RF style/measured height. */
export function spineTurnHeight(
  turn: TurnItem,
  nodes: {
    id: string;
    style?: { height?: number | string };
    height?: number;
    measured?: { height?: number };
  }[],
): number {
  const n = nodes.find((x) => x.id === turn.id);
  const styleH = n?.style?.height;
  if (typeof styleH === "number" && Number.isFinite(styleH)) return styleH;
  if (typeof styleH === "string") {
    const parsed = Number.parseFloat(styleH);
    if (!Number.isNaN(parsed)) return parsed;
  }
  const measured = n?.measured?.height ?? n?.height;
  if (typeof measured === "number" && Number.isFinite(measured))
    return measured;
  return turn.kind === "team" ? TEAM_NODE_HEIGHT : SIMPLE_NODE_HEIGHT;
}

interface UseCanvasTurnsOptions {
  focusedTurn: string | null;
  setFocusedTurn: (id: string) => void;
}

export function useCanvasTurns({
  focusedTurn,
  setFocusedTurn,
}: UseCanvasTurnsOptions) {
  const messages = useActiveMessages();
  const conversationId = useConversationStore((s) => s.currentConversationId);

  const teamTurnIds = useMemo(() => {
    const ids: string[] = [];
    for (const m of messages) {
      if (m.role !== "assistant" || !m.executionId) continue;
      ids.push(assistantProjectionId(m));
    }
    return ids;
  }, [messages]);

  // Per-turn runtimes only (not the whole byId table).
  const teamRuntimes = useExecutionStore(
    useShallow((s) => teamTurnIds.map((id) => s.byId[id])),
  );
  const interactionById = useInteractionStore((s) => s.byId);

  // Journal identity (m.runs / events.length), not every messages tick — live
  // streaming must not re-fold every team journal. hydrateFromJournal still
  // applies journalIsNewerThan (catch up after half-court; never roll live back).
  const journalSlotsRef = useRef<TeamJournalSlot[]>([]);
  const nextJournals = teamJournalsIfIdentityChanged(
    journalSlotsRef.current,
    messages,
  );
  if (nextJournals) journalSlotsRef.current = nextJournals;
  const teamJournals = journalSlotsRef.current;

  useEffect(() => {
    const store = useExecutionStore.getState();
    for (const { key, journal } of teamJournals) {
      store.hydrateFromJournal(key, journal);
    }
  }, [teamJournals]);

  const turns = useMemo<TurnItem[]>(() => {
    const out: TurnItem[] = [];
    let lastUser = "";
    let lastUserId = "";
    let teamIdx = 0;
    for (const m of messages) {
      if (m.role === "user") {
        lastUser = m.content;
        lastUserId = m.id;
        continue;
      }
      if (m.role !== "assistant") continue;
      const turnId = assistantProjectionId(m);
      if (m.executionId) {
        const rt = teamRuntimes[teamIdx++];
        const exec = rt ? projectRuntime(rt) : null;
        const showGraph = teamGraphVisible(
          exec?.runs,
          teamPreviewsExact(interactionById.values(), conversationId, turnId),
        );
        out.push({
          id: turnId,
          kind: showGraph ? "team" : "simple",
          exec: showGraph ? exec : null,
          prompt: lastUser,
          answer: visibleMessageText(m),
          promptMessageId: lastUserId,
          answerMessageId: m.id,
          running: showGraph
            ? exec?.status === "running" || m.isStreaming
            : m.isStreaming,
          pendingDecisions: showGraph
            ? countPendingDecisions(m, exec, {
                conversationId,
              })
            : 0,
        });
      } else {
        out.push({
          id: turnId,
          kind: "simple",
          exec: null,
          prompt: lastUser,
          answer: visibleMessageText(m),
          promptMessageId: lastUserId,
          answerMessageId: m.id,
          running: m.isStreaming,
          pendingDecisions: 0,
        });
      }
    }
    return out;
  }, [messages, teamRuntimes, conversationId, interactionById]);

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

  const railItems = useMemo<TurnRailItem[]>(
    () =>
      turns.map((t) => ({
        id: t.id,
        kind: t.kind,
        status: t.exec?.status ?? null,
        running: t.running,
        pendingDecisions: t.pendingDecisions,
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
  };
}
