import type { ErrorAction } from "@/lib/errors";
import type { ExecutionJournal } from "@/stores/execution";
import type {
  AskAssumption,
  AskQuestion,
  AskStyleOption,
  CheckpointDecision,
  CheckpointIntent,
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
  intent: CheckpointIntent;
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

export interface TeamPreviewWorkerDisplay {
  run_id: string;
  role: string;
  task: string;
  depends_on: string[];
  debate: boolean;
}

export interface TeamPreviewDisplay {
  id: string;
  workers: TeamPreviewWorkerDisplay[];
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
  pinned?: boolean;
  archived?: boolean;
  /** Auto-classified on first-turn title minting; null = unclassified. */
  tag?: string | null;
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

/** One applied change in a「记忆已更新」card (记忆更新对话内可见, Agent记忆与知识系统 §1.6).
 * `file` is a friendly label (偏好 / 画像 / 主题·<slug>); `scope` is `"global"` |
 * `"project"`; `content` is the bullet (add/update) or matched text (remove); `target`
 * is the synthetic memory-leaf path the card deep-links to (`""` = no leaf). */
export interface MemoryUpdateItem {
  action: string;
  file: string;
  section: string;
  scope: string;
  content: string;
  target: string;
}

/** One offline-consolidation pass's result, rendered as a conversation-tail card —
 * what the AI remembered FROM this conversation (写也可见). Loaded with the latest
 * messages window + pushed live on the per-user firehose (`memory_updated`). */
export interface MemoryUpdate {
  id: string;
  createdAt: string;
  items: MemoryUpdateItem[];
}

export interface Message {
  id: string;
  /** 挂起即收口 (②): the SERVER's assistant message_id from `message_start` (the live
   * bubble's own `id` is a client UUID). It is the resume KEY — the id a durable frame is
   * persisted under and that `POST .../resume` claims — so a turn that ends paused
   * in-session must surface its resume card keyed by THIS, not the client id (which 404s).
   * Absent until message_start stamps it (and on reload, where `id` is already the server id). */
  serverMessageId?: string;
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
  /** 协作质量 (学·度量 §2.5): turn-level orchestration signals. Live via
   * message_end; reload via messages API (nested in usage column). Orchestration
   * counts also surface in the assistant footer; audit_drops is diagnostic-only. */
  collab?: import("@/types/events").TurnCollabMetrics;
  runs?: ExecutionJournal;
  captainContext?: ContextBlockWire[];
  checkpoints?: CheckpointDisplay[];
  nonBlockingAsks?: NonBlockingAskDisplay[];
  planReviews?: PlanReviewDisplay[];
  teamPreviews?: TeamPreviewDisplay[];
  error?: {
    code: string;
    message: string;
    context?: {
      upstream_status?: number;
      upstream_body_preview?: string | null;
      retry_attempts?: number;
      empty_diagnosis?: string;
      sub2api_diagnosis?: string;
      sub2api_account?: string;
    };
  };
  /** CEO→用户「下一步推荐」(下一步推荐): post-turn quick-reply suggestions, shown as
   * one-click chips under the latest assistant turn (fill the composer on click).
   * DERIVED-persisted (messages.followups column, twin of the title): live they ride
   * `followups_generated`; on reload `toMessage` replays them so reopening a conversation
   * still shows the last turn's chips. */
  followups?: string[];
  /** 回复反馈 (点赞/点踩, 对话基础功能补齐): the user's satisfaction rating on this assistant
   * reply — `"up"` / `"down"`, or `null` / undefined for 未评价. Persisted (messages.feedback
   * column) so a reloaded bubble replays the rating; toggled via the footer thumbs. */
  feedback?: "up" | "down" | null;
  traceId?: string;
  /** Preflight soft gate when the configured model may lack tool calling (turn_warning SSE). */
  turnWarning?: string;
}

export interface ConversationRuntime {
  messages: Message[];
  /** Conversation-tail「记忆已更新」cards (记忆更新对话内可见, §1.6): what the AI
   * remembered FROM this conversation, appended after the last message. Loaded with
   * the latest window + appended live from the firehose. */
  memoryUpdates: MemoryUpdate[];
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
  /** turn_warning received before message_start — stamped onto the next assistant bubble. */
  pendingTurnWarning: string | null;
}
