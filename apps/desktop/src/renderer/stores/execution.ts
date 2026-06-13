import { create } from "zustand";

export type StepStatus =
  | "pending"
  | "ready"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type ExecutionStatus =
  | "planning"
  | "running"
  | "paused"
  | "completed"
  | "failed";

export interface AgentState {
  id: string;
  role: string;
  status: "idle" | "working" | "completed" | "error";
  currentStepId: string | null;
  outputChunks: string[];
}

export interface StepState {
  id: string;
  agentId: string;
  task: string;
  status: StepStatus;
  dependsOn: string[];
  outputSummary: string | null;
  durationMs: number | null;
}

interface ExecutionState {
  currentExecution: {
    id: string;
    planType: "single_agent" | "multi_agent";
    taskSummary: string;
    status: ExecutionStatus;
    agents: AgentState[];
    steps: StepState[];
    progress: { completed: number; total: number };
  } | null;

  setExecution: (execution: ExecutionState["currentExecution"]) => void;
  clearExecution: () => void;
}

export const useExecutionStore = create<ExecutionState>((set) => ({
  currentExecution: null,

  setExecution: (execution) => set({ currentExecution: execution }),
  clearExecution: () => set({ currentExecution: null }),
}));
