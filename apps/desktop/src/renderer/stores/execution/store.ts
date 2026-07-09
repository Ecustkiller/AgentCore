import type {
  DebateNarrativeRound,
  DebateResultPayload,
  RunPlanPayload,
  ToolUseProgressPayload,
} from "@/types/events";
import { create } from "zustand";
import {
  type DebateDecisionUpdate,
  foldDebateDecision,
  upsertDebateRound,
} from "./debate";
import { type RunFrame, frameFromEvent } from "./frames";
import { mergePlanInto, planFromRunPlan } from "./plan";
import type {
  DebateRoundDecision,
  ExecutionJournal,
  ExecutionPlan,
  ExecutionStatus,
} from "./types";

/**
 * The execution state of a single assistant message's turn — plan, frame
 * stream, playhead and cross-view focus. Keyed by assistant message id so every
 * past multi-agent turn in a conversation keeps its own graph: the live turn
 * streams frames into its message's slot, and a reloaded turn hydrates its slot
 * once from the persisted journal.
 */
export interface ExecutionRuntime {
  plan: ExecutionPlan | null;
  frames: RunFrame[];
  /** Number of frames to project. `null` = follow the live tail. */
  playhead: number | null;
  status: ExecutionStatus;
  /** 辩论收场产物（`debate_result` —— 回合级单事件，非 plan/非 frame）：到达即存此，
   * {@link projectExecution} 透传到 {@link Execution.debate}。null = 非辩论/未收场。 */
  debate: DebateResultPayload | null;
  /** 辩论逐轮叙事（`debate_round_started` / `debate_round` —— 回合级单事件，非 frame）：
   * 折叠累积于此，{@link projectExecution} 透传到 {@link Execution.debateRounds}。`[]` =
   * 非辩论/无逐轮事件（含重载，逐轮事件 transport-only 不进 journal）。 */
  debateRounds: DebateNarrativeRound[];
  /** 交互式逐轮辩论决策卡（`debate_round_decision_*` —— 回合级单事件，非 frame）：折叠累积于
   * 此，{@link projectExecution} 透传到 {@link Execution.debateDecisions}。`[]` = 非交互辩论 /
   * 无决策事件（含重载，事件 transport-only 不进 journal）。 */
  debateDecisions: DebateRoundDecision[];
  /** Worker-scoped `tool_use_progress` (run_id present), keyed by run id. Transport-only —
   * merged onto agents at projection time; never journaled or replayed. */
  workerToolPhases: Record<string, { phase: string; toolName: string }>;
}

/**
 * Every mutator targets one assistant message's {@link ExecutionRuntime} by id.
 * SSE dispatch resolves the live turn's assistant message id and routes frames
 * there; view interactions (focus / playhead) pass the message id of the graph
 * subtree they belong to ({@link useExecutionScope}).
 */
interface ExecutionState {
  byId: Record<string, ExecutionRuntime>;

  startExecution: (plan: ExecutionPlan, messageId: string) => void;
  /**
   * Ingest a `run_plan` batch. The first batch of a turn starts a fresh
   * execution; a later batch with the *same* execution id (the adaptive D1′
   * case where the CEO delegates again) is merged in — new agents/runs are
   * appended and the frame stream is kept — so every batch stays on the graph
   * and timeline. A new turn produces a new assistant message (new slot), so
   * cross-turn batches never merge.
   */
  ingestPlan: (plan: ExecutionPlan, messageId: string) => void;
  clearExecution: (messageId: string) => void;
  recordFrame: (frame: RunFrame, messageId: string) => void;
  /** Append a rAF-coalesced batch of frames in ONE update (流式性能): the SSE ingest
   * buffers a frame's worth of `run_*_delta` and flushes them here so a token storm
   * triggers ≤60 store writes/projections per second instead of one per token. */
  recordFrames: (frames: RunFrame[], messageId: string) => void;
  /** Store a turn's debate 收场产物 (`debate_result`) on its slot; a no-plan slot
   * ignores it (stray fact). Sibling of {@link recordFrame} — one accrues the frame
   * stream, the other the debate brief/narrative (a回合级 one-shot, not a frame). */
  recordDebateResult: (debate: DebateResultPayload, messageId: string) => void;
  /** Fold one 逐轮叙事 update (`debate_round_started` → focus only; `debate_round` →
   * full) into the slot's {@link ExecutionRuntime.debateRounds} via {@link
   * upsertDebateRound}; a no-plan slot ignores it. Drives the进行中 per-round overlay
   * before {@link recordDebateResult}'s 收场 product lands. */
  recordDebateRound: (round: DebateNarrativeRound, messageId: string) => void;
  /** Fold one 交互式逐轮决策 update (`debate_round_decision_required` → append `pending`;
   * `..._resolved` → settle by id) into the slot's {@link ExecutionRuntime.debateDecisions}
   * via {@link foldDebateDecision}; a no-plan slot ignores it. Drives the round-boundary
   * 决策卡（opt-in, §逐轮交互）. */
  recordDebateDecision: (
    update: DebateDecisionUpdate,
    messageId: string,
  ) => void;
  /** Stamp a delegated worker's running-tool EXECUTION phase (`tool_use_progress` with
   * `run_id`). Transport-only — not a frame. */
  setWorkerToolPhase: (
    payload: ToolUseProgressPayload,
    messageId: string,
  ) => void;
  /** Clear a worker's live EXECUTION phase when its tool finishes (`tool_use_end`). */
  clearWorkerToolPhase: (runId: string, messageId: string) => void;
  setStatus: (status: ExecutionStatus, messageId: string) => void;
  setPlayhead: (index: number | null, messageId: string) => void;
  goLive: (messageId: string) => void;
  /**
   * Fold a persisted execution journal (`messages.runs`) into a message's slot,
   * reproducing the team graph a past multi-agent turn had — replayed through
   * the same fold as the live stream. Idempotent: a slot that already holds a
   * plan (a live turn, or an earlier hydrate) is left untouched, so a re-render
   * or a late history fetch never clobbers live frames.
   */
  hydrateFromJournal: (messageId: string, journal: ExecutionJournal) => void;
}

const EMPTY_EXEC: ExecutionRuntime = {
  plan: null,
  frames: [],
  playhead: null,
  status: "planning",
  debate: null,
  debateRounds: [],
  debateDecisions: [],
  workerToolPhases: {},
};

/** Map a persisted turn's `finish_reason` to the terminal execution status the
 * fold needs (a journal is only stored for finished turns). */
function statusFromFinish(finishReason: string): ExecutionStatus {
  if (finishReason === "error") return "failed";
  if (finishReason === "cancelled") return "cancelled";
  // 挂起即收口 (②): a turn finalized AT a durable checkpoint carries finish_reason=paused;
  // its graph stayed paused (the resume card drives it), so a hydrate must keep it paused
  // rather than collapse it to "completed" (mirrors the conformance fold's FINISH_TO_STATUS).
  if (finishReason === "paused") return "paused";
  return "completed";
}

/**
 * The execution runtime of an assistant message, never undefined (empty
 * default). Use this for imperative reads (`getState`, tests); components
 * subscribe via {@link useProjectedExecution} / {@link useActiveExecField}
 * (scoped to the in-context message) so a conversation switch re-renders.
 */
export function execRuntime(
  state: ExecutionState,
  messageId: string | null | undefined,
): ExecutionRuntime {
  return (messageId ? state.byId[messageId] : undefined) ?? EMPTY_EXEC;
}

export const useExecutionStore = create<ExecutionState>((set, get) => {
  /** Patch one message's runtime slice, lazily created from empty. */
  const patchExec = (
    messageId: string,
    update: (cur: ExecutionRuntime) => Partial<ExecutionRuntime> | null,
  ) =>
    set((state) => {
      const cur = state.byId[messageId] ?? EMPTY_EXEC;
      const patch = update(cur);
      if (patch === null) return {};
      return { byId: { ...state.byId, [messageId]: { ...cur, ...patch } } };
    });

  return {
    byId: {},

    startExecution: (plan, messageId) =>
      patchExec(messageId, () => ({
        plan,
        frames: [],
        playhead: null,
        status: "running",
        debate: null,
        debateRounds: [],
        debateDecisions: [],
        workerToolPhases: {},
      })),

    ingestPlan: (plan, messageId) => {
      const cur = execRuntime(get(), messageId).plan;
      // Different turn / first batch → fresh start (resets frames).
      if (!cur || cur.id !== plan.id) {
        get().startExecution(plan, messageId);
        return;
      }
      // Same execution → an incremental delegate batch: merge in unseen
      // agents/runs while keeping the existing frame stream and playhead.
      patchExec(messageId, () => ({
        plan: mergePlanInto(cur, plan),
        status: "running",
      }));
    },

    clearExecution: (messageId) =>
      patchExec(messageId, () => ({ ...EMPTY_EXEC })),

    // Frames only carry meaning inside an execution; ignore stray run/tool facts
    // from the single-agent path (no plan declared).
    recordFrame: (frame, messageId) =>
      patchExec(messageId, (cur) =>
        cur.plan ? { frames: [...cur.frames, frame] } : null,
      ),

    recordFrames: (frames, messageId) =>
      patchExec(messageId, (cur) =>
        cur.plan && frames.length
          ? { frames: [...cur.frames, ...frames] }
          : null,
      ),

    recordDebateResult: (debate, messageId) =>
      patchExec(messageId, (cur) => (cur.plan ? { debate } : null)),

    recordDebateRound: (round, messageId) =>
      patchExec(messageId, (cur) =>
        cur.plan
          ? { debateRounds: upsertDebateRound(cur.debateRounds, round) }
          : null,
      ),

    recordDebateDecision: (update, messageId) =>
      patchExec(messageId, (cur) =>
        cur.plan
          ? {
              debateDecisions: foldDebateDecision(cur.debateDecisions, update),
            }
          : null,
      ),

    setWorkerToolPhase: (payload, messageId) => {
      if (!payload.run_id) return;
      patchExec(messageId, (cur) => ({
        workerToolPhases: {
          ...cur.workerToolPhases,
          [payload.run_id!]: {
            phase: payload.phase,
            toolName: payload.tool_name,
          },
        },
      }));
    },

    clearWorkerToolPhase: (runId, messageId) =>
      patchExec(messageId, (cur) => {
        if (!cur.workerToolPhases[runId]) return null;
        const { [runId]: _, ...rest } = cur.workerToolPhases;
        return { workerToolPhases: rest };
      }),

    setStatus: (status, messageId) => patchExec(messageId, () => ({ status })),

    setPlayhead: (index, messageId) =>
      patchExec(messageId, () => ({ playhead: index })),

    goLive: (messageId) => patchExec(messageId, () => ({ playhead: null })),

    hydrateFromJournal: (messageId, journal) =>
      set((state) => {
        // Idempotent: never clobber a live turn's slot or an earlier hydrate.
        if (state.byId[messageId]?.plan) return {};
        let plan: ExecutionPlan | null = null;
        const frames: RunFrame[] = [];
        let debate: DebateResultPayload | null = null;
        for (const event of journal.events) {
          if (event.type === "run_plan") {
            const next = planFromRunPlan(event.payload as RunPlanPayload);
            plan = plan ? mergePlanInto(plan, next) : next;
          } else if (event.type === "debate_result") {
            // 回合级单事件（非 frame）：直接捕获，回放与直播经同一 slot 渲染辩论视图。
            debate = event.payload as DebateResultPayload;
          } else {
            const frame = frameFromEvent(event);
            if (frame) frames.push(frame);
          }
        }
        // No run_plan in the journal → nothing to draw (single-agent / stray).
        if (!plan) return {};
        return {
          byId: {
            ...state.byId,
            [messageId]: {
              plan,
              frames,
              playhead: null,
              status: statusFromFinish(journal.finishReason),
              debate,
              // 逐轮事件 transport-only（不进 journal）：重载无之，全量叙事线在 debate 里。
              debateRounds: [],
              // 交互式逐轮决策卡同为 transport-only：重载恒空（决策已体现在收场叙事 / 轮次）。
              debateDecisions: [],
              workerToolPhases: {},
            },
          },
        };
      }),
  };
});
