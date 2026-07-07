/** Per-turn dispatch context passed to every SSE handler. */
export interface DispatchContext {
  conversationId: string;
  /** When set, `sim.*` events update the simulation store. */
  simulationRunId?: string;
}
