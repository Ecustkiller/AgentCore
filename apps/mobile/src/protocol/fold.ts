// The mobile protocol fold: SSE events → normalized ProjectedTurn (前端技术与架构 §十二).
//
// This is the ONE dangerous surface the conformance巡检 guards (cross-platform-
// frontend.mdc §四): it must match the backend oracle's golden for every vector
// (`pnpm conformance`). It is a brand-new mobile implementation — NOT shared with
// desktop's `projectExecution` — but behaviorally aligned to the same golden.
//
// Exhaustive `switch` + `assertNever` (支柱2): a new backend SSE type added to
// @agentcore/contract-types breaks this build until it is handled here.

import type {
  ApprovalRequiredPayload,
  ApprovalResolvedPayload,
  AskAssumption,
  AskQuestion,
  AskStyleOption,
  CheckpointRequiredPayload,
  CheckpointResolvedPayload,
  CitationsPayload,
  ContentDeltaPayload,
  ContextBlockWire,
  CostBreakdown,
  DebateNarrativeRound,
  DebateResultPayload,
  DebateRoundPayload,
  DebateRoundStartedPayload,
  EscalationRequiredPayload,
  EscalationResolvedPayload,
  FollowupsGeneratedPayload,
  MessageEndPayload,
  PlanAgentPayload,
  PlanReviewRequiredPayload,
  PlanReviewResolvedPayload,
  PlanRevisedPayload,
  QuestionPostedPayload,
  ReasoningDeltaPayload,
  RunCompletedPayload,
  RunContextPayload,
  RunEscalationPayload,
  RunFailedPayload,
  RunOutputDeltaPayload,
  RunOutputResetPayload,
  RunPlanPayload,
  RunReasoningDeltaPayload,
  RunStartedPayload,
  RunToolProgressPayload,
  SSEEvent,
  TeamNotePostedPayload,
  ToolPhase,
  ToolUseEndPayload,
  ToolUseProgressPayload,
  ToolUseStartPayload,
} from "@agentcore/contract-types";
import type {
  PendingInteraction,
  ProcessStep,
  ProjectedAgent,
  ProjectedCitation,
  ProjectedRun,
  ProjectedTeamNote,
  ProjectedTurn,
  TurnStatus,
} from "@agentcore/protocol-conformance";

const FINISH_TO_STATUS: Record<string, TurnStatus> = {
  end_turn: "completed",
  max_rounds: "completed",
  degraded: "completed",
  unproductive: "completed",
  error: "failed",
  cancelled: "cancelled",
  // 挂起即收口 (②): a turn finalized AT a durable checkpoint ends with finish_reason=paused
  // — a terminal message_end whose turn is NOT done. Stay paused (the *_required already set
  // status + pendingInteraction; this only adds finishReason + cost) so the single resume
  // card renders, not a completed bubble. Without this it'd fall to "completed" below.
  paused: "paused",
};

function assertNever(x: never): never {
  throw new Error(`fold: unhandled SSE event type: ${JSON.stringify(x)}`);
}

// Orchestration tools (delegate/debate) never emit a `tool` step: they are stood in for
// by a `team` marker dropped at their run_plan (统一团队时间线). Mirrors the backend
// sink/oracle ORCHESTRATION_TOOLS — conformance pins this set equal.
const ORCHESTRATION_TOOLS = new Set(["delegate", "debate"]);

/** Drop a `team` marker fixing the collaboration graph's chronological slot in the CEO
 * timeline. Deduped by execution_id (a debate's two run_plans share one id ⇒ one slot). */
function pushTeamMarker(process: ProcessStep[], executionId: string): void {
  if (!executionId) return;
  if (process.some((s) => s.kind === "team" && s.execution_id === executionId))
    return;
  process.push({ kind: "team", execution_id: executionId });
}

/** Drop a `checkpoint` marker (blocking ask_user) at its chronological slot. */
function pushCheckpointMarker(process: ProcessStep[], id: string): void {
  if (!id) return;
  if (process.some((s) => s.kind === "checkpoint" && s.checkpoint_id === id))
    return;
  process.push({ kind: "checkpoint", checkpoint_id: id });
}

/** Drop an `ask` marker (non-blocking question) at its chronological slot. */
function pushAskMarker(process: ProcessStep[], id: string): void {
  if (!id) return;
  if (process.some((s) => s.kind === "ask" && s.ask_id === id)) return;
  process.push({ kind: "ask", ask_id: id });
}

/** Drop a `plan_review` marker (plan-review gate) at its chronological slot. */
function pushPlanReviewMarker(process: ProcessStep[], id: string): void {
  if (!id) return;
  if (process.some((s) => s.kind === "plan_review" && s.checkpoint_id === id))
    return;
  process.push({ kind: "plan_review", checkpoint_id: id });
}

/** Fold one 逐轮叙事 update (`debate_round_started` → focus only, verdict null;
 * `debate_round` → full) into the accumulated list, keyed by `round_no` (a later
 * `debate_round` overwrites the focus-only entry — it carries focus too), kept
 * ascending. Mirrors desktop `upsertDebateRound` (conformance pins them equal). */
function upsertNarrativeRound(
  rounds: DebateNarrativeRound[],
  round: DebateNarrativeRound,
): DebateNarrativeRound[] {
  const idx = rounds.findIndex((r) => r.round_no === round.round_no);
  if (idx === -1) {
    return [...rounds, round].sort((a, b) => a.round_no - b.round_no);
  }
  const next = [...rounds];
  next[idx] = round;
  return next;
}

function agentFromPlan(a: PlanAgentPayload): ProjectedAgent {
  return {
    id: a.id,
    role: a.role,
    modelPreference: a.model_preference,
    thinking: a.thinking,
    reasoningEffort: a.reasoning_effort,
    status: "idle",
    currentRunId: null,
    output: "",
    reasoning: "",
    toolProgress: null,
  };
}

function runFromPlan(s: RunPlanPayload["runs"][number]): ProjectedRun {
  return {
    id: s.id,
    agentId: s.agent_id,
    task: s.task,
    status: "pending",
    dependsOn: s.depends_on ?? [],
    outputSummary: null,
    debrief: null,
    durationMs: null,
    error: null,
    parentRunId: s.parent_run_id ?? null,
    kind: s.kind ?? "agent",
    role: null,
    model: null,
    usage: null,
    cost: null,
    stance: s.stance ?? null,
    group: s.group ?? null,
    round: s.round ?? 0,
    revisionOf: null,
    revision: 0,
    //「计划已调整」轻痕迹 (设计 §7.2): set by the plan_revised event; null until then.
    revised: null,
    checkpoint: null,
    // 收到的上下文 (上下文传递可视化): filled by the run_context event; empty until then.
    receivedContext: [],
    // 升级实时可见: appended by the run_escalation event; empty until a worker escalates.
    escalations: [],
  };
}

export function fold(events: SSEEvent[]): ProjectedTurn {
  let content = "";
  let reasoning = "";
  // 收到的上下文 · CEO 侧 (上下文传递可视化): the captain run id (its kind=captain
  // run_started) + the opening context it was fed, routed turn-level — the CEO is the
  // bubble above the graph, not a peer node.
  let captainRunId: string | null = null;
  let captainContext: ContextBlockWire[] = [];
  const process: ProcessStep[] = [];
  let citations: ProjectedCitation[] = [];
  const agents: ProjectedAgent[] = [];
  const runs: ProjectedRun[] = [];
  let planId: string | null = null;
  let status: TurnStatus = "running";
  let finishReason: string | null = null;
  let cost: CostBreakdown | null = null;
  let debate: DebateResultPayload | null = null;
  let debateRounds: DebateNarrativeRound[] = [];
  // 团队便签墙 (§2.2 通): notes broadcast to siblings this turn, in post order (deduped by noteId).
  const teamNotes: ProjectedTeamNote[] = [];
  let pending: PendingInteraction | null = null;
  const checkpointSteps = new Map<string, string[]>();

  const agentById = (id: string) => agents.find((a) => a.id === id);
  const runById = (id: string) => runs.find((r) => r.id === id);

  for (const ev of events) {
    const type = ev.type;
    switch (type) {
      case "content_delta": {
        const d = (ev.payload as ContentDeltaPayload).delta || "";
        content += d;
        if (d) {
          const last = process[process.length - 1];
          if (last && last.kind === "content") last.text += d;
          else process.push({ kind: "content", text: d });
        }
        break;
      }
      // 交付前核验回炉（finish_guard）：done 轮草稿未过轻层核验，引擎丢弃这一版、发
      // content_reset、回炉重写。该事件进 _history（重连回放会重发），故 fold 必须镜像后端
      // _accumulate_process 与 desktop fold：清正文标量 + 弹掉 process 尾部连续 content 步
      // （reasoning/tool 是真实过程，保留），让重写版从干净态重累积。
      case "content_reset": {
        content = "";
        while (
          process.length > 0 &&
          process[process.length - 1].kind === "content"
        ) {
          process.pop();
        }
        break;
      }
      case "reasoning_delta": {
        const d = (ev.payload as ReasoningDeltaPayload).delta || "";
        reasoning += d;
        if (d) {
          const last = process[process.length - 1];
          if (last && last.kind === "reasoning") last.text += d;
          else process.push({ kind: "reasoning", text: d });
        }
        break;
      }
      case "tool_use_start": {
        const p = ev.payload as ToolUseStartPayload;
        // A delegated worker's call (run-scoped) belongs to its run node, not the
        // captain's inline timeline — keep it out of `process` (统一团队时间线 = the
        // CEO's OWN steps); still clear the run's live toolProgress below. An
        // orchestration tool (delegate/debate) is likewise skipped: its `team` marker
        // (dropped at run_plan) stands in for it.
        if (!p.run_id && !ORCHESTRATION_TOOLS.has(p.tool_name)) {
          process.push({
            kind: "tool",
            id: p.tool_call_id,
            tool_name: p.tool_name,
            arguments: p.arguments ?? {},
            result: null,
            status: "running",
          });
        }
        const running = runs.find((r) => r.status === "running");
        if (running) {
          const ag = agentById(running.agentId);
          if (ag) ag.toolProgress = null;
        }
        break;
      }
      case "tool_use_end": {
        const p = ev.payload as ToolUseEndPayload;
        if (!p.run_id && !ORCHESTRATION_TOOLS.has(p.tool_name)) {
          for (let i = process.length - 1; i >= 0; i--) {
            const step = process[i];
            if (step.kind === "tool" && step.id === p.tool_call_id) {
              step.result = p.result;
              step.status = p.status;
              if (p.display != null) step.display = p.display;
              break;
            }
          }
        }
        break;
      }
      case "citations": {
        citations = (ev.payload as CitationsPayload).citations ?? [];
        break;
      }
      case "run_plan": {
        const p = ev.payload as RunPlanPayload;
        // 协作图时间线落点: the first plan of an execution drops a `team` marker fixing the
        // collaboration graph's slot in the CEO timeline (later same-id batches no-op).
        pushTeamMarker(process, p.execution_id);
        if (planId === null || planId === p.execution_id) {
          planId = p.execution_id;
          for (const a of p.agents)
            if (!agentById(a.id)) agents.push(agentFromPlan(a));
          for (const s of p.runs) if (!runById(s.id)) runs.push(runFromPlan(s));
        } else {
          planId = p.execution_id;
          agents.length = 0;
          runs.length = 0;
          for (const a of p.agents) agents.push(agentFromPlan(a));
          for (const s of p.runs) runs.push(runFromPlan(s));
        }
        break;
      }
      case "run_started": {
        const p = ev.payload as RunStartedPayload;
        // The CEO captain is the turn's root (kind=captain); remember its run id so its
        // run_context routes turn-level (the captain node itself comes from run_plan, or
        // is dropped on a non-delegating turn).
        if (p.kind === "captain") captainRunId = p.run_id;
        const revision = p.revision ?? 0;
        let run = runById(p.run_id);
        if (!run && revision > 0 && p.parent_run_id) {
          const original = runById(p.parent_run_id);
          if (original) {
            const originAgent = agentById(original.agentId);
            agents.push({
              id: p.agent_id,
              role: originAgent?.role ?? original.agentId,
              modelPreference: originAgent?.modelPreference ?? "strong",
              thinking: originAgent?.thinking ?? true,
              reasoningEffort: originAgent?.reasoningEffort ?? "high",
              status: "idle",
              currentRunId: null,
              output: "",
              reasoning: "",
              toolProgress: null,
            });
            run = {
              ...runFromPlan({
                id: p.run_id,
                agent_id: p.agent_id,
                task: original.task,
                depends_on: [],
              }),
              parentRunId: p.parent_run_id,
              kind: p.kind,
              revisionOf: p.parent_run_id,
              revision,
              // 乙 wire 携 round/stance (单一轮次投影): a debate 续写 keeps its debater
              // identity (stance/group) + TRUE round so every fold reads 第几轮/哪一方 from
              // one field. Legacy journals fall back to the original's stance/group +
              // revision-as-round. Mirrors the desktop fold + backend oracle (conformance
              // pins them equal).
              stance: p.stance ?? original.stance,
              group: p.group ?? original.group,
              round: p.round || revision,
            };
            runs.push(run);
          }
        }
        if (run) {
          run.status = "running";
          run.parentRunId = p.parent_run_id;
          run.kind = p.kind;
        }
        const ag = agentById(p.agent_id);
        if (ag) {
          ag.status = "working";
          ag.currentRunId = p.run_id;
          ag.toolProgress = null;
        }
        break;
      }
      case "run_context": {
        // 收到的上下文 (上下文传递可视化): the structured context this run was fed, carried
        // verbatim — the SAME data the LLM saw. The CAPTAIN's (kind=captain) routes
        // TURN-LEVEL onto captainContext (the CEO is the bubble above the graph, not a
        // node — so it shows on every turn, pure chat included), APPENDING across emits so
        // its context GROWS by each post-delegation team readback (通道⑤); a WORKER's folds
        // onto its graph node. Mirrors the desktop fold + backend oracle (conformance pins equal).
        const p = ev.payload as RunContextPayload;
        if (p.run_id === captainRunId) {
          captainContext = [...captainContext, ...p.blocks];
          break;
        }
        const run = runById(p.run_id);
        if (run) run.receivedContext = p.blocks;
        break;
      }
      case "run_output_delta": {
        const p = ev.payload as RunOutputDeltaPayload;
        const ag = agentById(p.agent_id);
        if (ag) ag.output += p.delta || "";
        break;
      }
      // 交付前核验回炉 (finish_guard) 的 worker 对偶（content_reset 之于 CEO）：worker done 轮
      // 草稿未过轻层核验（统一底线·结构完整性），引擎丢弃这一版、发 run_output_reset、回炉重写。
      // 只清该 agent 的 output（重写版从干净态重累积），reasoning 是真实过程、保留——镜像后端
      // oracle 与 desktop fold（conformance pins them equal）。transport-only（不进 journal）。
      case "run_output_reset": {
        const p = ev.payload as RunOutputResetPayload;
        const ag = agentById(p.agent_id);
        if (ag) ag.output = "";
        break;
      }
      case "run_reasoning_delta": {
        const p = ev.payload as RunReasoningDeltaPayload;
        const ag = agentById(p.agent_id);
        if (ag) ag.reasoning += p.delta || "";
        break;
      }
      case "run_tool_progress": {
        const p = ev.payload as RunToolProgressPayload;
        const ag = agentById(p.agent_id);
        if (ag) ag.toolProgress = { toolName: p.tool_name, chars: p.chars };
        break;
      }
      case "run_completed": {
        const p = ev.payload as RunCompletedPayload;
        const run = runById(p.run_id);
        if (run) {
          run.status = "completed";
          run.outputSummary = p.output_summary;
          run.debrief = p.debrief ?? null;
          run.durationMs = p.duration_ms;
          run.role = p.role;
          run.model = p.model;
          run.usage = p.usage;
          run.cost = p.cost;
        }
        const ag = agentById(p.agent_id);
        if (ag) {
          ag.status = "completed";
          ag.currentRunId = null;
          ag.toolProgress = null;
        }
        break;
      }
      case "run_failed": {
        const p = ev.payload as RunFailedPayload;
        const run = runById(p.run_id);
        if (run) {
          run.status = "failed";
          run.error = p.error;
          run.debrief = p.debrief ?? null;
        }
        const ag = agentById(p.agent_id);
        if (ag) {
          ag.status = "error";
          ag.toolProgress = null;
        }
        break;
      }
      case "run_progress":
        // Derived below from run states (cumulative, multi-batch safe); wire counter
        // is a timeline marker only.
        break;
      case "plan_revised": {
        //「计划已调整」轻痕迹 (设计 §7.2): the CEO autonomously re-bound / re-steered the
        // paused plan via replan — tag each affected node (bind=据上游证据定稿待绑定步骤;
        // steer=偏离后操舵未跑步骤) so it paints a non-interrupting trace. bind wins over
        // steer if a node is both. A stray run_id (not on this graph) is ignored. Mirrors
        // the desktop fold + backend oracle (conformance pins them equal).
        const p = ev.payload as PlanRevisedPayload;
        for (const rev of p.revisions ?? []) {
          const run = runById(rev.run_id);
          if (run && !(run.revised === "bind" && rev.kind === "steer")) {
            run.revised = rev.kind;
          }
        }
        break;
      }
      case "run_escalation": {
        // 升级实时可见 (非阻塞): a worker flagged a decision/blocker for the CEO — append it
        // to its run so the node carries a ⚠️ signal (mirrors desktop/oracle; conformance
        // pins them equal). Transport-only; durable copy rides RunState.escalations.
        const p = ev.payload as RunEscalationPayload;
        const run = runById(p.run_id);
        if (run)
          run.escalations.push({
            question: p.question,
            assumption: p.assumption,
            blocking: p.blocking,
            status: "raised",
            answer: null,
          });
        break;
      }
      case "escalation_required": {
        // 阻塞式求决策: a worker SUSPENDED on a blocking escalate, awaiting the user — append
        // a `pending` card to its run (the turn does NOT pause; siblings keep running). Twin
        // of the run_escalation banner but journaled, so it replays on reload.
        const p = ev.payload as EscalationRequiredPayload;
        const run = runById(p.run_id);
        if (run)
          run.escalations.push({
            question: p.question,
            assumption: p.assumption,
            blocking: true,
            status: "pending",
            answer: null,
          });
        break;
      }
      case "escalation_resolved": {
        // 阻塞式求决策 settlement: flip this run's pending escalation to resolved/timeout (a
        // worker is sequential ⇒ at most one pending per run, 设计 §4.7). `resolved` carries
        // the answer; `timeout` (含按假设继续) falls back to the assumption (answer null).
        const p = ev.payload as EscalationResolvedPayload;
        const esc = runById(p.run_id)?.escalations.find(
          (e) => e.status === "pending",
        );
        if (esc) {
          if (p.status === "resolved") {
            esc.status = "resolved";
            esc.answer = p.answer;
          } else {
            esc.status = "timeout";
            esc.answer = null;
          }
        }
        break;
      }
      // 辩论收场：整段结构化产物（简报 + 交锋叙事线）verbatim 折入 ProjectedTurn.debate，
      // 与团队图互补（图承载辩手执行/发言全文，本字段承载主持人裁判 + 决策简报）。
      case "debate_result":
        debate = ev.payload as DebateResultPayload;
        break;
      // 辩论逐轮增量（进行中实时叠加，非 frame）：折叠累积成 debateRounds，与 oracle / 桌面
      // fold 一致。round_started 先给焦点（verdict=null=进行中），round 补 summary/verdict/sides。
      case "debate_round_started": {
        const p = ev.payload as DebateRoundStartedPayload;
        debateRounds = upsertNarrativeRound(debateRounds, {
          round_no: p.round_no,
          focus: p.focus,
          summary: "",
          verdict: null,
          sides: [],
          clashes: [],
        });
        break;
      }
      case "debate_round": {
        const p = ev.payload as DebateRoundPayload;
        debateRounds = upsertNarrativeRound(debateRounds, {
          round_no: p.round_no,
          focus: p.focus,
          summary: p.summary,
          verdict: p.verdict,
          sides: p.sides,
          clashes: p.clashes,
        });
        break;
      }
      // 团队便签墙 (§2.2 通): a worker broadcast a one-line decision / heads-up to its
      // concurrent siblings — fold onto teamNotes (post order), deduped by noteId for replay
      // safety. Mirrors the backend oracle + desktop fold (conformance pins them equal).
      case "team_note_posted": {
        const p = ev.payload as TeamNotePostedPayload;
        if (!teamNotes.some((n) => n.noteId === p.note_id)) {
          teamNotes.push({
            noteId: p.note_id,
            runId: p.run_id,
            agentId: p.agent_id,
            role: p.role,
            kind: p.kind,
            text: p.text,
            ts: p.ts,
            status: "active",
            supersedes: p.supersedes ?? null,
          });
        }
        // 便签会过期 → supersession (§2.2): an amendment (carries `supersedes`) marks its TARGET
        // superseded (改写) / voided (作废). Target was posted earlier so it is already in the list.
        if (p.supersedes) {
          const target = teamNotes.find((n) => n.noteId === p.supersedes);
          if (target) {
            target.status =
              p.supersede_mode === "void" ? "voided" : "superseded";
          }
        }
        break;
      }
      case "approval_required": {
        const p = ev.payload as ApprovalRequiredPayload;
        pending = {
          kind: "approval",
          approvalId: p.approval_id,
          toolCallId: p.tool_call_id,
          toolName: p.tool_name,
          arguments: p.arguments ?? {},
        };
        status = "paused";
        break;
      }
      case "approval_resolved": {
        const p = ev.payload as ApprovalResolvedPayload;
        if (
          pending?.kind === "approval" &&
          pending.approvalId === p.approval_id
        ) {
          pending = null;
          status = "running";
        }
        break;
      }
      case "checkpoint_required": {
        const p = ev.payload as CheckpointRequiredPayload;
        pushCheckpointMarker(process, p.checkpoint_id);
        pending = {
          kind: "checkpoint",
          checkpointId: p.checkpoint_id,
          question: p.question,
          context: p.context,
        };
        status = "paused";
        break;
      }
      case "checkpoint_resolved": {
        const p = ev.payload as CheckpointResolvedPayload;
        if (
          pending?.kind === "checkpoint" &&
          pending.checkpointId === p.checkpoint_id
        ) {
          pending = null;
          status = "running";
        }
        break;
      }
      case "plan_review_required": {
        const p = ev.payload as PlanReviewRequiredPayload;
        pushPlanReviewMarker(process, p.checkpoint_id);
        const runIds = (p.steps ?? []).map((s) => s.run_id);
        checkpointSteps.set(p.checkpoint_id, runIds);
        for (const rid of runIds) {
          const run = runById(rid);
          if (run) run.checkpoint = { status: "pending", decision: null };
        }
        pending = {
          kind: "plan_review",
          checkpointId: p.checkpoint_id,
          runIds,
        };
        status = "paused";
        break;
      }
      case "plan_review_resolved": {
        const p = ev.payload as PlanReviewResolvedPayload;
        for (const rid of checkpointSteps.get(p.checkpoint_id) ?? []) {
          const run = runById(rid);
          if (run)
            run.checkpoint = { status: "resolved", decision: p.decision };
        }
        if (
          pending?.kind === "plan_review" &&
          pending.checkpointId === p.checkpoint_id
        ) {
          pending = null;
          status = "running";
        }
        break;
      }
      case "question_posted": {
        // 非阻塞提问 (ask_user blocking=false): drop an `ask` marker at its chronological
        // slot; the turn does NOT pause (no `pending`). Mirrors the backend oracle.
        const p = ev.payload as QuestionPostedPayload;
        pushAskMarker(process, p.ask_id);
        break;
      }
      case "error":
        status = "failed";
        break;
      case "message_end": {
        const p = ev.payload as MessageEndPayload;
        finishReason = p.finish_reason;
        cost = p.cost ?? null;
        status = FINISH_TO_STATUS[p.finish_reason] ?? "completed";
        break;
      }
      // Not part of the normalized turn judge state (no-op) — but enumerated so the
      // assertNever below stays exhaustive against @agentcore/contract-types.
      case "message_start":
      case "turn_saved":
      case "title_generated":
      // CEO→用户「下一步推荐」: post-turn quick-reply chips, filled into the composer on tap.
      // Transport-only — never journaled/persisted and excluded from the normalized judge
      // state (same as the desktop oracle) → no-op here. The live chip UI reads it straight
      // off the raw turn events via `extractFollowups` (below), NOT off this fold.
      case "followups_generated":
      // AI 协作白板 client-tool requests (board_op = 改板 / board_read = 读板): transport-only
      // request/response exchanges that settle the bound desktop's board, never turn content →
      // no-op (mobile has no board surface). Mirrors the desktop conformanceFold no-op group.
      case "board_op_required":
      case "board_read_required":
      case "tool_progress":
      // 工具执行阶段进度 (联网搜索前端展示优化): a running tool's coarse phase (web_search →
      // querying / queued / fallback). Transport-only liveliness — NEVER journaled and excluded
      // from the normalized judge state (so the golden stays phase-less), exactly like
      // `tool_progress`. The LIVE waiting UI reads it off the raw events via {@link
      // extractToolPhases}, NOT this fold → no-op here (enumerated to keep assertNever exhaustive).
      case "tool_use_progress":
      // 调度埋点量化 (深层诊断指标): a desktop-only 诊断模式 surface (run detail's 调度 block) —
      // mobile has no diagnostic panel, so it folds to nothing here and stays out of the
      // conformance ProjectedTurn (desktop folds it onto Execution.batches instead).
      case "batch_metrics":
      // 交互式逐轮辩论的「续辩/收场」决策事件：桌面端 live-only（驱动决策卡），收场叙事
      // 已由 debate_round / debate_result 承载，故 conformance ProjectedTurn 从不携带它们
      // （与桌面 oracle 一致）。手机端无逐轮决策 UI → 折为 no-op，仅在此登记以保穷尽。
      case "debate_round_decision_required":
      case "debate_round_decision_resolved":
      case "workspace_op_required":
      case "workspace_promoted":
      case "handoff_snapshot_done":
      case "handoff_job_started":
      case "handoff_apply_done":
        break;
      default:
        assertNever(type);
    }
  }

  if (status === "cancelled") {
    for (const r of runs) if (r.status === "running") r.status = "cancelled";
    for (const a of agents) if (a.status === "working") a.status = "cancelled";
  }

  return {
    status,
    finishReason,
    content,
    reasoning,
    captainContext,
    // CEO's inline timeline — single-agent AND multi-agent (统一团队时间线); the team
    // graph slots at the `delegate` step on a delegating turn.
    process,
    citations,
    agents,
    runs,
    progress: {
      completed: runs.filter((r) => r.status === "completed").length,
      total: runs.length,
    },
    pendingInteraction: pending,
    cost,
    debate,
    debateRounds,
    teamNotes,
  };
}

/**
 * 下一步推荐 (CEO→用户): pull a finished turn's followup suggestions straight off its raw SSE
 * events — a transport-only sibling of {@link fold}, deliberately kept OUT of the normalized
 * {@link ProjectedTurn}. Followups are never journaled/persisted and are excluded from the
 * conformance golden (matching the desktop oracle), so the fold no-ops `followups_generated`;
 * the live chat surfaces them as one-tap chips above the composer instead.
 *
 * Returns the LAST emitted batch (the backend emits at most one per turn, after `message_end`);
 * empty when none. A reloaded turn (history replay) carries no `followups_generated`, so stale
 * chips never reappear — same semantics as desktop.
 */
export function extractFollowups(events: SSEEvent[]): string[] {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "followups_generated") {
      return (events[i].payload as FollowupsGeneratedPayload).followups;
    }
  }
  return [];
}

/**
 * 工具执行阶段进度 (联网搜索前端展示优化): the LATEST coarse phase per still-running tool call,
 * pulled straight off a live turn's raw SSE events — a transport-only sibling of {@link fold}
 * (twin of {@link extractFollowups} / {@link extractAsks}), deliberately kept OUT of the
 * normalized {@link ProjectedTurn} (so the conformance golden stays phase-less, exactly like the
 * `tool_use_progress` no-op inside the fold). Keyed by `tool_call_id`; an entry is CLEARED on the
 * matching `tool_use_end` so a finished tool shows no stale phase. web_search fires querying /
 * queued / fallback while its blocking request is in flight.
 *
 * Only a LIVE turn carries these events (they are never journaled), so history replay yields an
 * empty map and tool rows fall back to their plain running/done status — the same live-only
 * semantics as the followups / asks siblings.
 */
export function extractToolPhases(events: SSEEvent[]): Map<string, ToolPhase> {
  const phases = new Map<string, ToolPhase>();
  for (const ev of events) {
    if (ev.type === "tool_use_progress") {
      const p = ev.payload as ToolUseProgressPayload;
      phases.set(p.tool_call_id, p.phase as ToolPhase);
    } else if (ev.type === "tool_use_end") {
      phases.delete((ev.payload as ToolUseEndPayload).tool_call_id);
    }
  }
  return phases;
}

/** 非阻塞提问 (ask_user blocking=false) 的卡片内容：question + 可选 选项/默认/风格。 The
 *  conformance fold only drops a positional `ask` MARKER (`{kind:"ask", ask_id}`) in the
 *  timeline — the question text/options are transport-only and excluded from the golden
 *  (same as the desktop oracle). This carries that content so the chat can render the card
 *  AT the marker; it is read straight off the raw events, NOT the ProjectedTurn. */
export interface NonBlockingAsk {
  id: string;
  question: string;
  context: string;
  assumptions: AskAssumption[];
  questions: AskQuestion[];
  styleOptions: AskStyleOption[];
}

/**
 * 非阻塞提问 (CEO→用户, blocking=false): pull a turn's `question_posted` cards off its raw SSE
 * events — a transport-only sibling of {@link fold} (twin of {@link extractFollowups}),
 * keyed/ordered by `ask_id`. Mirrors the desktop `nonBlockingAsksFromEvents` projection.
 *
 * Only LIVE turns and MULTI-agent history carry these events (a single-agent turn persists
 * an empty `runs.events`, so its reload keeps just the bare `ask` marker — no card, exactly
 * like desktop). De-duped by `ask_id`, preserving first-seen order; empty when none.
 */
export function extractAsks(events: SSEEvent[]): NonBlockingAsk[] {
  const byId = new Map<string, NonBlockingAsk>();
  const order: string[] = [];
  for (const ev of events) {
    if (ev.type !== "question_posted") continue;
    const p = ev.payload as QuestionPostedPayload;
    if (byId.has(p.ask_id)) continue;
    order.push(p.ask_id);
    byId.set(p.ask_id, {
      id: p.ask_id,
      question: p.question,
      context: p.context,
      assumptions: p.assumptions ?? [],
      questions: p.questions ?? [],
      styleOptions: p.style_options ?? [],
    });
  }
  return order.map((id) => byId.get(id) as NonBlockingAsk);
}

/**
 * 阻塞式求决策 (escalate blocking=true): the `escalation_id` of each run's CURRENTLY-pending
 * blocking escalation — a transport-only sibling of {@link fold} (twin of {@link extractAsks}),
 * keyed by `run_id`. The conformance {@link RunEscalation} carries no id (it is excluded from
 * the golden), so the interactive answer card reads the resolve key from HERE, off the raw
 * `escalation_required` events, and clears it on the matching `escalation_resolved`.
 *
 * A worker is sequential ⇒ at most one pending escalation per run (设计 §4.7), so a flat
 * runId→escalationId map suffices. Only LIVE turns carry these events (history replays them
 * already settled → empty), so the card is naturally live-only — matching desktop.
 */
export function extractPendingEscalations(
  events: SSEEvent[],
): Map<string, string> {
  const pending = new Map<string, string>();
  for (const ev of events) {
    if (ev.type === "escalation_required") {
      const p = ev.payload as EscalationRequiredPayload;
      pending.set(p.run_id, p.escalation_id);
    } else if (ev.type === "escalation_resolved") {
      const p = ev.payload as EscalationResolvedPayload;
      pending.delete(p.run_id);
    }
  }
  return pending;
}
