import { createContext, useContext, useMemo } from "react";
import { projectExecution } from "./project";
import { type ExecutionRuntime, execRuntime, useExecutionStore } from "./store";
import type { Execution } from "./types";

/**
 * The assistant message id whose team graph the current subtree renders.
 * Provided by {@link InlineTeamGraph} (inline graph) and the detail panel
 * (run-detail tab); the scoped hooks below read it so every graph view targets
 * the right message's slot — live or replayed — through one code path.
 */
export const ExecutionScopeContext = createContext<string | null>(null);

/** The in-scope message id (see {@link ExecutionScopeContext}). */
export function useExecutionScope(): string | null {
  return useContext(ExecutionScopeContext);
}

/**
 * One projected {@link Execution} per runtime snapshot, shared across every consumer
 * of the same turn. The store swaps a message's {@link ExecutionRuntime} for a NEW
 * object on every mutation (`patchExec` spreads), so the object identity IS a content
 * key: while a snapshot is unchanged all consumers (InlineTeamGraph / EscalationCards /
 * MultiAgentFileArtifacts / GraphView…) read the SAME fold — one `projectExecution` per
 * turn-frame instead of one per consumer per frame — and a superseded snapshot is GC'd
 * along with its cache entry. The playhead rides on `rt`, so scrubbing yields a new `rt`
 * and re-folds. Sharing one object also stabilizes referential equality downstream.
 */
const projectionCache = new WeakMap<ExecutionRuntime, Execution>();

function projectRuntime(rt: ExecutionRuntime): Execution | null {
  if (!rt.plan) return null;
  const cached = projectionCache.get(rt);
  if (cached) return cached;
  const upto = rt.playhead ?? rt.frames.length;
  const exec = projectExecution(
    rt.plan,
    rt.frames.slice(0, upto),
    rt.status,
    rt.debate,
    rt.debateRounds,
    rt.debateDecisions,
  );
  projectionCache.set(rt, exec);
  return exec;
}

/** Project a specific message's execution at its current playhead — live tail
 * or replay. Used where the message id is explicit (the inline graph + panel). */
export function useMessageExecution(
  messageId: string | null,
): Execution | null {
  const rt = useExecutionStore((s) =>
    messageId ? s.byId[messageId] : undefined,
  );
  return useMemo(() => (rt ? projectRuntime(rt) : null), [rt]);
}

/**
 * Subscribe to one field of the in-scope message's execution runtime
 * ({@link ExecutionScopeContext}). Re-renders when that field changes or the
 * scope switches. Prefer this over reading the store directly.
 */
export function useActiveExecField<T>(
  selector: (rt: ExecutionRuntime) => T,
): T {
  const messageId = useContext(ExecutionScopeContext);
  return useExecutionStore((s) =>
    selector(
      (messageId ? s.byId[messageId] : undefined) ?? execRuntime(s, messageId),
    ),
  );
}

/**
 * The in-scope message's execution snapshot at the current playhead — live
 * while following the tail, historical while scrubbing. Reads the scope from
 * {@link ExecutionScopeContext}.
 */
export function useProjectedExecution(): Execution | null {
  return useMessageExecution(useContext(ExecutionScopeContext));
}
