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
  AskAssumption,
  AskQuestion,
  AskStyleOption,
  CheckpointRequiredPayload,
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
  MessageStartPayload,
  PlanAgentPayload,
  PlanReviewRequiredPayload,
  PlanReviewResolvedPayload,
  PlanRevisedPayload,
  QuestionPostedPayload,
  ReasoningDeltaPayload,
  RunCancelledPayload,
  RunCompletedPayload,
  RunContextPayload,
  RunEscalationPayload,
  RunFailedPayload,
  RunOutputDeltaPayload,
  RunOutputResetPayload,
  RunPlanPayload,
  RunReasoningDeltaPayload,
  RunSkippedPayload,
  RunStartedPayload,
  RunToolProgressPayload,
  SSEEvent,
  TeamNotePostedPayload,
  TeamPreviewRequiredPayload,
  TeamSynthesisPreviewPayload,
  ToolPhase,
  ToolUseEndPayload,
  ToolUseProgressPayload,
  ToolUseStartPayload,
  TurnWarningPayload,
} from "@agentcore/contract-types";
import type {
  ProcessStep,
  ProjectedAgent,
  ProjectedCitation,
  ProjectedRun,
  ProjectedTeamNote,
  ProjectedTurn,
  TurnStatus,
} from "@agentcore/protocol-conformance";
import { foldInteractions, hasGatePending } from "./foldInteractions";

const FINISH_TO_STATUS: Record<string, TurnStatus> = {
  end_turn: "completed",
  max_rounds: "completed",
  degraded: "completed",
  unproductive: "completed",
  error: "failed",
  cancelled: "cancelled",
  // Crash / lease-sweeper salvage (流式回复持久化 P4): incomplete → cancelled-class.
  interrupted: "cancelled",
  // 挂起即收口 (②): a turn finalized AT a durable checkpoint ends with finish_reason=paused
  // — a terminal message_end whose turn is NOT done. Stay paused (gate interactions[] already
  // parked; this only adds finishReason + cost) so the resume card renders, not a completed
  // bubble. Without this it'd fall to "completed" below.
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

/** Pop trailing `content` steps (交付前 blocking ask_user 吸收同轮 CEO 导语进卡，不重复进时间线).
 * Mirrors desktop `dropTrailingContentSteps` + backend `EventSink._accumulate_process`. */
function dropTrailingContentSteps(process: ProcessStep[]): void {
  while (process.length > 0 && process[process.length - 1].kind === "content") {
    process.pop();
  }
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

/** Drop a `team_preview` marker (开工卡 gate). Event order is run_plan →
 * team_preview_required, but product narrative is 开工卡 → 协作图 — if a `team`
 * marker already exists, insert before the last one; else append. Dedupes by
 * checkpoint_id. Mirrors backend `EventSink._accumulate_process`. */
function pushTeamPreviewMarker(process: ProcessStep[], id: string): void {
  if (!id) return;
  if (process.some((s) => s.kind === "team_preview" && s.checkpoint_id === id))
    return;
  const marker = { kind: "team_preview" as const, checkpoint_id: id };
  for (let i = process.length - 1; i >= 0; i--) {
    if (process[i].kind === "team") {
      process.splice(i, 0, marker);
      return;
    }
  }
  process.push(marker);
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
    reasoningEffort: a.reasoning_effort ?? "high",
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
    continuesRunId: null,
    //「计划已调整」轻痕迹 (设计 §7.2): set by the plan_revised event; null until then.
    revised: null,
    replacesRunId: s.replaces_run_id ?? null,
    checkpoint: null,
    // 收到的上下文 (上下文传递可视化): filled by the run_context event; empty until then.
    receivedContext: [],
    // 升级实时可见: appended by the run_escalation event; empty until a worker escalates.
    escalations: [],
    process: [],
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
  let finishReason: string | null = null;
  let cost: CostBreakdown | null = null;
  let debate: DebateResultPayload | null = null;
  let debateRounds: DebateNarrativeRound[] = [];
  let crossExamEnabled = false;
  let debateOpening: string | null = null;
  let teamSynthesisPreview: TeamSynthesisPreviewPayload | null = null;
  let turnWarning: string | null = null;
  // 团队便签墙 (§2.2 通): notes broadcast to siblings this turn, in post order (deduped by noteId).
  const teamNotes: ProjectedTeamNote[] = [];
  let sawError = false;
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
        process.push({ kind: "rework" });
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
        // A delegated worker's call (run-scoped) belongs to its run node's process,
        // not the captain's inline timeline (统一团队时间线 = the CEO's OWN steps).
        // An orchestration tool (delegate/debate) is skipped from both: its `team`
        // marker (dropped at run_plan) stands in for it on the captain bubble.
        if (p.run_id) {
          const run = runById(p.run_id);
          if (run) {
            run.process.push({
              kind: "tool",
              id: p.tool_call_id,
              tool_name: p.tool_name,
              arguments: p.arguments ?? {},
              result: null,
              status: "running",
            });
          }
        } else if (!ORCHESTRATION_TOOLS.has(p.tool_name)) {
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
        if (p.run_id) {
          const run = runById(p.run_id);
          if (run) {
            for (let i = run.process.length - 1; i >= 0; i--) {
              const step = run.process[i];
              if (step.kind === "tool" && step.id === p.tool_call_id) {
                step.result = p.result;
                step.status = p.status;
                if (p.display != null) step.display = p.display;
                break;
              }
            }
          }
        } else if (!ORCHESTRATION_TOOLS.has(p.tool_name)) {
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
        const continuesRoot = p.continues_run_id ?? null;
        let run = runById(p.run_id);
        if (!run && continuesRoot) {
          const original = runById(continuesRoot);
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
              continuesRunId: continuesRoot,
              // 乙 wire 携 round/stance (单一轮次投影): debate 续写从 wire 读取。
              stance: p.stance ?? null,
              group: p.group ?? null,
              round: p.round ?? 0,
            };
            runs.push(run);
          }
        }
        if (run) {
          run.status = "running";
          run.parentRunId = p.parent_run_id;
          run.kind = p.kind;
          if (continuesRoot && run.continuesRunId == null) {
            run.continuesRunId = continuesRoot;
          }
          // 冷回落接手: mid-flight `_redir` carries replaces_run_id on the wire.
          if (p.replaces_run_id) run.replacesRunId = p.replaces_run_id;
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
        const run = runById(p.run_id);
        if (run) {
          const d = p.delta || "";
          if (d) {
            const last = run.process[run.process.length - 1];
            if (last && last.kind === "content") last.text += d;
            else run.process.push({ kind: "content", text: d });
          }
        }
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
        const run = runById(p.run_id);
        if (run) {
          while (
            run.process.length > 0 &&
            run.process[run.process.length - 1].kind === "content"
          ) {
            run.process.pop();
          }
          run.process.push({ kind: "rework" });
        }
        break;
      }
      case "run_reasoning_delta": {
        const p = ev.payload as RunReasoningDeltaPayload;
        const ag = agentById(p.agent_id);
        if (ag) ag.reasoning += p.delta || "";
        const run = runById(p.run_id);
        if (run) {
          const d = p.delta || "";
          if (d) {
            const last = run.process[run.process.length - 1];
            if (last && last.kind === "reasoning") last.text += d;
            else run.process.push({ kind: "reasoning", text: d });
          }
        }
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
      case "run_cancelled": {
        // 跑一半改方向 / 整轮停止: interrupt mid-flight (orthogonal to run_failed).
        const p = ev.payload as RunCancelledPayload;
        const run = runById(p.run_id);
        if (run) run.status = "cancelled";
        const ag = agentById(p.agent_id);
        if (ag) {
          ag.status = "cancelled";
          ag.currentRunId = null;
          ag.toolProgress = null;
        }
        break;
      }
      case "run_skipped": {
        // 级联跳过 / graceful abort: node never ran —「未执行」. Agent stays idle.
        const p = ev.payload as RunSkippedPayload;
        const run = runById(p.run_id);
        if (run) run.status = "skipped";
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
            kind: p.kind === "scope" || p.kind === "dep" ? p.kind : "normal",
          });
        break;
      }
      case "escalation_required": {
        // 阻塞式求决策: a worker SUSPENDED on a blocking escalate — append a `pending`
        // card. awaiting=ceo → 等主管仲裁（不可答）；缺省 → 经典可答。
        const p = ev.payload as EscalationRequiredPayload;
        const run = runById(p.run_id);
        if (run)
          run.escalations.push({
            question: p.question,
            assumption: p.assumption,
            blocking: true,
            status: "pending",
            answer: null,
            kind: p.kind === "scope" || p.kind === "dep" ? p.kind : "normal",
            ...(p.awaiting === "ceo" ? { awaiting: "ceo" as const } : {}),
          });
        break;
      }
      case "escalation_resolved": {
        // Settlement: flip pending → resolved | assumed | timed_out.
        const p = ev.payload as EscalationResolvedPayload;
        const esc = runById(p.run_id)?.escalations.find(
          (e) => e.status === "pending",
        );
        if (esc) {
          if (p.status === "resolved") {
            esc.status = "resolved";
            esc.answer = p.answer;
          } else if (p.status === "assumed") {
            esc.status = "assumed";
            esc.answer = null;
          } else {
            esc.status = "timed_out";
            esc.answer = null;
          }
          if (p.arbitrated_by === "ceo") {
            esc.arbitrated_by = "ceo";
            if (p.via_user != null) esc.via_user = p.via_user;
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
        if (p.cross_exam_enabled === true) crossExamEnabled = true;
        const rawOpening = (p.opening ?? "").trim();
        if (rawOpening && !debateOpening) debateOpening = rawOpening;
        debateRounds = upsertNarrativeRound(debateRounds, {
          round_no: p.round_no,
          focus: p.focus,
          summary: "",
          verdict: null,
          sides: [],
          clashes: [],
          cross_exam: [],
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
          cross_exam: p.cross_exam ?? [],
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
            ...(p.source ? { source: p.source } : {}),
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
      case "approval_required":
      case "approval_resolved":
        break;
      case "checkpoint_required": {
        const p = ev.payload as CheckpointRequiredPayload;
        // Absorb same-round CEO prose into the checkpoint card (mirrors desktop
        // foldCheckpointMarker): drop trailing content steps + clear content scalar.
        dropTrailingContentSteps(process);
        content = "";
        pushCheckpointMarker(process, p.checkpoint_id);
        break;
      }
      case "checkpoint_resolved":
        break;
      case "plan_review_required": {
        const p = ev.payload as PlanReviewRequiredPayload;
        pushPlanReviewMarker(process, p.checkpoint_id);
        const runIds = (p.steps ?? []).map((s) => s.run_id);
        checkpointSteps.set(p.checkpoint_id, runIds);
        for (const rid of runIds) {
          const run = runById(rid);
          if (run) run.checkpoint = { status: "pending", decision: null };
        }
        break;
      }
      case "plan_review_resolved": {
        const p = ev.payload as PlanReviewResolvedPayload;
        for (const rid of checkpointSteps.get(p.checkpoint_id) ?? []) {
          const run = runById(rid);
          if (run)
            run.checkpoint = { status: "resolved", decision: p.decision };
        }
        break;
      }
      case "team_preview_required": {
        const p = ev.payload as TeamPreviewRequiredPayload;
        pushTeamPreviewMarker(process, p.checkpoint_id);
        break;
      }
      case "team_preview_resolved":
        break;
      case "question_posted": {
        // 非阻塞提问 (ask_user blocking=false): drop an `ask` marker at its chronological
        // slot; the turn does NOT pause. Mirrors the backend oracle.
        const p = ev.payload as QuestionPostedPayload;
        pushAskMarker(process, p.ask_id);
        break;
      }
      case "error":
        sawError = true;
        break;
      case "message_end": {
        const p = ev.payload as MessageEndPayload;
        finishReason = p.finish_reason;
        cost = p.cost ?? null;
        break;
      }
      // Not part of the normalized turn judge state beyond interactions[] fold (no-op) —
      // enumerated so assertNever stays exhaustive against @agentcore/contract-types.
      case "message_start":
      case "turn_saved":
      case "title_generated":
      case "followups_generated":
      case "board_op_required":
      case "board_read_required":
      case "desktop_notify_required":
      case "tool_progress":
      case "tool_use_progress":
      case "batch_metrics":
      case "run_escalation_gate":
      case "delegation_authorization_required":
      case "delegation_authorization_resolved":
      case "interaction_orphaned":
      case "workspace_op_required":
      case "handoff_snapshot_done":
      case "handoff_job_started":
      case "handoff_apply_done":
      case "sim.agent_action":
      case "sim.agent_state":
      case "sim.interaction":
      case "sim.tick_started":
      case "sim.tick_ended":
      case "sim.tick_frame":
      case "sim.world_event":
      case "sim.show.affection_shift":
      case "sim.show.departure":
      case "sim.show.episode_gate":
      case "sim.show.heart_pick":
      case "sim.show.pair_formed":
      case "sim.show.reveal":
      case "sim.show.zero_vote_alert":
        break;
      case "turn_warning": {
        turnWarning = (ev.payload as TurnWarningPayload).message;
        break;
      }
      case "team_synthesis_preview": {
        teamSynthesisPreview = ev.payload as TeamSynthesisPreviewPayload;
        break;
      }
      default:
        assertNever(type);
    }
  }

  const interactions = foldInteractions(events);
  let status: TurnStatus;
  if (finishReason != null) {
    status = FINISH_TO_STATUS[finishReason] ?? "completed";
  } else if (sawError) {
    status = "failed";
  } else if (hasGatePending(interactions)) {
    status = "paused";
  } else {
    status = "running";
  }

  // A cancelled OR failed turn may leave in-flight nodes with no terminal frame; freeze
  // them as cancelled (parity with the desktop finalizeFold + backend oracle). `cancelled`
  // is the graceful stop; `failed` is the defensive case — a turn that errors out (hard
  // crash / lost terminal frame) with a still-running worker would otherwise replay as a
  // forever-spinning node on reload.
  if (status === "cancelled" || status === "failed") {
    for (const r of runs) if (r.status === "running") r.status = "cancelled";
    for (const a of agents) if (a.status === "working") a.status = "cancelled";
  }

  // Turn terminal: plan-declared nodes with no terminal frame → skipped（旧 journal 无
  // run_skipped 时靠本收口兜住；completed 也要处理 pending 残留）。
  if (status === "completed" || status === "cancelled" || status === "failed") {
    for (const r of runs) if (r.status === "pending") r.status = "skipped";
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
    interactions,
    cost,
    debate,
    debateRounds,
    crossExamEnabled,
    debateOpening,
    teamSynthesisPreview,
    turnWarning,
    teamNotes,
  };
}

/**
 * 下一步推荐 (CEO→用户): pull a finished turn's followup suggestions straight off its raw SSE
 * events — a transport-only sibling of {@link fold}, deliberately kept OUT of the normalized
 * {@link ProjectedTurn}. Followups are DERIVED-persisted on `Message.followups` (reload via
 * MessageDetail); the live path rides `followups_generated`. Conformance fold still no-ops
 * the event (ProjectedTurn does not carry chips).
 *
 * Identity seam: chips are matched by `message_id` against this turn's `message_start`.
 * Missing `message_id` → empty (never fall back to「last batch」). A mismatched id (late
 * event appended to the wrong live turn after a fast consecutive send) is also empty.
 */
export function extractFollowups(events: SSEEvent[]): string[] {
  let turnMessageId: string | null = null;
  for (const ev of events) {
    if (ev.type === "message_start") {
      turnMessageId = (ev.payload as MessageStartPayload).message_id;
    }
  }
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type !== "followups_generated") continue;
    const p = events[i].payload as FollowupsGeneratedPayload;
    if (!p.message_id) return [];
    if (turnMessageId && p.message_id !== turnMessageId) continue;
    return p.followups;
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

/** Worker-scoped `tool_use_progress` (run_id present): the LATEST coarse EXECUTION phase per
 * still-running worker run, keyed by `run_id`. Transport-only sibling of {@link extractToolPhases}
 * — kept OUT of {@link ProjectedTurn} so the golden stays phase-less. Cleared on the matching
 * worker `tool_use_end`. */
export function extractWorkerToolPhases(
  events: SSEEvent[],
): Map<string, { phase: ToolPhase; toolName: string }> {
  const phases = new Map<string, { phase: ToolPhase; toolName: string }>();
  for (const ev of events) {
    if (ev.type === "tool_use_progress") {
      const p = ev.payload as ToolUseProgressPayload;
      if (!p.run_id) continue;
      phases.set(p.run_id, {
        phase: p.phase as ToolPhase,
        toolName: p.tool_name,
      });
    } else if (ev.type === "tool_use_end") {
      const p = ev.payload as ToolUseEndPayload;
      if (p.run_id) phases.delete(p.run_id);
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

/** One tool call a delegated worker made, for its run-detail 工具明细 (RunDetail). Mirrors the
 *  process timeline's `tool` step shape (中文名 + args/result peek) minus the live-only `phase`
 *  — a settled/replayed run's tools are all resolved, and a running one just shows「进行中」. */
export interface RunToolCall {
  id: string;
  toolName: string;
  arguments: Record<string, unknown>;
  result: string | null;
  status: "running" | "success" | "error";
}

/**
 * 队员工具明细 (RunDetail · 工具调用): the run-scoped tool calls each delegated worker made, pulled
 * straight off a turn's raw SSE events — a transport-only sibling of {@link fold} (twin of
 * {@link extractAsks}), keyed by `run_id`, calls in fire order.
 *
 * The conformance {@link ProjectedTurn} folds a WORKER's run-scoped tool calls to NOTHING: they
 * belong to the worker's node, not the CEO's inline timeline (统一团队时间线 = the CEO's OWN steps),
 * and the golden carries no per-run tool IO — so the fold {@link fold} skips a `run_id`-tagged
 * `tool_use_*` (leaving only the coarse {@link ProjectedAgent.toolProgress}). The run-detail panel
 * reads the full call list from HERE instead, exactly like the asks side channel.
 *
 * Escalation submit ids come from {@link ProjectedTurn.interactions} (kind=escalation,
 * status=pending) — not a parallel extract map (P3).
 *
 * A `tool_use_start` opens a `running` call (null result) appended to its run; the matching
 * `tool_use_end` folds in its `result`/`status`. Orchestration tools (delegate/debate) are skipped
 * — they are the team STRUCTURE (rendered as sub-tasks / the graph), not a worker tool, mirroring
 * the fold's ORCHESTRATION_TOOLS skip. Both LIVE turns and MULTI-agent history (`runs.events`)
 * carry these events, so the panel works live AND on replay; a single-agent turn yields an empty
 * map (its calls are the captain's own, run_id-less).
 */
export function extractRunToolCalls(
  events: SSEEvent[],
): Map<string, RunToolCall[]> {
  const byRun = new Map<string, RunToolCall[]>();
  const byCallId = new Map<string, RunToolCall>();
  for (const ev of events) {
    if (ev.type === "tool_use_start") {
      const p = ev.payload as ToolUseStartPayload;
      if (!p.run_id || ORCHESTRATION_TOOLS.has(p.tool_name)) continue;
      const call: RunToolCall = {
        id: p.tool_call_id,
        toolName: p.tool_name,
        arguments: p.arguments ?? {},
        result: null,
        status: "running",
      };
      const list = byRun.get(p.run_id);
      if (list) list.push(call);
      else byRun.set(p.run_id, [call]);
      byCallId.set(p.tool_call_id, call);
    } else if (ev.type === "tool_use_end") {
      const p = ev.payload as ToolUseEndPayload;
      if (!p.run_id || ORCHESTRATION_TOOLS.has(p.tool_name)) continue;
      const call = byCallId.get(p.tool_call_id);
      if (call) {
        call.result = p.result;
        call.status = p.status;
      }
    }
  }
  return byRun;
}
