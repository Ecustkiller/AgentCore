import type { DebateNarrativeRound, DebateResultPayload } from "@/types/events";
import type { RunFrame } from "./frames";
import {
  type AgentState,
  type BatchMetricsSnapshot,
  type DebateRoundDecision,
  type Execution,
  type ExecutionPlan,
  type ExecutionStatus,
  type RunNode,
  type TeamNote,
  toolLabel,
} from "./types";

/**
 * The mutable accumulator a frame stream folds into — the "current state" the
 * graph has after the frames applied so far.
 *
 * 增量投影 (流式性能): the fold is expressed as {@link initFold} → {@link applyFrame}
 * (per frame) → {@link finalizeFold}. A from-scratch projection ({@link
 * projectExecution}) runs all three; the live store keeps ONE `FoldState` per turn
 * and advances it by a single {@link applyFrame} per new frame — so a streaming turn
 * costs O(1) amortized per token instead of re-folding the whole history each tick.
 *
 * `agentIndex` / `runIndex` map id → the SAME object held in `agents` / `runs` (not a
 * copy), so an in-place mutation through the index is visible in the array — replacing
 * the old O(n) `.find` per lookup with O(1). Only `agents` / `runs` are rendered;
 * `checkpointSteps` / `batches` / `teamNotes` are fold bookkeeping + turn-level output.
 */
export interface FoldState {
  plan: ExecutionPlan;
  agents: AgentState[];
  runs: RunNode[];
  agentIndex: Map<string, AgentState>;
  runIndex: Map<string, RunNode>;
  // plan_review_resolved carries only the checkpoint id, so remember which step
  // run ids each pause gated on (from its _required frame) to apply the decision.
  checkpointSteps: Map<string, string[]>;
  // 调度埋点量化 (深层诊断指标): WaveScheduler snapshots fold here in fire order, one per
  // delegate segment (a checkpoint / scope yield + resume appends another).
  batches: BatchMetricsSnapshot[];
  // 团队便签墙 (§2.2 通): notes workers broadcast to siblings, in post order (deduped by noteId).
  teamNotes: TeamNote[];
}

function agentFromPlan(plan: ExecutionPlan, id: string): AgentState | null {
  const spec = plan.agents.find((a) => a.id === id);
  if (!spec) return null;
  return {
    id: spec.id,
    role: spec.role,
    modelPreference: spec.modelPreference,
    thinking: spec.thinking ?? true,
    reasoningEffort: spec.reasoningEffort ?? "high",
    status: "idle",
    currentRunId: null,
    outputChunks: [],
    reasoningChunks: [],
    toolCalls: [],
    toolProgress: null,
    toolExecutionLive: null,
  };
}

function runFromPlan(plan: ExecutionPlan, id: string): RunNode | null {
  const spec = plan.runs.find((s) => s.id === id);
  if (!spec) return null;
  return {
    id: spec.id,
    agentId: spec.agentId,
    task: spec.task,
    status: "pending",
    dependsOn: spec.dependsOn,
    outputSummary: null,
    outputFiles: [],
    debrief: null,
    durationMs: null,
    error: null,
    parentRunId: spec.parentRunId ?? null,
    kind: spec.kind ?? "agent",
    role: null,
    model: null,
    usage: null,
    cost: null,
    stance: spec.stance ?? null,
    group: spec.group ?? null,
    round: spec.round ?? 0,
    revisionOf: null,
    revision: 0,
    revised: null,
    replacesRunId: spec.replacesRunId ?? null,
    checkpoint: null,
    receivedContext: [],
    escalations: [],
  };
}

function addAgent(s: FoldState, a: AgentState): void {
  s.agents.push(a);
  s.agentIndex.set(a.id, a);
}

function addRun(s: FoldState, r: RunNode): void {
  s.runs.push(r);
  s.runIndex.set(r.id, r);
}

function ensureAgent(s: FoldState, id: string): void {
  if (!s.agentIndex.has(id)) {
    const a = agentFromPlan(s.plan, id);
    if (a) addAgent(s, a);
  }
}

function ensureRun(s: FoldState, id: string): void {
  if (!s.runIndex.has(id)) {
    const r = runFromPlan(s.plan, id);
    if (r) addRun(s, r);
  }
}

/** A fresh accumulator for `plan`, before any frame is applied. */
export function initFold(plan: ExecutionPlan): FoldState {
  return {
    plan,
    agents: [],
    runs: [],
    agentIndex: new Map(),
    runIndex: new Map(),
    checkpointSteps: new Map(),
    batches: [],
    teamNotes: [],
  };
}

/**
 * Fold ONE run-level fact into the accumulator, in place. Deterministic and
 * order-dependent (frames replay in stream order): applying `frames[0..n]` in
 * sequence yields the exact state the graph had after the n-th fact, which is
 * what powers both the live tail and timeline replay.
 */
export function applyFrame(s: FoldState, f: RunFrame): void {
  switch (f.kind) {
    case "run_started": {
      let run = s.runIndex.get(f.runId);
      // 定向唤回 续写 (乙 热修 P4): a revision (`revision >= 2`) is NOT in the plan —
      // it is born from this frame. Synthesize its run + agent, inheriting the
      // ORIGINAL's display identity (role / tier / task), and hang it off the
      // original as a「修订 vN」child so its output / cost / status fold in just
      // like a planned worker. Guarded on the original existing, so a stray
      // revision frame (parent not on this graph) is ignored, not mis-drawn.
      if (!run && f.revision > 0 && f.parentRunId) {
        // Parent is plan-declared and may not be materialized yet (lazy fold).
        ensureRun(s, f.parentRunId);
        const original = s.runIndex.get(f.parentRunId);
        if (original) {
          ensureAgent(s, original.agentId);
          const originAgent = s.agentIndex.get(original.agentId);
          addAgent(s, {
            id: f.agentId,
            role: originAgent?.role ?? original.agentId,
            modelPreference: originAgent?.modelPreference ?? "strong",
            thinking: originAgent?.thinking ?? true,
            reasoningEffort: originAgent?.reasoningEffort ?? "high",
            status: "idle",
            currentRunId: null,
            outputChunks: [],
            reasoningChunks: [],
            toolCalls: [],
            toolProgress: null,
            toolExecutionLive: null,
          });
          run = {
            id: f.runId,
            agentId: f.agentId,
            task: original.task,
            status: "pending",
            dependsOn: [],
            outputSummary: null,
            outputFiles: [],
            debrief: null,
            durationMs: null,
            error: null,
            parentRunId: f.parentRunId,
            kind: f.runKind,
            role: null,
            model: null,
            usage: null,
            cost: null,
            // 乙 wire 携 round/stance (单一轮次投影): debate 续写从 frame wire 读取。
            stance: f.stance ?? null,
            group: f.group ?? null,
            round: f.round ?? 0,
            revisionOf: f.parentRunId,
            revision: f.revision,
            revised: null,
            replacesRunId: null,
            checkpoint: null,
            receivedContext: [],
            escalations: [],
          };
          addRun(s, run);
        }
      }
      if (!run) ensureRun(s, f.runId);
      ensureAgent(s, f.agentId);
      run = s.runIndex.get(f.runId);
      if (run) {
        run.status = "running";
        // Capture the 阶段2 declaration slots onto the node so a later graph
        // can read them from the projected run (inert in 阶段1).
        run.parentRunId = f.parentRunId;
        run.kind = f.runKind;
        // 冷回落接手: mid-flight `_redir` carries replaces_run_id on the wire.
        if (f.replacesRunId) run.replacesRunId = f.replacesRunId;
      }
      const agent = s.agentIndex.get(f.agentId);
      if (agent) {
        agent.status = "working";
        agent.currentRunId = f.runId;
        agent.toolProgress = null;
      }
      break;
    }
    case "run_context": {
      // 收到的上下文 (上下文传递可视化): record the structured context this run was
      // fed onto its node, so the detail panel shows exactly what the LLM saw.
      // The captain's own context is TURN-LEVEL (the message bubble, not a node):
      // skip it here so a multi-agent journal replay doesn't paint the CEO node.
      const run = s.runIndex.get(f.runId);
      if (run && run.kind !== "captain") run.receivedContext = f.blocks;
      break;
    }
    case "run_output_delta": {
      const agent = s.agentIndex.get(f.agentId);
      if (agent) agent.outputChunks.push(f.delta);
      break;
    }
    case "run_output_reset": {
      // 交付前核验回炉 (finish_guard) 的 worker 对偶（content_reset 之于 CEO）：worker done
      // 轮草稿未过轻层核验（统一底线·结构完整性），引擎丢弃这一版、发 run_output_reset、回炉
      // 重写。清这个 agent 已累积的产出（重写版从干净态重累积），reasoning 是真实过程、保留
      // ——镜像后端 oracle 与 mobile fold（conformance pins them equal）。
      const agent = s.agentIndex.get(f.agentId);
      if (agent) {
        agent.outputChunks = [];
        agent.didRework = true;
      }
      break;
    }
    case "run_reasoning_delta": {
      const agent = s.agentIndex.get(f.agentId);
      if (agent) agent.reasoningChunks.push(f.delta);
      break;
    }
    case "run_tool_progress": {
      // The worker is composing a tool call's arguments (the file body for
      // file_write, …): light up the live「正在生成」line. Cleared when the call
      // starts executing (tool_use_start) or the run ends.
      const agent = s.agentIndex.get(f.agentId);
      if (agent) agent.toolProgress = { toolName: f.toolName, chars: f.chars };
      break;
    }
    case "run_completed": {
      const run = s.runIndex.get(f.runId);
      if (run) {
        run.status = "completed";
        run.outputSummary = f.outputSummary;
        run.outputFiles = f.outputFiles ?? [];
        run.debrief = f.debrief ?? null;
        run.durationMs = f.durationMs;
        // Light up this run's payroll row (§7.3B); absent on cost-less frames.
        run.role = f.role ?? null;
        run.model = f.model ?? null;
        run.usage = f.usage ?? null;
        run.cost = f.cost ?? null;
      }
      const agent = s.agentIndex.get(f.agentId);
      if (agent) {
        agent.status = "completed";
        agent.currentRunId = null;
        agent.toolProgress = null;
      }
      break;
    }
    case "plan_review_required": {
      // 结构化挂起 2a: the scheduler paused after these step(s) completed; mark
      // them pending so the node shows a「待放行」badge.
      s.checkpointSteps.set(f.checkpointId, f.runIds);
      for (const id of f.runIds) {
        ensureRun(s, id);
        const run = s.runIndex.get(id);
        if (run) run.checkpoint = { status: "pending", decision: null };
      }
      break;
    }
    case "plan_review_resolved": {
      for (const id of s.checkpointSteps.get(f.checkpointId) ?? []) {
        const run = s.runIndex.get(id);
        if (run) {
          run.checkpoint = { status: "resolved", decision: f.decision };
        }
      }
      break;
    }
    case "plan_revised": {
      // 「计划已调整」轻痕迹 (设计 §7.2): the CEO autonomously re-bound / re-steered the
      // paused plan via replan. Tag each affected node so it paints a non-interrupting
      // trace (bind=据上游证据定稿待绑定步骤; steer=偏离后操舵未跑步骤). bind wins over steer
      // if a node is both. A stray run_id (not on this graph) is ignored.
      // Oracle declares every run in the run_plan before plan_revised fires — materialize
      // the full plan slice so late-bound nodes exist to tag (r2/r3 while still pending).
      for (const spec of s.plan.runs) ensureRun(s, spec.id);
      for (const rev of f.revisions) {
        const run = s.runIndex.get(rev.runId);
        if (run && !(run.revised === "bind" && rev.revisionKind === "steer")) {
          run.revised = rev.revisionKind;
        }
      }
      break;
    }
    case "run_failed": {
      const run = s.runIndex.get(f.runId);
      if (run) {
        run.status = "failed";
        run.error = f.error;
        run.debrief = f.debrief ?? null;
      }
      const agent = s.agentIndex.get(f.agentId);
      if (agent) {
        agent.status = "error";
        agent.toolProgress = null;
      }
      break;
    }
    case "run_cancelled": {
      // 跑一半改方向 / 整轮停止: interrupt mid-flight (orthogonal to run_failed).
      // Clear currentRunId + toolProgress so the node leaves its live「正在生成」line.
      const run = s.runIndex.get(f.runId);
      if (run) run.status = "cancelled";
      const agent = s.agentIndex.get(f.agentId);
      if (agent) {
        agent.status = "cancelled";
        agent.currentRunId = null;
        agent.toolProgress = null;
      }
      break;
    }
    case "run_progress": {
      // Progress is derived from run states below so it stays correct and
      // cumulative across multiple delegate batches (the per-batch wire
      // counters would reset). The frame is kept only as a timeline marker.
      break;
    }
    case "batch_metrics": {
      // 调度埋点量化 (深层诊断指标): accrue the scheduler snapshot for 诊断模式 (run
      // detail's 调度 block). Append per segment so a multi-batch / resumed turn keeps each.
      s.batches.push(f.metrics);
      break;
    }
    case "team_note_posted": {
      // 团队便签墙 (§2.2 通): a worker broadcast a one-line decision / heads-up to its
      // concurrent siblings — accrue TURN-LEVEL (not onto a node), in post order, deduped
      // by noteId for replay safety. Mirrors the backend oracle + mobile fold.
      if (!s.teamNotes.some((n) => n.noteId === f.noteId)) {
        s.teamNotes.push({
          noteId: f.noteId,
          runId: f.runId,
          agentId: f.agentId,
          role: f.role,
          kind: f.noteKind,
          text: f.text,
          ts: f.ts,
          status: "active",
          supersedes: f.supersedes,
          source: f.source,
        });
      }
      // 便签会过期 → supersession (§2.2): an amendment (carries `supersedes`) marks its TARGET
      // superseded (改写) / voided (作废) — `supersedeMode` is the shared discriminator. The
      // target was posted earlier so it is already in the list (frames replay in order).
      if (f.supersedes) {
        const target = s.teamNotes.find((n) => n.noteId === f.supersedes);
        if (target) {
          target.status = f.supersedeMode === "void" ? "voided" : "superseded";
        }
      }
      break;
    }
    case "run_escalation": {
      // 升级实时可见 (非阻塞): a worker flagged a decision/blocker for the CEO — append it
      // to its run so the node shows a ⚠️ badge and the card raises a live notice the
      // instant it fires (the durable copy still rides RunState.escalations → CEO
      // synthesis). A stray frame whose run isn't on this graph is ignored.
      const run = s.runIndex.get(f.runId);
      if (run)
        run.escalations.push({
          // Non-blocking banner: no resolve target (it never suspended).
          id: null,
          question: f.question,
          assumption: f.assumption,
          blocking: f.blocking,
          status: "raised",
          answer: null,
          kind: f.escalationKind,
          // 非阻塞 banner 无应答卡，故无结构化选项。
          questions: [],
        });
      break;
    }
    case "escalation_required": {
      // 阻塞式求决策: a worker SUSPENDED on a blocking escalate — append a `pending` card.
      // awaiting=ceo → 等主管仲裁（不可答）；缺省 → 经典可答卡。
      const run = s.runIndex.get(f.runId);
      if (run)
        run.escalations.push({
          id: f.escalationId,
          question: f.question,
          assumption: f.assumption,
          blocking: true,
          status: "pending",
          answer: null,
          kind: f.escalationKind,
          questions: f.questions ?? [],
          ...(f.awaiting === "ceo" ? { awaiting: "ceo" as const } : {}),
        });
      break;
    }
    case "escalation_resolved": {
      // 阻塞式求决策 settlement: flip this run's pending escalation to resolved/timeout.
      const run = s.runIndex.get(f.runId);
      const esc = run?.escalations.find((e) => e.status === "pending");
      if (esc) {
        if (f.status === "resolved") {
          esc.status = "resolved";
          esc.answer = f.answer;
        } else {
          esc.status = "timeout";
          esc.answer = null;
        }
        if (f.arbitrated_by === "ceo") {
          esc.arbitrated_by = "ceo";
          if (f.via_user != null) esc.via_user = f.via_user;
        }
      }
      break;
    }
    case "tool_use_start": {
      // A delegated worker tags its calls with `runId`, so file the call onto
      // THAT run's agent — with width>1 several workers run concurrently and the
      // old "first running run" heuristic mis-attributed them all to one. The
      // captain's own calls carry no runId (and an unresolvable id can't be
      // placed), so those fall back to the running-run heuristic as before.
      const owner =
        (f.runId ? s.runIndex.get(f.runId) : undefined) ??
        s.runs.find((r) => r.status === "running");
      const agent = owner ? s.agentIndex.get(owner.agentId) : undefined;
      if (agent) {
        agent.toolCalls.push({
          id: f.toolCallId,
          toolName: f.toolName,
          arguments: f.arguments,
          result: null,
          status: "running",
        });
        // The call's arguments finished assembling and it is now executing, so
        // the「正在生成」progress line gives way to this real tool-call row.
        agent.toolProgress = null;
      }
      break;
    }
    case "tool_use_end": {
      for (const agent of s.agents) {
        const tc = agent.toolCalls.find((t) => t.id === f.toolCallId);
        if (tc) {
          tc.result = f.result;
          tc.display = f.display ?? null;
          tc.status = f.status;
          break;
        }
      }
      break;
    }
  }
}

/**
 * Materialize the accumulator into a full {@link Execution} snapshot — the
 * post-loop finalization: surface plan-declared-but-untouched nodes, freeze a
 * stopped turn's in-flight nodes, derive progress, and attach the turn-level
 * debate / notes payloads.
 *
 * Pure w.r.t. `s`: it never mutates the accumulator's arrays or node objects (it
 * builds fresh output arrays and copies only the nodes it must freeze), so the
 * live store can keep advancing the SAME `FoldState` after a snapshot is taken.
 */
export function finalizeFold(
  s: FoldState,
  status: ExecutionStatus,
  debate: DebateResultPayload | null = null,
  debateRounds: DebateNarrativeRound[] = [],
  debateDecisions: DebateRoundDecision[] = [],
): Execution {
  // Plan-declared nodes not yet touched by frames stay visible as pending/idle
  // (replay playhead before their run_started) — appended after started nodes so
  // multi-batch delegate order matches the oracle (revision before later batch).
  const runs: RunNode[] = [...s.runs];
  for (const spec of s.plan.runs) {
    if (!s.runIndex.has(spec.id)) {
      const r = runFromPlan(s.plan, spec.id);
      if (r) runs.push(r);
    }
  }
  const agents: AgentState[] = [...s.agents];
  for (const spec of s.plan.agents) {
    if (!s.agentIndex.has(spec.id)) {
      const a = agentFromPlan(s.plan, spec.id);
      if (a) agents.push(a);
    }
  }

  // A stopped turn never receives terminal run frames for its in-flight nodes;
  // freeze them as cancelled so the card leaves its live state (no spinners /
  // progress bar) instead of looking like it is still running. Copy-on-write so
  // the accumulator's live objects are left untouched (a re-fold must not see them
  // frozen).
  const finalRuns =
    status === "cancelled"
      ? runs.map((r) =>
          r.status === "running" ? { ...r, status: "cancelled" as const } : r,
        )
      : runs;
  const finalAgents =
    status === "cancelled"
      ? agents.map((a) =>
          a.status === "working" ? { ...a, status: "cancelled" as const } : a,
        )
      : agents;

  return {
    id: s.plan.id,
    planType: s.plan.planType,
    taskSummary: s.plan.taskSummary,
    status,
    agents: finalAgents,
    runs: finalRuns,
    // Derived (not from run_progress): count terminal-completed nodes over the
    // cumulative run set, so multi-batch delegate progress is always correct.
    progress: {
      completed: finalRuns.filter((s) => s.status === "completed").length,
      total: finalRuns.length,
    },
    batches: s.batches,
    debate,
    debateRounds,
    debateDecisions,
    teamNotes: s.teamNotes,
  };
}

/**
 * Fold a prefix of the frame stream into a full {@link Execution} snapshot.
 *
 * Pure and deterministic: feeding `frames.slice(0, n)` yields the exact state
 * the graph had after the n-th fact, which is what powers timeline replay. This
 * is the from-scratch path (reload / scrub / conformance); the live store folds
 * the SAME {@link applyFrame} incrementally (增量投影) to stay O(1) per token.
 */
export function projectExecution(
  plan: ExecutionPlan,
  frames: RunFrame[],
  status: ExecutionStatus,
  debate: DebateResultPayload | null = null,
  debateRounds: DebateNarrativeRound[] = [],
  debateDecisions: DebateRoundDecision[] = [],
): Execution {
  const state = initFold(plan);
  for (const f of frames) applyFrame(state, f);
  return finalizeFold(state, status, debate, debateRounds, debateDecisions);
}

/** Human-readable label for a frame, used by the timeline scrubber. */
export function describeFrame(frame: RunFrame, plan: ExecutionPlan): string {
  const role = (agentId: string) =>
    plan.agents.find((a) => a.id === agentId)?.role ?? agentId;
  const task = (runId: string) =>
    plan.runs.find((s) => s.id === runId)?.task ?? runId;

  switch (frame.kind) {
    case "run_started":
      return `${role(frame.agentId)} 开始 · ${task(frame.runId)}`;
    case "run_context":
      return `${task(frame.runId)} · 收到上下文`;
    case "run_output_delta":
      return `${role(frame.agentId)} 输出中…`;
    case "run_output_reset":
      return `${role(frame.agentId)} 重写产出…`;
    case "run_reasoning_delta":
      return `${role(frame.agentId)} 思考中…`;
    case "run_tool_progress":
      return `${role(frame.agentId)} 生成 ${toolLabel(frame.toolName)}…`;
    case "run_completed":
      return `${role(frame.agentId)} 完成`;
    case "run_failed":
      return `${role(frame.agentId)} 失败`;
    case "run_cancelled":
      return frame.reason === "redirect"
        ? `${role(frame.agentId)} 已改方向`
        : `${role(frame.agentId)} 已停止`;
    case "run_progress":
      return `进度 ${frame.completed}/${frame.total}`;
    case "batch_metrics":
      return `调度快照 · ${frame.metrics.nodes} 节点 · 峰值并发 ${frame.metrics.peakRunning}`;
    case "run_escalation":
      return `${role(frame.agentId)} 上报问题`;
    case "escalation_required":
      return `${role(frame.agentId)} 求决策 · 待你拍板`;
    case "escalation_resolved":
      return frame.status === "resolved"
        ? `${role(frame.agentId)} 已获答复 · 继续`
        : `${role(frame.agentId)} 按假设继续`;
    case "tool_use_start":
      return `调用工具 ${frame.toolName}`;
    case "tool_use_end":
      return `工具${frame.status === "success" ? "完成" : "失败"}`;
    case "plan_review_required":
      return "执行暂停 · 待你放行";
    case "plan_review_resolved":
      return frame.decision === "stop"
        ? "已停止 · 未运行下游"
        : "已放行 · 继续";
    case "plan_revised": {
      const bound = frame.revisions.filter(
        (r) => r.revisionKind === "bind",
      ).length;
      const steered = frame.revisions.filter(
        (r) => r.revisionKind === "steer",
      ).length;
      const parts: string[] = [];
      if (bound) parts.push(`职责已定稿 ${bound}`);
      if (steered) parts.push(`方向已校准 ${steered}`);
      return parts.length > 0 ? parts.join(" · ") : "计划已调整";
    }
    case "team_note_posted":
      return `${frame.role || role(frame.agentId)} 贴便签`;
  }
}

/**
 * Wall-clock span covered by a frame stream, in ms (0 if fewer than 2 frames).
 *
 * Used for the completed task card's "用时" summary. Wall-clock (last − first
 * frame timestamp) is correct regardless of parallelism, unlike summing
 * per-run durations which would overcount concurrent agents.
 */
export function elapsedMs(frames: RunFrame[]): number {
  if (frames.length < 2) return 0;
  return Math.max(0, frames[frames.length - 1].t - frames[0].t);
}
