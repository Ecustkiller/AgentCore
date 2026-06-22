import type { ErrorAction } from "@/lib/errors";
import type { ExecutionJournal } from "@/stores/execution";
import type {
  AskAssumption,
  AskQuestion,
  AskStyleOption,
  CheckpointDecision,
  Citation,
  ContextBlockWire,
  CostBreakdown,
  PlanReviewPending,
  PlanReviewStep,
  ProcessStep,
  UsageBreakdown,
} from "@/types/events";

export interface CheckpointDisplay {
  id: string;
  question: string;
  context: string;
  assumptions: AskAssumption[];
  questions: AskQuestion[];
  styleOptions: AskStyleOption[];
  status: "pending" | "resolved";
  decision: CheckpointDecision | null;
  note: string;
  selected: string[];
}

export interface NonBlockingAskDisplay {
  id: string;
  question: string;
  context: string;
  assumptions: AskAssumption[];
  questions: AskQuestion[];
  styleOptions: AskStyleOption[];
}

export interface PlanReviewDisplay {
  id: string;
  steps: PlanReviewStep[];
  pending: PlanReviewPending[];
  status: "pending" | "resolved";
  decision: CheckpointDecision | null;
  note: string;
}

export interface Conversation {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
  lastMessagePreview: string | null;
  folderId?: string | null;
  localContainerRootId?: string | null;
  modelMode?: string | null;
  pinned?: boolean;
  archived?: boolean;
}

export interface MessageAttachmentMeta {
  id: string;
  name: string;
  path: string;
  truncated: boolean;
  kind?: "file" | "dir" | "conversation";
  workspacePath?: string;
  conversationId?: string;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  process?: ProcessStep[];
  createdAt: string;
  executionId: string | null;
  isStreaming: boolean;
  composingTool?: { toolName: string; chars: number } | null;
  attachments?: MessageAttachmentMeta[];
  citations?: Citation[];
  cost?: CostBreakdown;
  usage?: UsageBreakdown;
  rounds?: number;
  finishReason?: string;
  runs?: ExecutionJournal;
  captainContext?: ContextBlockWire[];
  checkpoints?: CheckpointDisplay[];
  nonBlockingAsks?: NonBlockingAskDisplay[];
  planReviews?: PlanReviewDisplay[];
  error?: { code: string; message: string };
  traceId?: string;
  /** P2 工作区升级提示 (前端UX设计.md §九): set when THIS turn's first file write
   * promoted a bare chat into a folder-backed workspace (`workspace_promoted`).
   * Drives the bubble's inline「已升级为工作区」notice. Live-only — never persisted
   * (on reload the folder is simply already there, no longer news). */
  workspacePromotion?: { folderId: string; name: string };
}

export interface ConversationRuntime {
  messages: Message[];
  isGenerating: boolean;
  abort: AbortController | null;
  error: string | null;
  retry: (() => void) | null;
  errorAction: ErrorAction | null;
  messageFocus: { id: string; nonce: number } | null;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  loadingOlder: boolean;
  loadingNewer: boolean;
}
